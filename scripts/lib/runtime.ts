// Pinned AI-DLC core runtimes. Plugins are built and tested against the
// official `aidlc-copy-runtime-X.Y.Z.tar.gz` release asset, which carries a
// pristine `runtime/<harness>/` project shell plus the plugin tooling.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync } from "node:fs";
import { join } from "node:path";
import { CACHE_ROOT, REPO_ROOT } from "./paths.ts";

export const HARNESS = "claude";
const RELEASE_BASE = "https://github.com/awslabs/aidlc-workflows/releases/download";

export function pinnedVersions(file = join(REPO_ROOT, "aidlc-versions.json")): string[] {
  const parsed: unknown = JSON.parse(readFileSync(file, "utf-8"));
  const versions = (parsed as { versions?: unknown }).versions;
  if (
    !Array.isArray(versions) ||
    versions.length === 0 ||
    !versions.every((v) => typeof v === "string" && /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(v))
  ) {
    throw new Error(`${file}: "versions" must be a non-empty array of release versions`);
  }
  return versions as string[];
}

/** The version whose tooling builds the published dist. */
export function buildVersion(): string {
  return pinnedVersions()[0];
}

/** Pristine project shell for one harness, e.g. `.aidlc-cache/2.10.0/runtime/claude`. */
export function runtimeShell(version: string, harness = HARNESS): string {
  return join(CACHE_ROOT, version, "runtime", harness);
}

export function runtimeTool(version: string, tool: string): string {
  const path = join(runtimeShell(version), ".claude", "tools", tool);
  if (!existsSync(path)) {
    throw new Error(`${path} is missing; run \`pnpm fetch-runtime\` first`);
  }
  return path;
}

export function sha256File(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

/** Download, checksum-verify, and extract one release's runtime. Idempotent. */
export function fetchRuntime(version: string): string {
  const shell = runtimeShell(version);
  if (existsSync(join(shell, ".claude"))) return shell;

  const asset = `aidlc-copy-runtime-${version}.tar.gz`;
  const work = join(CACHE_ROOT, `.download-${version}-${process.pid}`);
  rmSync(work, { recursive: true, force: true });
  mkdirSync(work, { recursive: true });
  try {
    const tarball = join(work, asset);
    const digestFile = `${tarball}.sha256`;
    // curl honours HTTPS_PROXY and custom CA bundles; Node's fetch does not.
    for (const [url, out] of [
      [`${RELEASE_BASE}/v${version}/${asset}`, tarball],
      [`${RELEASE_BASE}/v${version}/${asset}.sha256`, digestFile],
    ]) {
      execFileSync("curl", ["-fsSL", "--retry", "3", "-o", out, url], { stdio: "inherit" });
    }
    const expected = readFileSync(digestFile, "utf-8").trim().split(/\s+/)[0]?.toLowerCase();
    const actual = sha256File(tarball);
    if (expected !== actual) {
      throw new Error(`${asset}: sha256 mismatch (expected ${expected}, got ${actual})`);
    }
    const extracted = join(work, "x");
    mkdirSync(extracted);
    execFileSync("tar", ["xzf", tarball, "-C", extracted, `runtime/${HARNESS}`]);
    mkdirSync(join(CACHE_ROOT, version, "runtime"), { recursive: true });
    renameSync(join(extracted, "runtime", HARNESS), shell);
    return shell;
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}
