import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = join(__dirname, "../..");
const inspectAliases =
  '((.aliases // []) | type == "array") and (((.aliases // []) | length) == 0)';
const projectedAliases =
  '(.aliases | type == "array") and ((.aliases | length) == 0)';

function normalize(text: string): string {
  return text.replace(/\s+/gu, " ").trim();
}

function rolloutSection(): string {
  const runbook = readFileSync(
    join(root, "docs/operations/production-runbook.md"),
    "utf8",
  );
  const start = runbook.indexOf("## Application identity maintenance rollout");
  const end = runbook.indexOf("## Backup and restore", start);
  expect(start).not.toBe(-1);
  expect(end).toBeGreaterThan(start);
  return runbook.slice(start, end);
}

function bashBlocks(section: string): string[] {
  return [...section.matchAll(/```bash\r?\n([\s\S]*?)```/gu)].map(
    ([, block]) => block,
  );
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

function oneLine(lines: string[], matcher: RegExp, label: string): string {
  const matches = lines.filter((line) => matcher.test(line));
  expect(matches).toHaveLength(1);
  expect(matches[0]).toBeDefined();
  return matches[0] ?? label;
}

describe("production rollout staged-candidate binding documentation contract", () => {
  it("binds each candidate's deployment, provenance, and promotion by data flow", () => {
    const section = rolloutSection();
    const blocks = bashBlocks(section);
    const candidateBlocks = blocks.filter((block) =>
      normalize(block).includes(
        "vercel deploy . --prod --skip-domain --yes --format=json --no-color",
      ),
    );
    expect(candidateBlocks).toHaveLength(1);
    const candidate = candidateBlocks[0] ?? "";
    const procedureMatch = candidate.match(
      /stage_candidate\(\) \{([\s\S]*?)\n\}/u,
    );
    expect(procedureMatch).not.toBeNull();
    const procedure = procedureMatch?.[1] ?? "";
    const lines = procedure
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);

    expect(procedure).toContain(
      'local CANDIDATE_JSON="" CANDIDATE_INSPECT="" CANDIDATE_METADATA="" CANONICAL_METADATA="" CANDIDATE_ID="" CANDIDATE_URL=""',
    );
    expect(procedure).toContain(
      "trap 'unset CANDIDATE_JSON CANDIDATE_INSPECT CANDIDATE_METADATA CANONICAL_METADATA CANDIDATE_ID CANDIDATE_URL; trap - RETURN' RETURN",
    );

    const deployLine = oneLine(
      lines,
      /^CANDIDATE_JSON="\$\(vercel deploy \. --prod --skip-domain --yes --format=json --no-color\)"$/u,
      "candidate deploy capture",
    );
    const idLine = oneLine(
      lines,
      /^CANDIDATE_ID="\$\(jq -er /u,
      "candidate ID projection",
    );
    const urlLine = oneLine(
      lines,
      /^CANDIDATE_URL="\$\(jq -er /u,
      "candidate URL projection",
    );
    const inspectLine = oneLine(
      lines,
      /^CANDIDATE_INSPECT="\$\(vercel inspect /u,
      "candidate inspect",
    );
    const inspectCheck = oneLine(
      lines,
      /^jq -e --arg id .*\.aliases \/\//u,
      "candidate inspect check",
    );
    const apiLine = oneLine(
      lines,
      /^CANDIDATE_METADATA="\$\(vercel api /u,
      "candidate API projection",
    );
    const metadataCheck = oneLine(
      lines,
      /^jq -e --arg id .*--arg sha /u,
      "candidate metadata check",
    );
    const promoteLine = oneLine(
      lines,
      /^vercel promote /u,
      "candidate promotion",
    );
    const canonicalLine = oneLine(
      lines,
      /^CANONICAL_METADATA="\$\(vercel inspect /u,
      "canonical inspect",
    );
    const canonicalCheck = oneLine(
      lines,
      /^jq -e --arg id "\$CANDIDATE_ID" '\.id == \$id'/u,
      "canonical identity check",
    );

    expect(deployLine).toContain("--skip-domain --yes --format=json --no-color");
    expect(idLine).toContain('<<<"$CANDIDATE_JSON")"');
    expect(idLine).toContain('test("^dpl_[A-Za-z0-9]+$")');
    expect(urlLine).toContain('<<<"$CANDIDATE_JSON")"');
    expect(urlLine).toContain(".id == $id");
    expect(urlLine).toContain(".url | length > 0");
    expect(inspectLine).toContain('vercel inspect "$CANDIDATE_ID" --wait');
    expect(inspectCheck).toContain('--arg id "$CANDIDATE_ID"');
    expect(inspectCheck).toContain('.readyState == "READY"');
    expect(inspectCheck).toContain(inspectAliases);
    expect(apiLine).toMatch(
      /^CANDIDATE_METADATA="\$\(vercel api "\/v13\/deployments\/\$CANDIDATE_ID" --raw \| jq -ce /u,
    );
    expect(apiLine).toContain(
      "'{id,readyState,target,url,githubCommitSha:.meta.githubCommitSha,aliases:(.alias//[])}'",
    );
    expect(metadataCheck).toContain('--arg id "$CANDIDATE_ID"');
    expect(metadataCheck).toContain('--arg sha "$TARGET_SHA"');
    expect(metadataCheck).toContain('--arg url "$CANDIDATE_URL"');
    expect(metadataCheck).toContain('.readyState == "READY"');
    expect(metadataCheck).toContain('.target == "production"');
    expect(metadataCheck).toContain(".githubCommitSha == $sha");
    expect(metadataCheck).toContain(".url == $url");
    expect(metadataCheck).toContain(projectedAliases);
    expect(promoteLine).toBe('vercel promote "$CANDIDATE_ID" --yes');
    expect(canonicalLine).toContain('vercel inspect "$APP_BASE_URL"');
    expect(canonicalCheck).toContain('--arg id "$CANDIDATE_ID"');
    expect(canonicalCheck).toContain(".id == $id");

    expectOrdered(procedure, [
      '[[ "${VERCEL_UNPAUSED_ATTESTED:-}" == "true" ]]',
      '[[ -n "$TARGET_SHA" ]]',
      '[[ -n "${APP_BASE_URL:-}" ]]',
      '[[ -z "$(git status --porcelain)" ]]',
      '[[ "$(git rev-parse HEAD)" == "$TARGET_SHA" ]]',
      deployLine,
      idLine,
      urlLine,
      '[[ "$CANDIDATE_ID" =~ ^dpl_[A-Za-z0-9]+$ ]]',
      '[[ -n "$CANDIDATE_URL" ]]',
      inspectLine,
      inspectCheck,
      apiLine,
      metadataCheck,
      promoteLine,
      canonicalLine,
      canonicalCheck,
    ]);

    const deployPosition = procedure.indexOf(deployLine);
    const rawDeployUnsetPosition = procedure.indexOf("\n  unset CANDIDATE_JSON\n");
    expect(rawDeployUnsetPosition).toBeGreaterThan(deployPosition);
    expect(
      procedure.slice(rawDeployUnsetPosition + "\n  unset CANDIDATE_JSON\n".length),
    ).not.toContain("CANDIDATE_JSON");
    const inspectUnsetPosition = procedure.indexOf("\n  unset CANDIDATE_INSPECT\n");
    const metadataUnsetPosition = procedure.indexOf("\n  unset CANDIDATE_METADATA\n");
    const canonicalUnsetPosition = procedure.indexOf(
      "\n  unset CANONICAL_METADATA CANDIDATE_ID CANDIDATE_URL",
    );
    expect(rawDeployUnsetPosition).toBeLessThan(inspectUnsetPosition);
    expect(inspectUnsetPosition).toBeLessThan(metadataUnsetPosition);
    expect(metadataUnsetPosition).toBeLessThan(canonicalUnsetPosition);
    expect(procedure.match(/vercel api /gu)).toHaveLength(1);
    expect(apiLine).toContain("--raw | jq -ce");
    expect(candidate).not.toMatch(/^\s*export\s+CANDIDATE_/mu);
    expect(candidate).not.toMatch(/vercel\s+alias\b/iu);
    expect(candidate).not.toMatch(/vercel\s+promote\s+(?:"?\$CANDIDATE_URL|"?\$APP_BASE_URL)/iu);
    expect(candidate).not.toMatch(/vercel\s+promote\s+.*(?:preview|alias|remembered)/iu);

    const pauseStart = section.indexOf("4. Pause Vercel Production");
    const resumeStart = section.indexOf("8. Resume Vercel Production", pauseStart);
    expect(pauseStart).not.toBe(-1);
    expect(resumeStart).toBeGreaterThan(pauseStart);
    const paused = section.slice(pauseStart, resumeStart);
    expect(normalize(paused)).toMatch(/no build,? deploy, alias, or promot(?:e|ion)[^.]*while paused/iu);
    expect(paused).toContain("unset VERCEL_UNPAUSED_ATTESTED");
    for (const block of bashBlocks(paused)) {
      expect(block).not.toMatch(/\b(?:vercel\s+(?:deploy|promote|alias)|vercel\s+--prod)\b/iu);
    }
    expect(procedure).toMatch(/\[\[ "\$\{VERCEL_UNPAUSED_ATTESTED:-\}" == "true" \]\]/u);

    for (const predicate of [inspectAliases, projectedAliases]) {
      expect(() =>
        execFileSync("jq", ["-e", predicate], {
          input: '{"aliases":""}\n',
          encoding: "utf8",
          stdio: ["pipe", "pipe", "pipe"],
        }),
      ).toThrow();
    }
  });

  it("uses the same guarded procedure for both staged rollout gates", () => {
    const section = rolloutSection();
    const stageOneCall = section.indexOf('stage_candidate "identity=1,writes=0"');
    const finalCall = section.indexOf('stage_candidate "identity=1,writes=1"');
    const pauseStart = section.indexOf("4. Pause Vercel Production");
    const resumeStart = section.indexOf("8. Resume Vercel Production", pauseStart);
    expect(stageOneCall).toBeGreaterThan(-1);
    expect(finalCall).toBeGreaterThan(resumeStart);
    expect(stageOneCall).toBeLessThan(pauseStart);
    expect(finalCall).toBeGreaterThan(stageOneCall);
    expect(section.match(/stage_candidate "identity=1,writes=(?:0|1)"/gu)).toEqual([
      'stage_candidate "identity=1,writes=0"',
      'stage_candidate "identity=1,writes=1"',
    ]);

    const stageOneBlockStart = section.lastIndexOf("```bash", stageOneCall);
    const finalBlockStart = section.lastIndexOf("```bash", finalCall);
    const stageOneBlock = section.slice(stageOneBlockStart, section.indexOf("```", stageOneCall + 1));
    const finalBlock = section.slice(finalBlockStart, section.indexOf("```", finalCall + 1));
    for (const block of [stageOneBlock, finalBlock]) {
      expect(block).toContain("VERCEL_UNPAUSED_ATTESTED=true");
      expect(block).not.toContain("vercel deploy .");
      expect(block).not.toContain("vercel promote ");
    }
    expect(section.match(/vercel deploy \. --prod --skip-domain --yes --format=json --no-color/gu)).toHaveLength(1);
    expect(section).toMatch(/candidate procedure[^.]{0,180}unpaused/iu);
    expect(normalize(section)).toMatch(/raw API response[^.]{0,260}never[^.]{0,120}(?:stored|echoed|uploaded|evidence)/iu);
  });
});
