// Release rules. A plugin is released when its manifest version has no tag
// yet. Tags follow Claude Code's `<plugin>--v<version>` convention, so several
// plugins share one repository without tag collisions.
import { execFileSync } from "node:child_process";
import { SHIPPED_PATHS, type Plugin } from "./plugins.ts";

export function git(cwd: string, args: string[], input?: string): string {
  return execFileSync("git", args, { cwd, encoding: "utf-8", input, stdio: ["pipe", "pipe", "pipe"] }).trim();
}

export function releaseTag(plugin: Plugin): string {
  return `${plugin.hostName}--v${plugin.manifest.version}`;
}

export function listTags(cwd: string): Set<string> {
  const out = git(cwd, ["tag", "--list"]);
  return new Set(out ? out.split("\n") : []);
}

/** Plugins whose current version has not been tagged yet. */
export function pendingReleases(plugins: Plugin[], tags: Set<string>): Plugin[] {
  return plugins.filter((plugin) => !tags.has(releaseTag(plugin)));
}

function compareVersions(a: string, b: string): number {
  const pa = a.split(/[.+-]/).slice(0, 3).map(Number);
  const pb = b.split(/[.+-]/).slice(0, 3).map(Number);
  for (let i = 0; i < 3; i++) {
    if (pa[i] !== pb[i]) return (pa[i] ?? 0) - (pb[i] ?? 0);
  }
  // A prerelease sorts before its release.
  return Number(!a.includes("-")) - Number(!b.includes("-"));
}

/** Newest released tag of a plugin, ignoring `exclude` (the tag being cut). */
export function previousTag(plugin: Plugin, tags: Set<string>, exclude?: string): string | null {
  const prefix = `${plugin.hostName}--v`;
  const versions = [...tags]
    .filter((tag) => tag.startsWith(prefix) && tag !== exclude)
    .map((tag) => tag.slice(prefix.length))
    .sort(compareVersions);
  const newest = versions.at(-1);
  return newest === undefined ? null : `${prefix}${newest}`;
}

/**
 * Plugins whose shipped files changed after their current version was tagged.
 * Users only receive a new copy when the version changes, so such a change
 * would never reach existing installs.
 */
export function missingVersionBumps(cwd: string, plugins: Plugin[], tags: Set<string>, ref = "HEAD"): Plugin[] {
  return plugins.filter((plugin) => {
    const tag = releaseTag(plugin);
    if (!tags.has(tag)) return false;
    const paths = SHIPPED_PATHS.map((path) => `${plugin.key}/${path}`);
    const changed = git(cwd, ["diff", "--name-only", tag, ref, "--", ...paths]);
    return changed !== "";
  });
}

export interface Commit {
  sha: string;
  subject: string;
}

export function commitsSince(cwd: string, plugin: Plugin, from: string | null, ref = "HEAD"): Commit[] {
  const range = from === null ? ref : `${from}..${ref}`;
  const out = git(cwd, ["log", "--no-merges", "--format=%H%x1f%s", range, "--", `${plugin.key}/`]);
  if (!out) return [];
  return out.split("\n").map((line) => {
    const [sha, subject] = line.split("\x1f");
    return { sha, subject };
  });
}

const SECTIONS: Array<[string, string]> = [
  ["feat", "Features"],
  ["fix", "Bug Fixes"],
];

/** GitHub Release body: conventional-commit subjects grouped by type. */
export function renderChangelog(plugin: Plugin, previous: string | null, commits: Commit[]): string {
  const groups = new Map<string, string[]>();
  for (const { sha, subject } of commits) {
    const match = subject.match(/^(\w+)(?:\([^)]*\))?!?:\s*(.+)$/);
    const type = match && SECTIONS.some(([t]) => t === match[1]) ? match[1] : "other";
    const text = match ? match[2] : subject;
    const lines = groups.get(type) ?? [];
    lines.push(`- ${text} (${sha.slice(0, 7)})`);
    groups.set(type, lines);
  }
  const parts = [`## ${plugin.hostName} ${plugin.manifest.version}`, ""];
  parts.push(previous === null ? "Initial release." : `Changes since \`${previous}\`.`, "");
  if (commits.length === 0) parts.push("No changes under this plugin's directory.", "");
  for (const [type, title] of [...SECTIONS, ["other", "Other Changes"] as [string, string]]) {
    const lines = groups.get(type);
    if (lines) parts.push(`### ${title}`, "", ...lines, "");
  }
  return `${parts.join("\n").trimEnd()}\n`;
}
