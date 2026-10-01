// quint-doctor.ts — install prerequisites for the quint plugin.
//
// Prints {"checks":[{pass,label,fix?,severity?}]} and nothing else on stdout,
// the plugin doctor contract of AI-DLC.
//
// AI-DLC 2.10.0 runs a plugin's doctor script from `/aidlc --doctor` only when
// the plugin owns a stage or scope. This plugin owns neither (its gate rides on
// functional-design), so run it directly: `bun .claude/tools/quint-doctor.ts`.

import { spawnSync } from "node:child_process";
import { resolveQuint } from "./quint-check.ts";

interface Check {
  pass: boolean;
  label: string;
  fix?: string;
  severity?: "error" | "advisory";
}

function firstLine(text: string | null | undefined): string {
  return (text ?? "").trim().split(/\r?\n/)[0] ?? "";
}

export function checks(): Check[] {
  const result: Check[] = [];

  const node = spawnSync("node", ["--version"], { encoding: "utf-8", timeout: 15_000 });
  result.push(
    !node.error && node.status === 0
      ? { pass: true, label: `quint: Node.js ${firstLine(node.stdout)} found` }
      : {
          pass: false,
          label: "quint: Node.js not found on PATH",
          fix: "Install Node.js; the quint CLI is a Node.js program.",
          severity: "error",
        },
  );

  const bin = resolveQuint();
  if (bin === null) {
    result.push({
      pass: false,
      label: "quint: quint CLI not found ($QUINT_BIN, PATH, ./node_modules/.bin)",
      fix: "Run `npm i -D @informalsystems/quint` in the project, or set QUINT_BIN to the quint executable. Until then the blocking quint-check gate stays closed (tool-unavailable).",
      severity: "error",
    });
    return result;
  }
  const version = spawnSync(bin, ["--version"], { encoding: "utf-8", timeout: 30_000 });
  result.push({ pass: true, label: `quint: quint ${firstLine(version.stdout)} at ${bin}` });

  // quint-check always passes --backend typescript; older CLIs have no
  // --backend option and would reject the run.
  const help = spawnSync(bin, ["run", "--help"], { encoding: "utf-8", timeout: 30_000 });
  const helpText = `${help.stdout ?? ""}${help.stderr ?? ""}`;
  result.push(
    /--backend/.test(helpText) && /typescript/.test(helpText)
      ? { pass: true, label: "quint: `quint run --backend typescript` is supported (the backend quint-check uses)" }
      : {
          pass: false,
          label: "quint: this quint CLI has no `--backend typescript` option",
          fix: "Upgrade with `npm i -D @informalsystems/quint@latest`; quint-check runs `quint run --backend typescript`.",
          severity: "error",
        },
  );
  return result;
}

if (import.meta.main) {
  process.stdout.write(`${JSON.stringify({ checks: checks() })}\n`);
}
