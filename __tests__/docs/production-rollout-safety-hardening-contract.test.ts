import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

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

function candidateFunction(): string {
  const block = bashBlocks(rolloutSection()).find((candidate) =>
    normalize(candidate).includes("vercel deploy . --prod --skip-domain --yes --format=json --no-color"),
  );
  expect(block).toBeDefined();
  const match = (block ?? "").match(/stage_candidate\(\) \([\s\S]*?\n\)/u);
  expect(match).not.toBeNull();
  return match?.[0] ?? "";
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
if [[ "\${1:-} \${2:-}" == "status --porcelain" ]]; then exit 0; fi
if [[ "\${1:-} \${2:-}" == "rev-parse HEAD" ]]; then printf '%s\\n' "\${TARGET_SHA:-}"; exit 0; fi
exit 2
`, { mode: 0o700 });
  writeFileSync(join(directory, "vercel"), `#!/usr/bin/env bash
case "\${1:-}" in
  deploy) printf '%s\\n' deploy >> "\${DEPLOY_LOG:?}"; printf '%s\\n' "\${DEPLOY_JSON:-}" ;;
  inspect) if [[ "\${2:-}" == "\${APP_BASE_URL:-}" ]]; then printf '%s\\n' "\${CANONICAL_JSON:-}"; else printf '%s\\n' "\${INSPECT_JSON:-}"; fi ;;
  api) printf '%s\\n' "\${API_JSON:-}" ;;
  promote) printf '%s\\n' "\${2:-}" >> "\${PROMOTE_LOG:?}" ;;
  *) exit 2 ;;
esac
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
      },
    });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

function baseScenario(): Record<string, string> {
  return {
    TARGET_SHA: "sha-reviewed",
    APP_BASE_URL: expectedOrigin,
    VERCEL_UNPAUSED_ATTESTED: "true",
    DEPLOY_JSON: JSON.stringify({ id: "dpl_valid", url: "https://candidate.example" }),
    INSPECT_JSON: JSON.stringify({ id: "dpl_valid", readyState: "READY", aliases: [] }),
    API_JSON: JSON.stringify({ id: "dpl_valid", readyState: "READY", target: "production", url: "https://candidate.example", meta: { githubCommitSha: "sha-reviewed" }, alias: [] }),
    CANONICAL_JSON: JSON.stringify({ id: "dpl_valid" }),
  };
}

function aliasJson(alias: string): string {
  if (alias === "missing") return JSON.stringify({ id: "dpl_valid", readyState: "READY" });
  return JSON.stringify({ id: "dpl_valid", readyState: "READY", aliases: JSON.parse(alias) });
}

describe("production rollout staged-candidate binding documentation contract", () => {
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

    expectOrdered(procedure, [
      '[[ "$stage_name" == "identity=1,writes=0" || "$stage_name" == "identity=1,writes=1" ]] || return 1',
      '[[ "${VERCEL_UNPAUSED_ATTESTED:-}" == "true" ]] || return 1',
      '[[ -n "${TARGET_SHA:-}" ]] || return 1',
      '[[ -n "${APP_BASE_URL:-}" ]] || return 1',
      '[[ "$APP_BASE_URL" == "$EXPECTED_PRODUCTION_ORIGIN" ]] || return 1',
      'WORKTREE_STATUS="$(git status --porcelain)" || return 1',
      'CURRENT_SHA="$(git rev-parse HEAD)" || return 1',
      deploy,
      id,
      url,
      inspect,
      inspectCheck,
      api,
      metadataCheck,
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
    expect(paused).toContain("unset VERCEL_UNPAUSED_ATTESTED");
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
    expect(section.match(/stage_candidate "identity=1,writes=(?:0|1)"/gu)).toHaveLength(2);
    expect(section.match(/vercel deploy \. --prod --skip-domain --yes --format=json --no-color/gu)).toHaveLength(1);
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
});
