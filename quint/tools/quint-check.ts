// quint-check.ts — one CLI for the quint-check gate sensor, Chunk, and CI.
//
// The check lives in the unit's functional-spec.md, as a section:
//
//   ## Quint Behavior Check
//   Applicability: applicable            (or: not-applicable — <reason>)
//   ### Specification                    one ```quint block, one module
//   ### Check configuration              one ```json block
//
// Sensor mode (the engine's gate dispatcher):
//   quint-check.ts --stage <slug> --output-path <functional-spec.md>
//     Always exits 0 with a JSON verdict on stdout, except 127 when quint is
//     not installed and 2 on a usage error (the dispatcher's truth table in
//     aidlc-sensor.ts: 127 = tool-unavailable, other non-zero = script-error).
//
// Direct mode (Chunk named commands, CI, humans):
//   quint-check.ts --file <functional-spec.md | spec.qnt> [options]
//     Exits 0 on pass, 1 on fail, 127 when quint is not installed, 2 on a
//     usage error. Prints the same JSON verdict.
//
// Options for direct mode (each overrides the check configuration):
//   --invariants a,b    invariant names (default for a .qnt: every `val inv_*`)
//   --seed <seed>       random seed (default for a .qnt: 0x2a)
//   --max-samples <n>   simulated traces (default for a .qnt: 1000)
//   --max-steps <n>     steps per trace (default for a .qnt: 20)
//   --out-itf <pattern> write traces as ITF, e.g. .quint-traces/u1/t_{seq}.itf.json
//   --n-traces <n>      how many traces --out-itf writes
//
// The backend is fixed to `--backend typescript`: the rust backend could not
// fetch its evaluator in the environment this plugin was built in.
//
// quint is resolved from $QUINT_BIN, then `quint` on PATH, then
// ./node_modules/.bin/quint in the working directory.

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

export const SECTION_TITLE = "Quint Behavior Check";
const OUTPUT_TAIL_LIMIT = 6 * 1024;
const TYPECHECK_TIMEOUT_MS = 60_000;
// The sensor manifest allows 300 s; stay below it so the dispatcher never has
// to kill the script.
const RUN_TIMEOUT_MS = 230_000;
const DEFAULTS = { seed: "0x2a", maxSamples: 1000, maxSteps: 20 };

type Phase = "applicability" | "extract" | "typecheck" | "simulate" | "ok";

export interface Verdict {
  pass: boolean;
  phase: Phase;
  file: string;
  stage?: string;
  applicable?: boolean;
  module?: string;
  invariants?: string[];
  seed?: string;
  maxSamples?: number;
  maxSteps?: number;
  command?: string;
  reason?: string;
  output?: string;
}

export interface Args {
  mode: "sensor" | "direct";
  stage: string;
  path: string;
  invariants?: string[];
  seed?: string;
  maxSamples?: number;
  maxSteps?: number;
  outItf?: string;
  nTraces?: number;
}

interface CheckConfig {
  invariants: string[];
  seed: string;
  maxSamples: number;
  maxSteps: number;
}

class UsageError extends Error {}

function positiveInt(flag: string, raw: string): number {
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1) throw new UsageError(`${flag} must be a positive integer, got "${raw}"`);
  return n;
}

export function parseArgs(argv: string[]): Args {
  let stage = "";
  let outputPath = "";
  let file = "";
  const options: Partial<Args> = {};
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
      case "--invariants": options.invariants = value().split(",").map((s) => s.trim()).filter(Boolean); break;
      case "--seed": options.seed = value(); break;
      case "--max-samples": options.maxSamples = positiveInt(flag, value()); break;
      case "--max-steps": options.maxSteps = positiveInt(flag, value()); break;
      case "--out-itf": options.outItf = value(); break;
      case "--n-traces": options.nTraces = positiveInt(flag, value()); break;
      default: throw new UsageError(`unknown flag: ${flag}`);
    }
  }
  if (outputPath && file) throw new UsageError("use either --output-path (sensor) or --file (direct), not both");
  if (outputPath) {
    if (!stage) throw new UsageError("--output-path requires --stage");
    return { ...options, mode: "sensor", stage, path: outputPath };
  }
  if (!file) throw new UsageError("missing --file <path> (or --stage with --output-path)");
  return { ...options, mode: "direct", stage, path: file };
}

// --- Markdown extraction ---------------------------------------------------

export interface Fence {
  info: string;
  body: string;
}

interface Line {
  text: string;
  inFence: boolean;
}

/** Lines tagged with whether they sit inside (or open/close) a fenced block. */
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

export function fencedBlocks(markdown: string): Fence[] {
  const blocks: Fence[] = [];
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

/**
 * Text under the first heading `<level × #> <title>` (outside code fences), up
 * to the next heading of the same or a higher level. null when absent.
 */
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

// Quint's lexer, as checked against quint 0.33.0: `//` runs to the end of the
// line (`///` doc comments included); a block comment `/* ... */` does not
// nest, the first `*/` closes it; a string is `"..."` with no escape
// sequences and may span lines, so `//` or `/*` inside one is not a comment.
const COMMENT_OR_STRING = /\/\/[^\n]*|\/\*[\s\S]*?(?:\*\/|$)|"[^"]*"?/g;

/**
 * The source with every comment and string literal replaced by spaces (line
 * breaks kept), so regex scans for declarations see only code.
 */
export function stripCommentsAndStrings(source: string): string {
  return source.replace(COMMENT_OR_STRING, (match) => match.replace(/[^\n]/g, " "));
}

export function moduleName(source: string): string | null {
  return /^\s*module\s+([A-Za-z_][A-Za-z0-9_]*)\s*\{/m.exec(stripCommentsAndStrings(source))?.[1] ?? null;
}

/** Every `val inv_*` / `def inv_*` name in the module, ignoring comments and strings. */
export function declaredInvariants(source: string): string[] {
  const code = stripCommentsAndStrings(source);
  return [...new Set([...code.matchAll(/\b(?:val|def)\s+(inv_[A-Za-z0-9_]*)\s*=/g)].map((m) => m[1]))];
}

export type Extracted =
  | { applicable: false; reason: string }
  | { applicable: true; source: string; config: Partial<CheckConfig> };

/** Parse the `## Quint Behavior Check` section. Throws with a reviewer-facing message. */
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
  const quint = fencedBlocks(body).filter((b) => b.info === "quint");
  if (declared[1] === "not-applicable") {
    if (declared[2].trim().length === 0) throw new Error("not-applicable needs a reason on the same line");
    if (quint.length > 0) throw new Error("the section says not-applicable but contains a ```quint block");
    return { applicable: false, reason: declared[2].trim() };
  }

  if (quint.length !== 1) throw new Error(`expected exactly one \`\`\`quint block, found ${quint.length}`);
  const configSection = section(body, "Check configuration", 3);
  const json = configSection === null ? [] : fencedBlocks(configSection).filter((b) => b.info === "json");
  if (json.length !== 1) {
    throw new Error(`expected exactly one \`\`\`json block under "### Check configuration", found ${json.length}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(json[0].body);
  } catch (error) {
    throw new Error(`check configuration is not valid JSON: ${(error as Error).message}`);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("check configuration must be a JSON object");
  }
  const raw = parsed as Record<string, unknown>;
  const config: Partial<CheckConfig> = {};
  if (raw.invariants !== undefined) {
    if (!Array.isArray(raw.invariants) || !raw.invariants.every((v) => typeof v === "string")) {
      throw new Error('"invariants" must be an array of names');
    }
    config.invariants = raw.invariants as string[];
  }
  if (raw.seed !== undefined) config.seed = String(raw.seed);
  for (const key of ["maxSamples", "maxSteps"] as const) {
    if (raw[key] === undefined) continue;
    if (!Number.isInteger(raw[key]) || (raw[key] as number) < 1) throw new Error(`"${key}" must be a positive integer`);
    config[key] = raw[key] as number;
  }
  if (config.maxSamples === undefined) {
    // quint run simulates exactly one trace when a seed is set and
    // --max-samples is not, so a missing value would silently weaken the gate.
    throw new Error('"maxSamples" is required: with a seed and no --max-samples, quint run simulates one trace');
  }
  return { applicable: true, source: quint[0].body, config };
}

export function resolveConfig(source: string, fromFile: Partial<CheckConfig>, args: Partial<Args>): CheckConfig {
  const declared = declaredInvariants(source);
  const invariants = args.invariants ?? fromFile.invariants ?? declared;
  if (invariants.length === 0) throw new Error("no invariants: declare `val inv_<name>` values or pass --invariants");
  for (const name of invariants) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) throw new Error(`invalid invariant name "${name}"`);
  }
  // Dropping an invariant from the configuration must not quietly stop
  // checking it: every declared inv_* has to be listed.
  const missing = declared.filter((name) => !invariants.includes(name));
  if (missing.length > 0) throw new Error(`invariants declared in the module but not checked: ${missing.join(", ")}`);
  return {
    invariants,
    seed: args.seed ?? fromFile.seed ?? DEFAULTS.seed,
    maxSamples: args.maxSamples ?? fromFile.maxSamples ?? DEFAULTS.maxSamples,
    maxSteps: args.maxSteps ?? fromFile.maxSteps ?? DEFAULTS.maxSteps,
  };
}

// --- quint invocation ------------------------------------------------------

function tail(text: string): string {
  return text.length > OUTPUT_TAIL_LIMIT ? text.slice(text.length - OUTPUT_TAIL_LIMIT) : text;
}

export function resolveQuint(): string | null {
  const candidates = [process.env.QUINT_BIN, "quint", resolve("node_modules", ".bin", "quint")].filter(
    (c): c is string => typeof c === "string" && c.length > 0,
  );
  for (const candidate of candidates) {
    const probe = spawnSync(candidate, ["--version"], { encoding: "utf-8", timeout: 30_000 });
    if (!probe.error && probe.status === 0) return candidate;
  }
  return null;
}

function runQuint(bin: string, argv: string[], timeout: number): { status: number | null; output: string; timedOut: boolean } {
  const result = spawnSync(bin, argv, { encoding: "utf-8", timeout, maxBuffer: 32 * 1024 * 1024 });
  return {
    status: result.status,
    output: tail(`${result.stdout ?? ""}\n${result.stderr ?? ""}`.trim()),
    timedOut: (result.error as NodeJS.ErrnoException | undefined)?.code === "ETIMEDOUT",
  };
}

function shellQuote(parts: string[]): string {
  return parts.map((p) => (/^[\w@%+=:,./{}-]+$/.test(p) ? p : `'${p.replace(/'/g, "'\\''")}'`)).join(" ");
}

function check(bin: string, source: string, config: CheckConfig, args: Args, base: Verdict): Verdict {
  const module = moduleName(source);
  if (!module) return { ...base, pass: false, phase: "extract", reason: "no `module <Name> {` declaration found" };
  const work = mkdtempSync(join(tmpdir(), "quint-check-"));
  try {
    // quint derives the main module from the file name, so name the file after it.
    const specPath = join(work, `${module}.qnt`);
    writeFileSync(specPath, source.endsWith("\n") ? source : `${source}\n`);
    const shared: Verdict = { ...base, module, ...config };

    const typecheck = runQuint(bin, ["typecheck", specPath], TYPECHECK_TIMEOUT_MS);
    if (typecheck.status !== 0) {
      return {
        ...shared,
        pass: false,
        phase: "typecheck",
        command: shellQuote(["quint", "typecheck", `${module}.qnt`]),
        reason: typecheck.timedOut ? "quint typecheck timed out" : "quint typecheck failed",
        output: typecheck.output,
      };
    }

    const runArgs = [
      "run",
      specPath,
      "--main",
      module,
      "--backend",
      "typescript",
      "--seed",
      config.seed,
      "--max-samples",
      String(config.maxSamples),
      "--max-steps",
      String(config.maxSteps),
    ];
    if (args.outItf) {
      const pattern = resolve(args.outItf);
      mkdirSync(dirname(pattern), { recursive: true });
      runArgs.push("--out-itf", pattern, "--n-traces", String(args.nTraces ?? 1));
    }
    // --invariants is variadic: it must come last or it swallows the next word.
    runArgs.push("--invariants", ...config.invariants);
    const run = runQuint(bin, runArgs, RUN_TIMEOUT_MS);
    const command = shellQuote(["quint", ...runArgs.map((a) => (a === specPath ? `${module}.qnt` : a))]);
    if (run.status === 0) return { ...shared, pass: true, phase: "ok", command, output: run.output };
    return {
      ...shared,
      pass: false,
      phase: "simulate",
      command,
      reason: run.timedOut
        ? "quint run timed out"
        : /\[violation\]|Invariant violated/i.test(run.output)
          ? "invariant violated"
          : "quint run failed",
      output: run.output,
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
    extracted = path.endsWith(".qnt") ? { applicable: true, source: text, config: {} } : extractFromMarkdown(text);
  } catch (error) {
    return emit({ ...base, phase: "applicability", reason: (error as Error).message });
  }
  if (!extracted.applicable) {
    return emit({ ...base, pass: true, phase: "ok", applicable: false, reason: `not applicable: ${extracted.reason}` });
  }
  let config: CheckConfig;
  try {
    config = resolveConfig(extracted.source, extracted.config, args);
  } catch (error) {
    return emit({ ...base, applicable: true, reason: (error as Error).message });
  }

  const bin = resolveQuint();
  if (bin === null) {
    process.stderr.write(
      "quint-unavailable: install it with `npm i -D @informalsystems/quint` or set QUINT_BIN; run `bun .claude/tools/quint-doctor.ts`\n",
    );
    return 127;
  }
  return emit(check(bin, extracted.source, config, args, { ...base, applicable: true }));
}

if (import.meta.main) process.exit(main(process.argv.slice(2)));
