import { createHash } from "node:crypto";
import { once } from "node:events";
import { createReadStream } from "node:fs";
import * as fsPromises from "node:fs/promises";
import { createInterface } from "node:readline";
import { basename, dirname, join } from "node:path";

const SORT_CHUNK_ENTRIES = 512;
const MERGE_FAN_IN = 32;

export async function hashFileStream(absolutePath, options = {}) {
  const streamFactory = options.createReadStream ?? createReadStream;
  const hash = createHash("sha256");
  let bytes = 0;
  const stream = streamFactory(absolutePath, { highWaterMark: 64 * 1024 });
  for await (const chunk of stream) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    hash.update(buffer);
    bytes += buffer.length;
  }
  return { sha256: hash.digest("hex"), bytes };
}

function modeOf(stat) {
  return stat.mode & 0o7777;
}

async function inventoryRecord(absolutePath, relativePath, stat, fsApi) {
  if (stat.isDirectory()) {
    return {
      record: { path: relativePath, type: "directory", mode: modeOf(stat), size: 0 },
      bytes: 0,
    };
  }
  if (stat.isFile()) {
    const hashed = await hashFileStream(absolutePath);
    if (hashed.bytes !== stat.size) {
      throw new Error(`file changed while being inventoried: ${relativePath}`);
    }
    return {
      record: {
        path: relativePath,
        type: "file",
        mode: modeOf(stat),
        size: stat.size,
        sha256: hashed.sha256,
      },
      bytes: stat.size,
    };
  }
  if (stat.isSymbolicLink()) {
    const linkTarget = await fsApi.readlink(absolutePath);
    const size = Buffer.byteLength(linkTarget);
    return {
      record: {
        path: relativePath,
        type: "symlink",
        mode: modeOf(stat),
        size,
        linkTarget,
      },
      bytes: size,
    };
  }
  throw new Error(`unsupported inventory entry type: ${relativePath}`);
}

async function* walkTree(root, fsApi) {
  async function* walkDirectory(absoluteDirectory, relativeDirectory) {
    const directory = await fsApi.opendir(absoluteDirectory);
    for await (const entry of directory) {
      const relativePath = relativeDirectory
        ? `${relativeDirectory}/${entry.name}`
        : entry.name;
      const absolutePath = join(absoluteDirectory, entry.name);
      const stat = await fsApi.lstat(absolutePath);
      yield { absolutePath, relativePath, stat };
      if (stat.isDirectory()) {
        yield* walkDirectory(absolutePath, relativePath);
      }
    }
  }
  yield* walkDirectory(root, "");
}

function compareRecords(left, right) {
  return Buffer.compare(Buffer.from(left.path), Buffer.from(right.path));
}

async function writeChunk(records, path, fsApi) {
  records.sort(compareRecords);
  const handle = await fsApi.open(path, "w", 0o600);
  try {
    await handle.chmod(0o600);
    await handle.writeFile(records.map((record) => `${JSON.stringify(record)}\n`).join(""));
  } finally {
    await handle.close();
  }
}

async function writeWithBackpressure(handle, lines, onLine) {
  const output = handle.createWriteStream({ autoClose: false });
  try {
    for await (const line of lines) {
      const framed = `${line}\n`;
      onLine?.(framed);
      if (!output.write(framed, "utf8")) {
        await once(output, "drain");
      }
    }
    const finished = once(output, "finish");
    output.end();
    await finished;
    await handle.sync();
    const closed = once(output, "close");
    output.destroy();
    await closed;
  } catch (error) {
    output.destroy();
    throw error;
  }
}

async function* mergeSortedFiles(paths) {
  const sources = paths.map((path) => {
    const reader = createInterface({
      input: createReadStream(path, { encoding: "utf8" }),
      crlfDelay: Infinity,
    });
    return { reader, iterator: reader[Symbol.asyncIterator](), current: null };
  });

  try {
    for (const source of sources) {
      const next = await source.iterator.next();
      if (!next.done) {
        source.current = {
          line: next.value,
          path: Buffer.from(JSON.parse(next.value).path),
        };
      }
    }

    while (true) {
      let selectedIndex = -1;
      for (let index = 0; index < sources.length; index += 1) {
        const candidate = sources[index].current;
        if (
          candidate !== null &&
          (selectedIndex === -1 ||
            Buffer.compare(candidate.path, sources[selectedIndex].current.path) < 0)
        ) {
          selectedIndex = index;
        }
      }
      if (selectedIndex === -1) return;

      const selected = sources[selectedIndex];
      yield selected.current.line;
      const next = await selected.iterator.next();
      selected.current = next.done
        ? null
        : { line: next.value, path: Buffer.from(JSON.parse(next.value).path) };
    }
  } finally {
    for (const source of sources) source.reader.close();
  }
}

async function mergeGroup(inputPaths, outputPath, fsApi, onLine) {
  const handle = await fsApi.open(outputPath, "w", 0o600);
  try {
    await handle.chmod(0o600);
    await writeWithBackpressure(handle, mergeSortedFiles(inputPaths), onLine);
  } finally {
    await handle.close();
  }
}

async function reduceMergeFiles(paths, temporaryDirectory, fsApi) {
  let currentPaths = paths;
  let round = 0;
  while (currentPaths.length > MERGE_FAN_IN) {
    const nextPaths = [];
    for (let offset = 0; offset < currentPaths.length; offset += MERGE_FAN_IN) {
      const group = currentPaths.slice(offset, offset + MERGE_FAN_IN);
      const mergedPath = join(
        temporaryDirectory,
        `merge-${round}-${String(nextPaths.length).padStart(6, "0")}.jsonl`,
      );
      await mergeGroup(group, mergedPath, fsApi);
      nextPaths.push(mergedPath);
    }
    await Promise.all(currentPaths.map((path) => fsApi.rm(path, { force: true })));
    currentPaths = nextPaths;
    round += 1;
  }
  return currentPaths;
}

export async function writeInventoryJsonl({ root, outputPath, fsApi = fsPromises }) {
  const rootStat = await fsApi.lstat(root);
  if (rootStat.isSymbolicLink() || (!rootStat.isDirectory() && !rootStat.isFile())) {
    throw new Error("inventory root must be a non-symlink regular file or directory");
  }

  await fsApi.mkdir(dirname(outputPath), { recursive: true });
  const temporaryDirectory = await fsApi.mkdtemp(
    join(dirname(outputPath), `.${basename(outputPath)}-sort-`),
  );
  const chunkPaths = [];
  let bufferedRecords = [];
  let entries = 0;
  let bytes = 0;

  try {
    const inventoryItems = rootStat.isFile()
      ? [{ absolutePath: root, relativePath: ".", stat: rootStat }]
      : walkTree(root, fsApi);
    for await (const item of inventoryItems) {
      const inventoried = await inventoryRecord(
        item.absolutePath,
        item.relativePath,
        item.stat,
        fsApi,
      );
      bufferedRecords.push(inventoried.record);
      entries += 1;
      bytes += inventoried.bytes;

      if (bufferedRecords.length === SORT_CHUNK_ENTRIES) {
        const chunkPath = join(
          temporaryDirectory,
          `chunk-${String(chunkPaths.length).padStart(6, "0")}.jsonl`,
        );
        await writeChunk(bufferedRecords, chunkPath, fsApi);
        chunkPaths.push(chunkPath);
        bufferedRecords = [];
      }
    }
    if (bufferedRecords.length > 0) {
      const chunkPath = join(
        temporaryDirectory,
        `chunk-${String(chunkPaths.length).padStart(6, "0")}.jsonl`,
      );
      await writeChunk(bufferedRecords, chunkPath, fsApi);
      chunkPaths.push(chunkPath);
    }

    const finalInputs = await reduceMergeFiles(chunkPaths, temporaryDirectory, fsApi);
    const digest = createHash("sha256");
    let writtenEntries = 0;
    if (finalInputs.length === 0) {
      const handle = await fsApi.open(outputPath, "w", 0o600);
      try {
        await handle.chmod(0o600);
        await handle.sync();
      } finally {
        await handle.close();
      }
    } else {
      await mergeGroup(finalInputs, outputPath, fsApi, (framed) => {
        digest.update(framed);
        writtenEntries += 1;
      });
    }
    if (writtenEntries !== entries) {
      throw new Error("inventory merge lost entries");
    }
    return { sha256: digest.digest("hex"), entries, bytes };
  } finally {
    await fsApi.rm(temporaryDirectory, { recursive: true, force: true });
  }
}

export function parseInventorySummary(value) {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)
  ) {
    throw new TypeError("inventory summary must be an object");
  }
  const keys = Object.keys(value).sort();
  if (keys.join(",") !== "bytes,entries,sha256") {
    throw new TypeError("inventory summary has an invalid schema");
  }
  if (!/^[a-f0-9]{64}$/u.test(value.sha256)) {
    throw new TypeError("inventory summary hash is invalid");
  }
  if (!Number.isSafeInteger(value.entries) || value.entries < 0) {
    throw new TypeError("inventory summary entry count is invalid");
  }
  if (!Number.isSafeInteger(value.bytes) || value.bytes < 0) {
    throw new TypeError("inventory summary byte count is invalid");
  }
  return Object.freeze({ sha256: value.sha256, entries: value.entries, bytes: value.bytes });
}

export async function compareInventorySummary(expected, observed) {
  const parsedExpected = parseInventorySummary(expected);
  const parsedObserved = parseInventorySummary(observed);
  if (
    parsedExpected.sha256 !== parsedObserved.sha256 ||
    parsedExpected.entries !== parsedObserved.entries ||
    parsedExpected.bytes !== parsedObserved.bytes
  ) {
    throw new Error("inventory summary mismatch");
  }
  return true;
}

export async function fsyncTree(root, fsApi = fsPromises) {
  const stat = await fsApi.lstat(root);
  if (stat.isSymbolicLink()) return;
  if (stat.isDirectory()) {
    const directory = await fsApi.opendir(root);
    for await (const entry of directory) {
      await fsyncTree(join(root, entry.name), fsApi);
    }
  } else if (!stat.isFile()) {
    throw new Error(`unsupported fsync entry type: ${root}`);
  }

  const handle = await fsApi.open(root, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}
