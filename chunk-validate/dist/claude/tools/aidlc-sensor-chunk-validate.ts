// aidlc-sensor-chunk-validate.ts — chunk-validate sensor 用の per-sensor script
//
// 契約(aidlc-sensor-linter.ts の実物から確認済み):
//   0   pass/fail は判定不要。stdout の JSON `pass` フィールドが判定を運ぶ
//   127 ツール自体が使えない(dispatcher branch b: 静かに PASSED, Note=tool-unavailable)
//   1   stdout の出力がパースできない(dispatcher branch f)
//   2   スクリプト自体のエラー(dispatcher branch e: SENSOR_PASSED, Note=script-error)
//
// --file-path は契約として受け取るが、このセンサーは「そのファイル」ではなく
// ワーキングツリー全体のテストを検証する。契約を握るのは dispatcher なので
// 必須のままにしておき、値は出力 JSON には含めない。
//
// ⚠️未確定: `pass=false` は「`chunk validate` が非ゼロ終了した」の意味で、
// 実テスト失敗(exitCode 1)であることは実測済みだが、sidecar 側のインフラ
// 障害との切り分けはできていない。確定したら isChunkFailure() の判定か
// output の内容分岐を直す。

import { execSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";

interface Args {
  stage: string;
  filePath: string;
}

interface SensorOutput {
  pass: boolean;
  exitCode: number | null;
  cached: boolean;
  stage: string;
  output?: string;
}

// このプロジェクトの .chunk/config.json 上のゲートコマンド名。
// `chunk validate --list` で確認した値(このプロジェクトでは "test")。
const CHUNK_COMMAND = "test";

// キャッシュ置き場。.git/ 配下ならリポジトリ管理外で、かつ fire_on: write の
// matches ("**/*.{ts,tsx}") にも引っかからない。
// worktree 環境で .git がファイルになる場合は writeFileSync が失敗するが、
// その場合はキャッシュ無しで毎回実行にフォールバックするだけなので安全側。
const CACHE_PATH = ".git/aidlc-chunk-validate-cache.json";

// 詳細 JSON に載せる chunk 出力の末尾最大長。テスト失敗時の診断用。
const OUTPUT_TAIL_LIMIT = 4 * 1024;

function parseArgs(argv: string[]): Args {
  let stage = "";
  let filePath = "";
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--stage") {
      stage = argv[++i] ?? "";
    } else if (a === "--file-path") {
      filePath = argv[++i] ?? "";
    } else if (a === "--help" || a === "-h") {
      printHelp();
      process.exit(0);
    } else {
      process.stderr.write(`unknown flag: ${a}\n`);
      process.exit(1);
    }
  }
  if (!stage) {
    process.stderr.write("missing required flag: --stage\n");
    process.exit(1);
  }
  if (!filePath) {
    process.stderr.write("missing required flag: --file-path\n");
    process.exit(1);
  }
  return { stage, filePath };
}

function printHelp(): void {
  process.stdout.write(
    `Usage: aidlc-sensor-chunk-validate --stage <slug> --file-path <path>\n\n` +
      `Wraps \`chunk validate ${CHUNK_COMMAND}\` and prints {pass, exitCode, cached, stage, output} JSON to stdout.\n`,
  );
}

// --- ツール自体の有無を確認 ---------------------------------------------

// linter sensor と同じ理由: chunk バイナリ自体が無い/PATHに無い場合は
// 「壊れている」ではなく「今回は静かにスキップ」として dispatcher に返す。
function probeChunkAvailable(): void {
  const result = spawnSync("chunk", ["--version"], {
    encoding: "utf-8",
    timeout: 10_000,
  });
  if (result.error && "code" in result.error && result.error.code === "ENOENT") {
    process.stderr.write("chunk-unavailable\n");
    process.exit(127);
  }
  if (result.error) {
    process.stderr.write(`chunk-probe-error: ${result.error.message}\n`);
    process.exit(2);
  }
  if (result.status !== 0) {
    const detail = result.stderr?.trim();
    process.stderr.write(
      `chunk-probe-error: chunk --version exited with status ${result.status}${detail ? `: ${detail}` : ""}\n`,
    );
    process.exit(2);
  }
}

// --- 重複排除 -------------------------------------------------------------

// fire_on: write は保存のたびに発火する。1ステージで10ファイル保存されれば
// 10回走るので、ワーキングツリー全体の内容をキーに前回結果を使い回す。
//
// `git stash create` は tracked ファイルの差分しか見ないため、
// code-generation が書く新規(untracked)ファイルでハッシュが変わらず
// 古い結果を返す問題があった。代わりに:
//   - tracked: `git diff HEAD --binary` の全バイト(index+worktree 合体差分)
//   - untracked: `git ls-files --others --exclude-standard` の各ファイル内容
// を sha256 に流す。全ファイルを読むので大規模 repo では重いが、
// .gitignore 適用後の untracked だけなので実用上は十分軽い。
const HASH_FILE_SIZE_LIMIT = 1024 * 1024;

function workingTreeHash(): string {
  try {
    const h = createHash("sha256");
    h.update(
      execSync("git diff HEAD --binary", {
        encoding: "utf-8",
        maxBuffer: 16 * 1024 * 1024,
      }),
    );
    const untracked = execSync("git ls-files --others --exclude-standard", {
      encoding: "utf-8",
    })
      .split("\n")
      .filter((p) => p.length > 0)
      .sort();
    for (const path of untracked) {
      h.update(`${path}\0`);
      try {
        if (statSync(path).size > HASH_FILE_SIZE_LIMIT) {
          h.update(`<too-large:${path}>`);
        } else {
          h.update(readFileSync(path));
        }
      } catch {
        h.update(`<unreadable:${path}>`);
      }
      h.update("\0");
    }
    return h.digest("hex");
  } catch {
    // git 自体が使えない/リポジトリ外など。キャッシュを諦めて毎回実行する。
    return `no-git-${Date.now()}`;
  }
}

interface Cache {
  hash: string;
  pass: boolean;
  exitCode: number | null;
  output?: string;
}

function readCache(): Cache | null {
  if (!existsSync(CACHE_PATH)) return null;
  try {
    return JSON.parse(readFileSync(CACHE_PATH, "utf-8"));
  } catch {
    return null;
  }
}

function writeCache(cache: Cache): void {
  try {
    writeFileSync(CACHE_PATH, JSON.stringify(cache));
  } catch {
    // キャッシュ書き込み失敗は致命的ではない。次回また実行されるだけ。
  }
}

// --- chunk validate 実行 ---------------------------------------------------

function isChunkFailure(exitCode: number | null): boolean {
  // null は spawn が起動すらしなかった/シグナル終了。保守的に失敗扱い。
  return exitCode !== 0;
}

function tail(text: string): string {
  return text.length > OUTPUT_TAIL_LIMIT
    ? text.slice(text.length - OUTPUT_TAIL_LIMIT)
    : text;
}

function runChunkValidate(): { exitCode: number | null; output: string } {
  const result = spawnSync("chunk", ["validate", CHUNK_COMMAND], {
    encoding: "utf-8",
    // manifest の timeout_seconds より短く設定すること。長いと
    // SENSOR_BUDGET_OVERRIDE より先にこちらが黙ってタイムアウトする。
    timeout: 55_000,
    maxBuffer: 8 * 1024 * 1024,
  });
  if (result.error) {
    // 実行時に急に chunk が消えた等、probe後の異常系。
    process.stderr.write(`chunk-exec-error: ${result.error.message}\n`);
    process.exit(2);
  }
  // 失敗時にエージェントが detail ファイルから原因を読めるよう、
  // 標準出力+標準エラーの末尾を JSON に載せる(センサーの output_schema
  // は pass だけだが、詳細ファイルにはこの JSON 全体が残る)。
  const combined = `${result.stdout ?? ""}\n${result.stderr ?? ""}`.trim();
  return { exitCode: result.status, output: tail(combined) };
}

// --- main -------------------------------------------------------------------

export function main(argv: string[]): void {
  const args = parseArgs(argv);

  probeChunkAvailable();

  const hash = workingTreeHash();
  const cached = readCache();
  if (cached && cached.hash === hash) {
    const out: SensorOutput = {
      pass: cached.pass,
      exitCode: cached.exitCode,
      cached: true,
      stage: args.stage,
      ...(cached.output ? { output: cached.output } : {}),
    };
    process.stdout.write(`${JSON.stringify(out)}\n`);
    process.exit(0);
  }

  const { exitCode, output } = runChunkValidate();
  const pass = !isChunkFailure(exitCode);

  writeCache({ hash, pass, exitCode, output });

  const out: SensorOutput = { pass, exitCode, cached: false, stage: args.stage, output };
  process.stdout.write(`${JSON.stringify(out)}\n`);
  process.exit(0);
}

if (import.meta.main) main(process.argv.slice(2));
