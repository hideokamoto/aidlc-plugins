import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { buildPlugin } from "../scripts/lib/build.ts";
import { discoverPlugins } from "../scripts/lib/plugins.ts";
import { buildVersion, fetchRuntime } from "../scripts/lib/runtime.ts";

describe("buildPlugin", () => {
  const root = mkdtempSync(join(tmpdir(), "aidlc-build-invalid-"));
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  it("reports the build tool's validation errors when it rejects a plugin", () => {
    const dir = join(root, "broken");
    mkdirSync(join(dir, ".aidlc-plugin"), { recursive: true });
    mkdirSync(join(dir, "contributions"), { recursive: true });
    writeFileSync(
      join(dir, ".aidlc-plugin", "plugin.json"),
      JSON.stringify({
        name: "broken",
        version: "0.1.0",
        description: "broken",
        dependencies: ["core"],
        aidlc: { contributes: { overlays: "contributions/" } },
      }),
    );
    writeFileSync(join(dir, "contributions", "x.md"), "---\ntarget: no-such-stage\nplugin: broken\n---\n\nbody\n");
    const [plugin] = discoverPlugins(root);
    fetchRuntime(buildVersion());

    expect(() => buildPlugin(buildVersion(), plugin, join(root, "out"))).toThrow(
      /broken: aidlc-plugin-build rejected the plugin: .*contribution-target/,
    );
  });
});
