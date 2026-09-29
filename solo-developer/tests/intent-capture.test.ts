// solo-developer only appends prose to intent-capture; it cannot delete core
// text. Its fragments are therefore written against specific core wording:
// the three stakeholder questions in Step 2 and the stakeholder-map contract in
// Step 4. These tests fail when a core release changes that wording or moves
// the steps, even when the heading anchors still resolve and compose reports
// no drop.
import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { discoverPlugins } from "../../scripts/lib/plugins.ts";
import { pinnedVersions } from "../../scripts/lib/runtime.ts";
import { composedStage, coreStage, installAndSync, stepSection } from "../../test/support/core.ts";

const plugin = discoverPlugins().find((p) => p.key === "solo-developer")!;
const PLUGIN_DIR = plugin.dir;
const STAGE = "ideation/intent-capture.md";
const contribution = readFileSync(join(PLUGIN_DIR, "contributions", STAGE), "utf-8");

/** Core question lines the fragment tells the agent to skip, quoted verbatim in backticks. */
const skippedQuestions = [...contribution.matchAll(/`([^`]+\?)`/g)].map((m) => m[1]);

function block(stage: string, anchor: string): { start: number; end: number; text: string } {
  const open = new RegExp(`<!-- plugin:solo-developer:${anchor}:100:([0-9a-f]+) -->`, "g");
  const matches = [...stage.matchAll(open)];
  expect(matches, `exactly one ${anchor} block`).toHaveLength(1);
  const [match] = matches;
  const close = `<!-- /plugin:solo-developer:${anchor}:100:${match[1]} -->`;
  const end = stage.indexOf(close, match.index);
  expect(end, `${anchor} close marker`).toBeGreaterThan(match.index);
  return { start: match.index, end: end + close.length, text: stage.slice(match.index, end) };
}

function headingIndex(stage: string, pattern: RegExp): number {
  const match = pattern.exec(stage);
  if (!match) throw new Error(`heading ${pattern} not found`);
  return match.index;
}

describe.each(pinnedVersions())("aidlc %s", (version) => {
  describe("core premises", () => {
    const core = coreStage(version, STAGE);

    it("quotes exactly three stakeholder questions from the contribution", () => {
      expect(skippedQuestions).toHaveLength(3);
    });

    it("still asks those questions in Step 2", () => {
      const step2 = stepSection(core, 2);
      expect(step2).toMatch(/^### Step 2: Generate Clarifying Questions$/m);
      for (const question of skippedQuestions) {
        expect(step2).toContain(`- ${question}`);
      }
    });

    it("still registers memory rules as [memory:M<n>] sources in Step 2", () => {
      expect(stepSection(core, 2)).toContain("- [memory:M<n>] `aidlc/spaces/<active-space>/memory/{org,team,project}.md#<exact H2 heading>`");
    });

    it("still builds stakeholder-map.md with a Source column in Step 4", () => {
      const step4 = stepSection(core, 4);
      expect(step4).toMatch(/^### Step 4: Generate Artifacts$/m);
      expect(step4).toContain("stakeholder-map.md");
      expect(step4).toContain("`Source`");
      expect(step4).toContain("registered `[memory:M<n>]` entries");
    });
  });

  describe("composed stage", () => {
    const project = installAndSync(version, [plugin]);
    afterAll(() => rmSync(project, { recursive: true, force: true }));
    const stage = composedStage(project, STAGE);

    it("places the question-skipping prose between Step 2 and Step 3", () => {
      const { start, end, text } = block(stage, "after-step:2");
      expect(start).toBeGreaterThan(headingIndex(stage, /^### Step 2\b/m));
      expect(end).toBeLessThan(headingIndex(stage, /^### Step 3\b/m));
      for (const question of skippedQuestions) expect(text).toContain(question);
    });

    it("places the stakeholder-map prose between Step 4 and Step 5", () => {
      const { start, end, text } = block(stage, "after-step:4");
      expect(start).toBeGreaterThan(headingIndex(stage, /^### Step 4\b/m));
      expect(end).toBeLessThan(headingIndex(stage, /^### Step 5\b/m));
      expect(text).toContain("stakeholder-map.md");
    });

    it("does not add a numbered step heading that would shift core step anchors", () => {
      const numbered = [...stage.matchAll(/^### Step (\d+)\b/gm)].map((m) => Number(m[1]));
      expect(numbered).toEqual([1, 2, 3, 4, 5, 6, 7]);
    });
  });
});
