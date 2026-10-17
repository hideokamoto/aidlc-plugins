import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildPlugin } from "../../scripts/lib/build.ts";
import type { Plugin } from "../../scripts/lib/plugins.ts";
import { fetchRuntime, runtimeShell, runtimeTool } from "../../scripts/lib/runtime.ts";

export interface ComposeResult {
  valid: boolean;
  errors: unknown[];
  warnings: unknown[];
  composedFiles: string[];
  changedFiles: string[];
  drops: unknown[];
  idempotent: boolean;
}

/** Copy the pristine project shell of `version` so a test can compose into it. */
export function freshProject(version: string): string {
  fetchRuntime(version);
  const project = mkdtempSync(join(tmpdir(), `aidlc-${version}-`));
  cpSync(runtimeShell(version), project, { recursive: true });
  return project;
}

/**
 * Compose one plugin into a fresh project with the release's own
 * aidlc-plugin-test tool: validate, compose, compile the stage graph, and
 * re-run to prove idempotence.
 */
export function compose(version: string, pluginDir: string): { project: string; result: ComposeResult } {
  const project = freshProject(version);
  let stdout: string;
  try {
    stdout = execFileSync(
      "bun",
      [runtimeTool(version, "aidlc-plugin-test.ts"), pluginDir, "--install", project, "--json"],
      { encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] },
    );
  } catch (error) {
    // The tool exits non-zero on findings but still prints its JSON report.
    stdout = String((error as { stdout?: string }).stdout ?? "");
    if (!stdout.trim()) throw error;
  }
  return { project, result: JSON.parse(stdout) as ComposeResult };
}

export interface Installation {
  project: string;
  /** Points the project's plugin tool at the temporary registry; `CLAUDE_PLUGIN_ROOT` is unset. */
  env: NodeJS.ProcessEnv;
  /** Install path of each plugin, keyed by plugin key. */
  roots: Map<string, string>;
}

/**
 * Install built plugins the way a user does: Claude Code records them in its
 * plugin registry. The registry and settings files are temporary, so the
 * machine's real Claude configuration is never read or written. Nothing is
 * composed yet.
 */
export function installPlugins(version: string, plugins: Plugin[]): Installation {
  const project = freshProject(version);
  const home = mkdtempSync(join(tmpdir(), "aidlc-claude-home-"));
  const registry: Record<string, Array<{ installPath: string; version: string }>> = {};
  const roots = new Map<string, string>();
  for (const plugin of plugins) {
    const installPath = join(home, "plugins", plugin.key);
    mkdirSync(join(home, "plugins"), { recursive: true });
    buildPlugin(version, plugin, installPath);
    registry[`${plugin.hostName}@aidlc-plugins`] = [{ installPath, version: plugin.manifest.version }];
    roots.set(plugin.key, installPath);
  }
  writeFileSync(join(home, "installed_plugins.json"), JSON.stringify({ version: 2, plugins: registry }));
  writeFileSync(join(home, "settings.json"), "{}");
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    AIDLC_HARNESS_DIR: ".claude",
    AIDLC_HARNESS_NAME: "claude",
    AIDLC_CLAUDE_PLUGIN_REGISTRY: join(home, "installed_plugins.json"),
    AIDLC_CLAUDE_SETTINGS: join(home, "settings.json"),
    CLAUDE_CONFIG_DIR: home,
  };
  delete env.CLAUDE_PLUGIN_ROOT;
  return { project, env, roots };
}

/**
 * Run the project's `aidlc-plugin.ts sync` once without `CLAUDE_PLUGIN_ROOT`:
 * it reads the registry and composes every installed plugin in one run.
 */
export function syncAll({ project, env, roots }: Installation): void {
  const stdout = execFileSync("bun", [join(project, ".claude", "tools", "aidlc-plugin.ts"), "sync", "--json"], {
    cwd: project,
    encoding: "utf-8",
    env,
  });
  const result = JSON.parse(stdout) as { ok: boolean; data: { synced: string[] } };
  if (!result.ok || result.data.synced.length !== roots.size) {
    throw new Error(`plugin sync did not install every plugin: ${stdout}`);
  }
}

/** Install built plugins and compose them, as the SessionStart hook does on the next session. */
export function installAndSync(version: string, plugins: Plugin[]): string {
  const installation = installPlugins(version, plugins);
  syncAll(installation);
  return installation.project;
}

export function coreStage(version: string, relative: string): string {
  fetchRuntime(version);
  return readFileSync(join(runtimeShell(version), ".claude", "aidlc-common", "stages", relative), "utf-8");
}

export function composedStage(project: string, relative: string): string {
  return readFileSync(join(project, ".claude", "aidlc-common", "stages", relative), "utf-8");
}

/** Text of one `### Step N` section, up to the next `##`/`###` heading. */
export function stepSection(stage: string, step: number): string {
  const heading = new RegExp(`^### Step ${step}\\b.*$`, "m").exec(stage);
  if (!heading) throw new Error(`no "### Step ${step}" heading`);
  const from = heading.index + heading[0].length;
  const rest = stage.slice(from);
  const next = rest.search(/^#{2,3} /m);
  return `${heading[0]}${next === -1 ? rest : rest.slice(0, next)}`;
}
