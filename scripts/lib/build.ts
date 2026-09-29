// Projection of authored plugins into installable Claude plugins, plus the
// repository marketplace catalogue that lists them.
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { REPO_ROOT } from "./paths.ts";
import type { Plugin } from "./plugins.ts";
import { HARNESS, runtimeTool } from "./runtime.ts";

export const MARKETPLACE_NAME = "aidlc-plugins";
export const CATALOG_PATH = join(".claude-plugin", "marketplace.json");

export function distDir(plugin: Plugin): string {
  return join(plugin.dir, "dist", HARNESS);
}

export function buildPlugin(version: string, plugin: Plugin, outDir = distDir(plugin)): void {
  let stdout: string;
  try {
    stdout = execFileSync(
      "bun",
      [runtimeTool(version, "aidlc-plugin-build.ts"), plugin.dir, HARNESS, outDir, "--json"],
      { encoding: "utf-8", stdio: ["ignore", "pipe", "inherit"] },
    );
  } catch (error) {
    // On rejection the tool prints its JSON report to stdout, then exits 1.
    // Surface that report; rethrow anything that is not one.
    const report = String((error as { stdout?: unknown }).stdout ?? "");
    let parsed: { errors?: unknown[] } | undefined;
    try {
      parsed = JSON.parse(report) as { errors?: unknown[] };
    } catch {
      throw error;
    }
    if (!parsed?.errors?.length) throw error;
    stdout = report;
  }
  const result = JSON.parse(stdout) as { valid: boolean; errors: unknown[] };
  if (!result.valid || result.errors.length > 0) {
    throw new Error(`${plugin.key}: aidlc-plugin-build rejected the plugin: ${JSON.stringify(result.errors)}`);
  }
}

export interface Catalog {
  name: string;
  owner: { name: string };
  description: string;
  plugins: Array<{ name: string; source: string; description: string }>;
}

export function catalogFor(plugins: Plugin[]): Catalog {
  return {
    name: MARKETPLACE_NAME,
    owner: { name: "hideokamoto" },
    description: "AIDLC plugin catalogue.",
    // No entry `version`: the built plugin.json carries it, and setting both
    // makes `claude plugin validate` warn on any mismatch.
    plugins: plugins.map((plugin) => ({
      name: plugin.hostName,
      // Relative sources containing "/" must start with "./".
      source: `./${plugin.key}/dist/${HARNESS}`,
      description: plugin.manifest.description,
    })),
  };
}

export function writeCatalog(plugins: Plugin[], root = REPO_ROOT): string {
  const path = join(root, CATALOG_PATH);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(catalogFor(plugins), null, 2)}\n`);
  return path;
}
