import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readFile,
  readlink,
  readdir,
  realpath,
  rename,
  rmdir,
  statfs as filesystemStats,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
} from "node:path";

const NUMBERED_COPY_PATTERN = /^(.*) ([2-9][0-9]*)(\.[^/]+)$/u;
const GENERATED_NUMBERED_COPY_PATTERN = / [2-9][0-9]*(?:\.[^/]+)?$/u;
const MANIFEST_GENERATION_PATTERN = /^gen-([0-9]{6})$/u;
const GENERATED_TREE_PATHS = [".next", "node_modules"];
const RETENTION_DAYS = 4;

export function canonicalPathForNumberedCopy(relativePath) {
  const filename = basename(relativePath);
  const match = NUMBERED_COPY_PATTERN.exec(filename);
  if (!match) return null;
  return join(dirname(relativePath), `${match[1]}${match[3]}`);
}

export async function inspectWorkspace(options, dependencies = {}) {
  const repositoryRoot = await realpath(resolve(options.repositoryRoot));
  const quarantineRoot = await realpath(resolve(options.quarantineRoot));
  const runStatfs = dependencies.statfs ?? filesystemStats;

  if (!isAbsolute(options.repositoryRoot)) {
    throw new Error("Repository root must be absolute");
  }
  requireExternalPath(repositoryRoot, quarantineRoot);

  const actualRoot = resolve(
    gitText(repositoryRoot, ["rev-parse", "--show-toplevel"]),
  );
  const branch = gitText(repositoryRoot, ["rev-parse", "--abbrev-ref", "HEAD"]);
  const head = gitText(repositoryRoot, ["rev-parse", "HEAD"]);
  if (
    actualRoot !== repositoryRoot ||
    branch !== options.expectedBranch ||
    head !== options.expectedHead
  ) {
    throw new Error("Workspace identity does not match approved input");
  }

  const status = gitBuffer(repositoryRoot, [
    "status",
    "--porcelain=v1",
    "-z",
    "--untracked-files=all",
  ]);
  const records = status.toString("utf8").split("\0").filter(Boolean);
  if (records.some((record) => !record.startsWith("?? "))) {
    throw new Error("Tracked or staged workspace changes are not allowed");
  }

  const candidates = [];
  for (const record of records) {
    const originalPath = record.slice(3);
    const canonicalPath = canonicalPathForNumberedCopy(originalPath);
    if (!canonicalPath) continue;
    const originalMetadata = await fileMetadata(
      join(repositoryRoot, originalPath),
    );
    const canonicalMetadata = await fileMetadata(
      join(repositoryRoot, canonicalPath),
    );
    if (originalMetadata.type !== "file" || canonicalMetadata.type !== "file") {
      continue;
    }
    const classification =
      originalMetadata.sha256 === canonicalMetadata.sha256
        ? "identical"
        : "divergent";
    candidates.push({
      originalPath,
      quarantinePath: join("source-copies", originalPath),
      canonicalPath,
      mode: originalMetadata.mode,
      size: originalMetadata.size,
      sha256: originalMetadata.sha256,
      canonicalMode: canonicalMetadata.mode,
      canonicalSize: canonicalMetadata.size,
      canonicalSha256: canonicalMetadata.sha256,
      classification,
      historyMatch:
        classification === "divergent"
          ? historicalMatch(
              repositoryRoot,
              canonicalPath,
              originalMetadata.sha256,
            )
          : null,
    });
  }
  candidates.sort((left, right) =>
    Buffer.from(left.originalPath).compare(Buffer.from(right.originalPath)),
  );
  if (candidates.length !== options.expectedCount) {
    throw new Error("Numbered-copy inventory does not match approved count");
  }

  const requiredBytes =
    candidates.reduce((total, candidate) => total + candidate.size, 0) +
    (await apparentSize(join(repositoryRoot, "node_modules"))) +
    (await apparentSize(join(repositoryRoot, ".next")));
  const stats = await runStatfs(quarantineRoot);
  const availableBytes = Number(stats.bavail) * Number(stats.bsize);
  if (!Number.isFinite(availableBytes) || availableBytes <= requiredBytes) {
    throw new Error("Quarantine filesystem has insufficient available space");
  }

  const createdAt = normalizeDate(options.now ?? new Date());
  return {
    schemaVersion: 1,
    state: "inspected",
    repositoryRoot,
    branch,
    head,
    createdAt,
    validationAt: null,
    deleteAfter: null,
    deletionStatus: "retained",
    deletionRequiresConfirmation: true,
    copies: candidates,
  };
}

export async function quarantineWorkspace(options, dependencies = {}) {
  const inspection = await inspectWorkspace(options, dependencies);
  const runDirectory = join(
    await realpath(resolve(options.quarantineRoot)),
    timestampIdentifier(inspection.createdAt),
  );
  await mkdir(runDirectory, { mode: 0o700 });
  await chmod(runDirectory, 0o700);

  let manifest = {
    ...inspection,
    state: "copying",
    deletionStagingResidues: [],
    generatedTrees: [],
    copies: inspection.copies.map((copy) => ({ ...copy, diffPath: null })),
  };
  await writeManifest(runDirectory, manifest);

  try {
    const generatedTrees = [];
    for (const treePath of GENERATED_TREE_PATHS) {
      const sourcePath = join(inspection.repositoryRoot, treePath);
      const metadata = await pathMetadata(sourcePath);
      if (metadata.type !== "directory") {
        throw new Error(`Required generated tree is missing: ${treePath}`);
      }
      generatedTrees.push({
        path: treePath,
        quarantinePath: join("generated", treePath),
        inventory: await inventoryTree(sourcePath),
      });
    }
    manifest = { ...manifest, generatedTrees };
    await writeManifest(runDirectory, manifest);

    await mkdir(join(runDirectory, "source-copies"), {
      recursive: true,
      mode: 0o700,
    });
    await mkdir(join(runDirectory, "generated"), {
      recursive: true,
      mode: 0o700,
    });

    const archivedCopies = [];
    for (const copy of manifest.copies) {
      const sourcePath = join(inspection.repositoryRoot, copy.originalPath);
      const archivePath = join(runDirectory, copy.quarantinePath);
      await copyRegularFile(sourcePath, archivePath, copy.mode);

      let diffPath = null;
      if (copy.classification === "divergent") {
        diffPath = join("divergent-diffs", `${copy.originalPath}.diff`);
        const diff = createPrivateDiff(
          copy.canonicalPath,
          copy.originalPath,
          await readFile(join(inspection.repositoryRoot, copy.canonicalPath)),
          await readFile(sourcePath),
        );
        await writePrivateFile(join(runDirectory, diffPath), diff);
      }
      archivedCopies.push({ ...copy, diffPath });
    }
    manifest = { ...manifest, copies: archivedCopies };
    await writeManifest(runDirectory, manifest);

    for (const tree of generatedTrees) {
      await copyTree(
        join(inspection.repositoryRoot, tree.path),
        join(runDirectory, tree.quarantinePath),
      );
    }

    await dependencies.afterArchiveCopied?.({ runDirectory });

    for (const copy of manifest.copies) {
      await requireFileMatch(join(runDirectory, copy.quarantinePath), copy);
    }
    for (const tree of generatedTrees) {
      const archiveInventory = await inventoryTree(
        join(runDirectory, tree.quarantinePath),
      );
      requireMatchingInventory(tree.inventory, archiveInventory, tree.path);
    }

    await dependencies.beforeDeletionPreflight?.({
      repositoryRoot: inspection.repositoryRoot,
    });
    const deletionEntries = [
      ...manifest.copies.map((copy) => ({
        type: "file",
        relativePath: copy.originalPath,
        quarantinePath: copy.quarantinePath,
        expected: copy,
      })),
      ...[...generatedTrees].reverse().map((tree) => ({
        type: "tree",
        relativePath: tree.path,
        quarantinePath: tree.quarantinePath,
        expected: tree.inventory,
      })),
    ];
    await removeOriginalsTransactionally(
      inspection.repositoryRoot,
      runDirectory,
      deletionEntries,
      dependencies,
    );

    manifest = {
      ...manifest,
      state: "quarantined",
      quarantinedAt: inspection.createdAt,
    };
    await writeManifest(runDirectory, manifest);
    return { runDirectory, manifest };
  } catch (error) {
    manifest = {
      ...manifest,
      state: "incomplete",
      failure: "Quarantine transaction did not complete",
      deletionStagingResidues: Array.isArray(error?.deletionStagingResidues)
        ? error.deletionStagingResidues
        : manifest.deletionStagingResidues,
    };
    await writeManifest(runDirectory, manifest);
    throw error;
  }
}

export async function markQuarantineValidated(options) {
  const repositoryRoot = await realpath(resolve(options.repositoryRoot));
  const runDirectory = await realpath(resolve(options.runDirectory));
  requireExternalPath(repositoryRoot, runDirectory);
  const manifest = await readVerifiedManifest(runDirectory);
  requireManifestRepository(manifest, repositoryRoot);
  if (manifest.state !== "quarantined") {
    throw new Error("Only a quarantined run can be validated");
  }
  requireRepositoryIdentity(repositoryRoot, manifest);

  const status = gitBuffer(repositoryRoot, [
    "status",
    "--porcelain=v1",
    "-z",
    "--untracked-files=all",
  ]);
  if (status.length !== 0) {
    throw new Error("Regenerated workspace is not clean");
  }

  for (const treePath of GENERATED_TREE_PATHS) {
    const metadata = await pathMetadata(join(repositoryRoot, treePath));
    if (metadata.type !== "directory") {
      throw new Error(`Regenerated tree is missing: ${treePath}`);
    }
    const inventory = await inventoryTree(join(repositoryRoot, treePath));
    if (
      inventory.some(
        (record) =>
          record.path !== "." &&
          GENERATED_NUMBERED_COPY_PATTERN.test(basename(record.path)),
      )
    ) {
      throw new Error("Regenerated trees contain a numbered copy");
    }
  }

  const validationAt = normalizeDate(options.now ?? new Date());
  const validated = {
    ...manifest,
    state: "validated",
    validationAt,
    retentionDays: RETENTION_DAYS,
    deleteAfter: new Date(
      new Date(validationAt).valueOf() + RETENTION_DAYS * 24 * 60 * 60 * 1000,
    ).toISOString(),
    deletionRequiresConfirmation: true,
  };
  await writeManifest(runDirectory, validated);
  return validated;
}

export async function restoreQuarantine(options) {
  const repositoryRoot = await realpath(resolve(options.repositoryRoot));
  const runDirectory = await realpath(resolve(options.runDirectory));
  requireExternalPath(repositoryRoot, runDirectory);
  let manifest = await readVerifiedManifest(runDirectory);
  requireManifestRepository(manifest, repositoryRoot);
  if (!["quarantined", "validated"].includes(manifest.state)) {
    throw new Error("Run is not eligible for restore");
  }
  requireRepositoryIdentity(repositoryRoot, manifest);

  for (const copy of manifest.copies) {
    if (
      (await pathMetadata(join(repositoryRoot, copy.originalPath))).type !==
      "missing"
    ) {
      throw new Error(`Restore target already exists: ${copy.originalPath}`);
    }
    await requireFileMatch(join(runDirectory, copy.quarantinePath), copy);
  }
  for (const tree of manifest.generatedTrees) {
    requireMatchingInventory(
      tree.inventory,
      await inventoryTree(join(runDirectory, tree.quarantinePath)),
      tree.path,
    );
  }

  const restoredAt = normalizeDate(options.now ?? new Date());
  const rollbackRelativePath = join(
    "rollback",
    "regenerated-before-restore",
    timestampIdentifier(restoredAt),
  );
  const rollbackPath = join(runDirectory, rollbackRelativePath);
  await mkdir(dirname(rollbackPath), { recursive: true, mode: 0o700 });
  await mkdir(rollbackPath, { mode: 0o700 });
  await chmod(rollbackPath, 0o700);

  try {
    const activeInventories = new Map();
    for (const tree of manifest.generatedTrees) {
      const activePath = join(repositoryRoot, tree.path);
      const activeMetadata = await pathMetadata(activePath);
      if (activeMetadata.type === "missing") continue;
      if (activeMetadata.type !== "directory") {
        throw new Error(
          `Active generated path is not a directory: ${tree.path}`,
        );
      }
      const activeInventory = await inventoryTree(activePath);
      activeInventories.set(tree.path, activeInventory);
      const rollbackTreePath = join(rollbackPath, tree.path);
      await copyTree(activePath, rollbackTreePath);
      requireMatchingInventory(
        activeInventory,
        await inventoryTree(rollbackTreePath),
        tree.path,
      );
    }

    for (const tree of manifest.generatedTrees) {
      if (activeInventories.has(tree.path)) {
        await removePath(join(repositoryRoot, tree.path));
      }
      await copyTree(
        join(runDirectory, tree.quarantinePath),
        join(repositoryRoot, tree.path),
      );
      requireMatchingInventory(
        tree.inventory,
        await inventoryTree(join(repositoryRoot, tree.path)),
        tree.path,
      );
    }
    for (const copy of manifest.copies) {
      await copyRegularFile(
        join(runDirectory, copy.quarantinePath),
        join(repositoryRoot, copy.originalPath),
        copy.mode,
      );
      await requireFileMatch(join(repositoryRoot, copy.originalPath), copy);
    }

    manifest = {
      ...manifest,
      state: "restored",
      restoredAt,
      rollbackPath: rollbackRelativePath,
    };
    await writeManifest(runDirectory, manifest);
    return manifest;
  } catch (error) {
    manifest = {
      ...manifest,
      state: "incomplete",
      failure: "Restore transaction did not complete",
      rollbackPath: rollbackRelativePath,
    };
    await writeManifest(runDirectory, manifest);
    throw error;
  }
}

async function pathMetadata(path) {
  try {
    const stats = await lstat(path);
    if (stats.isFile()) return { type: "file", stats };
    if (stats.isDirectory()) return { type: "directory", stats };
    if (stats.isSymbolicLink()) return { type: "symlink", stats };
    return { type: "other", stats };
  } catch (error) {
    if (error?.code === "ENOENT") return { type: "missing", stats: null };
    throw error;
  }
}

async function inventoryTree(root) {
  const records = [];

  async function visit(path, relativePath) {
    const metadata = await pathMetadata(path);
    if (metadata.type === "missing") {
      throw new Error(`Archived tree is missing: ${relativePath}`);
    }
    if (metadata.type === "file") {
      const contents = await readFile(path);
      records.push({
        path: relativePath,
        type: "file",
        mode: metadata.stats.mode & 0o777,
        size: metadata.stats.size,
        sha256: sha256(contents),
      });
      return;
    }
    if (metadata.type === "symlink") {
      records.push({
        path: relativePath,
        type: "symlink",
        linkTarget: await readlink(path),
      });
      return;
    }
    if (metadata.type !== "directory") {
      throw new Error(`Unsupported filesystem entry: ${relativePath}`);
    }
    records.push({
      path: relativePath,
      type: "directory",
      mode: metadata.stats.mode & 0o777,
    });
    const names = await readdir(path);
    names.sort(compareBytes);
    for (const name of names) {
      await visit(
        join(path, name),
        relativePath === "." ? name : join(relativePath, name),
      );
    }
  }

  await visit(root, ".");
  records.sort((left, right) => compareBytes(left.path, right.path));
  return records;
}

async function copyTree(source, destination) {
  const metadata = await pathMetadata(source);
  if (metadata.type === "file") {
    await copyRegularFile(source, destination, metadata.stats.mode & 0o777);
    return;
  }
  if (metadata.type === "symlink") {
    await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
    await symlink(await readlink(source), destination);
    return;
  }
  if (metadata.type !== "directory") {
    throw new Error(`Cannot copy unsupported path: ${source}`);
  }
  await mkdir(destination, { mode: metadata.stats.mode & 0o777 });
  const names = await readdir(source);
  names.sort(compareBytes);
  for (const name of names) {
    await copyTree(join(source, name), join(destination, name));
  }
  await chmod(destination, metadata.stats.mode & 0o777);
}

async function copyRegularFile(source, destination, mode) {
  const metadata = await pathMetadata(source);
  if (metadata.type !== "file") {
    throw new Error(`Expected a regular file: ${source}`);
  }
  await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
  await copyFile(source, destination);
  await chmod(destination, mode);
}

async function removeOriginalsTransactionally(
  repositoryRoot,
  runDirectory,
  entries,
  dependencies,
) {
  for (const entry of entries) {
    await requireOriginalMatch(repositoryRoot, entry);
  }

  const removed = [];
  const stagingContainers = [];
  try {
    for (const entry of entries) {
      await dependencies.beforeOriginalRemoval?.({
        relativePath: entry.relativePath,
        repositoryRoot,
      });
      await requireOriginalMatch(repositoryRoot, entry);
      const originalPath = join(repositoryRoot, entry.relativePath);
      const stagingContainer = await mkdtemp(
        join(dirname(originalPath), ".quarantine-delete-"),
      );
      await chmod(stagingContainer, 0o700);
      stagingContainers.push(stagingContainer);
      const stagingPath = join(stagingContainer, basename(originalPath));
      try {
        await rename(originalPath, stagingPath);
      } catch (error) {
        try {
          await rmdir(stagingContainer);
        } catch {
          // The residue is recorded by the transaction catch below.
        }
        throw error;
      }
      const removedEntry = { entry, stagingContainer, stagingPath };
      removed.push(removedEntry);
      await dependencies.afterOriginalStaged?.({
        relativePath: entry.relativePath,
        repositoryRoot,
        stagingPath,
      });
      await removeStagedPath(stagingPath, removedEntry, dependencies);
      await rmdir(stagingContainer);
    }
  } catch (error) {
    for (const { entry } of removed.reverse()) {
      const originalPath = join(repositoryRoot, entry.relativePath);
      if ((await pathMetadata(originalPath)).type !== "missing") continue;
      if (entry.type === "file") {
        await copyRegularFile(
          join(runDirectory, entry.quarantinePath),
          originalPath,
          entry.expected.mode,
        );
      } else {
        await copyTree(join(runDirectory, entry.quarantinePath), originalPath);
      }
      await requireOriginalMatch(repositoryRoot, entry);
    }
    const deletionStagingResidues = [];
    for (const path of stagingContainers) {
      if ((await pathMetadata(path)).type !== "missing") {
        deletionStagingResidues.push(relative(repositoryRoot, path));
      }
    }
    deletionStagingResidues.sort(compareBytes);
    const transactionError = new Error("Original removal transaction failed", {
      cause: error,
    });
    transactionError.deletionStagingResidues = deletionStagingResidues;
    throw transactionError;
  }
}

async function removeStagedPath(path, removedEntry, dependencies) {
  const metadata = await pathMetadata(path);
  if (metadata.type === "missing") return;
  if (metadata.type === "directory") {
    const names = await readdir(path);
    names.sort(compareBytes);
    for (const name of names) {
      await removeStagedPath(join(path, name), removedEntry, dependencies);
    }
    await dependencies.beforeStagingDirectoryRemoval?.({
      relativePath: removedEntry.entry.relativePath,
      path,
      stagingPath: removedEntry.stagingPath,
    });
    await rmdir(path);
    return;
  }
  await unlink(path);
}

async function requireOriginalMatch(repositoryRoot, entry) {
  const originalPath = join(repositoryRoot, entry.relativePath);
  if (entry.type === "file") {
    await requireFileMatch(originalPath, entry.expected);
    return;
  }
  requireMatchingInventory(
    entry.expected,
    await inventoryTree(originalPath),
    entry.relativePath,
  );
}

async function removePath(path) {
  const metadata = await pathMetadata(path);
  if (metadata.type === "missing") return;
  if (metadata.type === "directory") {
    const names = await readdir(path);
    names.sort(compareBytes);
    for (const name of names) await removePath(join(path, name));
    await rmdir(path);
    return;
  }
  await unlink(path);
}

async function requireFileMatch(path, expected) {
  const metadata = await fileMetadata(path);
  if (
    metadata.type !== "file" ||
    metadata.mode !== expected.mode ||
    metadata.size !== expected.size ||
    metadata.sha256 !== expected.sha256
  ) {
    throw new Error(
      `Archived file verification failed: ${expected.originalPath}`,
    );
  }
}

function requireMatchingInventory(expected, actual, label) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`Archived tree verification failed: ${label}`);
  }
}

function createPrivateDiff(canonicalPath, originalPath, canonical, original) {
  return Buffer.from(
    [
      `--- a/${canonicalPath}`,
      `+++ b/${originalPath}`,
      "@@ archived divergent numbered copy @@",
      canonical
        .toString("utf8")
        .split("\n")
        .filter((line) => line.length > 0)
        .map((line) => `-${line}`)
        .join("\n"),
      original
        .toString("utf8")
        .split("\n")
        .filter((line) => line.length > 0)
        .map((line) => `+${line}`)
        .join("\n"),
      "",
    ].join("\n"),
  );
}

async function writePrivateFile(path, contents) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await writeFile(path, contents, { mode: 0o600 });
  await chmod(path, 0o600);
}

async function writeManifest(runDirectory, manifest) {
  const contents = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`);
  const generationsDirectory = join(runDirectory, "manifest-generations");
  await mkdir(generationsDirectory, { recursive: true, mode: 0o700 });
  await chmod(generationsDirectory, 0o700);

  const generationName = await nextGenerationName(generationsDirectory);
  const generationDirectory = join(generationsDirectory, generationName);
  const temporaryGenerationDirectory = join(
    generationsDirectory,
    `.${generationName}.tmp-${process.pid}-${Date.now()}`,
  );
  await mkdir(temporaryGenerationDirectory, { mode: 0o700 });
  await writeDurablePrivateFile(
    join(temporaryGenerationDirectory, "manifest.json"),
    contents,
  );
  await writeDurablePrivateFile(
    join(temporaryGenerationDirectory, "manifest.sha256"),
    `${sha256(contents)}  manifest.json\n`,
  );
  await readManifestPair(temporaryGenerationDirectory);
  await syncDirectory(temporaryGenerationDirectory);
  await rename(temporaryGenerationDirectory, generationDirectory);
  await syncDirectory(generationsDirectory);

  const pointerContents = `${generationName}\n`;
  const temporaryPointerPath = join(
    runDirectory,
    `.current.tmp-${process.pid}-${generationName}`,
  );
  await writeDurablePrivateFile(temporaryPointerPath, pointerContents);
  if ((await readFile(temporaryPointerPath, "utf8")) !== pointerContents) {
    throw new Error("Manifest pointer verification failed");
  }
  await rename(temporaryPointerPath, join(runDirectory, "current"));
  await syncDirectory(runDirectory);
}

async function readVerifiedManifest(runDirectory) {
  const pointer = await readFile(join(runDirectory, "current"), "utf8");
  if (!pointer.endsWith("\n") || pointer.indexOf("\n") !== pointer.length - 1) {
    throw new Error("Manifest pointer is invalid");
  }
  const generationName = pointer.slice(0, -1);
  if (!MANIFEST_GENERATION_PATTERN.test(generationName)) {
    throw new Error("Manifest pointer is invalid");
  }
  return readManifestPair(
    join(runDirectory, "manifest-generations", generationName),
  );
}

async function readManifestPair(generationDirectory) {
  const manifestContents = await readFile(
    join(generationDirectory, "manifest.json"),
  );
  const checksum = await readFile(
    join(generationDirectory, "manifest.sha256"),
    "utf8",
  );
  if (checksum.trim() !== `${sha256(manifestContents)}  manifest.json`) {
    throw new Error("Manifest checksum verification failed");
  }
  const manifest = JSON.parse(manifestContents.toString("utf8"));
  if (manifest?.schemaVersion !== 1 || !Array.isArray(manifest.copies)) {
    throw new Error("Manifest schema is invalid");
  }
  return manifest;
}

async function nextGenerationName(generationsDirectory) {
  let highest = 0;
  for (const name of await readdir(generationsDirectory)) {
    const match = MANIFEST_GENERATION_PATTERN.exec(name);
    if (match) highest = Math.max(highest, Number(match[1]));
  }
  if (highest >= 999_999) {
    throw new Error("Manifest generation limit reached");
  }
  return `gen-${String(highest + 1).padStart(6, "0")}`;
}

async function writeDurablePrivateFile(path, contents) {
  const handle = await open(path, "wx", 0o600);
  try {
    await handle.writeFile(contents);
    await handle.sync();
  } finally {
    await handle.close();
  }
  await chmod(path, 0o600);
}

async function syncDirectory(path) {
  const handle = await open(path, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

function requireManifestRepository(manifest, repositoryRoot) {
  if (manifest.repositoryRoot !== repositoryRoot) {
    throw new Error("Manifest belongs to a different repository");
  }
}

function requireRepositoryIdentity(repositoryRoot, manifest) {
  const actualRoot = resolve(
    gitText(repositoryRoot, ["rev-parse", "--show-toplevel"]),
  );
  const branch = gitText(repositoryRoot, ["rev-parse", "--abbrev-ref", "HEAD"]);
  const head = gitText(repositoryRoot, ["rev-parse", "HEAD"]);
  if (
    actualRoot !== repositoryRoot ||
    branch !== manifest.branch ||
    head !== manifest.head
  ) {
    throw new Error("Repository identity no longer matches the manifest");
  }
}

function timestampIdentifier(value) {
  return normalizeDate(value).replace(/[-:.]/gu, "");
}

function compareBytes(left, right) {
  return Buffer.from(left).compare(Buffer.from(right));
}

async function fileMetadata(path) {
  const stats = await lstat(path);
  if (!stats.isFile()) {
    return {
      type: stats.isDirectory() ? "directory" : "other",
      mode: stats.mode & 0o777,
      size: stats.size,
      sha256: null,
    };
  }
  const contents = await readFile(path);
  return {
    type: "file",
    mode: stats.mode & 0o777,
    size: stats.size,
    sha256: sha256(contents),
  };
}

function historicalMatch(repositoryRoot, canonicalPath, expectedHash) {
  const revisions = gitText(repositoryRoot, [
    "log",
    "--all",
    "--format=%H",
    "--",
    canonicalPath,
  ])
    .split("\n")
    .filter(Boolean);
  for (const revision of revisions) {
    try {
      const contents = gitBuffer(repositoryRoot, [
        "show",
        `${revision}:${canonicalPath}`,
      ]);
      if (sha256(contents) === expectedHash) return revision;
    } catch {
      // A path may not exist in every revision returned for a rename.
    }
  }
  return null;
}

async function apparentSize(path) {
  let stats;
  try {
    stats = await lstat(path);
  } catch (error) {
    if (error?.code === "ENOENT") return 0;
    throw error;
  }
  if (!stats.isDirectory()) return stats.size;
  let total = stats.size;
  for (const name of await readdir(path)) {
    total += await apparentSize(join(path, name));
  }
  return total;
}

function requireExternalPath(repositoryRoot, quarantineRoot) {
  const location = relative(repositoryRoot, quarantineRoot);
  if (
    location === "" ||
    (!location.startsWith("..") && !isAbsolute(location))
  ) {
    throw new Error("Quarantine root must be outside the repository");
  }
}

function normalizeDate(value) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.valueOf())) throw new Error("Invalid timestamp");
  return date.toISOString();
}

function gitText(repositoryRoot, args) {
  return gitBuffer(repositoryRoot, args).toString("utf8").trim();
}

function gitBuffer(repositoryRoot, args) {
  return execFileSync("git", args, {
    cwd: repositoryRoot,
    encoding: "buffer",
    stdio: ["ignore", "pipe", "pipe"],
    maxBuffer: 64 * 1024 * 1024,
  });
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}
