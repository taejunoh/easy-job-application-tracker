import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

const root = join(__dirname, "../..");
const expectedOrigin = "https://easy-job-application-tracker.vercel.app";
const aliasPredicate = '(.aliases | type == "array") and ((.aliases | length) == 0)';

function normalize(text: string): string {
  return text.replace(/\s+/gu, " ").trim();
}

function rolloutSection(): string {
  const runbook = readFileSync(join(root, "docs/operations/production-runbook.md"), "utf8");
  const start = runbook.indexOf("## Application identity maintenance rollout");
  const end = runbook.indexOf("## Backup and restore", start);
  expect(start).not.toBe(-1);
  expect(end).toBeGreaterThan(start);
  return runbook.slice(start, end);
}

function bashBlocks(section: string): string[] {
  return [...section.matchAll(/```bash\r?\n([\s\S]*?)```/gu)].map(([, block]) => block);
}

function executableVercelLines(document: string): string[] {
  return executableShellLines(document, /vercel/iu);
}

function fencedShellBlocks(document: string): string[] {
  const blocks: string[] = [];
  let activeMarker: "`" | "~" | null = null;
  let activeLength = 0;
  let block: string[] = [];

  for (const line of document.split(/\r?\n/u)) {
    const fence = line.match(/^\s{0,3}(`{3,}|~{3,})([^\r\n]*)$/u);
    if (fence) {
      const marker = (fence[1] ?? "")[0] as "`" | "~" | undefined;
      const length = (fence[1] ?? "").length;
      const info = fence[2] ?? "";
      if (activeMarker === null) {
        activeMarker = marker ?? null;
        activeLength = length;
        block = [];
      } else if (marker === activeMarker && length >= activeLength && info.trim() === "") {
        blocks.push(block.join("\n"));
        activeMarker = null;
        activeLength = 0;
        block = [];
      }
      continue;
    }
    if (activeMarker !== null) block.push(line);
  }
  if (activeMarker !== null) blocks.push(block.join("\n"));
  return blocks;
}

function executableGhProductionLines(document: string): string[] {
  return executableShellLines(
    document,
    /gh\s+(?:workflow\s+run|run\s+(?:list|view|watch|download|cancel|rerun)|pr\s+(?:create|checks|merge))\b/iu,
  );
}

function commandSegmentStarts(line: string): number[] {
  const starts = [0];
  let quote: "'" | '"' | null = null;
  let inBackticks = false;

  for (let index = 0; index < line.length; index += 1) {
    const character = line[index] ?? "";
    const next = line[index + 1] ?? "";

    if (inBackticks) {
      if (character === "`") {
        inBackticks = false;
      } else if (character === "$" && next === "(") {
        starts.push(index + 2);
        index += 1;
      } else if (
        character === ";" ||
        character === "|" ||
        character === "&"
      ) {
        starts.push(index + 1);
      }
      continue;
    }

    if (quote === "'") {
      if (character === "'") quote = null;
      continue;
    }
    if (quote === '"') {
      if (character === '"') {
        quote = null;
      } else if (character === "$" && next === "(") {
        starts.push(index + 2);
        index += 1;
      } else if (character === "`") {
        inBackticks = true;
        starts.push(index + 1);
      }
      continue;
    }

    if (character === "'") {
      quote = "'";
    } else if (character === '"') {
      quote = '"';
    } else if (character === "`") {
      inBackticks = true;
      starts.push(index + 1);
    } else if (character === "$" && next === "(") {
      starts.push(index + 2);
      index += 1;
    } else if (
      character === ";" ||
      character === "|" ||
      character === "&"
    ) {
      starts.push(index + 1);
    } else if (
      character === "#" &&
      (index === 0 || /\s/u.test(line[index - 1] ?? ""))
    ) {
      break;
    }
  }

  return starts;
}

function nestedShellSources(line: string): string[] {
  const sources: string[] = [];
  let quote: "'" | '"' | null = null;
  let backtickStart = -1;

  for (let index = 0; index < line.length; index += 1) {
    const character = line[index] ?? "";
    const next = line[index + 1] ?? "";
    if (quote === "'") {
      if (character === "'") quote = null;
      continue;
    }
    if (quote === '"') {
      if (character === '"') {
        quote = null;
      } else if (character === "\\") {
        index += 1;
      } else if (character === "$" && next === "(") {
        const end = findCommandSubstitutionEnd(line, index + 2);
        if (end !== -1) {
          sources.push(line.slice(index + 2, end));
          index = end;
        }
      }
      continue;
    }
    if (backtickStart !== -1) {
      if (character === "\\") {
        index += 1;
      } else if (character === "`") {
        sources.push(line.slice(backtickStart, index));
        backtickStart = -1;
      }
      continue;
    }
    if (character === "'") {
      quote = "'";
    } else if (character === '"') {
      quote = '"';
    } else if (character === "`") {
      backtickStart = index + 1;
    } else if (character === "$" && next === "(") {
      const end = findCommandSubstitutionEnd(line, index + 2);
      if (end !== -1) {
        sources.push(line.slice(index + 2, end));
        index = end;
      }
    } else if (character === "\\") {
      index += 1;
    }
  }
  return sources;
}

function findCommandSubstitutionEnd(line: string, start: number): number {
  let depth = 1;
  let quote: "'" | '"' | null = null;
  for (let index = start; index < line.length; index += 1) {
    const character = line[index] ?? "";
    if (quote === "'") {
      if (character === "'") quote = null;
      continue;
    }
    if (quote === '"') {
      if (character === '"') quote = null;
      else if (character === "\\") index += 1;
      continue;
    }
    if (character === "'") quote = "'";
    else if (character === '"') quote = '"';
    else if (character === "\\") index += 1;
    else if (character === "(") depth += 1;
    else if (character === ")" && --depth === 0) return index;
  }
  return -1;
}

function executableShellWrapperLines(line: string, commandPattern: RegExp): boolean {
  const assignment = String.raw`[A-Za-z_][A-Za-z0-9_]*=(?:"[^"]*"|'[^']*'|[^\s]+)`;
  const executablePath = String.raw`(?:[^\s/]+[/\\]|[/\\])*`;
  const envPrefix = String.raw`${executablePath}env(?:[ \t]+(?:--[^\s]+|-[^\s]+|${assignment}))*`;
  const shellWrapper = new RegExp(
    String.raw`(?:^|[;|&][ \t]*)(?:${assignment}[ \t]*)*(?:${envPrefix}[ \t]+)?(?:(?:sudo|doas)(?:[ \t]+-[^\s]+)*[ \t]+)?(?:command[ \t]+)?${executablePath}(?:bash|sh|zsh|dash|ksh|fish|pwsh|powershell|busybox[ \t]+(?:sh|ash))(?:\.(?:exe|cmd|bat|com))?[ \t]+(?:--[^\s]+[ \t]+)*(?:-[A-Za-z]*c|-[Cc]ommand)[ \t]+(['"])([\s\S]*?)\1`,
    "gu",
  );
  const cmdWrapper = new RegExp(
    String.raw`(?:^|[;|&][ \t]*)(?:${assignment}[ \t]*)*(?:${envPrefix}[ \t]+)?(?:(?:sudo|doas)(?:[ \t]+-[^\s]+)*[ \t]+)?(?:command[ \t]+)?${executablePath}cmd(?:\.(?:exe|cmd|bat|com))?[ \t]+\/[CcKk][ \t]+(['"])([\s\S]*?)\1`,
    "gu",
  );
  for (const wrapper of [shellWrapper, cmdWrapper]) {
    for (const match of line.matchAll(wrapper)) {
      const wrapped = match[2];
      if (wrapped !== undefined && executableShellLine(wrapped, commandPattern)) return true;
    }
  }
  return false;
}

function shellWords(segment: string): string[] {
  return [...segment.matchAll(/"(?:\\.|[^"])*"|'[^']*'|\\[^\s][^\s]*|[^\s]+/gu)].map(
    ([word]) => word ?? "",
  );
}

function shellWordValue(word: string): string {
  if (word.startsWith("\\") && word.length > 1) return word.slice(1);
  if (
    word.length >= 2 &&
    ((word.startsWith("'") && word.endsWith("'")) ||
      (word.startsWith('"') && word.endsWith('"')))
  ) {
    return word.slice(1, -1);
  }
  return word;
}

function isAssignment(word: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]*=/u.test(word);
}

function commandName(word: string): string {
  const value = shellWordValue(word).replace(/[\\/]+/gu, "/");
  const basename = value.slice(value.lastIndexOf("/") + 1);
  return basename.replace(/\.(?:exe|cmd|bat|com)$/iu, "").toLowerCase();
}

function targetMatches(words: string[], index: number, commandPattern: RegExp): boolean {
  const invocation = [commandName(words[index] ?? ""), ...words.slice(index + 1).map(shellWordValue)].join(" ");
  const flags = commandPattern.flags.replace(/g/gu, "");
  return new RegExp(`^${commandPattern.source}`, flags).test(invocation);
}

function commandIndex(words: string[]): number {
  let index = 0;
  while (index < words.length && isAssignment(words[index] ?? "")) index += 1;

  const prefix = commandName(words[index] ?? "");
  if (prefix === "env") {
    index += 1;
    while (index < words.length) {
      const word = shellWordValue(words[index] ?? "");
      if (word === "--") {
        index += 1;
        break;
      }
      if (isAssignment(word) || word.startsWith("-")) index += 1;
      else break;
    }
  }

  const privilege = commandName(words[index] ?? "");
  if (privilege === "sudo" || privilege === "doas") {
    index += 1;
    while (index < words.length && shellWordValue(words[index] ?? "").startsWith("-")) index += 1;
  }

  if (commandName(words[index] ?? "") === "command") {
    index += 1;
    while (index < words.length && shellWordValue(words[index] ?? "").startsWith("-")) index += 1;
  }
  return index;
}

function executableCommandSegment(segment: string, commandPattern: RegExp): boolean {
  const words = shellWords(segment);
  const index = commandIndex(words);
  const command = commandName(words[index] ?? "");
  if (targetMatches(words, index, commandPattern)) return true;

  if (command === "npx") {
    let targetIndex = index + 1;
    while (targetIndex < words.length && shellWordValue(words[targetIndex] ?? "").startsWith("-")) {
      targetIndex += 1;
    }
    return targetMatches(words, targetIndex, commandPattern);
  }
  return false;
}

function shellCommentIndex(line: string): number {
  let quote: "'" | '"' | null = null;
  let inBackticks = false;
  for (let index = 0; index < line.length; index += 1) {
    const character = line[index] ?? "";
    if (quote === "'") {
      if (character === "'") quote = null;
      continue;
    }
    if (quote === '"') {
      if (character === '"') quote = null;
      else if (character === "\\") index += 1;
      continue;
    }
    if (inBackticks) {
      if (character === "`") inBackticks = false;
      else if (character === "\\") index += 1;
      continue;
    }
    if (character === "'") quote = "'";
    else if (character === '"') quote = '"';
    else if (character === "`") inBackticks = true;
    else if (character === "\\") index += 1;
    else if (character === "#" && (index === 0 || /\s/u.test(line[index - 1] ?? ""))) return index;
  }
  return -1;
}

function executableShellLine(line: string, commandPattern: RegExp): boolean {
  const trimmed = line.trim();
  if (trimmed.length === 0 || trimmed.startsWith("#")) return false;

  const source = line.replace(/^\s*\$\s+/u, "");
  if (executableShellWrapperLines(source, commandPattern)) return true;
  if (nestedShellSources(source).some((nested) => executableShellLine(nested, commandPattern))) return true;
  const commentIndex = shellCommentIndex(source);
  const starts = commandSegmentStarts(source);
  for (let index = 0; index < starts.length; index += 1) {
    const segmentStart = starts[index] ?? 0;
    const segmentEnd = starts[index + 1] ?? source.length;
    const segment = source.slice(segmentStart, segmentEnd);
    if (commentIndex !== -1 && segmentStart >= commentIndex) continue;
    const boundedSegment =
      commentIndex !== -1 && segmentEnd > commentIndex
        ? source.slice(segmentStart, commentIndex)
        : segment;
    if (executableCommandSegment(boundedSegment, commandPattern)) return true;
  }
  return false;
}

function executableShellLines(document: string, commandPattern: RegExp): string[] {
  return fencedShellBlocks(document)
    .flatMap((block) => block.split(/\r?\n/u))
    .filter((line) => executableShellLine(line, commandPattern));
}

function readmeMaintenanceSection(): string {
  const readme = readFileSync(join(root, "README.md"), "utf8");
  const start = readme.indexOf("### Production identity maintenance");
  const end = readme.indexOf("## Development and Verification", start);
  expect(start).not.toBe(-1);
  expect(end).toBeGreaterThan(start);
  return readme.slice(start, end);
}

function expectOrderedMatches(source: string, requirements: RegExp[]): void {
  let prior = -1;
  for (const requirement of requirements) {
    const match = source.slice(prior + 1).match(requirement);
    expect(match).not.toBeNull();
    const next = match ? prior + 1 + (match.index ?? 0) : -1;
    expect(next).toBeGreaterThan(prior);
    prior = next;
  }
}

function candidateFunction(): string {
  const block = bashBlocks(rolloutSection()).find((candidate) =>
    normalize(candidate).includes("vercel deploy . --prod --skip-domain --yes --format=json --no-color"),
  );
  expect(block).toBeDefined();
  const match = (block ?? "").match(/stage_candidate\(\) \([\s\S]*?\n\)/u);
  expect(match).not.toBeNull();
  return match?.[0] ?? "";
}

function supportFunction(): string {
  const block = bashBlocks(rolloutSection()).find((candidate) =>
    normalize(candidate).includes("support_candidate()"),
  );
  expect(block).toBeDefined();
  const match = (block ?? "").match(/support_candidate\(\) \([\s\S]*?\n\)/u);
  expect(match).not.toBeNull();
  return match?.[0] ?? "";
}

function supportGateBlock(): string {
  const block = bashBlocks(rolloutSection()).find((candidate) =>
    candidate.includes('SUPPORT_CANDIDATE_ID="$(support_candidate "identity=0,writes=1")"'),
  );
  expect(block).toBeDefined();
  return block ?? "";
}

function oneLine(lines: string[], matcher: RegExp): string {
  const matches = lines.filter((line) => matcher.test(line));
  expect(matches).toHaveLength(1);
  return matches[0] ?? "";
}

function expectOrdered(source: string, requirements: string[]): void {
  const normalized = normalize(source).toLowerCase();
  let prior = -1;
  for (const requirement of requirements) {
    const next = normalized.indexOf(normalize(requirement).toLowerCase(), prior + 1);
    expect(next).toBeGreaterThan(prior);
    prior = next;
  }
}

function mockBin(): string {
  const directory = mkdtempSync(join(tmpdir(), "production-rollout-contract-"));
  writeFileSync(join(directory, "git"), `#!/usr/bin/env bash
if [[ "\${1:-} \${2:-}" == "status --porcelain" ]]; then printf '%s\\n' "\${DIRTY_STATUS:-}"; exit 0; fi
if [[ "\${1:-} \${2:-}" == "rev-parse HEAD" ]]; then printf '%s\\n' "\${MOCK_CURRENT_SHA:-\${TARGET_SHA:-}}"; exit 0; fi
if [[ "\${1:-} \${2:-}" == "rev-parse --show-toplevel" ]]; then printf '%s\\n' "\${MOCK_REPO_ROOT:?}"; exit 0; fi
exit 2
`, { mode: 0o700 });
  writeFileSync(join(directory, "vercel"), `#!/usr/bin/env bash
case "\${1:-}" in
  deploy) printf '%s\\n' deploy >> "\${DEPLOY_LOG:?}"; printf '%s\\n' "\${DEPLOY_JSON:-}" ;;
  inspect) printf '%s\\n' inspect >> "\${VERCEL_INSPECT_LOG:?}"; if [[ "\${2:-}" == "\${APP_BASE_URL:-}" ]]; then printf '%s\\n' "\${CANONICAL_JSON:-}"; else printf '%s\\n' "\${INSPECT_JSON:-}"; fi ;;
  api) printf '%s\\n' "\${API_JSON:-}" ;;
  promote) printf '%s\\n' "\${2:-}" >> "\${PROMOTE_LOG:?}" ;;
  env)
    [[ "\${2:-}" == "add" ]] || exit 2
    key="\${3:-}"
    value=""
    while (($#)); do
      if [[ "\${1:-}" == "--value" ]]; then value="\${2:-}"; shift 2; else shift; fi
    done
    printf '%s=%s\\n' "\$key" "\$value" >> "\${ENV_LOG:?}"
    [[ "\${VERCEL_ENV_FAIL:-}" != "\$key" ]]
    ;;
  *) exit 2 ;;
esac
`, { mode: 0o700 });
  writeFileSync(join(directory, "curl"), `#!/usr/bin/env bash
call_number=0
if [[ -f "\${CURL_LOG:?}" ]]; then call_number="$(wc -l < "\${CURL_LOG:?}")"; fi
printf '%s\\n' curl >> "\${CURL_LOG:?}"
output=/dev/null
while (($#)); do
  case "\${1:-}" in
    --output|-o) output="\${2:?}"; shift 2 ;;
    *) shift ;;
  esac
done
IFS=',' read -r -a statuses <<< "\${CURL_STATUS_SEQUENCE:-401,401}"
if (( call_number < \${#statuses[@]} )); then
  status="\${statuses[$call_number]}"
else
  status="\${statuses[\${#statuses[@]}-1]}"
fi
body=""
if [[ -n "\${CURL_BODY_SEQUENCE:-}" ]]; then
  IFS=',' read -r -a bodies <<< "\${CURL_BODY_SEQUENCE}"
  if (( call_number < \${#bodies[@]} )); then body="\${bodies[$call_number]}"; else body="\${bodies[\${#bodies[@]}-1]}"; fi
fi
[[ "$output" == /dev/null ]] || printf '%s' "$body" > "$output"
printf '%s' "$status"
`, { mode: 0o700 });
writeFileSync(join(directory, "npm"), `#!/usr/bin/env bash
printf '%s\\n' "\$*" >> "\${NPM_LOG:?}"
printf '%s\\n' npm >> "\${ORDER_LOG:?}"
[[ "\${NPM_FAIL:-}" != "true" ]]
`, { mode: 0o700 });
  writeFileSync(join(directory, "sleep"), `#!/usr/bin/env bash
printf 'sleep %s\\n' "\${1:-}" >> "\${SLEEP_LOG:?}"
printf '%s\\n' sleep >> "\${ORDER_LOG:?}"
[[ "\${SLEEP_FAIL:-}" != "true" ]]
`, { mode: 0o700 });
  return directory;
}

function runMocked(source: string, variables: Record<string, string>, body: string): string {
  const directory = mockBin();
  try {
    return execFileSync("bash", ["-c", `${source}\n${body}`], {
      encoding: "utf8",
      stdio: ["pipe", "pipe", "pipe"],
      env: {
        ...process.env,
        ...variables,
        PATH: `${directory}:${process.env.PATH ?? ""}`,
        DEPLOY_LOG: join(directory, "deploy.log"),
        PROMOTE_LOG: join(directory, "promote.log"),
        CURL_LOG: join(directory, "curl.log"),
        NPM_LOG: join(directory, "npm.log"),
        SLEEP_LOG: join(directory, "sleep.log"),
        ORDER_LOG: join(directory, "order.log"),
        ENV_LOG: join(directory, "env.log"),
        VERCEL_INSPECT_LOG: join(directory, "inspect.log"),
        MOCK_REPO_ROOT: root,
      },
    });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

function runMockedFailure(source: string, variables: Record<string, string>, body: string): { stderr: string; deploys: string; promotes: string; inspects: string; envs: string; curlCalls: number } {
  const directory = mockBin();
  try {
    try {
      execFileSync("bash", ["-c", `${source}\n${body}`], {
        encoding: "utf8",
        stdio: ["pipe", "pipe", "pipe"],
        env: {
          ...process.env,
          ...variables,
          PATH: `${directory}:${process.env.PATH ?? ""}`,
          DEPLOY_LOG: join(directory, "deploy.log"),
          PROMOTE_LOG: join(directory, "promote.log"),
          CURL_LOG: join(directory, "curl.log"),
          NPM_LOG: join(directory, "npm.log"),
          SLEEP_LOG: join(directory, "sleep.log"),
          ORDER_LOG: join(directory, "order.log"),
          ENV_LOG: join(directory, "env.log"),
          VERCEL_INSPECT_LOG: join(directory, "inspect.log"),
          MOCK_REPO_ROOT: root,
        },
      });
      throw new Error("expected mocked rollout failure");
    } catch (error) {
      if (error instanceof Error && error.message === "expected mocked rollout failure") throw error;
      const failure = error as { stderr?: string | Buffer };
      return {
        stderr: String(failure.stderr ?? ""),
        deploys: existsSync(join(directory, "deploy.log")) ? readFileSync(join(directory, "deploy.log"), "utf8") : "",
        promotes: existsSync(join(directory, "promote.log")) ? readFileSync(join(directory, "promote.log"), "utf8") : "",
        inspects: existsSync(join(directory, "inspect.log")) ? readFileSync(join(directory, "inspect.log"), "utf8") : "",
        envs: existsSync(join(directory, "env.log")) ? readFileSync(join(directory, "env.log"), "utf8") : "",
        curlCalls: existsSync(join(directory, "curl.log")) ? readFileSync(join(directory, "curl.log"), "utf8").trim().split("\n").filter(Boolean).length : 0,
      };
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

function baseScenario(): Record<string, string> {
  return {
    TARGET_SHA: "sha-reviewed",
    APP_BASE_URL: expectedOrigin,
    DEPLOY_JSON: JSON.stringify({ id: "dpl_valid", url: "https://candidate.example" }),
    INSPECT_JSON: JSON.stringify({ id: "dpl_valid", readyState: "READY", aliases: [] }),
    API_JSON: JSON.stringify({ id: "dpl_valid", readyState: "READY", target: "production", url: "https://candidate.example", meta: { githubCommitSha: "sha-reviewed" }, alias: [] }),
    CANONICAL_JSON: JSON.stringify({ id: "dpl_valid" }),
  };
}

function writeStopEvidence(deploymentId: string): Record<string, string | number> {
  const projection = {
    cacheControl: "private, no-store",
    code: "writes_stopped",
    deploymentId,
    expectedStatus: 503,
    observedAt: "2026-09-04T00:00:00Z",
    observedStatus: 503,
    retryAfter: "60",
    schemaVersion: 1,
  };
  return {
    ...projection,
    projectionSha256: createHash("sha256").update(JSON.stringify(projection)).digest("hex"),
  };
}

function aliasJson(alias: string): string {
  if (alias === "missing") return JSON.stringify({ id: "dpl_valid", readyState: "READY" });
  return JSON.stringify({ id: "dpl_valid", readyState: "READY", aliases: JSON.parse(alias) });
}

function ledgerSetupBlock(): string {
  const block = bashBlocks(rolloutSection()).find((candidate) =>
    normalize(candidate).includes('(set -o noclobber; : > "$LEDGER")'),
  );
  expect(block).toBeDefined();
  return block ?? "";
}

function regressionBlock(): string {
  const block = bashBlocks(rolloutSection()).find((candidate) =>
    normalize(candidate).includes('ROLLBACK_CANDIDATE_ID="$(stage_candidate "identity=1,writes=0")"'),
  );
  expect(block).toBeDefined();
  return block ?? "";
}

function normalResumeBlock(): string {
  const block = bashBlocks(rolloutSection()).find((candidate) =>
    normalize(candidate).includes("Normal PAUSED_AFTER_APPLY -> UNPAUSED_READONLY"),
  );
  expect(block).toBeDefined();
  return block ?? "";
}

function stageOneLedgerBlock(): string {
  const block = bashBlocks(rolloutSection()).find((candidate) =>
    normalize(candidate).includes('STAGE_ONE_LEDGER_TMP="$(mktemp "$EVIDENCE_ROOT/.rollout-ledger.stage1.XXXXXX")"'),
  );
  expect(block).toBeDefined();
  return block ?? "";
}

function stageOneWriteStopEvidenceBlock(): string {
  const block = bashBlocks(rolloutSection()).find((candidate) =>
    normalize(candidate).includes("STAGE_ONE_EVIDENCE_PROJECTION"),
  );
  expect(block).toBeDefined();
  return block ?? "";
}

describe("production rollout staged-candidate binding documentation contract", () => {
  it("keeps non-runbook documents design-level and fixes Settings wording", () => {
    const files = [
      {
        file: "README.md",
        statusTerms: [],
      },
      {
        file: "docs/superpowers/specs/2026-09-04-production-write-stop-rollout-design.md",
        statusTerms: ["design-level", "approved for implementation"],
      },
      {
        file: "docs/superpowers/specs/2026-09-03-production-recovery-and-identity-rollout-design.md",
        statusTerms: ["historical", "superseded"],
      },
      {
        file: "docs/superpowers/plans/2026-09-03-hosted-production-rollout.md",
        statusTerms: ["historical", "superseded"],
      },
    ];
    for (const { file, statusTerms } of files) {
      const filePath = join(root, file);
      const document = readFileSync(join(root, file), "utf8");
      const normalizedDocument = normalize(document).replace(/`/gu, "");
      const preamble = document.split(/\r?\n/u).slice(0, 24).join("\n");
      const normalizedPreamble = normalize(preamble).replace(/`/gu, "");
      const runbookHrefs = [...preamble.matchAll(
        /\[[^\]]+\]\(([^)\s]*production-runbook\.md(?:#[^)]+)?)\)/giu,
      )].map(([, href]) => href ?? "");
      const runbookHref = runbookHrefs.find((href) =>
        href.split("#", 1)[0]?.endsWith("production-runbook.md") &&
        href.split("#", 2)[1] === "application-identity-maintenance-rollout",
      );
      expect(runbookHref).toBeDefined();
      const [runbookPath, runbookAnchor] = (runbookHref ?? "").split("#");
      expect(resolve(dirname(filePath), runbookPath ?? "")).toBe(
        join(root, "docs/operations/production-runbook.md"),
      );
      expect(runbookAnchor).toBe("application-identity-maintenance-rollout");
      expect(document).toContain("first successful PUT /api/settings");
      expect(normalizedDocument).toMatch(
        /authenticated GET \/api\/settings is read-only and (?:never|does not) create(?:s)? the row/iu,
      );
      expect(document).not.toContain("authenticated GET /api/settings creates");
      expect(document).not.toMatch(/vercel api \/v13\/deployments\//u);
      expect(document).not.toMatch(/vercel promote "\$CANDIDATE_ID"/u);

      for (const statusTerm of statusTerms) {
        expect(normalizedPreamble.toLowerCase()).toContain(statusTerm.toLowerCase());
      }

      expect(executableVercelLines(document)).toEqual([]);
      expect(executableGhProductionLines(document)).toEqual([]);

      const heading = document.search(/^#{3,4} Rollout state and evidence summary\s*$/mu);
      expect(heading).not.toBe(-1);
      const bodyStart = document.indexOf("\n", heading) + 1;
      const nextHeading = document.slice(bodyStart).search(/^#{2,4} \S/mu);
      const summary = document.slice(
        bodyStart,
        nextHeading === -1 ? document.length : bodyStart + nextHeading,
      );
      const normalizedSummary = normalize(summary).replace(/`/gu, "");
      expectOrderedMatches(normalizedSummary, [
        /PAUSED_AFTER_APPLY/iu,
        /(?:failed|ambiguous)[^.]{0,100}HOLD_PAUSED/iu,
        /HOLD_PAUSED[^.]{0,180}no (?:build|deploy)[^.]{0,100}(?:alias|promotion)/iu,
      ]);
      expectOrderedMatches(normalizedSummary, [
        /(?:approval|approved)/iu,
        /exact recorded identity=1,writes=0/iu,
        /Ready deployment/iu,
        /UNPAUSED_READONLY/iu,
        /read-only/iu,
        /negative probes/iu,
      ]);
      const regressionOffset = normalizedSummary.search(/regression/iu);
      expect(regressionOffset).not.toBe(-1);
      const regressionSummary = normalizedSummary.slice(regressionOffset);
      expectOrderedMatches(regressionSummary, [
        /regression/iu,
        /Ready/iu,
        /candidate ID/iu,
        /reviewed SHA/iu,
        /(?:returns? to|return to) HOLD_PAUSED/iu,
      ]);
      expectOrderedMatches(normalizedSummary, [
        /private ledger/iu,
        /exact owned IDs/iu,
        /bounded cleanup/iu,
        /cleanup may remove only those IDs/iu,
      ]);
    }
  });

  it("keeps the historical hosted plan factual and requirement-scoped", () => {
    const plan = readFileSync(
      join(root, "docs/superpowers/plans/2026-09-03-hosted-production-rollout.md"),
      "utf8",
    );
    const factualText = plan.replace(/^>\s?/gmu, " ");
    expect(factualText).toMatch(/does not assert that any\s+Production action occurred/iu);
    expect(factualText).toMatch(/Each step states\s+what the plan required/iu);
    const historicalSteps = plan.slice(plan.indexOf("### Historical task 1"));

    const taskSections = [...plan.matchAll(/^### Historical task [1-6]:/gmu)];
    expect(taskSections).toHaveLength(6);
    for (const [index, match] of taskSections.entries()) {
      const start = match.index ?? -1;
      const end = taskSections[index + 1]?.index ?? plan.length;
      expect(start).toBeGreaterThanOrEqual(0);
      expect(plan.slice(start, end)).toMatch(/\b(?:plan|required|would have|acceptance|success criterion)\b/iu);
    }

    const forbiddenCompletionAssertions = [
      /\bThe rollout (?:integrated|created|completed|verified)\b/iu,
      /\bVercel was unpaused\b/iu,
      /\bThe historical record confirmed\b/iu,
      /\bThe historical plan (?:published|merged|dispatched)\b/iu,
      /\bThe historical transition resumed\b/iu,
      /(?:^|[.;]\s+)promotion occurred\b/iu,
      /\bThis was the final staged\b/iu,
      /\bThe final historical record contained\b/iu,
      /\bThe evidence recorded that external writers are resumed\b/iu,
      /\bThe historical (?:inspection|rehearsal|smoke) (?:used|decrypted|restored|covered)\b/iu,
    ];
    for (const assertion of forbiddenCompletionAssertions) {
      expect(historicalSteps).not.toMatch(assertion);
    }
  });

  it("rejects every executable Vercel invocation in fenced shell blocks", () => {
    const fixture = [
      "```bash\n# vercel deploy is only a comment\necho 'vercel deploy is only text'\nprintf '%s' 'vercel inspect is only text'\nvercel env add SECRET production --value test\n```",
      "```sh\n$ vercel alias rm example.vercel.app\ncandidate=$(vercel deploy .)\ncommand vercel inspect deployment-id\n```",
      "```shell\n  env FOO=1 vercel env add SECRET production\nFOO=1 vercel promote deployment-id\nresult=`vercel alias ls`\necho ready && vercel rm deployment-id\n```",
      "```shell\nprintf ready; vercel project ls\necho ready | vercel inspect deployment-id\n```",
      "```zsh\nvercel rollback deployment-id\n```",
      "```console\n$ vercel alias add example.vercel.app deployment-id\n```",
      "```\nFOO=1 vercel env rm SECRET production\n```",
      "```bash\nsudo -n vercel promote deployment-id\nnpx --yes vercel deploy .\nbash -lc \"vercel inspect deployment-id\"\nresult=$(bash -lc 'vercel alias ls')\n```",
    ].join("\n");

    expect(executableVercelLines(fixture)).toEqual([
      "vercel env add SECRET production --value test",
      "$ vercel alias rm example.vercel.app",
      "candidate=$(vercel deploy .)",
      "command vercel inspect deployment-id",
      "  env FOO=1 vercel env add SECRET production",
      "FOO=1 vercel promote deployment-id",
      "result=`vercel alias ls`",
      "echo ready && vercel rm deployment-id",
      "printf ready; vercel project ls",
      "echo ready | vercel inspect deployment-id",
      "vercel rollback deployment-id",
      "$ vercel alias add example.vercel.app deployment-id",
      "FOO=1 vercel env rm SECRET production",
      "sudo -n vercel promote deployment-id",
      "npx --yes vercel deploy .",
      "bash -lc \"vercel inspect deployment-id\"",
      "result=$(bash -lc 'vercel alias ls')",
    ]);
  });

  it("rejects indirect production workflow/run GitHub invocations", () => {
    const fixture = [
      "```bash\n# gh workflow run is only a comment\ngh workflow run production.yml --ref main\n```",
      "```sh\n$ gh run watch 123\ncandidate=$(gh workflow run production.yml)\ncommand gh run list --workflow production.yml\n```",
      "```shell\n  env GH_TOKEN=test gh run view 123\nGH_TOKEN=test gh run download 123\n```",
      "```zsh\n$ gh workflow run production.yml --ref main\n```",
      "```console\nGH_TOKEN=test gh run watch 123\n```",
      "```\nresult=$(gh run list --workflow production.yml)\n```",
      "```bash\nsudo -n gh run cancel 123\nbash -lc \"gh workflow run production.yml --ref main\"\nresult=$(sh -c 'gh run view 123')\n```",
    ].join("\n");

    expect(executableGhProductionLines(fixture)).toEqual([
      "gh workflow run production.yml --ref main",
      "$ gh run watch 123",
      "candidate=$(gh workflow run production.yml)",
      "command gh run list --workflow production.yml",
      "  env GH_TOKEN=test gh run view 123",
      "GH_TOKEN=test gh run download 123",
      "$ gh workflow run production.yml --ref main",
      "GH_TOKEN=test gh run watch 123",
      "result=$(gh run list --workflow production.yml)",
      "sudo -n gh run cancel 123",
      "bash -lc \"gh workflow run production.yml --ref main\"",
      "result=$(sh -c 'gh run view 123')",
    ]);
  });

  it("does not treat quoted echo/printf mentions as executable commands", () => {
    const fixture = [
      "```bash\necho \"bash -lc 'vercel deploy .'\"\nprintf '%s' \"gh workflow run production.yml\"\n```",
      "```console\necho '$(vercel inspect deployment-id)'\nprintf '%s' 'gh run view 123'\n```",
    ].join("\n");
    expect(executableVercelLines(fixture)).toEqual([]);
    expect(executableGhProductionLines(fixture)).toEqual([]);
  });

  it("distinguishes command-position paths and shell-wrapper flags", () => {
    const fixture = [
      "```bash\necho vercel deploy is prohibited\nprintf '%s\\n' vercel deploy\necho ready && /usr/local/bin/vercel deploy .\n\\vercel deploy .\n```",
      "```sh\nbash --noprofile -c 'vercel alias ls'\nenv bash -c \"gh workflow run production.yml --ref main\"\n```",
    ].join("\n");

    expect(executableVercelLines(fixture)).toEqual([
      "echo ready && /usr/local/bin/vercel deploy .",
      "\\vercel deploy .",
      "bash --noprofile -c 'vercel alias ls'",
    ]);
    expect(executableGhProductionLines(fixture)).toEqual([
      "env bash -c \"gh workflow run production.yml --ref main\"",
    ]);
  });

  it("scans every fence style and normalizes wrapper executable paths", () => {
    const fixture = [
      "```shell-session\necho vercel deploy is prose\n```",
      "````text\necho '%s\\n' vercel deploy\n/usr/local/bin/vercel deploy .\n````",
      "~~~terminal\n/usr/bin/env sh -c 'gh run view 1'\n~~~",
      "~~~zsh\n/bin/bash -c 'vercel deploy .'\n/usr/bin/zsh -c 'vercel inspect deployment-id'\n~~~",
      "~~~~fish\n/usr/bin/fish -c 'vercel alias ls'\n~~~~",
      "```text\nbusybox sh -c 'vercel rm deployment-id'\n```",
      "```powershell\n/usr/bin/pwsh -Command 'gh run list'\n/opt/powershell/powershell -Command 'gh run watch 1'\n```",
      "```cmd\n/usr/bin/cmd /c \"vercel inspect deployment-id\"\n```",
      "outside prose: vercel deploy and gh workflow run are not shell commands",
    ].join("\n");

    expect(executableVercelLines(fixture)).toEqual([
      "/usr/local/bin/vercel deploy .",
      "/bin/bash -c 'vercel deploy .'",
      "/usr/bin/zsh -c 'vercel inspect deployment-id'",
      "/usr/bin/fish -c 'vercel alias ls'",
      "busybox sh -c 'vercel rm deployment-id'",
      "/usr/bin/cmd /c \"vercel inspect deployment-id\"",
    ]);
    expect(executableGhProductionLines(fixture)).toEqual([
      "/usr/bin/env sh -c 'gh run view 1'",
      "/usr/bin/pwsh -Command 'gh run list'",
      "/opt/powershell/powershell -Command 'gh run watch 1'",
    ]);
  });

  it("normalizes Windows executable paths and PowerShell call operators", () => {
    const fixture = [
      "```powershell\nC:\\Tools\\vercel.exe deploy .\n\"C:\\Program Files\\Vercel\\vercel.cmd\" inspect deployment-id\nC:\\Tools\\gh.exe run view 1\nWrite-Output \"C:\\Tools\\vercel.exe deploy .\"\n& \"C:\\Tools\\vercel.exe\" alias ls\n```",
      "```cmd\nC:\\Windows\\System32\\cmd.exe /c \"vercel inspect deployment-id\"\nC:\\Windows\\System32\\pwsh.exe -Command \"gh run list\"\n```",
    ].join("\n");

    expect(executableVercelLines(fixture)).toEqual([
      "C:\\Tools\\vercel.exe deploy .",
      "\"C:\\Program Files\\Vercel\\vercel.cmd\" inspect deployment-id",
      "& \"C:\\Tools\\vercel.exe\" alias ls",
      "C:\\Windows\\System32\\cmd.exe /c \"vercel inspect deployment-id\"",
    ]);
    expect(executableGhProductionLines(fixture)).toEqual([
      "C:\\Tools\\gh.exe run view 1",
      "C:\\Windows\\System32\\pwsh.exe -Command \"gh run list\"",
    ]);
  });

  it("keeps the README maintenance section and historical plan non-executable", () => {
    expect(fencedShellBlocks(readmeMaintenanceSection())).toEqual([]);
    expect(readmeMaintenanceSection()).not.toMatch(
      /\bgh\s+(?:workflow\s+run|run\s+(?:list|view|watch|download|cancel|rerun))\b/iu,
    );
    const plan = readFileSync(
      join(root, "docs/superpowers/plans/2026-09-03-hosted-production-rollout.md"),
      "utf8",
    );
    expect(executableVercelLines(plan)).toEqual([]);
    expect(executableGhProductionLines(plan)).toEqual([]);
    const inlineOperationalRecipes = [...plan.matchAll(/`([^`\r\n]+)`/gu)]
      .map(([, code]) => code ?? "")
      .filter((code) => /^(?:(?:[A-Z_][A-Z0-9_]*=\S+)[ \t]+)*(?:git|gh|vercel|curl|npm|npx|node|docker|prisma|jq|chmod|mktemp|install|rm|mv|export|set|read|printf|echo)\b/iu.test(code));
    expect(inlineOperationalRecipes).toEqual([]);
  });

  it("binds candidate data flow with explicit guards and safe projections", () => {
    const section = rolloutSection();
    const procedureMatch = candidateFunction().match(/stage_candidate\(\) \(([\s\S]*?)\n\)/u);
    const procedure = procedureMatch?.[1] ?? "";
    const lines = procedure.split("\n").map((line) => line.trim()).filter(Boolean);
    expect(procedure).toContain("stage_name");
    expect(procedure).toContain('local CANDIDATE_DEPLOYMENT="" CANDIDATE_INSPECT="" CANDIDATE_METADATA="" CANONICAL_METADATA=""');
    expect(procedure).toContain('local CANDIDATE_ID="" CANDIDATE_URL=""');
    expect(procedure).not.toContain("trap");

    const deploy = oneLine(lines, /^CANDIDATE_DEPLOYMENT="\$\(vercel deploy /u);
    const id = oneLine(lines, /^CANDIDATE_ID="\$\(jq -er /u);
    const url = oneLine(lines, /^CANDIDATE_URL="\$\(jq -er /u);
    const inspect = oneLine(lines, /^CANDIDATE_INSPECT="\$\(vercel inspect /u);
    const inspectCheck = oneLine(lines, /^jq -e --arg id .*\.aliases .*CANDIDATE_INSPECT/u);
    const api = oneLine(lines, /^CANDIDATE_METADATA="\$\(vercel api /u);
    const metadataCheck = oneLine(lines, /^jq -e --arg id .*--arg sha /u);
    const promote = oneLine(lines, /^vercel promote /u);
    const canonical = oneLine(lines, /^CANONICAL_METADATA="\$\(vercel inspect /u);
    const canonicalCheck = oneLine(lines, /^jq -e --arg id "\$CANDIDATE_ID" '\.id == \$id'/u);

    expect(deploy).toContain("vercel deploy . --prod --skip-domain --yes --format=json --no-color | jq -ce '{id,url}'");
    expect(id).toContain('<<<"$CANDIDATE_DEPLOYMENT")"');
    expect(url).toContain('<<<"$CANDIDATE_DEPLOYMENT")"');
    expect(inspect).toContain('vercel inspect "$CANDIDATE_ID" --wait');
    expect(inspect).toContain("| jq -ce '{id,readyState,aliases}'");
    expect(inspectCheck).toContain(aliasPredicate);
    expect(api).toContain('vercel api "/v13/deployments/$CANDIDATE_ID" --raw | jq -ce');
    expect(api).toContain("if (.alias | type) == \"array\" then");
    expect(api).toContain("{id,readyState,target,url,githubCommitSha:.meta.githubCommitSha,aliases:(.alias//[])}");
    expect(metadataCheck).toContain(aliasPredicate);
    expect(metadataCheck).toContain('--arg sha "$TARGET_SHA"');
    expect(metadataCheck).toContain('--arg url "$CANDIDATE_URL"');
    expect(metadataCheck).toContain('.target == "production"');
    expect(metadataCheck).toContain(".githubCommitSha == $sha");
    expect(promote).toBe('vercel promote "$CANDIDATE_ID" --yes >/dev/null || return 1');
    expect(canonical).toContain('vercel inspect "$APP_BASE_URL"');
    expect(canonical).toContain("| jq -ce '{id}'");
    expect(canonicalCheck).toContain('--arg id "$CANDIDATE_ID"');

    const liveChecks = lines.filter((line) => line === 'assert_canonical_unpaused "$APP_BASE_URL" || return 1');
    expect(liveChecks).toHaveLength(2);
    expect(procedure).toContain("curl --silent --show-error --output /dev/null --write-out '%{http_code}' --connect-timeout 5 --max-time 15");
    expect(procedure).not.toContain("VERCEL_UNPAUSED_ATTESTED");
    expectOrdered(procedure, [
      '[[ "$stage_name" == "identity=1,writes=0" || "$stage_name" == "identity=1,writes=1" ]] || return 1',
      '[[ -n "${TARGET_SHA:-}" ]] || return 1',
      '[[ -n "${APP_BASE_URL:-}" ]] || return 1',
      '[[ "$APP_BASE_URL" == "$EXPECTED_PRODUCTION_ORIGIN" ]] || return 1',
      'WORKTREE_STATUS="$(git status --porcelain)" || return 1',
      'CURRENT_SHA="$(git rev-parse HEAD)" || return 1',
      'assert_canonical_unpaused "$APP_BASE_URL" || return 1',
      deploy,
      id,
      url,
      inspect,
      inspectCheck,
      api,
      metadataCheck,
      'assert_canonical_unpaused "$APP_BASE_URL" || return 1',
      promote,
      canonical,
      canonicalCheck,
      'printf \'%s\\n\' "$CANDIDATE_ID" || return 1',
    ]);
    for (const command of [deploy, id, url, inspect, inspectCheck, api, metadataCheck, promote, canonical, canonicalCheck]) {
      expect(command).toMatch(/\|\| return 1$/u);
    }
    expect(procedure).not.toContain("CANDIDATE_JSON");
    expect(candidateFunction()).not.toMatch(/^\s*export\s+CANDIDATE_/mu);

    const pauseStart = section.indexOf("4. Pause Vercel Production");
    const resumeStart = section.indexOf("8. Resume Vercel Production", pauseStart);
    const paused = section.slice(pauseStart, resumeStart);
    expect(paused).toContain("fresh canonical-origin check before each deploy and promotion");
    expect(paused).not.toContain("VERCEL_UNPAUSED_ATTESTED");
    for (const block of bashBlocks(paused)) expect(block).not.toMatch(/\bvercel\s+(?:deploy|promote|alias)\b/iu);
  });

  it("uses the same guarded procedure for both stage calls", () => {
    const section = rolloutSection();
    const pauseStart = section.indexOf("4. Pause Vercel Production");
    const resumeStart = section.indexOf("8. Resume Vercel Production", pauseStart);
    const stageOne = section.indexOf('STAGE_ONE_CANDIDATE_ID="$(stage_candidate "identity=1,writes=0")" || exit 1');
    const final = section.indexOf('FINAL_CANDIDATE_ID="$(stage_candidate "identity=1,writes=1")" || exit 1');
    expect(stageOne).toBeGreaterThan(-1);
    expect(stageOne).toBeLessThan(pauseStart);
    expect(final).toBeGreaterThan(resumeStart);
    expect(section.match(/stage_candidate "identity=1,writes=(?:0|1)"/gu)).toHaveLength(3);
    const rollback = section.indexOf('stage_candidate "identity=1,writes=0"', resumeStart);
    expect(rollback).toBeGreaterThan(resumeStart);
    expect(rollback).toBeLessThan(final);
    expect(section.match(/vercel deploy \. --prod --skip-domain --yes --format=json --no-color/gu)).toHaveLength(2);
  });

  it("promotes the strict support candidate after ledger setup and before Stage 1", () => {
    const section = rolloutSection();
    const ledger = section.indexOf('(set -o noclobber; : > "$LEDGER")');
    const support = section.indexOf('SUPPORT_CANDIDATE_ID="$(support_candidate "identity=0,writes=1")"');
    const fixtureProof = section.indexOf("successful authenticated owned-fixture creation");
    const stageOne = section.indexOf('STAGE_ONE_CANDIDATE_ID="$(stage_candidate "identity=1,writes=0")"');
    expect(ledger).toBeGreaterThan(-1);
    expect(support).toBeGreaterThan(ledger);
    expect(fixtureProof).toBeGreaterThan(support);
    expect(stageOne).toBeGreaterThan(support);
    expect(fixtureProof).toBeLessThan(stageOne);
    expect(section.match(/support_candidate "identity=0,writes=1"/gu)).toHaveLength(1);

    const supportBlock = supportGateBlock();
    expect(supportBlock).toContain('vercel env add APPLICATION_IDENTITY_WRITES_ENABLED production --value "0" --yes --force || exit 1');
    expect(supportBlock).toContain('vercel env add APPLICATION_WRITES_ENABLED production --value "1" --yes --force || exit 1');
    expect(supportBlock).toContain('support_candidate "identity=0,writes=1"');
    expect(normalize(section)).toMatch(/private ledger exists[^.]*before creating or using any fixture[^.]*stage and promote the canonical support deployment/iu);
    expect(normalize(section)).toMatch(/exact promoted ID owns the canonical alias/iu);
  });

  it("keeps support_candidate strict and fails closed before promotion", () => {
    const source = supportFunction();
    expect(source).toContain('[[ "$stage_name" == "identity=0,writes=1" ]] || return 1');
    expect(source).not.toContain('identity=1,writes=0" || "$stage_name" == "identity=1,writes=1');

    const invalid: Array<Record<string, string>> = [
      { DIRTY_STATUS: " M docs/operations/production-runbook.md" },
      { MOCK_CURRENT_SHA: "sha-other" },
      { INSPECT_JSON: JSON.stringify({ id: "dpl_valid", readyState: "BUILDING", aliases: [] }) },
      { INSPECT_JSON: JSON.stringify({ id: "dpl_other", readyState: "READY", aliases: [] }) },
      { API_JSON: JSON.stringify({ id: "dpl_valid", readyState: "READY", target: "preview", url: "https://candidate.example", meta: { githubCommitSha: "sha-reviewed" }, alias: [] }) },
      { API_JSON: JSON.stringify({ id: "dpl_valid", readyState: "READY", target: "production", url: "https://candidate.example", meta: { githubCommitSha: "sha-other" }, alias: [] }) },
      { API_JSON: JSON.stringify({ id: "dpl_valid", readyState: "READY", target: "production", url: "https://other.example", meta: { githubCommitSha: "sha-reviewed" }, alias: [] }) },
      { DEPLOY_JSON: JSON.stringify({ id: "dpl_other", url: "https://candidate.example" }) },
      { API_JSON: JSON.stringify({ id: "dpl_valid", readyState: "READY", target: "production", url: "https://candidate.example", meta: { githubCommitSha: "sha-reviewed" }, alias: ["canonical.example"] }) },
    ];
    for (const stage of ["", "identity=0,writes=0", "identity=1,writes=0", "identity=1,writes=1"]) {
      invalid.push({ SUPPORT_STAGE: stage });
    }

    for (const overrides of invalid) {
      const stage = overrides.SUPPORT_STAGE ?? "identity=0,writes=1";
      const variables = { ...baseScenario(), ...overrides };
      delete variables.SUPPORT_STAGE;
      expect(runMocked(source, variables, `if support_candidate "${stage}"; then exit 81; fi
[[ ! -s "\${PROMOTE_LOG:?}" ]] || exit 82`)).toBe("");
    }

    expect(runMocked(source, baseScenario(), `captured="\$(support_candidate "identity=0,writes=1")" || exit 84
[[ "\$captured" == "dpl_valid" ]] || exit 85
[[ "\$(wc -l < "\${PROMOTE_LOG:?}")" -eq 1 ]] || exit 86
[[ "\$(sed -n '1p' "\${PROMOTE_LOG:?}")" == "dpl_valid" ]] || exit 87`)).toBe("");
  });

  it("executes both support gates before staging and stops on either gate failure", () => {
    const source = `${supportFunction()}\n${supportGateBlock()}`;
    const expectedEnv = "APPLICATION_IDENTITY_WRITES_ENABLED=0\nAPPLICATION_WRITES_ENABLED=1\n";
    const expectedEnvShell = "APPLICATION_IDENTITY_WRITES_ENABLED=0\\nAPPLICATION_WRITES_ENABLED=1";
    expect(runMocked(source, baseScenario(), `[[ "\$(cat "\${ENV_LOG:?}")" == $'${expectedEnvShell}' ]] || exit 88
[[ "\$(cat "\${PROMOTE_LOG:?}")" == "dpl_valid" ]] || exit 89`)).toBe("");

    for (const [key, expectedEnvLog] of [
      ["APPLICATION_IDENTITY_WRITES_ENABLED", "APPLICATION_IDENTITY_WRITES_ENABLED=0\n"],
      ["APPLICATION_WRITES_ENABLED", expectedEnv],
    ] as const) {
      const failure = runMockedFailure(source, { ...baseScenario(), VERCEL_ENV_FAIL: key }, "");
      expect(failure.envs).toBe(expectedEnvLog);
      expect(failure.deploys).toBe("");
      expect(failure.promotes).toBe("");
    }
  });

  it("fails closed under mocked responses and isolates projections", () => {
    const source = candidateFunction();
    const noLeak = `for name in CANDIDATE_DEPLOYMENT CANDIDATE_INSPECT CANDIDATE_METADATA CANONICAL_METADATA CANDIDATE_ID CANDIDATE_URL; do [[ -z "\${!name+x}" ]] || exit 60; done
[[ ! -s "\${PROMOTE_LOG:?}" ]] || exit 61
`;
    const invalid: Array<Record<string, string>> = [
      { INSPECT_JSON: JSON.stringify({ id: "dpl_valid", readyState: "BUILDING", aliases: [] }) },
      { INSPECT_JSON: JSON.stringify({ id: "dpl_other", readyState: "READY", aliases: [] }) },
      { API_JSON: JSON.stringify({ id: "dpl_valid", readyState: "READY", target: "production", url: "https://candidate.example", meta: { githubCommitSha: "wrong" }, alias: [] }) },
    ];
    for (const alias of ["\"\"", "false", "null", "missing"]) {
      invalid.push({ INSPECT_JSON: aliasJson(alias) });
      invalid.push({ API_JSON: JSON.stringify({ id: "dpl_valid", readyState: "READY", target: "production", url: "https://candidate.example", meta: { githubCommitSha: "sha-reviewed" }, ...(alias === "missing" ? {} : { alias: JSON.parse(alias) }) }) });
    }
    for (const overrides of invalid) expect(runMocked(source, { ...baseScenario(), ...overrides }, `if stage_candidate "identity=1,writes=0"; then exit 59; fi
${noLeak}`)).toBe("");
    expect(runMocked(source, baseScenario(), `captured="$(stage_candidate "identity=1,writes=0")" || exit 62
[[ "$captured" == "dpl_valid" ]] || exit 63
[[ "$(wc -l < "\${PROMOTE_LOG:?}")" -eq 1 ]] || exit 64
[[ "$(sed -n '1p' "\${PROMOTE_LOG:?}")" == "dpl_valid" ]] || exit 65
${noLeak.replace("[[ ! -s", "[[ -s")}`)).toBe("");
    expect(runMocked(source, { ...baseScenario(), APP_BASE_URL: "https://preview.example" }, `if stage_candidate "identity=1,writes=0"; then exit 66; fi
[[ ! -s "\${DEPLOY_LOG:?}" ]] || exit 67
    [[ ! -s "\${PROMOTE_LOG:?}" ]] || exit 68`)).toBe("");
  });

  it("requires fresh live canonical status before deploy and promotion", () => {
    const helpers = [
      { source: candidateFunction(), invocation: 'stage_candidate "identity=1,writes=0"' },
      { source: supportFunction(), invocation: 'support_candidate "identity=0,writes=1"' },
    ];
    for (const [index, helper] of helpers.entries()) {
      const offset = index * 10;
      const staleAttestation = { ...baseScenario(), VERCEL_UNPAUSED_ATTESTED: "true", CURL_STATUS_SEQUENCE: "503,401" };
      expect(runMocked(helper.source, staleAttestation, `
if ${helper.invocation}; then exit ${69 + offset}; fi
[[ ! -s "\${DEPLOY_LOG:?}" ]] || exit ${70 + offset}
[[ ! -s "\${PROMOTE_LOG:?}" ]] || exit ${71 + offset}
[[ "\$(wc -l < "\${CURL_LOG:?}")" -eq 1 ]] || exit ${72 + offset}`)).toBe("");

      const pausesAfterInspect = { ...baseScenario(), VERCEL_UNPAUSED_ATTESTED: "true", CURL_STATUS_SEQUENCE: "401,503" };
      expect(runMocked(helper.source, pausesAfterInspect, `
if ${helper.invocation}; then exit ${73 + offset}; fi
[[ -s "\${DEPLOY_LOG:?}" ]] || exit ${74 + offset}
[[ ! -s "\${PROMOTE_LOG:?}" ]] || exit ${75 + offset}
[[ "\$(wc -l < "\${CURL_LOG:?}")" -eq 2 ]] || exit ${76 + offset}`)).toBe("");

      expect(runMocked(helper.source, { ...baseScenario(), CURL_STATUS_SEQUENCE: "401,401" }, `
captured="\$(${helper.invocation})" || exit ${77 + offset}
[[ "\$captured" == "dpl_valid" ]] || exit ${78 + offset}
[[ "\$(wc -l < "\${CURL_LOG:?}")" -eq 2 ]] || exit ${79 + offset}`)).toBe("");
    }
  });

  it("binds paused-after-apply rollback to the recorded identity-aware deployment", () => {
    const section = rolloutSection();
    const apply = section.indexOf('gh run watch "$APPLY_RUN_ID" --exit-status');
    const paused = section.indexOf("PAUSED_AFTER_APPLY", apply);
    const hold = section.indexOf("HOLD_PAUSED", paused);
    const readonly = section.indexOf("Evidence approval resumes", hold);
    const regression = section.indexOf("regression", readonly);
    expect(apply).toBeGreaterThan(-1);
    expect(paused).toBeGreaterThan(apply);
    expect(hold).toBeGreaterThan(paused);
    expect(readonly).toBeGreaterThan(hold);
    expect(regression).toBeGreaterThan(readonly);

    const pausedState = section.slice(paused, hold);
    expect(pausedState).toContain("apply completed");
    expect(pausedState).toContain("project is paused");
    expect(pausedState).toContain('identity=1,writes=0');
    expect(pausedState).toMatch(/recorded[^.\n]*Stage 1[^.\n]*deployment[^.\n]*Ready/iu);
    expect(pausedState).toContain("apply, migration, schema, identity, and private fixture evidence");

    const holdState = section.slice(hold, readonly);
    expect(section.slice(paused, readonly)).toContain("missing or ambiguous");
    expect(holdState).toContain("writers stopped");
    expect(holdState).toMatch(/no (?:build, )?deploy, alias, or promote/iu);
    expect(holdState).toContain("preserve");

    const resumeState = section.slice(readonly, regression);
    expect(normalize(resumeState)).toMatch(/resume[^.]*recorded[^.]*same-identity[^.]*exact[^.]*deployment[^.]*without redeploy/iu);
    expect(resumeState).toContain("read-only");
    expect(resumeState).toContain("deployment ID");
    expect(resumeState).toContain("negative probes");
    expect(resumeState).not.toMatch(/vercel\s+(?:build|deploy|alias|promote)/iu);

    const regressionState = section.slice(regression);
    expect(regressionState).toContain('stage_candidate "identity=1,writes=0"');
    expect(normalize(regressionState)).toContain("Ready, inspected Production candidate");
    expect(normalize(regressionState)).toContain("reviewed compatible exact SHA and exact ID");
    expect(regressionState).toContain("only while unpaused");
    expect(regressionState).toContain("drain");
    expect(regressionState).toContain("at least 60 seconds");
    expect(regressionState).toContain("If absent");
    expect(regressionState).toContain("HOLD_PAUSED");

    expect(normalize(section)).toMatch(/never resume[^.]*identity-unaware[^.]*pre-apply[^.]*remembered URL[^.]*environment[^.]*claim/iu);
    expect(normalize(section)).toMatch(/never enable writers merely to recover/iu);
    expect(normalize(section)).toMatch(/no state[^.]*permits promotion while paused/iu);
    expect(section.match(/vercel\s+promote\b/giu)).toHaveLength(2);

    expectOrdered(section, [
      "PAUSED_AFTER_APPLY -> UNPAUSED_READONLY",
      "PAUSED_AFTER_APPLY -> HOLD_PAUSED",
      "UNPAUSED_READONLY -> HOLD_PAUSED",
    ]);
  });

  it("makes post-resume regression recovery executable and fail closed", () => {
    const block = regressionBlock();
    const normalizedBlock = normalize(block);
    expectOrdered(normalizedBlock, [
      "validate_stage1_write_stop_selector || enter_hold_paused",
      'ROLLBACK_CANDIDATE_ID="$(stage_candidate "identity=1,writes=0")"',
      "sleep 60",
      'READONLY_STATUS="$(curl',
      "check:production:writes-stopped",
      'unset ROLLBACK_READ_TOKEN',
    ]);
    expect(normalizedBlock).toContain("POST_RESUME_REGRESSION_CONFIRMED");
    expect(normalizedBlock).not.toContain("VERCEL_UNPAUSED_ATTESTED");
    expect(normalizedBlock).not.toContain("NEGATIVE_STATUS");
  });

  it("executes PAUSED_AFTER_APPLY to UNPAUSED_READONLY through the exact recorded selector", () => {
    const temporaryRoot = mkdtempSync(join(tmpdir(), "production-rollout-normal-resume-"));
    try {
      writeFileSync(join(temporaryRoot, "rollout-ledger.json"), JSON.stringify({
        schemaVersion: 1,
        fixtureOwnership: {
          applicationIds: ["app_owned"], ownedDeploymentIds: ["dpl_valid"], preProbeHash: "before", postProbeHash: "after",
          settings: { existedBefore: true, contentHashBefore: "before", contentHashAfter: "after" },
          pairingGrantIds: ["grant"], pairing: { preStopUnconsumedGrantId: "grant", codeReference: "code-ref" },
          installation: { credentialReference: "credential-ref", installationId: "installation" },
          cleanup: [{ action: "revoke_installation", targetId: "installation", expectedTerminalState: "401", timestamp: "2026-09-04T00:00:00Z", observedResult: "pending" }],
        },
        stage1: {
          deploymentId: "dpl_valid", targetSha: "sha-reviewed", gates: { identity: "1", writes: "0" }, reviewedGateConfig: { identity: "1", writes: "0", reviewedAt: "2026-09-04T00:00:00Z" },
          ready: true, readyState: "READY", readyEvidence: { deploymentId: "dpl_valid", state: "READY", observedAt: "2026-09-04T00:00:00Z" },
          canonicalPromotionVerified: true, canonicalPromotion: { origin: expectedOrigin, deploymentId: "dpl_valid", verified: true, verifiedAt: "2026-09-04T00:00:00Z" },
          compatibilityVerified: true, timestamps: { recordedAt: "2026-09-04T00:00:00Z", readyObservedAt: "2026-09-04T00:00:00Z", canonicalPromotionVerifiedAt: "2026-09-04T00:00:00Z" }, writeStopEvidence: writeStopEvidence("dpl_valid"),
        },
      }), { mode: 0o600 });
      const source = `${candidateFunction()}\n${normalResumeBlock().replace(/^[ \t]*read -r -p .*$/gmu, "     :")}\n[[ "$(cat \"$NPM_LOG\")" == "run check:production:writes-stopped" ]] || exit 90\n[[ ! -s "$DEPLOY_LOG" && ! -s "$PROMOTE_LOG" ]] || exit 91`;
      expect(runMocked(source, { ...baseScenario(), EVIDENCE_ROOT: temporaryRoot, ROLLBACK_READ_TOKEN: "private-test-token", CURL_STATUS_SEQUENCE: "401,200" }, "")).toBe("");
    } finally {
      rmSync(temporaryRoot, { recursive: true, force: true });
    }
  });

  it("requires observed provider pause evidence before HOLD_PAUSED on missing evidence or a failed probe", () => {
    const testableBlock = regressionBlock()
      .replace(/^[ \t]*read -r -p 'After the provider pause is complete, press Enter: ' _ <\/dev\/tty \|\| return 1$/mu, "     :")
      .replace(/   # Normal PAUSED_AFTER_APPLY -> UNPAUSED_READONLY:[\s\S]*?   validate_stage1_write_stop_selector \|\| enter_hold_paused\n\n/u, "")
    const helperBlock = normalResumeBlock().slice(0, normalResumeBlock().indexOf("validate_stage1_write_stop_selector || enter_hold_paused"))
      .replace(/^[ \t]*read -r -p 'After the provider pause is complete, press Enter: ' _ <\/dev\/tty \|\| return 1$/mu, "     :");
    const source = `${candidateFunction()}\n${helperBlock}\n${testableBlock}`;
    const temporaryRoot = mkdtempSync(join(tmpdir(), "production-rollout-regression-"));
    try {
      const missingEvidence = runMockedFailure(source, {
        ...baseScenario(),
        POST_RESUME_REGRESSION_CONFIRMED: "true",
        EVIDENCE_ROOT: temporaryRoot,
        CURL_STATUS_SEQUENCE: "503",
        CURL_BODY_SEQUENCE: "DEPLOYMENT_PAUSED",
      }, "");
      expect(missingEvidence.stderr).toContain("HOLD_PAUSED");
      expect(missingEvidence.deploys).toBe("");
      expect(missingEvidence.promotes).toBe("");
      expect(missingEvidence.curlCalls).toBe(1);

      writeFileSync(join(temporaryRoot, "rollout-ledger.json"), JSON.stringify({
        schemaVersion: 1,
        stage1: {
          deploymentId: "dpl_valid",
          targetSha: "sha-reviewed",
          gates: { identity: "1", writes: "0" },
          reviewedGateConfig: { identity: "1", writes: "0", reviewedAt: "2026-09-04T00:00:00Z" },
          ready: true,
          readyState: "READY",
          readyEvidence: { deploymentId: "dpl_valid", state: "READY", observedAt: "2026-09-04T00:00:00Z" },
          canonicalPromotionVerified: true,
          canonicalPromotion: { origin: expectedOrigin, deploymentId: "dpl_valid", verified: true, verifiedAt: "2026-09-04T00:00:00Z" },
          compatibilityVerified: true,
          timestamps: { recordedAt: "2026-09-04T00:00:00Z", readyObservedAt: "2026-09-04T00:00:00Z", canonicalPromotionVerifiedAt: "2026-09-04T00:00:00Z" },
          writeStopEvidence: writeStopEvidence("dpl_valid"),
        },
      }), { mode: 0o600 });
      expect(runMocked(source, {
        ...baseScenario(),
        POST_RESUME_REGRESSION_CONFIRMED: "true",
        EVIDENCE_ROOT: temporaryRoot,
        ROLLBACK_READ_TOKEN: "private-test-token",
        CURL_STATUS_SEQUENCE: "401,401,200",
      }, '[[ "$(cat "$NPM_LOG")" == "run check:production:writes-stopped" ]] || exit 92')).toBe("");

      const unchangedLedger = readFileSync(join(temporaryRoot, "rollout-ledger.json"), "utf8");
      const failedProbe = runMockedFailure(source, {
        ...baseScenario(),
        POST_RESUME_REGRESSION_CONFIRMED: "true",
        EVIDENCE_ROOT: temporaryRoot,
        ROLLBACK_READ_TOKEN: "private-test-token",
        NPM_FAIL: "true",
        CURL_STATUS_SEQUENCE: "401,401,200,503",
        CURL_BODY_SEQUENCE: "ignored,ignored,ignored,DEPLOYMENT_PAUSED",
      }, "");
      expect(failedProbe.stderr).toContain("HOLD_PAUSED");
      expect(failedProbe.deploys).toBe("deploy\n");
      expect(failedProbe.promotes).toBe("dpl_valid\n");
      expect(failedProbe.curlCalls).toBe(4);
      expect(readFileSync(join(temporaryRoot, "rollout-ledger.json"), "utf8")).toBe(unchangedLedger);
    } finally {
      rmSync(temporaryRoot, { recursive: true, force: true });
    }
  });

  it("writes the Stage 1 ledger schema that the resume and rollback gate consumes", () => {
    const block = stageOneLedgerBlock();
    const temporaryRoot = mkdtempSync(join(tmpdir(), "production-rollout-stage1-ledger-"));
    try {
      const ledger = join(temporaryRoot, "rollout-ledger.json");
      const preStageLedger = {
        schemaVersion: 1,
        fixtureOwnership: {
          applicationIds: ["app_fixture_1", "app_fixture_2"],
          ownedDeploymentIds: ["dpl_fixture_1"],
          pairingGrantIds: ["grant_fixture"],
          preProbeHash: "sha256:before",
          postProbeHash: "sha256:after",
          settings: { existedBefore: true, contentHashBefore: "sha256:settings-before", contentHashAfter: "sha256:settings-after" },
          pairing: { preStopUnconsumedGrantId: "grant_fixture", codeReference: "private-code-ref" },
          installation: { credentialReference: "private-credential-ref", installationId: "installation_fixture" },
          cleanup: [{ action: "revoke_installation", targetId: "installation_fixture", expectedTerminalState: "401", timestamp: "2026-09-04T00:00:00Z", observedResult: "pending" }],
        },
        extraPrivateRecord: { nested: ["preserve", { every: "value" }] },
      };
      writeFileSync(ledger, JSON.stringify(preStageLedger), { mode: 0o600 });
      execFileSync("bash", ["-c", block], {
        env: {
          ...process.env,
          EVIDENCE_ROOT: temporaryRoot,
          LEDGER: ledger,
          TARGET_SHA: "sha-reviewed",
          APP_BASE_URL: expectedOrigin,
          STAGE_ONE_CANDIDATE_ID: "dpl_stageone",
        },
        stdio: ["pipe", "pipe", "pipe"],
      });
      const record = JSON.parse(readFileSync(ledger, "utf8"));
      expect(record.fixtureOwnership).toEqual(preStageLedger.fixtureOwnership);
      expect(record.extraPrivateRecord).toEqual(preStageLedger.extraPrivateRecord);
      expect(record).toMatchObject({
        schemaVersion: 1,
        stage1: {
          deploymentId: "dpl_stageone",
          targetSha: "sha-reviewed",
          gates: { identity: "1", writes: "0" },
          ready: true,
          readyState: "READY",
          canonicalPromotionVerified: true,
          compatibilityVerified: true,
        },
      });
      expect(record.stage1.canonicalPromotion).toMatchObject({
        origin: expectedOrigin,
        deploymentId: "dpl_stageone",
        verified: true,
      });
      expect(record.stage1.timestamps.readyObservedAt).toEqual(expect.any(String));
      expect(record.stage1.timestamps.canonicalPromotionVerifiedAt).toEqual(expect.any(String));
      expect(statSync(ledger).mode & 0o777).toBe(0o600);

      expect(() => execFileSync("bash", ["-c", block], {
        env: {
          ...process.env,
          EVIDENCE_ROOT: temporaryRoot,
          LEDGER: ledger,
          TARGET_SHA: "sha-reviewed",
          APP_BASE_URL: expectedOrigin,
          STAGE_ONE_CANDIDATE_ID: "not-a-deployment",
        },
        stdio: ["pipe", "pipe", "pipe"],
      })).toThrow();

      const invalidLedger = "{not-valid-json";
      writeFileSync(ledger, invalidLedger, { mode: 0o600 });
      expect(() => execFileSync("bash", ["-c", block], {
        env: {
          ...process.env,
          EVIDENCE_ROOT: temporaryRoot,
          LEDGER: ledger,
          TARGET_SHA: "sha-reviewed",
          APP_BASE_URL: expectedOrigin,
          STAGE_ONE_CANDIDATE_ID: "dpl_stageone",
        },
        stdio: ["pipe", "pipe", "pipe"],
      })).toThrow();
      expect(readFileSync(ledger, "utf8")).toBe(invalidLedger);

      const nonObjectLedger = JSON.stringify(["not", "a", "ledger"]);
      writeFileSync(ledger, nonObjectLedger, { mode: 0o600 });
      expect(() => execFileSync("bash", ["-c", block], {
        env: {
          ...process.env,
          EVIDENCE_ROOT: temporaryRoot,
          LEDGER: ledger,
          TARGET_SHA: "sha-reviewed",
          APP_BASE_URL: expectedOrigin,
          STAGE_ONE_CANDIDATE_ID: "dpl_stageone",
        },
        stdio: ["pipe", "pipe", "pipe"],
      })).toThrow();
      expect(readFileSync(ledger, "utf8")).toBe(nonObjectLedger);

      writeFileSync(ledger, JSON.stringify(preStageLedger), { mode: 0o600 });
      chmodSync(ledger, 0o644);
      expect(() => execFileSync("bash", ["-c", block], {
        env: {
          ...process.env,
          EVIDENCE_ROOT: temporaryRoot,
          LEDGER: ledger,
          TARGET_SHA: "sha-reviewed",
          APP_BASE_URL: expectedOrigin,
          STAGE_ONE_CANDIDATE_ID: "dpl_stageone",
        },
        stdio: ["pipe", "pipe", "pipe"],
      })).toThrow();
      expect(JSON.parse(readFileSync(ledger, "utf8"))).toEqual(preStageLedger);

      writeFileSync(ledger, JSON.stringify({ ...preStageLedger, stage1: { deploymentId: "dpl_existing" } }), { mode: 0o600 });
      chmodSync(ledger, 0o600);
      expect(() => execFileSync("bash", ["-c", block], {
        env: {
          ...process.env,
          EVIDENCE_ROOT: temporaryRoot,
          LEDGER: ledger,
          TARGET_SHA: "sha-reviewed",
          APP_BASE_URL: expectedOrigin,
          STAGE_ONE_CANDIDATE_ID: "dpl_stageone",
        },
        stdio: ["pipe", "pipe", "pipe"],
      })).toThrow();
      expect(JSON.parse(readFileSync(ledger, "utf8"))).toEqual({ ...preStageLedger, stage1: { deploymentId: "dpl_existing" } });

      for (const malformedLedger of [
        { ...preStageLedger, fixtureOwnership: { ...preStageLedger.fixtureOwnership, applicationIds: [null] } },
        { ...preStageLedger, fixtureOwnership: { ...preStageLedger.fixtureOwnership, applicationIds: [""] } },
        { ...preStageLedger, fixtureOwnership: { ...preStageLedger.fixtureOwnership, pairingGrantIds: [17] } },
        { ...preStageLedger, fixtureOwnership: { ...preStageLedger.fixtureOwnership, applicationIds: ["app_fixture_1", "app_fixture_1"] } },
        { ...preStageLedger, fixtureOwnership: { ...preStageLedger.fixtureOwnership, pairingGrantIds: ["grant_fixture", "grant_fixture"] } },
        { ...preStageLedger, fixtureOwnership: { ...preStageLedger.fixtureOwnership, installationIds: ["installation_fixture", "installation_fixture"] } },
        { ...preStageLedger, fixtureOwnership: { ...preStageLedger.fixtureOwnership, postResumeApplicationIds: ["app_resume", "app_resume"] } },
        { ...preStageLedger, fixtureOwnership: { ...preStageLedger.fixtureOwnership, postResumePairingGrantIds: ["grant_resume", "grant_resume"] } },
        { ...preStageLedger, fixtureOwnership: { ...preStageLedger.fixtureOwnership, postResumeInstallationIds: ["installation_resume", "installation_resume"] } },
        { ...preStageLedger, fixtureOwnership: { ...preStageLedger.fixtureOwnership, ownedDeploymentIds: ["dpl_fixture_1", "dpl_fixture_1"] } },
        { ...preStageLedger, fixtureOwnership: { ...preStageLedger.fixtureOwnership, cleanup: [{ action: "delete_application", targetId: "app_unowned", expectedTerminalState: "deleted", timestamp: "2026-09-04T00:00:00Z", observedResult: "pending" }] } },
        { ...preStageLedger, fixtureOwnership: { ...preStageLedger.fixtureOwnership, cleanup: [{ action: "unknown_action", targetId: "installation_fixture", expectedTerminalState: "401", timestamp: "2026-09-04T00:00:00Z", observedResult: "pending" }] } },
        { ...preStageLedger, fixtureOwnership: { ...preStageLedger.fixtureOwnership, cleanup: [{ action: "revoke_installation", targetId: "installation_fixture", expectedTerminalState: "401", timestamp: "not-utc", observedResult: "pending" }] } },
        { ...preStageLedger, fixtureOwnership: { ...preStageLedger.fixtureOwnership, cleanup: [{ action: "revoke_installation", targetId: "installation_fixture", expectedTerminalState: "401", timestamp: "2026-09-04T00:00:00Z", observedResult: "unknown" }] } },
        { ...preStageLedger, fixtureOwnership: { ...preStageLedger.fixtureOwnership, cleanup: [{ action: "revoke_installation", targetId: "installation_fixture", expectedTerminalState: "401", observedResult: "pending" }] } },
      ]) {
        const original = JSON.stringify(malformedLedger);
        writeFileSync(ledger, original, { mode: 0o600 });
        chmodSync(ledger, 0o600);
        expect(() => execFileSync("bash", ["-c", block], {
          env: {
            ...process.env,
            EVIDENCE_ROOT: temporaryRoot,
            LEDGER: ledger,
            TARGET_SHA: "sha-reviewed",
            APP_BASE_URL: expectedOrigin,
            STAGE_ONE_CANDIDATE_ID: "dpl_stageone",
          },
          stdio: ["pipe", "pipe", "pipe"],
        })).toThrow();
        expect(readFileSync(ledger, "utf8")).toBe(original);
        expect(JSON.parse(readFileSync(ledger, "utf8")).stage1).toBeUndefined();
      }

      const repositoryRoot = join(temporaryRoot, "repository");
      const repositoryLedgerRoot = join(repositoryRoot, "private-ledger");
      mkdirSync(repositoryLedgerRoot, { recursive: true, mode: 0o700 });
      chmodSync(repositoryLedgerRoot, 0o700);
      const repositoryLedger = join(repositoryLedgerRoot, "rollout-ledger.json");
      const originalRepositoryLedger = JSON.stringify(preStageLedger);
      writeFileSync(repositoryLedger, originalRepositoryLedger, { mode: 0o600 });
      expect(() => execFileSync("bash", ["-c", `git() { if [[ "$1 $2" == "rev-parse --show-toplevel" ]]; then printf '%s\\n' "$FAKE_REPO_ROOT"; else command git "$@"; fi; }\n${block}`], {
        env: {
          ...process.env,
          EVIDENCE_ROOT: repositoryLedgerRoot,
          FAKE_REPO_ROOT: repositoryRoot,
          TARGET_SHA: "sha-reviewed",
          APP_BASE_URL: expectedOrigin,
          STAGE_ONE_CANDIDATE_ID: "dpl_stageone",
        },
        stdio: ["pipe", "pipe", "pipe"],
      })).toThrow();
      expect(readFileSync(repositoryLedger, "utf8")).toBe(originalRepositoryLedger);
      expect(JSON.parse(readFileSync(repositoryLedger, "utf8")).stage1).toBeUndefined();
    } finally {
      rmSync(temporaryRoot, { recursive: true, force: true });
    }

    expect(execFileSync("bash", ["-n"], { input: block, encoding: "utf8" })).toBe("");
  });

  it("requires authenticated stopped-write evidence that is bound to the exact Stage 1 deployment", () => {
    const section = rolloutSection();
    expectOrdered(section, [
      'STAGE_ONE_CANDIDATE_ID="$(stage_candidate "identity=1,writes=0")"',
      "STAGE_ONE_CANDIDATE_ID",
      "check:production:writes-stopped",
      "stage1.writeStopEvidence",
    ]);
    expect(section).toContain("projectionSha256");
    expect(section).toContain("observedStatus: 503");
    expect(section).toContain('cacheControl: "private, no-store"');
    expect(section).toContain('retryAfter: "60"');
    expect(section).toContain('code: "writes_stopped"');
  });

  it("atomically records only a hash-bound stopped-write projection after the exact canonical Stage 1 check", () => {
    const temporaryRoot = mkdtempSync(join(tmpdir(), "production-rollout-write-stop-evidence-"));
    try {
      const ledger = join(temporaryRoot, "rollout-ledger.json");
      const initialLedger = {
        schemaVersion: 1,
        fixtureOwnership: {
          applicationIds: ["app_fixture"],
          ownedDeploymentIds: ["dpl_fixture"],
          pairingGrantIds: ["grant_fixture"],
          preProbeHash: "before", postProbeHash: "after",
          settings: { existedBefore: true, contentHashBefore: "before", contentHashAfter: "after" },
          pairing: { preStopUnconsumedGrantId: "grant_fixture", codeReference: "private-code-ref" },
          installation: { credentialReference: "private-credential-ref", installationId: "installation_fixture" },
          cleanup: [{ action: "revoke_installation", targetId: "installation_fixture", expectedTerminalState: "401", timestamp: "2026-09-04T00:00:00Z", observedResult: "pending" }],
        },
      };
      writeFileSync(ledger, JSON.stringify(initialLedger), { mode: 0o600 });
      const source = `${stageOneLedgerBlock()}\n${stageOneWriteStopEvidenceBlock()}\n[[ "$(cat \"$NPM_LOG\")" == "run check:production:writes-stopped" ]] || exit 94`;
      expect(runMocked(source, {
        ...baseScenario(), EVIDENCE_ROOT: temporaryRoot, APP_ACCESS_TOKEN: "private-test-token", STAGE_ONE_CANDIDATE_ID: "dpl_valid",
      }, "")).toBe("");
      const record = JSON.parse(readFileSync(ledger, "utf8"));
      expect(record.stage1.writeStopEvidence).toMatchObject({
        deploymentId: "dpl_valid", expectedStatus: 503, observedStatus: 503, cacheControl: "private, no-store", retryAfter: "60", code: "writes_stopped",
      });
      const { projectionSha256, ...projection } = record.stage1.writeStopEvidence;
      expect(projectionSha256).toBe(createHash("sha256").update(JSON.stringify(projection)).digest("hex"));
      expect(JSON.stringify(record)).not.toContain("private-test-token");
    } finally {
      rmSync(temporaryRoot, { recursive: true, force: true });
    }
  });

  it("drains for 60 seconds before the authenticated Stage 1 stopped-write probe and never records evidence after a drain failure", () => {
    const temporaryRoot = mkdtempSync(join(tmpdir(), "production-rollout-write-stop-drain-"));
    try {
      expectOrdered(stageOneWriteStopEvidenceBlock(), [
        'jq -e --arg id "$STAGE_ONE_LEDGER_ID"',
        "sleep 60 || exit 1",
        "check:production:writes-stopped",
        "STAGE_ONE_EVIDENCE_PROJECTION",
        'mv -f -- "$STAGE_ONE_EVIDENCE_TMP" "$LEDGER"',
      ]);
      const ledger = join(temporaryRoot, "rollout-ledger.json");
      const initialLedger = {
        schemaVersion: 1,
        fixtureOwnership: {
          applicationIds: ["app_fixture"], ownedDeploymentIds: ["dpl_fixture"], pairingGrantIds: ["grant_fixture"], preProbeHash: "before", postProbeHash: "after",
          settings: { existedBefore: true, contentHashBefore: "before", contentHashAfter: "after" }, pairing: { preStopUnconsumedGrantId: "grant_fixture", codeReference: "private-code-ref" },
          installation: { credentialReference: "private-credential-ref", installationId: "installation_fixture" },
          cleanup: [{ action: "revoke_installation", targetId: "installation_fixture", expectedTerminalState: "401", timestamp: "2026-09-04T00:00:00Z", observedResult: "pending" }],
        },
      };
      const source = `${stageOneLedgerBlock()}\n${stageOneWriteStopEvidenceBlock()}\n[[ "$(cat \"$SLEEP_LOG\")" == "sleep 60" ]] || exit 95\n[[ "$(cat \"$ORDER_LOG\")" == $'sleep\\nnpm' ]] || exit 96`;
      const variables = { ...baseScenario(), EVIDENCE_ROOT: temporaryRoot, APP_ACCESS_TOKEN: "private-test-token", STAGE_ONE_CANDIDATE_ID: "dpl_valid" };
      writeFileSync(ledger, JSON.stringify(initialLedger), { mode: 0o600 });
      expect(runMocked(source, variables, "")).toBe("");

      writeFileSync(ledger, JSON.stringify(initialLedger), { mode: 0o600 });
      const failure = runMockedFailure(`${stageOneLedgerBlock()}\n${stageOneWriteStopEvidenceBlock()}`, { ...variables, SLEEP_FAIL: "true" }, "");
      expect(failure.deploys).toBe("");
      expect(failure.promotes).toBe("");
      expect(JSON.parse(readFileSync(ledger, "utf8")).stage1.writeStopEvidence).toBeUndefined();
    } finally {
      rmSync(temporaryRoot, { recursive: true, force: true });
    }
  });

  it("holds without a provider mutation when selector evidence or UTC record fields are missing, mismatched, or tampered", () => {
    const temporaryRoot = mkdtempSync(join(tmpdir(), "production-rollout-write-stop-selector-"));
    try {
      const ledger = join(temporaryRoot, "rollout-ledger.json");
      const source = `${candidateFunction()}\n${normalResumeBlock().replace(/^[ \t]*read -r -p .*$/gmu, "     :")}`;
      const stage1 = {
        deploymentId: "dpl_valid", targetSha: "sha-reviewed", gates: { identity: "1", writes: "0" }, reviewedGateConfig: { identity: "1", writes: "0", reviewedAt: "2026-09-04T00:00:00Z" },
        ready: true, readyState: "READY", readyEvidence: { deploymentId: "dpl_valid", state: "READY", observedAt: "2026-09-04T00:00:00Z" },
        canonicalPromotionVerified: true, canonicalPromotion: { origin: expectedOrigin, deploymentId: "dpl_valid", verified: true, verifiedAt: "2026-09-04T00:00:00Z" },
        compatibilityVerified: true, timestamps: { recordedAt: "2026-09-04T00:00:00Z", readyObservedAt: "2026-09-04T00:00:00Z", canonicalPromotionVerifiedAt: "2026-09-04T00:00:00Z" },
        writeStopEvidence: writeStopEvidence("dpl_valid"),
      };
      for (const invalidStage1 of [
        { ...stage1, writeStopEvidence: undefined },
        { ...stage1, writeStopEvidence: { ...writeStopEvidence("dpl_other") } },
        { ...stage1, writeStopEvidence: { ...writeStopEvidence("dpl_valid"), projectionSha256: "0".repeat(64) } },
        { ...stage1, reviewedGateConfig: { identity: "1", writes: "0" } },
        { ...stage1, reviewedGateConfig: { identity: "1", writes: "0", reviewedAt: "2026-09-04T00:00:00+00:00" } },
        { ...stage1, timestamps: { readyObservedAt: "2026-09-04T00:00:00Z", canonicalPromotionVerifiedAt: "2026-09-04T00:00:00Z" } },
        { ...stage1, timestamps: { ...stage1.timestamps, recordedAt: "2026-09-04T00:00:00+00:00" } },
      ]) {
        writeFileSync(ledger, JSON.stringify({ schemaVersion: 1, stage1: invalidStage1 }), { mode: 0o600 });
        const failure = runMockedFailure(source, {
          ...baseScenario(), EVIDENCE_ROOT: temporaryRoot, ROLLBACK_READ_TOKEN: "private-test-token", CURL_STATUS_SEQUENCE: "503", CURL_BODY_SEQUENCE: "DEPLOYMENT_PAUSED",
        }, "");
        expect(failure.stderr).toContain("HOLD_PAUSED");
        expect(failure.deploys).toBe("");
        expect(failure.promotes).toBe("");
        expect(failure.inspects).toBe("");
        expect(failure.curlCalls).toBe(1);
        expect(JSON.parse(readFileSync(ledger, "utf8"))).toEqual({ schemaVersion: 1, stage1: invalidStage1 });
      }

      const original = { schemaVersion: 1, stage1 };
      writeFileSync(ledger, JSON.stringify(original), { mode: 0o600 });
      const withoutTargetSha = baseScenario();
      delete withoutTargetSha.TARGET_SHA;
      const missingTargetSha = runMockedFailure(source, {
        ...withoutTargetSha, EVIDENCE_ROOT: temporaryRoot, ROLLBACK_READ_TOKEN: "private-test-token", CURL_STATUS_SEQUENCE: "503", CURL_BODY_SEQUENCE: "DEPLOYMENT_PAUSED",
      }, "");
      expect(missingTargetSha.stderr).toContain("HOLD_PAUSED");
      expect(missingTargetSha.curlCalls).toBe(1);
      expect(missingTargetSha.inspects).toBe("");
      expect(missingTargetSha.deploys).toBe("");
      expect(missingTargetSha.promotes).toBe("");
      expect(JSON.parse(readFileSync(ledger, "utf8"))).toEqual(original);
    } finally {
      rmSync(temporaryRoot, { recursive: true, force: true });
    }
  });

  it("accepts only typed cleanup targets from the owned pre- and post-resume unions", () => {
    const temporaryRoot = mkdtempSync(join(tmpdir(), "production-rollout-typed-cleanup-"));
    try {
      const ledger = join(temporaryRoot, "rollout-ledger.json");
      const owned = {
        applicationIds: ["app_pre"], postResumeApplicationIds: ["app_post"], ownedDeploymentIds: ["dpl_fixture"],
        pairingGrantIds: ["grant_pre"], postResumePairingGrantIds: ["grant_post"], installationIds: ["installation_pre"], postResumeInstallationIds: ["installation_post"],
        preProbeHash: "before", postProbeHash: "after",
        settings: { existedBefore: true, contentHashBefore: "before", contentHashAfter: "after" },
        pairing: { preStopUnconsumedGrantId: "grant_pre", codeReference: "private-code-ref" },
        installation: { credentialReference: "private-credential-ref", installationId: "installation_singleton" },
        cleanup: [
          { action: "delete_application", targetId: "app_post", expectedTerminalState: "404", timestamp: "2026-09-04T00:00:00Z", observedResult: "pending" },
          { action: "consume_pairing_grant", targetId: "grant_post", expectedTerminalState: "401", timestamp: "2026-09-04T00:00:00Z", observedResult: "pending" },
          { action: "revoke_installation", targetId: "installation_post", expectedTerminalState: "401", timestamp: "2026-09-04T00:00:00Z", observedResult: "pending" },
          { action: "reconcile", targetRef: "settings", expectedTerminalState: "matched", timestamp: "2026-09-04T00:00:00Z", observedResult: "pending" },
        ],
      };
      writeFileSync(ledger, JSON.stringify({ schemaVersion: 1, fixtureOwnership: owned }), { mode: 0o600 });
      execFileSync("bash", ["-c", stageOneLedgerBlock()], {
        env: { ...process.env, EVIDENCE_ROOT: temporaryRoot, TARGET_SHA: "sha-reviewed", APP_BASE_URL: expectedOrigin, STAGE_ONE_CANDIDATE_ID: "dpl_stageone" },
        stdio: ["pipe", "pipe", "pipe"],
      });
      expect(JSON.parse(readFileSync(ledger, "utf8")).stage1.deploymentId).toBe("dpl_stageone");

      const invalid = { ...owned, cleanup: [{ action: "delete_application", targetId: "app_unowned", expectedTerminalState: "404", timestamp: "2026-09-04T00:00:00Z", observedResult: "pending" }] };
      const original = JSON.stringify({ schemaVersion: 1, fixtureOwnership: invalid });
      writeFileSync(ledger, original, { mode: 0o600 });
      expect(() => execFileSync("bash", ["-c", stageOneLedgerBlock()], {
        env: { ...process.env, EVIDENCE_ROOT: temporaryRoot, TARGET_SHA: "sha-reviewed", APP_BASE_URL: expectedOrigin, STAGE_ONE_CANDIDATE_ID: "dpl_stageone" },
        stdio: ["pipe", "pipe", "pipe"],
      })).toThrow();
      expect(readFileSync(ledger, "utf8")).toBe(original);
    } finally {
      rmSync(temporaryRoot, { recursive: true, force: true });
    }
  });

  it("defines a fail-closed private ledger setup with restrictive modes", () => {
    const block = ledgerSetupBlock();
    const lines = block.split("\n").map((line) => line.trim()).filter(Boolean);
    expectOrdered(block, [
      ': "${EVIDENCE_ROOT:?set EVIDENCE_ROOT to a private path outside the repository}"',
      '[[ "$EVIDENCE_ROOT" == /* ]]',
      'EVIDENCE_PARENT="$(dirname -- "$EVIDENCE_ROOT")"',
      'EVIDENCE_BASENAME="$(basename -- "$EVIDENCE_ROOT")"',
      '[[ "$EVIDENCE_BASENAME" != "." && "$EVIDENCE_BASENAME" != ".." && -n "$EVIDENCE_BASENAME" ]]',
      '[[ -d "$EVIDENCE_PARENT" ]]',
      'EVIDENCE_PARENT_REAL="$(cd -- "$EVIDENCE_PARENT" && pwd -P)" || exit 1',
      'EVIDENCE_CANDIDATE="$EVIDENCE_PARENT_REAL/$EVIDENCE_BASENAME"',
      'case "$EVIDENCE_CANDIDATE" in',
      '[[ ! -L "$EVIDENCE_CANDIDATE" ]] || exit 1',
      'umask 077',
      'install -d -m 0700 -- "$EVIDENCE_CANDIDATE" || exit 1',
      'EVIDENCE_ROOT="$EVIDENCE_CANDIDATE"',
      '[[ -d "$EVIDENCE_ROOT" && ! -L "$EVIDENCE_ROOT" ]] || exit 1',
      '[[ "$(cd -- "$EVIDENCE_ROOT" && pwd -P)" == "$EVIDENCE_CANDIDATE" ]] || exit 1',
      'LEDGER="$EVIDENCE_ROOT/rollout-ledger.json"',
      '[[ ! -e "$LEDGER" && ! -L "$LEDGER" ]] || exit 1',
      '(set -o noclobber; : > "$LEDGER") || exit 1',
      '[[ -f "$LEDGER" && ! -L "$LEDGER" ]] || exit 1',
      'chmod 0600 "$LEDGER" || exit 1',
    ]);
    expect(lines.some((line) => line.includes('EVIDENCE_ROOT="/'))).toBe(false);

    const tempRoot = mkdtempSync(join(tmpdir(), "production-rollout-ledger-"));
    try {
      const privateRoot = join(tempRoot, "private");
      execFileSync("bash", ["-c", `${block}\n[[ -d "$EVIDENCE_ROOT" ]] && [[ -f "$EVIDENCE_ROOT/rollout-ledger.json" ]]`], {
        env: { ...process.env, EVIDENCE_ROOT: privateRoot },
        stdio: ["pipe", "pipe", "pipe"],
      });
      expect(statSync(privateRoot).mode & 0o777).toBe(0o700);
      expect(statSync(join(privateRoot, "rollout-ledger.json")).mode & 0o777).toBe(0o600);

      expect(() => execFileSync("bash", ["-c", block], {
        env: { ...process.env, EVIDENCE_ROOT: root },
        stdio: ["pipe", "pipe", "pipe"],
      })).toThrow();

      const traversal = join(root, "docs", "..", "ledger-traversal");
      expect(() => execFileSync("bash", ["-c", block], {
        env: { ...process.env, EVIDENCE_ROOT: traversal },
        stdio: ["pipe", "pipe", "pipe"],
      })).toThrow();

      const repoLink = join(tempRoot, "repo-link");
      symlinkSync(root, repoLink);
      expect(() => execFileSync("bash", ["-c", block], {
        env: { ...process.env, EVIDENCE_ROOT: join(repoLink, "ledger") },
        stdio: ["pipe", "pipe", "pipe"],
      })).toThrow();

      const existingRoot = join(tempRoot, "existing");
      mkdirSync(existingRoot, { mode: 0o700 });
      symlinkSync(root, join(existingRoot, "rollout-ledger.json"));
      expect(() => execFileSync("bash", ["-c", block], {
        env: { ...process.env, EVIDENCE_ROOT: existingRoot },
        stdio: ["pipe", "pipe", "pipe"],
      })).toThrow();
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
    }

    expect(execFileSync("bash", ["-n"], { input: block, encoding: "utf8" })).toBe("");
    expect(block).not.toMatch(/\b(?:vercel|gh|curl|fetch|http)\b/iu);
    for (const secretName of [
      "DATABASE_URL",
      "ENCRYPTION_SECRET",
      "APP_ACCESS_TOKEN",
      "PRODUCTION_DATABASE_URL",
    ]) {
      expect(block).not.toMatch(new RegExp(`\\b${secretName}\\s*=`, "u"));
    }
  });

  it("records ownership-limited fixture cleanup and safe Settings semantics", () => {
    const section = rolloutSection();
    const normalizedSection = normalize(section);
    for (const requirement of [
      "rollout SHA",
      "staged candidate ID",
      "promoted deployment ID",
      "canonical origin",
      "exact owned Application IDs",
      "pre- and post-probe hashes",
      "Settings singleton existed before",
      "pre-stop unconsumed pairing grant",
      "installed credential",
      "installation ID",
      "every Application, pairing grant, or installation created after resume",
      "expected terminal state",
      "observed result",
    ]) expect(normalizedSection).toContain(requirement);
    expect(normalizedSection).toMatch(/private[^.]*directory[^.]*0700/iu);
    expect(normalizedSection).toMatch(/ledger[^.]*0600/iu);
    expect(normalizedSection).toContain("never committed or uploaded");
    expect(normalizedSection).toMatch(/only exact ledger-owned Application IDs/iu);
    expect(normalizedSection).toMatch(/never search or delete by broad (?:name|timestamp|origin|user)/iu);
    expect(normalizedSection).toContain("exactly once");
    expect(normalizedSection).toContain("replay rejection");
    expect(normalizedSection).toContain("credential returns `401`");
    expect(normalizedSection).toContain("final counts and content hashes");
    expect(normalizedSection).toContain("ledger is retained");
    expect(normalizedSection).toContain("second unrecorded credential attempt");
    expect(normalizedSection).toContain("syntactically valid `PUT /api/settings`");
    expect(normalizedSection).toContain("private, non-production canary");
    expect(normalizedSection).toContain("stopped-write response");
    expect(normalizedSection).toContain("unchanged Settings existence and content hash");
    expect(normalizedSection).toContain("Settings singleton is created only on the first successful `PUT /api/settings`");
    expect(normalizedSection).toContain("authenticated `GET /api/settings` never creates the row");

    const cleanupStart = section.indexOf("11. After the final write-enabled promotion");
    const cleanup = normalize(section.slice(cleanupStart));
    expectOrdered(cleanup, [
      "Delete only exact ledger-owned Application IDs",
      "Consume the recorded pre-stop unconsumed pairing grant exactly once",
      "prove replay rejection",
      "Revoke every ledger-owned installation",
      "stored credential returns `401`",
      "Reconcile final counts and content hashes",
      "Delete `rollout-ledger.json` only after every",
      "resume external writers last",
    ]);
    expect(cleanup).toContain("supported application paths");
    expect(cleanup).toContain("no real provider credential");

    const failureStart = section.indexOf("Cleanup or rejection failure");
    const failure = normalize(section.slice(failureStart, section.indexOf("8. Resume Vercel Production")));
    expect(failure).toContain("HOLD_PAUSED");
    expect(failure.toLowerCase()).toContain("ordinary and external writers remain stopped");
    expect(failure).toContain("ledger is retained");
    expect(failure).toContain("unbounded delete");
    expect(failure).toContain("second unrecorded credential attempt");
    expectOrdered(failure, [
      "provider Production pause control",
      "bounded canonical-origin curl",
      "HTTP `503`",
      "DEPLOYMENT_PAUSED",
      "state labeled `HOLD_PAUSED`",
    ]);
  });
});
