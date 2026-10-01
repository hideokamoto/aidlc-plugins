// alloy rides on core stages it cannot edit: a blocking gate sensor plus
// prose fragments on functional-design, and prose on code-generation. These
// tests pin the core facts that design depends on, where the prose lands, and
// the check tool's verdicts against the real Alloy 6.2.0 JAR.
import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { discoverPlugins } from "../../scripts/lib/plugins.ts";
import { REPO_ROOT } from "../../scripts/lib/paths.ts";
import { pinnedVersions } from "../../scripts/lib/runtime.ts";
import { fetchAlloyJar } from "../../test/support/alloy.ts";
import { composedStage, coreStage, installAndSync, stepSection } from "../../test/support/core.ts";
import { extractFromMarkdown, judgeReceipt, shapeProblems, stripComments } from "../tools/alloy-check.ts";

const plugin = discoverPlugins().find((p) => p.key === "alloy")!;
const TOOL = join(plugin.dir, "tools", "alloy-check.ts");
const FIXTURES = join(plugin.dir, "tests", "fixtures");
// Absolute, so a test can replace PATH without losing bun itself.
const BUN = spawnSync("bun", ["-e", "console.log(process.execPath)"], { encoding: "utf-8" }).stdout.trim();
const fixture = (name: string) => readFileSync(join(FIXTURES, `${name}.md`), "utf-8");

let ALLOY_JAR = "";
beforeAll(() => {
  ALLOY_JAR = fetchAlloyJar();
  const java = spawnSync("java", ["-version"], { encoding: "utf-8" });
  if (java.error || java.status !== 0) throw new Error("these tests need a Java runtime on PATH");
}, 120_000);

function runTool(args: string[], env: Record<string, string> = {}, cwd = REPO_ROOT) {
  const result = spawnSync(BUN, [TOOL, ...args], {
    cwd,
    encoding: "utf-8",
    env: { ...process.env, ALLOY_JAR, ...env },
  });
  const line = (result.stdout ?? "").trim().split("\n").pop() ?? "";
  return { status: result.status, verdict: line ? JSON.parse(line) : null };
}

function block(stage: string, anchor: string): { start: number; end: number; text: string } {
  const open = new RegExp(`<!-- plugin:alloy:${anchor}:100:([0-9a-f]+) -->`, "g");
  const matches = [...stage.matchAll(open)];
  expect(matches, `exactly one ${anchor} block`).toHaveLength(1);
  const [match] = matches;
  const close = `<!-- /plugin:alloy:${anchor}:100:${match[1]} -->`;
  const end = stage.indexOf(close, match.index);
  expect(end, `${anchor} close marker`).toBeGreaterThan(match.index);
  return { start: match.index, end: end + close.length, text: stage.slice(match.index, end) };
}

function headingIndex(stage: string, pattern: RegExp): number {
  const match = pattern.exec(stage);
  if (!match) throw new Error(`heading ${pattern} not found`);
  return match.index;
}

describe("alloy-check tool", () => {
  it("reads the Applicability line and the model from functional-spec.md", () => {
    const extracted = extractFromMarkdown(fixture("passing"));
    expect(extracted.applicable).toBe(true);
    if (extracted.applicable) expect(extracted.source).toContain("assert OnlyOwnerOrTeamCanEdit");
  });

  it("accepts not-applicable only with a reason", () => {
    expect(extractFromMarkdown(fixture("not-applicable"))).toMatchObject({ applicable: false });
    const noReason = fixture("not-applicable").replace(/^(Applicability: not-applicable).*$/m, "$1");
    expect(() => extractFromMarkdown(noReason)).toThrow(/needs a reason/);
  });

  it("rejects a functional-spec.md without the section", () => {
    expect(() => extractFromMarkdown(fixture("missing-section"))).toThrow(/no "## Alloy Structural Check" section/);
  });

  it("requires a check for every assert and at least one run", () => {
    expect(shapeProblems("sig A {}\nassert X { no A }\nrun {}")).toEqual(["asserts without a check command: X"]);
    expect(shapeProblems("sig A {}\nassert X { no A }\ncheck X")).toEqual([
      "the model needs at least one `run` command, so contradictory facts cannot make every check pass vacuously",
    ]);
    expect(shapeProblems("sig A {}\nrun {}")).toEqual(["the model has no `assert`: there is nothing to check"]);
  });

  it("ignores commands that only appear in comments", () => {
    expect(stripComments("-- check X\n// run Y\n/* check Z */ sig A {}")).not.toMatch(/check|run/);
    expect(shapeProblems("sig A {}\nassert X { no A }\n-- check X\nrun {}")).toEqual(["asserts without a check command: X"]);
  });

  it("reads counterexamples and empty runs from receipt.json", () => {
    expect(
      judgeReceipt({
        commands: {
          Ok: { type: "check", source: "check Ok for 3" },
          Bad: { type: "check", source: "check Bad for 3", solution: [{}] },
          Empty: { type: "run", source: "run Empty for 3" },
          Show: { type: "run", source: "run Show for 3", solution: [{}] },
        },
      }),
    ).toMatchObject({ counterexamples: ["check Bad for 3"], vacuousRuns: ["run Empty for 3"] });
  });

  it.each([
    ["passing", 0, true, "ok"],
    ["counterexample", 1, false, "check"],
    ["vacuous", 1, false, "check"],
    ["unchecked-assert", 1, false, "extract"],
    ["syntax-error", 1, false, "parse"],
    ["not-applicable", 0, true, "ok"],
    ["missing-section", 1, false, "applicability"],
  ])("direct mode: %s exits %i", (name, status, pass, phase) => {
    const { status: actual, verdict } = runTool(["--file", join(FIXTURES, `${name}.md`)]);
    expect(actual).toBe(status);
    expect(verdict).toMatchObject({ pass, phase });
  });

  it("reports the counterexample's witness for a combination bug", () => {
    const { verdict } = runTool(["--file", join(FIXTURES, "counterexample.md")]);
    expect(verdict.counterexamples).toEqual(["check OnlyOwnerOrTeamCanEdit for 4"]);
    expect(verdict.output).toContain("$OnlyOwnerOrTeamCanEdit_d");
  });

  it("reports contradictory facts instead of passing every check vacuously", () => {
    const { verdict } = runTool(["--file", join(FIXTURES, "vacuous.md")]);
    expect(verdict.counterexamples).toEqual([]);
    expect(verdict.vacuousRuns).toHaveLength(1);
  });

  it("sensor mode always exits 0 and carries the verdict in JSON", () => {
    const { status, verdict } = runTool([
      "--stage",
      "functional-design",
      "--output-path",
      join(FIXTURES, "counterexample.md"),
    ]);
    expect(status).toBe(0);
    expect(verdict).toMatchObject({ pass: false, phase: "check", stage: "functional-design" });
  });

  it("exits 127 (tool-unavailable) when the JAR cannot be found and the check applies", () => {
    // An empty cwd and HOME: the tool also looks in ./.alloy and ~/.alloy.
    const cwd = mkdtempSync(join(tmpdir(), "alloy-missing-"));
    try {
      const { status } = runTool(["--file", join(FIXTURES, "passing.md")], { ALLOY_JAR: "", HOME: cwd }, cwd);
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

    it("functional-design is per-unit and produces entities, rules, and functional-spec", () => {
      expect(functionalDesign).toMatch(/^for_each: unit-of-work$/m);
      for (const artifact of ["entities", "rules", "functional-spec"]) {
        expect(functionalDesign).toMatch(new RegExp(`^ {2}- ${artifact}$`, "m"));
      }
    });

    it("entities.md and rules.md still carry the inputs the model is written from", () => {
      const step4 = stepSection(functionalDesign, 4);
      expect(step4).toContain("relationships (cardinality + direction)");
      expect(step4).toContain("`BR{group}.{seq}`");
    });

    it("functional-design forbids code, which the fragment exempts the alloy block from", () => {
      expect(stepSection(functionalDesign, 4)).toContain("No code, no SQL, no framework references.");
    });

    it("code-generation Step 2 still plans tests under a Testing Contract", () => {
      const step2 = stepSection(codeGeneration, 2);
      expect(step2).toMatch(/^### Step 2: PART 1 — Planning$/m);
      expect(step2).toContain("Testing Contract");
      expect(step2).toContain("unit-test-instructions.md");
    });
  });

  describe("installed project", () => {
    const project = installAndSync(version, [plugin]);
    afterAll(() => rmSync(project, { recursive: true, force: true }));

    it("wires alloy-check into functional-design as a blocking gate sensor on functional-spec.md", () => {
      const graph = JSON.parse(readFileSync(join(project, ".claude", "tools", "data", "stage-graph.json"), "utf-8")) as Array<{
        slug: string;
        sensors_applicable?: unknown[];
      }>;
      const stage = graph.find((s) => s.slug === "functional-design")!;
      expect(stage.sensors_applicable).toContainEqual({
        id: "alloy-check",
        path: ".claude/sensors/aidlc-alloy-check.md",
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
      expect(text).toContain("## Alloy Structural Check");
    });

    it("places the review points between Step 5 and Step 6 of functional-design", () => {
      const stage = composedStage(project, "construction/functional-design.md");
      const { start, end } = block(stage, "after-step:5");
      expect(start).toBeGreaterThan(headingIndex(stage, /^### Step 5\b/m));
      expect(end).toBeLessThan(headingIndex(stage, /^### Step 6\b/m));
    });

    it("places the property-test plan between Step 2 and Step 3 of code-generation", () => {
      const stage = composedStage(project, "construction/code-generation.md");
      const { start, end, text } = block(stage, "after-step:2");
      expect(start).toBeGreaterThan(headingIndex(stage, /^### Step 2\b/m));
      expect(end).toBeLessThan(headingIndex(stage, /^### Step 3\b/m));
      expect(text).toContain("fast-check");
    });

    it.each([
      ["passing", "passed"],
      ["counterexample", "failed"],
      ["not-applicable", "passed"],
    ])("the engine's sensor dispatcher reports %s as %s", (name, result) => {
      const dir = join(project, "fixture", name, "functional-design");
      mkdirSync(dir, { recursive: true });
      const output = join(dir, "functional-spec.md");
      cpSync(join(FIXTURES, `${name}.md`), output);
      const fire = spawnSync(
        BUN,
        [join(project, ".claude", "tools", "aidlc-sensor.ts"), "fire", "alloy-check", "--stage", "functional-design", "--output-path", output],
        { cwd: project, encoding: "utf-8", env: { ...process.env, ALLOY_JAR } },
      );
      expect(fire.status).toBe(0);
      const verdict = JSON.parse(fire.stdout.trim().split("\n").pop()!);
      expect(verdict).toMatchObject({ sensor_id: "alloy-check", result });
      expect(verdict.note).toBeUndefined();
    });
  });
});
