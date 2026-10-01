// Alloy 6.2.0 for the alloy plugin's tests: downloaded once into .aidlc-cache/
// and sha256-checked. The digest was recorded from the release asset when the
// plugin was written; GitHub publishes no checksum file for it.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, renameSync, rmSync } from "node:fs";
import { join } from "node:path";
import { CACHE_ROOT } from "../../scripts/lib/paths.ts";
import { sha256File } from "../../scripts/lib/runtime.ts";

export const ALLOY_VERSION = "6.2.0";
const JAR = "org.alloytools.alloy.dist.jar";
const URL = `https://github.com/AlloyTools/org.alloytools.alloy/releases/download/v${ALLOY_VERSION}/${JAR}`;
const SHA256 = "6b8c1cb5bc93bedfc7c61435c4e1ab6e688a242dc702a394628d9a9801edb78d";

export function fetchAlloyJar(): string {
  const dir = join(CACHE_ROOT, `alloy-${ALLOY_VERSION}`);
  const jar = join(dir, JAR);
  if (existsSync(jar)) return jar;
  mkdirSync(dir, { recursive: true });
  const partial = `${jar}.${process.pid}.part`;
  try {
    // curl honours HTTPS_PROXY and custom CA bundles; Node's fetch does not.
    execFileSync("curl", ["-fsSL", "--retry", "3", "-o", partial, URL], { stdio: "inherit" });
    const actual = sha256File(partial);
    if (actual !== SHA256) throw new Error(`${JAR}: sha256 mismatch (expected ${SHA256}, got ${actual})`);
    renameSync(partial, jar);
    return jar;
  } finally {
    rmSync(partial, { force: true });
  }
}
