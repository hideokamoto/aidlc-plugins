// alloy-doctor.ts — install prerequisites for the alloy plugin.
//
// Prints {"checks":[{pass,label,fix?,severity?}]} and nothing else on stdout,
// the plugin doctor contract of AI-DLC.
//
// AI-DLC 2.10.0 runs a plugin's doctor script from `/aidlc --doctor` only when
// the plugin owns a stage or scope. This plugin owns neither (its gate rides on
// functional-design), so run it directly: `bun .claude/tools/alloy-doctor.ts`.

import { spawnSync } from "node:child_process";
import { JAR_NAME, resolveJar, resolveJava } from "./alloy-check.ts";

const EXPECTED_VERSION = "6.2.0";
const DOWNLOAD_URL = `https://github.com/AlloyTools/org.alloytools.alloy/releases/download/v${EXPECTED_VERSION}/${JAR_NAME}`;

interface Check {
  pass: boolean;
  label: string;
  fix?: string;
  severity?: "error" | "advisory";
}

export function checks(): Check[] {
  const result: Check[] = [];
  const java = resolveJava();
  if (java === null) {
    result.push({
      pass: false,
      label: "alloy: Java not found ($JAVA_HOME/bin/java, PATH)",
      fix: "Install a Java runtime (Alloy 6.2.0 was checked with OpenJDK 21). Until then the blocking alloy-check gate stays closed (tool-unavailable).",
      severity: "error",
    });
  } else {
    const probe = spawnSync(java, ["-version"], { encoding: "utf-8", timeout: 30_000 });
    const line = `${probe.stderr ?? ""}${probe.stdout ?? ""}`
      .split(/\r?\n/)
      .find((l) => /version/.test(l) && !l.startsWith("Picked up")) ?? "";
    result.push({ pass: true, label: `alloy: Java found (${line.trim() || java})` });
  }

  const jar = resolveJar();
  if (jar === null) {
    result.push({
      pass: false,
      label: `alloy: Alloy JAR not found ($ALLOY_JAR, ./.alloy/${JAR_NAME}, ~/.alloy/${JAR_NAME})`,
      fix: `Download ${DOWNLOAD_URL} to ./.alloy/${JAR_NAME}, or set ALLOY_JAR.`,
      severity: "error",
    });
    return result;
  }
  if (java === null) {
    result.push({ pass: true, label: `alloy: Alloy JAR at ${jar} (version not checked: no Java)` });
    return result;
  }
  const version = spawnSync(java, ["-jar", jar, "version"], { encoding: "utf-8", timeout: 60_000 });
  const reported = (version.stdout ?? "").trim().split(/\r?\n/).pop() ?? "";
  result.push(
    version.status === 0 && reported === EXPECTED_VERSION
      ? { pass: true, label: `alloy: Alloy ${reported} at ${jar}` }
      : {
          pass: false,
          label: `alloy: ${jar} reports version "${reported || "unknown"}"; alloy-check was built against ${EXPECTED_VERSION}`,
          fix: `Replace it with ${DOWNLOAD_URL}. Other versions may print a different receipt.json shape.`,
          severity: "advisory",
        },
  );
  return result;
}

if (import.meta.main) {
  process.stdout.write(`${JSON.stringify({ checks: checks() })}\n`);
}
