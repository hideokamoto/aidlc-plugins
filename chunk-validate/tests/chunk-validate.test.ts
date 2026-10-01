// chunk-validate wraps `chunk validate <command>` as an AI-DLC sensor. These
// tests never run the real `chunk`: every spawn puts a stub `chunk` first on
// PATH (the real binary talks to a remote sidecar in the user's account).
// The stub records each invocation, so tests can tell a fresh run from a
// cache hit.
import { execFileSync, spawnSync } from "node:child_process";
import { appendFileSync, chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { discoverPlugins } from "../../scripts/lib/plugins.ts";
import { pinnedVersions } from "../../scripts/lib/runtime.ts";
import { installAndSync } from "../../test/support/core.ts";

const plugin = discoverPlugins().find((p) => p.key === "chunk-validate")!;
const TOOL = join(plugin.dir, "tools", "aidlc-sensor-chunk-validate.ts");
// Absolute, so a test can replace PATH without losing bun itself.
const BUN = spawnSync("bun", ["-e", "console.log(process.execPath)"], { encoding: "utf-8" }).stdout.trim();

const cleanup: string[] = [];
afterEach(() => {
  while (cleanup.length) rmSync(cleanup.pop()!, { recursive: true, force: true });
});

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  cleanup.push(dir);
  return dir;
}

interface Stub {
  /** PATH with the stub directory first. */
  path: string;
  /** Arguments of every `chunk validate ...` call so far. */
  validateCalls(): string[];
}

/** A fake `chunk`: answers `--version`, and `validate` with the given exit status after an optional sleep. */
function stubChunk(opts: { exit?: number; sleepSeconds?: number } = {}): Stub {
  const dir = tempDir("chunk-stub-");
  const log = join(dir, "calls.log");
  const script = [
    "#!/bin/sh",
    `echo "$*" >> '${log}'`,
    'if [ "$1" = "--version" ]; then echo "chunk stub 0.0.0"; exit 0; fi',
    // exec, so the timeout's SIGTERM reaches the sleeping process itself.
    opts.sleepSeconds ? `exec sleep ${opts.sleepSeconds}` : "",
    `echo "stub: chunk $*"`,
    `exit ${opts.exit ?? 0}`,
    "",
  ].join("\n");
  writeFileSync(join(dir, "chunk"), script);
  chmodSync(join(dir, "chunk"), 0o755);
  return {
    path: `${dir}:${process.env.PATH ?? ""}`,
    validateCalls: () =>
      existsSync(log)
        ? readFileSync(log, "utf-8")
            .split("\n")
            .filter((line) => line.startsWith("validate"))
        : [],
  };
}

/** A git repository with one committed source file. */
function gitProject(): string {
  const dir = tempDir("chunk-validate-project-");
  const git = (...args: string[]) => execFileSync("git", args, { cwd: dir, stdio: "ignore" });
  git("init", "-q");
  git("config", "user.email", "test@example.com");
  git("config", "user.name", "test");
  mkdirSync(join(dir, "src"));
  writeFileSync(join(dir, "src", "index.ts"), "export const a = 1;\n");
  git("add", ".");
  git("commit", "-q", "-m", "init");
  return dir;
}

function runTool(args: string[], cwd: string, env: Record<string, string>) {
  const result = spawnSync(BUN, [TOOL, ...args], {
    cwd,
    encoding: "utf-8",
    env: { ...process.env, AIDLC_CHUNK_VALIDATE_COMMAND: "", AIDLC_CHUNK_VALIDATE_TIMEOUT_MS: "", ...env },
  });
  const line = (result.stdout ?? "").trim().split("\n").pop() ?? "";
  return { status: result.status, stderr: result.stderr, verdict: line ? JSON.parse(line) : null };
}

describe("aidlc-sensor-chunk-validate script", () => {
  it("accepts --output-path, the flag the engine dispatcher passes to plugin sensors", () => {
    const project = gitProject();
    const stub = stubChunk();
    const out = runTool(["--stage", "code-generation", "--output-path", join(project, "src", "index.ts")], project, {
      PATH: stub.path,
    });
    expect(out.stderr).not.toContain("unknown flag");
    expect(out.status).toBe(0);
    expect(out.verdict).toMatchObject({ pass: true, exitCode: 0, cached: false, stage: "code-generation" });
  });

  it("still accepts --file-path as an alias", () => {
    const project = gitProject();
    const stub = stubChunk();
    const out = runTool(["--stage", "code-generation", "--file-path", join(project, "src", "index.ts")], project, {
      PATH: stub.path,
    });
    expect(out.status).toBe(0);
    expect(out.verdict).toMatchObject({ pass: true });
  });

  it("reports a non-zero chunk exit as pass:false with the output tail", () => {
    const project = gitProject();
    const stub = stubChunk({ exit: 1 });
    const out = runTool(["--stage", "code-generation", "--output-path", "src/index.ts"], project, { PATH: stub.path });
    expect(out.status).toBe(0);
    expect(out.verdict).toMatchObject({ pass: false, exitCode: 1 });
    expect(out.verdict.output).toContain("stub: chunk validate test");
  });

  it("exits 127 (tool-unavailable) when chunk is not on PATH", () => {
    const project = gitProject();
    const empty = tempDir("empty-path-");
    const out = runTool(["--stage", "code-generation", "--output-path", "src/index.ts"], project, { PATH: empty });
    expect(out.status).toBe(127);
  });

  it("reports a timed-out validation as pass:false, not as a script error", () => {
    const project = gitProject();
    const stub = stubChunk({ sleepSeconds: 30 });
    const started = Date.now();
    const out = runTool(["--stage", "code-generation", "--output-path", "src/index.ts"], project, {
      PATH: stub.path,
      AIDLC_CHUNK_VALIDATE_TIMEOUT_MS: "1000",
    });
    expect(Date.now() - started).toBeLessThan(20_000);
    expect(out.status).toBe(0);
    expect(out.verdict).toMatchObject({ pass: false, timedOut: true, cached: false });
    expect(out.verdict.output).toMatch(/timed out after 1s/);
  });

  it("does not cache a timed-out result", () => {
    const project = gitProject();
    const slow = stubChunk({ sleepSeconds: 30 });
    runTool(["--stage", "code-generation", "--output-path", "src/index.ts"], project, {
      PATH: slow.path,
      AIDLC_CHUNK_VALIDATE_TIMEOUT_MS: "1000",
    });
    const fast = stubChunk();
    const out = runTool(["--stage", "code-generation", "--output-path", "src/index.ts"], project, { PATH: fast.path });
    expect(out.verdict).toMatchObject({ pass: true, cached: false });
    expect(fast.validateCalls()).toHaveLength(1);
  });

  it("reuses the cached result when only the AI-DLC record tree changed", () => {
    const project = gitProject();
    const stub = stubChunk();
    const args = ["--stage", "code-generation", "--output-path", "src/index.ts"];
    expect(runTool(args, project, { PATH: stub.path }).verdict).toMatchObject({ cached: false });

    // What the engine does around every fire: append an audit row to an
    // untracked shard and write sensor detail files under the record.
    const record = join(project, "aidlc", "spaces", "default", "intents", "260101-demo");
    mkdirSync(join(record, "audit"), { recursive: true });
    appendFileSync(join(record, "audit", "host-1234.md"), "SENSOR_FIRED row\n");
    mkdirSync(join(record, ".aidlc-engine", "sensors", "code-generation"), { recursive: true });
    writeFileSync(join(record, ".aidlc-engine", "sensors", "code-generation", "chunk-validate-abcd1234.md"), "detail\n");

    expect(runTool(args, project, { PATH: stub.path }).verdict).toMatchObject({ pass: true, cached: true });
    expect(stub.validateCalls()).toHaveLength(1);

    // A real source change still invalidates the cache, tracked or untracked.
    writeFileSync(join(project, "src", "index.ts"), "export const a = 2;\n");
    expect(runTool(args, project, { PATH: stub.path }).verdict).toMatchObject({ cached: false });
    writeFileSync(join(project, "src", "extra.ts"), "export const b = 1;\n");
    expect(runTool(args, project, { PATH: stub.path }).verdict).toMatchObject({ cached: false });
    expect(stub.validateCalls()).toHaveLength(3);
  });

  it("runs the gate command named by AIDLC_CHUNK_VALIDATE_COMMAND and keys the cache on it", () => {
    const project = gitProject();
    const stub = stubChunk();
    const args = ["--stage", "code-generation", "--output-path", "src/index.ts"];
    expect(runTool(args, project, { PATH: stub.path }).verdict).toMatchObject({ cached: false });
    const unit = runTool(args, project, { PATH: stub.path, AIDLC_CHUNK_VALIDATE_COMMAND: "unit" });
    expect(unit.verdict).toMatchObject({ pass: true, cached: false });
    expect(stub.validateCalls()).toEqual(["validate test", "validate unit"]);
    expect(runTool(args, project, { PATH: stub.path, AIDLC_CHUNK_VALIDATE_COMMAND: "unit" }).verdict).toMatchObject({
      cached: true,
    });
  });
});

describe.each(pinnedVersions())("aidlc %s installed project", (version) => {
  const project = installAndSync(version, [plugin]);
  afterAll(() => rmSync(project, { recursive: true, force: true }));
  // The project as a user has it: under git, with the sensor's cache in .git/.
  execFileSync("git", ["init", "-q"], { cwd: project });
  execFileSync("git", ["-c", "user.email=t@example.com", "-c", "user.name=t", "add", "."], { cwd: project });
  execFileSync("git", ["-c", "user.email=t@example.com", "-c", "user.name=t", "commit", "-q", "-m", "init"], {
    cwd: project,
  });
  const source = join(project, "src", "index.ts");
  mkdirSync(join(project, "src"), { recursive: true });

  function fire(stub: Stub) {
    const result = spawnSync(
      BUN,
      [join(project, ".claude", "tools", "aidlc-sensor.ts"), "fire", "chunk-validate", "--stage", "code-generation", "--output-path", source],
      { cwd: project, encoding: "utf-8", env: { ...process.env, PATH: stub.path, AIDLC_CHUNK_VALIDATE_COMMAND: "" } },
    );
    expect(result.status, result.stderr).toBe(0);
    return JSON.parse(result.stdout.trim().split("\n").pop()!);
  }

  it.each([
    [1, "failed"],
    [0, "passed"],
  ])("the engine's sensor dispatcher reports chunk exit %i as %s", (exit, result) => {
    // A distinct source per case, so the second case cannot hit the first's cache.
    writeFileSync(source, `export const exit = ${exit};\n`);
    const stub = stubChunk({ exit });
    const verdict = fire(stub);
    expect(verdict).toMatchObject({ sensor_id: "chunk-validate", result });
    expect(verdict.note).toBeUndefined();
    expect(stub.validateCalls()).toEqual(["validate test"]);
  });

  it("hits the cache on a second fire despite the audit rows the first fire wrote", () => {
    writeFileSync(source, "export const cached = true;\n");
    const stub = stubChunk();
    expect(fire(stub)).toMatchObject({ result: "passed" });
    expect(fire(stub)).toMatchObject({ result: "passed" });
    expect(stub.validateCalls()).toHaveLength(1);
  });
});
