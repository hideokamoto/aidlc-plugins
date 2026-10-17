// Claude Code runs every plugin's SessionStart hook in parallel, and the
// concurrent `aidlc-plugin.ts sync` runs race inside AI-DLC core: some plugins
// can end up silently not composed. The README tells users to run one sync for
// all installed plugins afterwards; this pins that the remedy repairs whatever
// state the parallel hooks leave behind.
import { execFileSync, spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { discoverPlugins } from "../scripts/lib/plugins.ts";
import { pinnedVersions } from "../scripts/lib/runtime.ts";
import { installPlugins, syncAll } from "./support/core.ts";

function runHook(command: string, cwd: string, env: NodeJS.ProcessEnv): Promise<number | null> {
  return new Promise((resolve, reject) => {
    const child = spawn("sh", ["-c", command], { cwd, env, stdio: "ignore" });
    child.on("error", reject);
    child.on("close", resolve);
  });
}

describe.each(pinnedVersions())("aidlc %s", (version) => {
  it("one sync after parallel SessionStart hooks composes every plugin", async () => {
    const plugins = discoverPlugins();
    const installation = installPlugins(version, plugins);
    const { project, env, roots } = installation;

    await Promise.all(
      [...roots.values()].map((root) => {
        const hooks = JSON.parse(readFileSync(join(root, "hooks", "hooks.json"), "utf-8")) as {
          hooks: { SessionStart: Array<{ hooks: Array<{ command: string }> }> };
        };
        const command = hooks.hooks.SessionStart[0].hooks[0].command;
        return runHook(command, project, { ...env, CLAUDE_PLUGIN_ROOT: root, CLAUDE_PROJECT_DIR: project });
      }),
    );

    syncAll(installation);

    const listed = JSON.parse(
      execFileSync("bun", [join(project, ".claude", "tools", "aidlc-plugin.ts"), "list", "--json"], {
        cwd: project,
        encoding: "utf-8",
        env,
      }),
    ) as { ok: boolean; data: { statuses: Array<{ key: string; state: string }> } };
    expect(listed.ok).toBe(true);
    expect(listed.data.statuses.map(({ key, state }) => ({ key, state }))).toEqual(
      [...roots.keys()].sort().map((key) => ({ key, state: "current" })),
    );
  }, 180_000);
});
