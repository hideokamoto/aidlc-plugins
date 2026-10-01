// alloy-check.ts — one CLI for the alloy-check gate sensor, Chunk, and CI.
//
// The check lives in the unit's functional-spec.md, as a section:
//
//   ## Alloy Structural Check
//   Applicability: applicable            (or: not-applicable — <reason>)
//   ### Model                            one ```alloy block with sigs, facts,
//                                        asserts, and their check/run commands
//
// Sensor mode (the engine's gate dispatcher):
//   alloy-check.ts --stage <slug> --output-path <functional-spec.md>
//     Always exits 0 with a JSON verdict on stdout, except 127 when Java or the
//     Alloy JAR is missing and 2 on a usage error (aidlc-sensor.ts truth table:
//     127 = tool-unavailable, other non-zero = script-error).
//
// Direct mode (Chunk named commands, CI, humans):
//   alloy-check.ts --file <functional-spec.md | model.als>
//     Exits 0 on pass, 1 on fail, 127 when Java or the JAR is missing, 2 on a
//     usage error. Prints the same JSON verdict.
//
// A model passes when:
//   - every `assert` has a `check` command,
//   - there is at least one `run` command,
//   - Alloy parses and type-checks it,
//   - no `check` finds a counterexample, and
//   - every `run` finds an instance. A `run` without one means the facts
//     contradict each other, which makes every `check` pass vacuously.
//
// Alloy is run as `java -jar <jar> exec -f -q -t text -c '*' -o <dir> <model>`.
// `exec` exits 0 whether or not a counterexample exists; the verdict comes from
// the receipt.json it writes: a command with a `solution` entry found an
// instance (a counterexample for `check`, a witness for `run`).
//
// The JAR is resolved from $ALLOY_JAR, then ./.alloy/org.alloytools.alloy.dist.jar,
// then ~/.alloy/org.alloytools.alloy.dist.jar. Java from $JAVA_HOME/bin/java,
// then `java` on PATH.

import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";

export const SECTION_TITLE = "Alloy Structural Check";
export const JAR_NAME = "org.alloytools.alloy.dist.jar";
const OUTPUT_TAIL_LIMIT = 6 * 1024;
// The sensor manifest allows 300 s; stay below it so the dispatcher never has
// to kill the script.
const EXEC_TIMEOUT_MS = 240_000;

type Phase = "applicability" | "extract" | "parse" | "check" | "ok";

export interface CommandResult {
  name: string;
  type: "check" | "run";
  source: string;
  found: boolean;
}

export interface Verdict {
  pass: boolean;
  phase: Phase;
  file: string;
  stage?: string;
  applicable?: boolean;
  commands?: CommandResult[];
  counterexamples?: string[];
  vacuousRuns?: string[];
  command?: string;
  reason?: string;
  output?: string;
}

export interface Args {
  mode: "sensor" | "direct";
  stage: string;
  path: string;
}

class UsageError extends Error {}

export function parseArgs(argv: string[]): Args {
  let stage = "";
  let outputPath = "";
  let file = "";
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    const value = (): string => {
      const v = argv[++i];
      if (v === undefined) throw new UsageError(`${flag} needs a value`);
      return v;
    };
    switch (flag) {
      case "--stage": stage = value(); break;
      case "--output-path": outputPath = value(); break;
      case "--file": file = value(); break;
      default: throw new UsageError(`unknown flag: ${flag}`);
    }
  }
  if (outputPath && file) throw new UsageError("use either --output-path (sensor) or --file (direct), not both");
  if (outputPath) {
    if (!stage) throw new UsageError("--output-path requires --stage");
    return { mode: "sensor", stage, path: outputPath };
  }
  if (!file) throw new UsageError("missing --file <path> (or --stage with --output-path)");
  return { mode: "direct", stage, path: file };
}

// --- Markdown extraction ---------------------------------------------------

interface Line {
  text: string;
  inFence: boolean;
}

function scanLines(markdown: string): Line[] {
  const out: Line[] = [];
  let marker: string | null = null;
  for (const text of markdown.split(/\r?\n/)) {
    if (marker === null) {
      const open = /^ {0,3}(`{3,}|~{3,})/.exec(text);
      if (open) {
        marker = open[1];
        out.push({ text, inFence: true });
        continue;
      }
      out.push({ text, inFence: false });
    } else {
      out.push({ text, inFence: true });
      if (new RegExp(`^ {0,3}${marker[0]}{${marker.length},}\\s*$`).test(text)) marker = null;
    }
  }
  return out;
}

export function fencedBlocks(markdown: string): Array<{ info: string; body: string }> {
  const blocks: Array<{ info: string; body: string }> = [];
  const lines = markdown.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const open = /^ {0,3}(`{3,}|~{3,})\s*([^\s`]*)/.exec(lines[i]);
    if (!open) continue;
    const marker = open[1];
    const close = new RegExp(`^ {0,3}${marker[0]}{${marker.length},}\\s*$`);
    const body: string[] = [];
    let j = i + 1;
    for (; j < lines.length && !close.test(lines[j]); j++) body.push(lines[j]);
    blocks.push({ info: open[2].toLowerCase(), body: body.join("\n") });
    i = j;
  }
  return blocks;
}

export function section(markdown: string, title: string, level = 2): string | null {
  const lines = scanLines(markdown);
  const wanted = `${"#".repeat(level)} ${title}`.toLowerCase();
  const start = lines.findIndex((l) => !l.inFence && l.text.trim().toLowerCase() === wanted);
  if (start === -1) return null;
  const stop = new RegExp(`^#{1,${level}}\\s`);
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((l) => !l.inFence && stop.test(l.text));
  return (end === -1 ? rest : rest.slice(0, end)).map((l) => l.text).join("\n");
}

export type Extracted = { applicable: false; reason: string } | { applicable: true; source: string };

export function extractFromMarkdown(markdown: string): Extracted {
  const body = section(markdown, SECTION_TITLE);
  if (body === null) {
    throw new Error(
      `no "## ${SECTION_TITLE}" section: every functional-spec.md must declare "Applicability: applicable" or "Applicability: not-applicable — <reason>" there`,
    );
  }
  const declared = /^Applicability:[ \t]*(applicable|not-applicable)\b[ \t:—–-]*([^\n]*)$/m.exec(
    scanLines(body).filter((l) => !l.inFence).map((l) => l.text).join("\n"),
  );
  if (!declared) {
    throw new Error(
      `"## ${SECTION_TITLE}" needs a line "Applicability: applicable" or "Applicability: not-applicable — <reason>"`,
    );
  }
  const models = fencedBlocks(body).filter((b) => b.info === "alloy" || b.info === "als");
  if (declared[1] === "not-applicable") {
    if (declared[2].trim().length === 0) throw new Error("not-applicable needs a reason on the same line");
    if (models.length > 0) throw new Error("the section says not-applicable but contains an ```alloy block");
    return { applicable: false, reason: declared[2].trim() };
  }
  if (models.length !== 1) throw new Error(`expected exactly one \`\`\`alloy block, found ${models.length}`);
  return { applicable: true, source: models[0].body };
}

/** Alloy source with `--`, `//`, and block comments blanked out. */
export function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "))
    .replace(/(--|\/\/).*$/gm, "");
}

/** Static shape rules that need no solver. Returns problems; empty when fine. */
export function shapeProblems(source: string): string[] {
  const code = stripComments(source);
  const asserts = [...code.matchAll(/\bassert\s+([A-Za-z_][\w'"]*)/g)].map((m) => m[1]);
  const checked = new Set(
    [...code.matchAll(/\bcheck\s+([A-Za-z_][\w'"]*)/g)].map((m) => m[1]),
  );
  const problems: string[] = [];
  const unchecked = asserts.filter((name) => !checked.has(name));
  if (asserts.length === 0) problems.push("the model has no `assert`: there is nothing to check");
  if (unchecked.length > 0) problems.push(`asserts without a check command: ${unchecked.join(", ")}`);
  if (!/\brun\b/.test(code)) {
    problems.push("the model needs at least one `run` command, so contradictory facts cannot make every check pass vacuously");
  }
  return problems;
}

// --- Alloy invocation ------------------------------------------------------

function tail(text: string): string {
  return text.length > OUTPUT_TAIL_LIMIT ? text.slice(text.length - OUTPUT_TAIL_LIMIT) : text;
}

export function resolveJava(): string | null {
  const candidates = [process.env.JAVA_HOME ? join(process.env.JAVA_HOME, "bin", "java") : "", "java"].filter(Boolean);
  for (const candidate of candidates) {
    const probe = spawnSync(candidate, ["-version"], { encoding: "utf-8", timeout: 30_000 });
    if (!probe.error && probe.status === 0) return candidate;
  }
  return null;
}

export function resolveJar(): string | null {
  const candidates = [
    process.env.ALLOY_JAR ?? "",
    resolve(".alloy", JAR_NAME),
    join(homedir(), ".alloy", JAR_NAME),
  ].filter(Boolean);
  return candidates.find((path) => existsSync(path)) ?? null;
}

interface Receipt {
  commands?: Record<string, { type?: string; source?: string; solution?: unknown[] }>;
}

export function judgeReceipt(receipt: Receipt): Pick<Verdict, "commands" | "counterexamples" | "vacuousRuns"> {
  const commands: CommandResult[] = Object.entries(receipt.commands ?? {}).map(([name, c]) => ({
    name,
    type: c.type === "run" ? "run" : "check",
    source: c.source ?? name,
    found: Array.isArray(c.solution) && c.solution.length > 0,
  }));
  return {
    commands,
    counterexamples: commands.filter((c) => c.type === "check" && c.found).map((c) => c.source),
    vacuousRuns: commands.filter((c) => c.type === "run" && !c.found).map((c) => c.source),
  };
}

/** The model's relations and skolem witnesses from a text solution, without the built-in sets. */
export function solutionText(path: string): string {
  if (!existsSync(path)) return `(no solution file at ${path})`;
  return readFileSync(path, "utf-8")
    .split(/\r?\n/)
    .filter((line) => !/^(univ|Int|seq\/Int|String|none)=/.test(line) && !/^-+(Trace|State \d+.*)-+$/.test(line))
    .join("\n")
    .trim();
}

function check(java: string, jar: string, source: string, base: Verdict): Verdict {
  const work = mkdtempSync(join(tmpdir(), "alloy-check-"));
  try {
    const model = join(work, "model.als");
    const out = join(work, "out");
    writeFileSync(model, source.endsWith("\n") ? source : `${source}\n`);
    // Text output: the verdict comes from receipt.json, which exec writes for
    // every output type, while the instance is shown from the text solution.
    // The instance values inside receipt.json are not reliable in 6.2.0 (atoms
    // shifted by one index, `one` fields shown empty).
    const argv = ["-jar", jar, "exec", "-f", "-q", "-t", "text", "-c", "*", "-o", out, model];
    const command = `java -jar ${JAR_NAME} exec -f -q -t text -c '*' -o out model.als`;
    const result = spawnSync(java, argv, { encoding: "utf-8", timeout: EXEC_TIMEOUT_MS, maxBuffer: 32 * 1024 * 1024 });
    const output = tail(
      `${result.stdout ?? ""}\n${result.stderr ?? ""}`
        .split(/\r?\n/)
        .filter((line) => !line.startsWith("Picked up JAVA_TOOL_OPTIONS"))
        .join("\n")
        .trim(),
    );
    if ((result.error as NodeJS.ErrnoException | undefined)?.code === "ETIMEDOUT") {
      return { ...base, pass: false, phase: "check", command, reason: "alloy exec timed out", output };
    }
    const receiptPath = join(out, "receipt.json");
    if (result.status !== 0 || !existsSync(receiptPath)) {
      return { ...base, pass: false, phase: "parse", command, reason: "alloy could not parse or type-check the model", output };
    }
    const receipt = JSON.parse(readFileSync(receiptPath, "utf-8")) as Receipt;
    const judged = judgeReceipt(receipt);
    const failures: string[] = [];
    if (judged.counterexamples!.length > 0) failures.push(`counterexample found: ${judged.counterexamples!.join("; ")}`);
    if (judged.vacuousRuns!.length > 0) failures.push(`no instance (facts may contradict): ${judged.vacuousRuns!.join("; ")}`);
    if (failures.length === 0) return { ...base, pass: true, phase: "ok", command, ...judged };
    const counterexampleText = Object.entries(receipt.commands ?? {})
      .filter(([, c]) => c.type === "check" && Array.isArray(c.solution) && c.solution.length > 0)
      .map(([name]) => `--- ${name} ---\n${solutionText(join(out, `${name}-solution-0.txt`))}`)
      .join("\n");
    return {
      ...base,
      pass: false,
      phase: "check",
      command,
      ...judged,
      reason: failures.join(" | "),
      output: counterexampleText.slice(0, OUTPUT_TAIL_LIMIT),
    };
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

// --- main ------------------------------------------------------------------

export function main(argv: string[]): number {
  let args: Args;
  try {
    args = parseArgs(argv);
  } catch (error) {
    process.stderr.write(`${(error as Error).message}\n`);
    return 2;
  }
  const path = resolve(args.path);
  const base: Verdict = { pass: false, phase: "extract", file: path, ...(args.stage ? { stage: args.stage } : {}) };
  const emit = (verdict: Verdict): number => {
    process.stdout.write(`${JSON.stringify(verdict)}\n`);
    if (args.mode === "sensor") return 0;
    return verdict.pass ? 0 : 1;
  };

  if (!existsSync(path)) return emit({ ...base, reason: `file not found: ${path}` });

  let extracted: Extracted;
  try {
    const text = readFileSync(path, "utf-8");
    extracted = path.endsWith(".als") ? { applicable: true, source: text } : extractFromMarkdown(text);
  } catch (error) {
    return emit({ ...base, phase: "applicability", reason: (error as Error).message });
  }
  if (!extracted.applicable) {
    return emit({ ...base, pass: true, phase: "ok", applicable: false, reason: `not applicable: ${extracted.reason}` });
  }
  const problems = shapeProblems(extracted.source);
  if (problems.length > 0) return emit({ ...base, applicable: true, reason: problems.join(" | ") });

  const java = resolveJava();
  const jar = resolveJar();
  if (java === null || jar === null) {
    process.stderr.write(
      `alloy-unavailable: ${java === null ? "java not found" : `Alloy JAR not found ($ALLOY_JAR, ./.alloy/${JAR_NAME}, ~/.alloy/${JAR_NAME})`}; run \`bun .claude/tools/alloy-doctor.ts\`\n`,
    );
    return 127;
  }
  return emit(check(java, jar, extracted.source, { ...base, applicable: true }));
}

if (import.meta.main) process.exit(main(process.argv.slice(2)));
