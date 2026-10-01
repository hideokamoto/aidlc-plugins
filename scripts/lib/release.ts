// Release rules. A plugin is released when its manifest version has no tag
// yet. Tags follow Claude Code's `<plugin>--v<version>` convention, so several
// plugins share one repository without tag collisions.
import { execFileSync } from "node:child_process";
import { SHIPPED_PATHS, type Plugin } from "./plugins.ts";
import { VERSIONS_FILE, parseVersions } from "./runtime.ts";

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

export interface PublishPlan {
  /** Versions without a tag: build, tag, push, then create the Release. */
  push: Plugin[];
  /** Tagged by an earlier run whose Release creation failed: create the Release only. */
  releaseOnly: Plugin[];
}

export function planPublish(plugins: Plugin[], tags: Set<string>, releasedTags: Set<string>): PublishPlan {
  return {
    push: pendingReleases(plugins, tags),
    releaseOnly: plugins.filter((plugin) => tags.has(releaseTag(plugin)) && !releasedTags.has(releaseTag(plugin))),
  };
}

function compareIdentifiers(a: string, b: string): number {
  const numericA = /^\d+$/.test(a);
  const numericB = /^\d+$/.test(b);
  if (numericA && numericB) {
    // Valid SemVer numbers have no leading zeros, so a longer one is larger.
    // Comparing digits avoids precision loss past Number.MAX_SAFE_INTEGER.
    return a.length !== b.length ? a.length - b.length : a < b ? -1 : a > b ? 1 : 0;
  }
  if (numericA) return -1;
  if (numericB) return 1;
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * SemVer 2.0.0 precedence (https://semver.org/#spec-item-11):
 * - build metadata (`+...`) is ignored;
 * - major, minor, and patch compare numerically;
 * - a version with a prerelease has lower precedence than the same version without one;
 * - prerelease identifiers compare left to right: numeric ones numerically,
 *   alphanumeric ones lexically in ASCII order, numeric lower than alphanumeric,
 *   and a longer set wins when every preceding identifier is equal.
 */
export function compareVersions(a: string, b: string): number {
  const parse = (version: string) => {
    const withoutBuild = version.split("+")[0];
    const dash = withoutBuild.indexOf("-");
    const core = dash === -1 ? withoutBuild : withoutBuild.slice(0, dash);
    const pre = dash === -1 ? [] : withoutBuild.slice(dash + 1).split(".");
    return { core: core.split(".").map(Number), pre };
  };
  const pa = parse(a);
  const pb = parse(b);
  for (let i = 0; i < 3; i++) {
    const x = pa.core[i] ?? 0;
    const y = pb.core[i] ?? 0;
    if (x !== y) return x - y;
  }
  if (pa.pre.length === 0 || pb.pre.length === 0) {
    // A prerelease sorts before its release.
    return Number(pa.pre.length === 0) - Number(pb.pre.length === 0);
  }
  for (let i = 0; i < Math.min(pa.pre.length, pb.pre.length); i++) {
    const order = compareIdentifiers(pa.pre[i], pb.pre[i]);
    if (order !== 0) return order;
  }
  return pa.pre.length - pb.pre.length;
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
 * The core version that builds the published dist (the first entry of
 * aidlc-versions.json) as committed at `ref`, or null when the file is absent
 * there.
 */
export function buildVersionAt(cwd: string, ref: string): string | null {
  const spec = `${ref}:${VERSIONS_FILE}`;
  try {
    git(cwd, ["cat-file", "-e", spec]);
  } catch {
    return null;
  }
  return parseVersions(git(cwd, ["show", spec]), spec)[0];
}

export interface StaleRelease {
  plugin: Plugin;
  reasons: string[];
}

/**
 * Tagged plugins whose shipped output changed after their current version was
 * tagged. Users only receive a new copy when the version changes, so such a
 * change would never reach existing installs.
 *
 * Two things change the output: the plugin's shipped files, and the core
 * version that builds it. publish rebuilds every plugin's dist with the first
 * entry of aidlc-versions.json, and that core's build injects its own
 * hooks/compose.ts and hooks.json, so a new build core changes what an
 * already-tagged version ships on the release branch. A tag without the file
 * was built by an unknown core and counts as changed.
 */
export function versionBumpReasons(cwd: string, plugins: Plugin[], tags: Set<string>, ref = "HEAD"): StaleRelease[] {
  const tagged = plugins.filter((plugin) => tags.has(releaseTag(plugin)));
  if (tagged.length === 0) return [];
  const core = buildVersionAt(cwd, ref);
  const stale: StaleRelease[] = [];
  for (const plugin of tagged) {
    const tag = releaseTag(plugin);
    const reasons: string[] = [];
    const paths = SHIPPED_PATHS.map((path) => `${plugin.key}/${path}`);
    if (git(cwd, ["diff", "--name-only", tag, ref, "--", ...paths]) !== "") {
      reasons.push(`shipped files changed since ${tag}`);
    }
    let tagCore: string | null;
    try {
      tagCore = buildVersionAt(cwd, tag);
    } catch {
      // An unparseable file at an old tag: the core that built it is unknown.
      tagCore = null;
    }
    if (tagCore !== core) {
      reasons.push(`build core changed since ${tag} (${tagCore ?? "unknown"} -> ${core ?? "unknown"})`);
    }
    if (reasons.length > 0) stale.push({ plugin, reasons });
  }
  return stale;
}

export function missingVersionBumps(cwd: string, plugins: Plugin[], tags: Set<string>, ref = "HEAD"): Plugin[] {
  return versionBumpReasons(cwd, plugins, tags, ref).map(({ plugin }) => plugin);
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
