// Plugin discovery: every top-level directory with `.aidlc-plugin/plugin.json`
// is one authored plugin root.
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { REPO_ROOT } from "./paths.ts";

export interface PluginManifest {
  name: string;
  version: string;
  description: string;
  author?: { name: string };
}

export interface Plugin {
  /** Directory and manifest name, e.g. `solo-developer`. */
  key: string;
  /** Claude host plugin name; the aidlc engine requires the `aidlc-` prefix. */
  hostName: string;
  dir: string;
  manifest: PluginManifest;
}

/**
 * Paths inside a plugin root that reach an install. A change under any of them
 * changes what users get, so it needs a version bump. README and tests/ do not.
 */
export const SHIPPED_PATHS = [
  ".aidlc-plugin",
  "agents",
  "contributions",
  "hooks",
  "knowledge",
  "scopes",
  "sensors",
  "stages",
  "tools",
] as const;

export function discoverPlugins(root = REPO_ROOT): Plugin[] {
  const plugins: Plugin[] = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name.startsWith(".") || entry.name === "node_modules") continue;
    const manifestPath = join(root, entry.name, ".aidlc-plugin", "plugin.json");
    if (!existsSync(manifestPath)) continue;
    const manifest = JSON.parse(readFileSync(manifestPath, "utf-8")) as PluginManifest;
    if (manifest.name !== entry.name) {
      throw new Error(`${manifestPath}: name "${manifest.name}" must equal its directory "${entry.name}"`);
    }
    plugins.push({ key: entry.name, hostName: `aidlc-${entry.name}`, dir: join(root, entry.name), manifest });
  }
  return plugins.sort((a, b) => a.key.localeCompare(b.key));
}
