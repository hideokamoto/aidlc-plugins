// Release CLI, run by CD on main.
//
//   check              fail when a released plugin changed without a version bump
//   plan               list plugins whose current version is not tagged yet
//   publish [--dry-run]
//                      build every plugin, commit main + build outputs onto the
//                      `release` branch, tag each pending plugin
//                      `<plugin>--v<version>`, push atomically, and create one
//                      GitHub Release per tag with a changelog body. A rerun
//                      creates Releases still missing for already-pushed tags.
//
// publish needs GITHUB_TOKEN (contents: write). The token is sent as an HTTP
// header, never embedded in a URL, and is scrubbed from error output.
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CATALOG_PATH, buildPlugin, distDir, writeCatalog } from "./lib/build.ts";
import { REPO_ROOT } from "./lib/paths.ts";
import { discoverPlugins, type Plugin } from "./lib/plugins.ts";
import {
  commitsSince,
  git,
  listTags,
  missingVersionBumps,
  pendingReleases,
  planPublish,
  previousTag,
  releaseTag,
  renderChangelog,
} from "./lib/release.ts";
import { buildVersion, fetchRuntime } from "./lib/runtime.ts";

const RELEASE_BRANCH = "release";
const repoSlug = process.env.GITHUB_REPOSITORY ?? "hideokamoto/aidlc-plugins";

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

function authArgs(token: string): string[] {
  const basic = Buffer.from(`x-access-token:${token}`).toString("base64");
  return ["-c", `http.https://github.com/.extraheader=AUTHORIZATION: basic ${basic}`];
}

function scrub(text: string, token: string): string {
  const basic = Buffer.from(`x-access-token:${token}`).toString("base64");
  return text.split(token).join("***").split(basic).join("***");
}

function remoteReleaseHead(token: string | undefined): string | null {
  const args = [...(token ? authArgs(token) : []), "ls-remote", `https://github.com/${repoSlug}.git`, `refs/heads/${RELEASE_BRANCH}`];
  const out = git(REPO_ROOT, args);
  if (!out) return null;
  const sha = out.split(/\s+/)[0];
  git(REPO_ROOT, [...(token ? authArgs(token) : []), "fetch", "--quiet", `https://github.com/${repoSlug}.git`, sha]);
  return sha;
}

/** Commit HEAD's tree plus the build outputs, without touching the work tree or index. */
function releaseCommit(plugins: Plugin[], pending: Plugin[], parent: string | null, version: string): string {
  const scratch = mkdtempSync(join(tmpdir(), "aidlc-release-"));
  const env = {
    ...process.env,
    GIT_INDEX_FILE: join(scratch, "index"),
    GIT_AUTHOR_NAME: process.env.GIT_AUTHOR_NAME ?? "aidlc-plugins release",
    GIT_AUTHOR_EMAIL: process.env.GIT_AUTHOR_EMAIL ?? "noreply@github.com",
    GIT_COMMITTER_NAME: process.env.GIT_COMMITTER_NAME ?? "aidlc-plugins release",
    GIT_COMMITTER_EMAIL: process.env.GIT_COMMITTER_EMAIL ?? "noreply@github.com",
  };
  const run = (args: string[], input?: string) =>
    execFileSync("git", args, { cwd: REPO_ROOT, env, encoding: "utf-8", input }).trim();
  try {
    run(["read-tree", "HEAD"]);
    run(["add", "--force", CATALOG_PATH, ...plugins.map((plugin) => distDir(plugin))]);
    const tree = run(["write-tree"]);
    const head = git(REPO_ROOT, ["rev-parse", "HEAD"]);
    const parents = parent ? ["-p", parent, "-p", head] : ["-p", head];
    const message = [
      `release: ${pending.map((plugin) => `${plugin.hostName} ${plugin.manifest.version}`).join(", ")}`,
      "",
      `Built from ${head} with aidlc ${version}.`,
    ].join("\n");
    return run(["commit-tree", tree, ...parents, "-F", "-"], message);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

function githubHeaders(token: string | undefined): Record<string, string> {
  return {
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  };
}

async function hasGitHubRelease(token: string | undefined, tag: string): Promise<boolean> {
  const response = await fetch(`https://api.github.com/repos/${repoSlug}/releases/tags/${encodeURIComponent(tag)}`, {
    headers: githubHeaders(token),
  });
  if (response.status === 404) return false;
  if (!response.ok) throw new Error(`GitHub Release lookup ${tag}: HTTP ${response.status}`);
  return true;
}

async function createGitHubRelease(token: string, tag: string, body: string): Promise<void> {
  const response = await fetch(`https://api.github.com/repos/${repoSlug}/releases`, {
    method: "POST",
    headers: githubHeaders(token),
    body: JSON.stringify({ tag_name: tag, name: tag, body }),
  });
  if (response.ok) return;
  const text = await response.text();
  // A concurrent or earlier run already created it: the goal state holds.
  if (response.status === 422 && text.includes("already_exists")) return;
  throw new Error(`GitHub Release ${tag}: HTTP ${response.status} ${text}`);
}

async function publish(dryRun: boolean): Promise<void> {
  const token = process.env.GITHUB_TOKEN;
  if (!dryRun && !token) fail("GITHUB_TOKEN is required to publish");

  const plugins = discoverPlugins();
  const tags = listTags(REPO_ROOT);
  const stale = missingVersionBumps(REPO_ROOT, plugins, tags);
  if (stale.length > 0) {
    fail(`version bump required before release: ${stale.map((plugin) => plugin.key).join(", ")}`);
  }

  const releasedTags = new Set<string>();
  for (const plugin of plugins) {
    const tag = releaseTag(plugin);
    if (!tags.has(tag)) continue;
    try {
      if (await hasGitHubRelease(token, tag)) releasedTags.add(tag);
    } catch (error) {
      if (!dryRun) throw error;
      console.warn(`dry run: could not look up the Release for ${tag}; assuming it exists`);
      releasedTags.add(tag);
    }
  }
  const plan = planPublish(plugins, tags, releasedTags);
  if (plan.push.length === 0 && plan.releaseOnly.length === 0) {
    console.log("nothing to release: every plugin version is tagged and has a GitHub Release");
    return;
  }

  const notes = [
    // New tags: changes up to the commit being released.
    ...plan.push.map((plugin) => ({ plugin, ref: "HEAD" })),
    // Tags from an earlier run: changes up to that tag, not today's HEAD.
    ...plan.releaseOnly.map((plugin) => ({ plugin, ref: releaseTag(plugin) })),
  ].map(({ plugin, ref }) => {
    const tag = releaseTag(plugin);
    const previous = previousTag(plugin, tags, tag);
    return { tag, body: renderChangelog(plugin, previous, commitsSince(REPO_ROOT, plugin, previous, ref)) };
  });

  let commit: string | null = null;
  if (plan.push.length > 0) {
    const version = buildVersion();
    fetchRuntime(version);
    for (const plugin of plugins) buildPlugin(version, plugin);
    writeCatalog(plugins);

    let parent: string | null;
    try {
      parent = remoteReleaseHead(token);
    } catch (error) {
      if (!dryRun) throw error;
      console.warn(`dry run: could not read the remote ${RELEASE_BRANCH} branch; assuming none`);
      parent = null;
    }
    commit = releaseCommit(plugins, plan.push, parent, version);
    console.log(`release commit ${commit} (parent ${parent ?? "none"})`);
  }
  for (const plugin of plan.releaseOnly) {
    console.log(`${releaseTag(plugin)} is already pushed; creating its missing GitHub Release`);
  }
  for (const { tag, body } of notes) console.log(`\n# ${tag}\n\n${body}`);
  if (dryRun) {
    console.log("dry run: nothing pushed");
    return;
  }

  if (commit !== null) {
    const refspecs = [
      `${commit}:refs/heads/${RELEASE_BRANCH}`,
      ...plan.push.map((plugin) => `${commit}:refs/tags/${releaseTag(plugin)}`),
    ];
    try {
      // --atomic: the branch and every tag land together or not at all.
      // Without --force the branch push is refused unless it fast-forwards.
      git(REPO_ROOT, [...authArgs(token!), "push", "--atomic", `https://github.com/${repoSlug}.git`, ...refspecs]);
    } catch (error) {
      const err = error as { stderr?: string; message?: string };
      fail(`push failed: ${scrub(String(err.stderr ?? err.message ?? error), token!)}`);
    }
  }
  for (const { tag, body } of notes) {
    await createGitHubRelease(token!, tag, body);
    console.log(`published ${tag}`);
  }
}

const [command, ...rest] = process.argv.slice(2);
if (command === "check") {
  const plugins = discoverPlugins();
  const stale = missingVersionBumps(REPO_ROOT, plugins, listTags(REPO_ROOT));
  if (stale.length > 0) {
    fail(
      stale
        .map((plugin) => `${plugin.key}: shipped files changed since ${releaseTag(plugin)}; bump .aidlc-plugin/plugin.json version`)
        .join("\n"),
    );
  }
  console.log("ok: every released plugin with shipped changes has a new version");
} else if (command === "plan") {
  const pending = pendingReleases(discoverPlugins(), listTags(REPO_ROOT));
  console.log(pending.length === 0 ? "nothing to release" : pending.map(releaseTag).join("\n"));
} else if (command === "publish") {
  await publish(rest.includes("--dry-run"));
} else {
  fail("usage: release.ts <check|plan|publish [--dry-run]>");
}
