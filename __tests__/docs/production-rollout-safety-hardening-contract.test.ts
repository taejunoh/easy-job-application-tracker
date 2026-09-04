import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
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
IFS=',' read -r -a bodies <<< "\${CURL_BODY_SEQUENCE:-}"
if (( call_number < \${#bodies[@]} )); then body="\${bodies[$call_number]}"; else body="\${bodies[\${#bodies[@]}-1]}"; fi
[[ "$output" == /dev/null ]] || printf '%s' "$body" > "$output"
printf '%s' "$status"
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
      },
    });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

function runMockedFailure(source: string, variables: Record<string, string>, body: string): { stderr: string; deploys: string; promotes: string; curlCalls: number } {
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

function stageOneLedgerBlock(): string {
  const block = bashBlocks(rolloutSection()).find((candidate) =>
    normalize(candidate).includes('STAGE_ONE_LEDGER_TMP="$(mktemp "$EVIDENCE_ROOT/.rollout-ledger.stage1.XXXXXX")"'),
  );
  expect(block).toBeDefined();
  return block ?? "";
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

  it("requires fresh live canonical status before deploy and promotion", () => {
    const source = candidateFunction();
    const staleAttestation = { ...baseScenario(), VERCEL_UNPAUSED_ATTESTED: "true", CURL_STATUS_SEQUENCE: "503,401" };
    expect(runMocked(source, staleAttestation, `
if stage_candidate "identity=1,writes=0"; then exit 69; fi
[[ ! -s "\${DEPLOY_LOG:?}" ]] || exit 70
[[ ! -s "\${PROMOTE_LOG:?}" ]] || exit 71
[[ "$(wc -l < "\${CURL_LOG:?}")" -eq 1 ]] || exit 72`)).toBe("");

    const pausesAfterInspect = { ...baseScenario(), VERCEL_UNPAUSED_ATTESTED: "true", CURL_STATUS_SEQUENCE: "401,503" };
    expect(runMocked(source, pausesAfterInspect, `
if stage_candidate "identity=1,writes=0"; then exit 73; fi
[[ -s "\${DEPLOY_LOG:?}" ]] || exit 74
[[ ! -s "\${PROMOTE_LOG:?}" ]] || exit 75
[[ "$(wc -l < "\${CURL_LOG:?}")" -eq 2 ]] || exit 76`)).toBe("");

    expect(runMocked(source, { ...baseScenario(), CURL_STATUS_SEQUENCE: "401,401" }, `
captured="$(stage_candidate "identity=1,writes=0")" || exit 77
[[ "$captured" == "dpl_valid" ]] || exit 78
[[ "$(wc -l < "\${CURL_LOG:?}")" -eq 2 ]] || exit 79`)).toBe("");
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
    expect(section.match(/vercel\s+promote\b/giu)).toHaveLength(1);

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
      'LEDGER="${EVIDENCE_ROOT:?private ledger path is required}/rollout-ledger.json"',
      'jq -e --arg sha "$TARGET_SHA"',
      "STAGE_ONE_RECORD_ID=\"$(jq -er '.stage1.deploymentId' \"$LEDGER\")\"",
      'STAGE_ONE_INSPECT="$(vercel inspect "$STAGE_ONE_RECORD_ID"',
      'STAGE_ONE_METADATA="$(vercel api "/v13/deployments/$STAGE_ONE_RECORD_ID"',
      'STAGE_ONE_CANONICAL="$(vercel inspect "$APP_BASE_URL"',
      'assert_canonical_unpaused "$APP_BASE_URL" || enter_hold_paused',
      'ROLLBACK_CANDIDATE_ID="$(stage_candidate "identity=1,writes=0")"',
      "sleep 60",
      'READONLY_STATUS="$(curl',
      'NEGATIVE_STATUS="$(curl',
      'unset ROLLBACK_READ_TOKEN',
    ]);
    expect(normalizedBlock).toContain("gates.identity == \"1\"");
    expect(normalizedBlock).toContain("gates.writes == \"0\"");
    expect(normalizedBlock).toContain("canonicalPromotionVerified == true");
    expect(normalizedBlock).toContain("compatibilityVerified == true");
    expect(normalizedBlock).toContain("readyState == \"READY\"");
    expect(normalizedBlock).toContain("target == \"production\"");
    expect(normalizedBlock).toContain("After the provider pause is complete");
    expect(normalizedBlock).toContain("PAUSE_STATUS");
    expect(normalizedBlock).toContain("$PAUSE_STATUS\" != \"503\"");
    expect(normalizedBlock).toContain("DEPLOYMENT_PAUSED");
    expect(normalizedBlock).toContain("printf '%s\\n' 'HOLD_PAUSED'");
    expect(normalizedBlock).not.toContain("VERCEL_UNPAUSED_ATTESTED");
    expect(normalizedBlock).toMatch(/writers remain stopped|ledger retained/iu);
  });

  it("requires observed provider pause evidence before HOLD_PAUSED on missing evidence or a failed probe", () => {
    const testableBlock = regressionBlock()
      .replace(/^[ \t]*read -r -p 'After the provider pause is complete, press Enter: ' _ <\/dev\/tty \|\| return 1$/mu, "     :")
      .replace("sleep 60 || enter_hold_paused", ":");
    const source = `${candidateFunction()}\n${testableBlock}`;
    const temporaryRoot = mkdtempSync(join(tmpdir(), "production-rollout-regression-"));
    try {
      const missingEvidence = runMockedFailure(source, {
        ...baseScenario(),
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
          timestamps: { readyObservedAt: "2026-09-04T00:00:00Z", canonicalPromotionVerifiedAt: "2026-09-04T00:00:00Z" },
        },
      }), { mode: 0o600 });
      const failedProbe = runMockedFailure(source, {
        ...baseScenario(),
        EVIDENCE_ROOT: temporaryRoot,
        ROLLBACK_READ_TOKEN: "private-test-token",
        CURL_STATUS_SEQUENCE: "401,401,401,500,503",
        CURL_BODY_SEQUENCE: "ignored,ignored,ignored,ignored,DEPLOYMENT_PAUSED",
      }, "");
      expect(failedProbe.stderr).toContain("HOLD_PAUSED");
      expect(failedProbe.deploys).toBe("deploy\n");
      expect(failedProbe.promotes).toBe("dpl_valid\n");
      expect(failedProbe.curlCalls).toBe(5);
    } finally {
      rmSync(temporaryRoot, { recursive: true, force: true });
    }
  });

  it("writes the Stage 1 ledger schema that the resume and rollback gate consumes", () => {
    const block = stageOneLedgerBlock();
    const temporaryRoot = mkdtempSync(join(tmpdir(), "production-rollout-stage1-ledger-"));
    try {
      const ledger = join(temporaryRoot, "rollout-ledger.json");
      writeFileSync(ledger, "", { mode: 0o600 });
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
    } finally {
      rmSync(temporaryRoot, { recursive: true, force: true });
    }

    expect(execFileSync("bash", ["-n"], { input: block, encoding: "utf8" })).toBe("");
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
    expect(normalizedSection).toContain("ledger retained");
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
    expect(failure).toContain("ledger retained");
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
