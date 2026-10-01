// quint rides on core stages it cannot edit: a blocking gate sensor plus
// prose fragments on functional-design, and prose on code-generation and
// ci-pipeline. These tests pin the core facts that design depends on, where the
// prose lands, and the check tool's verdicts against the real quint CLI.
import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { discoverPlugins } from "../../scripts/lib/plugins.ts";
import { REPO_ROOT } from "../../scripts/lib/paths.ts";
import { pinnedVersions } from "../../scripts/lib/runtime.ts";
import { composedStage, coreStage, installAndSync, stepSection } from "../../test/support/core.ts";
import { extractFromMarkdown, resolveConfig } from "../tools/quint-check.ts";

const plugin = discoverPlugins().find((p) => p.key === "quint")!;
const TOOL = join(plugin.dir, "tools", "quint-check.ts");
const FIXTURES = join(plugin.dir, "tests", "fixtures");
const QUINT_BIN = join(REPO_ROOT, "node_modules", ".bin", "quint");
// Absolute, so a test can replace PATH without losing bun itself.
const BUN = spawnSync("bun", ["-e", "console.log(process.execPath)"], { encoding: "utf-8" }).stdout.trim();
const fixture = (name: string) => readFileSync(join(FIXTURES, `${name}.md`), "utf-8");

function runTool(args: string[], env: Record<string, string> = {}, cwd = REPO_ROOT) {
  const result = spawnSync(BUN, [TOOL, ...args], {
    cwd,
    encoding: "utf-8",
    env: { ...process.env, QUINT_BIN, ...env },
  });
  const line = (result.stdout ?? "").trim().split("\n").pop() ?? "";
  return { status: result.status, verdict: line ? JSON.parse(line) : null, stderr: result.stderr };
}

function block(stage: string, anchor: string): { start: number; end: number; text: string } {
  const open = new RegExp(`<!-- plugin:quint:${anchor}:200:([0-9a-f]+) -->`, "g");
  const matches = [...stage.matchAll(open)];
  expect(matches, `exactly one ${anchor} block`).toHaveLength(1);
  const [match] = matches;
  const close = `<!-- /plugin:quint:${anchor}:200:${match[1]} -->`;
  const end = stage.indexOf(close, match.index);
  expect(end, `${anchor} close marker`).toBeGreaterThan(match.index);
  return { start: match.index, end: end + close.length, text: stage.slice(match.index, end) };
}

function headingIndex(stage: string, pattern: RegExp): number {
  const match = pattern.exec(stage);
  if (!match) throw new Error(`heading ${pattern} not found`);
  return match.index;
}

describe("quint-check tool", () => {
  it("reads the Applicability line and the spec from functional-spec.md", () => {
    const extracted = extractFromMarkdown(fixture("passing"));
    expect(extracted.applicable).toBe(true);
    if (!extracted.applicable) return;
    expect(extracted.source).toMatch(/^module inventory \{/);
    expect(extracted.config).toEqual({
      invariants: ["inv_conservation", "inv_nonNegative"],
      seed: "0x2a",
      maxSamples: 200,
      maxSteps: 20,
    });
  });

  it("accepts not-applicable only with a reason", () => {
    expect(extractFromMarkdown(fixture("not-applicable"))).toMatchObject({ applicable: false });
    const noReason = fixture("not-applicable").replace(/^(Applicability: not-applicable).*$/m, "$1");
    expect(() => extractFromMarkdown(noReason)).toThrow(/needs a reason/);
  });

  it("rejects a functional-spec.md without the section", () => {
    expect(() => extractFromMarkdown(fixture("missing-section"))).toThrow(/no "## Quint Behavior Check" section/);
  });

  it("requires maxSamples, since a seeded run without it simulates one trace", () => {
    const withoutSamples = fixture("passing").replace(/,\n\s*"maxSamples": 200/, "");
    expect(() => extractFromMarkdown(withoutSamples)).toThrow(/maxSamples/);
  });

  it("refuses a configuration that leaves a declared inv_ unchecked", () => {
    const extracted = extractFromMarkdown(fixture("dropped-invariant"));
    if (!extracted.applicable) throw new Error("fixture must be applicable");
    expect(() => resolveConfig(extracted.source, extracted.config, {})).toThrow(/inv_nonNegative/);
  });

  it.each([
    ["passing", 0, true, "ok"],
    ["violating", 1, false, "simulate"],
    ["type-error", 1, false, "typecheck"],
    ["dropped-invariant", 1, false, "extract"],
    ["not-applicable", 0, true, "ok"],
    ["missing-section", 1, false, "applicability"],
  ])("direct mode: %s exits %i", (name, status, pass, phase) => {
    const { status: actual, verdict } = runTool(["--file", join(FIXTURES, `${name}.md`)]);
    expect(actual).toBe(status);
    expect(verdict).toMatchObject({ pass, phase });
  });

  it("names the violated invariant run in the verdict", () => {
    const { verdict } = runTool(["--file", join(FIXTURES, "violating.md")]);
    expect(verdict.reason).toBe("invariant violated");
    expect(verdict.command).toContain("--backend typescript --seed 0x2a --max-samples 200 --max-steps 20");
    expect(verdict.output).toMatch(/\[violation\]/);
  });

  it("sensor mode always exits 0 and carries the verdict in JSON", () => {
    const { status, verdict } = runTool([
      "--stage",
      "functional-design",
      "--output-path",
      join(FIXTURES, "violating.md"),
    ]);
    expect(status).toBe(0);
    expect(verdict).toMatchObject({ pass: false, phase: "simulate", stage: "functional-design" });
  });

  it("exits 127 (tool-unavailable) when quint cannot be found and the check applies", () => {
    // An empty cwd: the tool also looks for ./node_modules/.bin/quint.
    const cwd = mkdtempSync(join(tmpdir(), "quint-missing-"));
    try {
      const { status } = runTool(
        ["--file", join(FIXTURES, "passing.md")],
        { QUINT_BIN: "/nonexistent/quint", PATH: "/nonexistent" },
        cwd,
      );
      expect(status).toBe(127);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});

describe.each(pinnedVersions())("aidlc %s", (version) => {
  describe("core premises", () => {
    const functionalDesign = coreStage(version, "construction/functional-design.md");
    const codeGeneration = coreStage(version, "construction/code-generation.md");
    const ciPipeline = coreStage(version, "construction/ci-pipeline.md");

    it("functional-design is per-unit and produces functional-spec.md, where the section lives", () => {
      expect(functionalDesign).toMatch(/^for_each: unit-of-work$/m);
      expect(functionalDesign).toMatch(/^ {2}- functional-spec$/m);
      expect(stepSection(functionalDesign, 4)).toContain("**functional-spec.md**");
    });

    it("functional-design Step 6 is the approval gate the blocking sensor guards", () => {
      expect(stepSection(functionalDesign, 6)).toMatch(/Approval gate: strictly 2-option/);
    });

    it("functional-design forbids code, which the fragment exempts the quint block from", () => {
      expect(stepSection(functionalDesign, 4)).toContain("No code, no SQL, no framework references.");
      expect(functionalDesign).toContain("Limit code to short illustrative snippets");
    });

    it("code-generation Step 2 still plans tests under a Testing Contract", () => {
      const step2 = stepSection(codeGeneration, 2);
      expect(step2).toMatch(/^### Step 2: PART 1 — Planning$/m);
      expect(step2).toContain("**Test files are MANDATORY in the plan.**");
      expect(step2).toContain("Testing Contract");
      expect(step2).toContain("unit-test-instructions.md");
    });

    it("ci-pipeline Step 4 still creates the CI configuration and quality gates", () => {
      const step4 = stepSection(ciPipeline, 4);
      expect(step4).toMatch(/^### Step 4: Generate Artifacts$/m);
      expect(step4).toContain("quality gate definitions");
    });
  });

  describe("installed project", () => {
    const project = installAndSync(version, [plugin]);
    afterAll(() => rmSync(project, { recursive: true, force: true }));

    it("wires quint-check into functional-design as a blocking gate sensor on functional-spec.md", () => {
      const graph = JSON.parse(readFileSync(join(project, ".claude", "tools", "data", "stage-graph.json"), "utf-8")) as Array<{
        slug: string;
        sensors_applicable?: Array<{ id: string; fire_on: string; default_severity: string; matches?: string }>;
      }>;
      const stage = graph.find((s) => s.slug === "functional-design")!;
      expect(stage.sensors_applicable).toContainEqual({
        id: "quint-check",
        path: ".claude/sensors/aidlc-quint-check.md",
        fire_on: "gate",
        default_severity: "blocking",
        category: "design-check",
        matches: "**/functional-design/functional-spec.md",
      });
    });

    it("places the check procedure between Step 4 and Step 5 of functional-design", () => {
      const stage = composedStage(project, "construction/functional-design.md");
      const { start, end, text } = block(stage, "after-step:4");
      expect(start).toBeGreaterThan(headingIndex(stage, /^### Step 4\b/m));
      expect(end).toBeLessThan(headingIndex(stage, /^### Step 5\b/m));
      expect(text).toContain("## Quint Behavior Check");
      expect(text).toContain("bun .claude/tools/quint-check.ts --file");
    });

    it("places the review points between Step 5 and Step 6 of functional-design", () => {
      const stage = composedStage(project, "construction/functional-design.md");
      const { start, end } = block(stage, "after-step:5");
      expect(start).toBeGreaterThan(headingIndex(stage, /^### Step 5\b/m));
      expect(end).toBeLessThan(headingIndex(stage, /^### Step 6\b/m));
    });

    it("places the replay plan between Step 2 and Step 3 of code-generation", () => {
      const stage = composedStage(project, "construction/code-generation.md");
      const { start, end } = block(stage, "after-step:2");
      expect(start).toBeGreaterThan(headingIndex(stage, /^### Step 2\b/m));
      expect(end).toBeLessThan(headingIndex(stage, /^### Step 3\b/m));
    });

    it("places the CI workflows between Step 4 and Step 5 of ci-pipeline", () => {
      const stage = composedStage(project, "construction/ci-pipeline.md");
      const { start, end } = block(stage, "after-step:4");
      expect(start).toBeGreaterThan(headingIndex(stage, /^### Step 4\b/m));
      expect(end).toBeLessThan(headingIndex(stage, /^### Step 5\b/m));
    });

    it("does not add numbered step headings that would shift core anchors", () => {
      const stage = composedStage(project, "construction/functional-design.md");
      const numbered = [...stage.matchAll(/^### Step (\d+)\b/gm)].map((m) => Number(m[1]));
      expect(numbered).toEqual([1, 2, 3, 4, 5, 6]);
    });

    it.each([
      ["passing", "passed"],
      ["violating", "failed"],
      ["not-applicable", "passed"],
    ])("the engine's sensor dispatcher reports %s as %s", (name, result) => {
      const dir = join(project, "fixture", name, "functional-design");
      mkdirSync(dir, { recursive: true });
      const output = join(dir, "functional-spec.md");
      cpSync(join(FIXTURES, `${name}.md`), output);
      const fire = spawnSync(
        BUN,
        [join(project, ".claude", "tools", "aidlc-sensor.ts"), "fire", "quint-check", "--stage", "functional-design", "--output-path", output],
        { cwd: project, encoding: "utf-8", env: { ...process.env, QUINT_BIN } },
      );
      expect(fire.status).toBe(0);
      const verdict = JSON.parse(fire.stdout.trim().split("\n").pop()!);
      expect(verdict).toMatchObject({ sensor_id: "quint-check", result });
      expect(verdict.note).toBeUndefined();
    });
  });
});
