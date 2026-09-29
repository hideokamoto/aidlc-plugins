import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { buildPlugin, catalogFor } from "../scripts/lib/build.ts";
import { discoverPlugins } from "../scripts/lib/plugins.ts";
import { buildVersion } from "../scripts/lib/runtime.ts";

const plugins = discoverPlugins();
const catalog = catalogFor(plugins);

describe("marketplace catalogue", () => {
  it("lists every plugin once under its aidlc- host name", () => {
    expect(catalog.plugins.map((entry) => entry.name)).toEqual(plugins.map((plugin) => `aidlc-${plugin.key}`));
  });

  it("uses ./-prefixed sources inside the repository", () => {
    for (const entry of catalog.plugins) {
      expect(entry.source).toMatch(/^\.\/[a-z][a-z0-9-]*\/dist\/claude$/);
    }
  });
});

describe.each(plugins)("built $key", (plugin) => {
  const out = mkdtempSync(join(tmpdir(), `aidlc-build-${plugin.key}-`));
  afterAll(() => rmSync(out, { recursive: true, force: true }));
  buildPlugin(buildVersion(), plugin, join(out, "dist"));
  const manifest = JSON.parse(readFileSync(join(out, "dist", ".claude-plugin", "plugin.json"), "utf-8")) as {
    name: string;
    version: string;
  };

  it("carries the catalogue entry name and the authored version", () => {
    // Claude Code reports "not found in marketplace" when these names differ.
    expect(manifest.name).toBe(catalog.plugins.find((entry) => entry.source === `./${plugin.key}/dist/claude`)?.name);
    expect(manifest.version).toBe(plugin.manifest.version);
  });

  it("does not ship tests or README", () => {
    expect(existsSync(join(out, "dist", "tests"))).toBe(false);
    expect(existsSync(join(out, "dist", "README.md"))).toBe(false);
  });
});
