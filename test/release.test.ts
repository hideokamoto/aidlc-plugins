import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { discoverPlugins, type Plugin } from "../scripts/lib/plugins.ts";
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
} from "../scripts/lib/release.ts";

let repo: string;

function write(path: string, content: string): void {
  mkdirSync(join(repo, path, ".."), { recursive: true });
  writeFileSync(join(repo, path), content);
}

function setVersion(key: string, version: string): void {
  write(`${key}/.aidlc-plugin/plugin.json`, JSON.stringify({ name: key, version, description: `${key} plugin` }));
}

function commit(message: string): string {
  git(repo, ["add", "-A"]);
  git(repo, ["commit", "-q", "-m", message]);
  return git(repo, ["rev-parse", "HEAD"]);
}

function plugin(key: string): Plugin {
  const found = discoverPlugins(repo).find((p) => p.key === key);
  if (!found) throw new Error(`no plugin ${key}`);
  return found;
}

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), "aidlc-release-test-"));
  git(repo, ["init", "-q", "-b", "main"]);
  git(repo, ["config", "user.email", "test@example.com"]);
  git(repo, ["config", "user.name", "test"]);
  git(repo, ["config", "commit.gpgsign", "false"]);
  setVersion("alpha", "0.1.0");
  write("alpha/contributions/x.md", "one\n");
  setVersion("beta", "1.0.0");
  commit("feat(alpha): initial");
});

afterEach(() => rmSync(repo, { recursive: true, force: true }));

describe("pendingReleases", () => {
  it("returns only plugins whose current version is untagged", () => {
    git(repo, ["tag", "aidlc-beta--v1.0.0"]);
    const pending = pendingReleases(discoverPlugins(repo), listTags(repo));
    expect(pending.map(releaseTag)).toEqual(["aidlc-alpha--v0.1.0"]);
  });
});

describe("planPublish", () => {
  it("pushes untagged versions and only creates Releases for tags that lack one", () => {
    git(repo, ["tag", "aidlc-alpha--v0.1.0"]);
    const plan = planPublish(discoverPlugins(repo), listTags(repo), new Set());
    expect(plan.push.map(releaseTag)).toEqual(["aidlc-beta--v1.0.0"]);
    // alpha's tag was pushed by an earlier run whose Release creation failed.
    expect(plan.releaseOnly.map(releaseTag)).toEqual(["aidlc-alpha--v0.1.0"]);
  });

  it("does nothing for a tag that already has its Release", () => {
    git(repo, ["tag", "aidlc-alpha--v0.1.0"]);
    git(repo, ["tag", "aidlc-beta--v1.0.0"]);
    const plan = planPublish(discoverPlugins(repo), listTags(repo), new Set(["aidlc-alpha--v0.1.0", "aidlc-beta--v1.0.0"]));
    expect(plan).toEqual({ push: [], releaseOnly: [] });
  });
});

describe("missingVersionBumps", () => {
  beforeEach(() => git(repo, ["tag", "aidlc-alpha--v0.1.0"]));

  it("flags a shipped-file change under an already-tagged version", () => {
    write("alpha/contributions/x.md", "two\n");
    commit("fix(alpha): change prose");
    expect(missingVersionBumps(repo, discoverPlugins(repo), listTags(repo)).map((p) => p.key)).toEqual(["alpha"]);
  });

  it("ignores README and tests changes, which never reach an install", () => {
    write("alpha/README.md", "docs\n");
    write("alpha/tests/a.test.ts", "// test\n");
    commit("docs(alpha): readme");
    expect(missingVersionBumps(repo, discoverPlugins(repo), listTags(repo))).toEqual([]);
  });

  it("accepts the change once the version is bumped", () => {
    write("alpha/contributions/x.md", "two\n");
    setVersion("alpha", "0.2.0");
    commit("feat(alpha): change prose");
    const tags = listTags(repo);
    expect(missingVersionBumps(repo, discoverPlugins(repo), tags)).toEqual([]);
    expect(pendingReleases(discoverPlugins(repo), tags).map(releaseTag)).toEqual(["aidlc-alpha--v0.2.0", "aidlc-beta--v1.0.0"]);
  });
});

describe("previousTag", () => {
  it("orders versions numerically and skips the tag being cut", () => {
    for (const tag of ["aidlc-alpha--v0.9.0", "aidlc-alpha--v0.10.0", "aidlc-alpha--v0.11.0", "aidlc-beta--v9.9.9"]) {
      git(repo, ["tag", tag]);
    }
    const tags = listTags(repo);
    expect(previousTag(plugin("alpha"), tags, "aidlc-alpha--v0.11.0")).toBe("aidlc-alpha--v0.10.0");
    expect(previousTag(plugin("beta"), tags, "aidlc-beta--v9.9.9")).toBeNull();
  });

  it("sorts a prerelease before its release", () => {
    git(repo, ["tag", "aidlc-alpha--v1.0.0"]);
    git(repo, ["tag", "aidlc-alpha--v1.0.0-rc.1"]);
    expect(previousTag(plugin("alpha"), listTags(repo))).toBe("aidlc-alpha--v1.0.0");
  });
});

describe("changelog", () => {
  it("lists only this plugin's commits since the previous tag, grouped by type", () => {
    git(repo, ["tag", "aidlc-alpha--v0.1.0"]);
    write("alpha/contributions/x.md", "two\n");
    const fixSha = commit("fix(alpha): correct anchor");
    write("beta/contributions/y.md", "beta\n");
    commit("feat(beta): unrelated");
    write("alpha/contributions/z.md", "new\n");
    const featSha = commit("feat(alpha)!: new overlay");
    write("alpha/README.md", "docs\n");
    const docSha = commit("update readme");

    const commits = commitsSince(repo, plugin("alpha"), "aidlc-alpha--v0.1.0");
    expect(commits.map((c) => c.sha)).toEqual([docSha, featSha, fixSha]);

    const body = renderChangelog(plugin("alpha"), "aidlc-alpha--v0.1.0", commits);
    expect(body).toBe(
      [
        "## aidlc-alpha 0.1.0",
        "",
        "Changes since `aidlc-alpha--v0.1.0`.",
        "",
        "### Features",
        "",
        `- new overlay (${featSha.slice(0, 7)})`,
        "",
        "### Bug Fixes",
        "",
        `- correct anchor (${fixSha.slice(0, 7)})`,
        "",
        "### Other Changes",
        "",
        `- update readme (${docSha.slice(0, 7)})`,
        "",
      ].join("\n"),
    );
  });

  it("marks a first release and covers the plugin's whole history", () => {
    const commits = commitsSince(repo, plugin("alpha"), null);
    expect(commits).toHaveLength(1);
    expect(renderChangelog(plugin("alpha"), null, commits)).toContain("Initial release.");
  });
});
