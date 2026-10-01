// aidlc-sensor-chunk-validate.ts — chunk-validate sensor 用の per-sensor script
//
// 契約(aidlc-sensor-linter.ts の実物から確認済み):
//   0   pass/fail は判定不要。stdout の JSON `pass` フィールドが判定を運ぶ
//   127 ツール自体が使えない(dispatcher branch b: 静かに PASSED, Note=tool-unavailable)
//   1   stdout の出力がパースできない(dispatcher branch f)
//   2   スクリプト自体のエラー(dispatcher branch e: SENSOR_PASSED, Note=script-error)
//
// 引数: engine の dispatcher (aidlc-sensor.ts) は組み込みの linter / type-check
// 以外のすべてのセンサーに `--stage <slug> --output-path <絶対パス>` を渡す。
// プラグインのセンサーはこちらの形で呼ばれるので `--output-path` を受け取る。
// `--file-path` は以前の契約との互換のための別名として残す。
// このセンサーは「そのファイル」ではなくワーキングツリー全体のテストを
// 検証するので、パスの値は出力 JSON には含めない。
//
// ⚠️未確定: `pass=false` は「`chunk validate` が非ゼロ終了した、または
// タイムアウトした」の意味で、実テスト失敗(exitCode 1)であることは実測済み
// だが、sidecar 側のインフラ障害との切り分けはできていない。確定したら
// isChunkFailure() の判定か output の内容分岐を直す。

import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";

interface Args {
  stage: string;
  outputPath: string;
}

interface SensorOutput {
  pass: boolean;
  exitCode: number | null;
  cached: boolean;
  timedOut?: boolean;
  command: string;
  stage: string;
  output?: string;
}

// `chunk validate <command>` に渡すゲートコマンド名(.chunk/config.json 上の
// 名前。`chunk validate --list` で確認できる)。プロジェクトごとに違うので
// 環境変数で指定し、未指定なら "test"。
const DEFAULT_CHUNK_COMMAND = "test";

function chunkCommand(): string {
  return process.env.AIDLC_CHUNK_VALIDATE_COMMAND?.trim() || DEFAULT_CHUNK_COMMAND;
}

// `chunk validate` の打ち切り時間。manifest の timeout_seconds (60) より
// 短くすること。長いと dispatcher が先にこのスクリプトごと kill し、
// SENSOR_BUDGET_OVERRIDE になって pass/fail が届かない。
// AIDLC_CHUNK_VALIDATE_TIMEOUT_MS で短くできる(上限はこの既定値)。
const MAX_TIMEOUT_MS = 55_000;

function validateTimeoutMs(): number {
  const raw = Number(process.env.AIDLC_CHUNK_VALIDATE_TIMEOUT_MS);
  return Number.isInteger(raw) && raw > 0 ? Math.min(raw, MAX_TIMEOUT_MS) : MAX_TIMEOUT_MS;
}

// キャッシュ置き場。.git/ 配下ならリポジトリ管理外で、かつ fire_on: write の
// matches ("**/*.{ts,tsx}") にも引っかからない。
// worktree 環境で .git がファイルになる場合は writeFileSync が失敗するが、
// その場合はキャッシュ無しで毎回実行にフォールバックするだけなので安全側。
const CACHE_PATH = ".git/aidlc-chunk-validate-cache.json";

// 詳細 JSON に載せる chunk 出力の末尾最大長。テスト失敗時の診断用。
const OUTPUT_TAIL_LIMIT = 4 * 1024;

function parseArgs(argv: string[]): Args {
  let stage = "";
  let outputPath = "";
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--stage") {
      stage = argv[++i] ?? "";
    } else if (a === "--output-path" || a === "--file-path") {
      outputPath = argv[++i] ?? "";
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
  if (!outputPath) {
    process.stderr.write("missing required flag: --output-path\n");
    process.exit(1);
  }
  return { stage, outputPath };
}

function printHelp(): void {
  process.stdout.write(
    `Usage: aidlc-sensor-chunk-validate --stage <slug> --output-path <path>\n\n` +
      `Wraps \`chunk validate <command>\` and prints {pass, exitCode, cached, command, stage, output} JSON to stdout.\n` +
      `--file-path is accepted as an alias of --output-path.\n\n` +
      `Environment:\n` +
      `  AIDLC_CHUNK_VALIDATE_COMMAND     gate command name in .chunk/config.json (default: ${DEFAULT_CHUNK_COMMAND})\n` +
      `  AIDLC_CHUNK_VALIDATE_TIMEOUT_MS  validation time limit in ms (default and maximum: ${MAX_TIMEOUT_MS})\n`,
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
//
// AI-DLC のワークスペース `aidlc/` はハッシュから除外する。engine は発火の
// たびに、このスクリプトの前後でアクティブな記録
// (`aidlc/spaces/<space>/intents/<record>/`) に audit 行
// (`audit/<host>-<clone>.md` への SENSOR_FIRED / SENSOR_PASSED 等) を追記し、
// 失敗時は `.aidlc-engine/sensors/` に詳細ファイルを書く。これを含めると
// 前回の発火そのものがハッシュを変え、キャッシュが一度も当たらない。
// `aidlc/` の中身(記録・監査ログ・memory)はワークフローの成果物であって、
// プロジェクトのテストスイートの入力ではない。テストが読むのはソースコードと
// その設定なので、ここが変わっても `chunk validate` の結果は変わらない。
// ゆえに除外してもキャッシュが古い結果を返すことはない。
const WORKSPACE_EXCLUDE = ":(exclude)aidlc/";

const HASH_FILE_SIZE_LIMIT = 1024 * 1024;

function git(args: string[]): string {
  return execFileSync("git", args, {
    encoding: "utf-8",
    maxBuffer: 16 * 1024 * 1024,
    stdio: ["ignore", "pipe", "ignore"],
  });
}

function workingTreeHash(command: string): string {
  try {
    const h = createHash("sha256");
    // 同じツリーでもゲートコマンドが違えば結果は別物。
    h.update(`command:${command}\0`);
    h.update(git(["diff", "HEAD", "--binary", "--", ".", WORKSPACE_EXCLUDE]));
    const untracked = git(["ls-files", "--others", "--exclude-standard", "--", ".", WORKSPACE_EXCLUDE])
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
  // null はシグナル終了。保守的に失敗扱い。
  return exitCode !== 0;
}

function tail(text: string): string {
  return text.length > OUTPUT_TAIL_LIMIT
    ? text.slice(text.length - OUTPUT_TAIL_LIMIT)
    : text;
}

interface ValidateResult {
  exitCode: number | null;
  timedOut: boolean;
  output: string;
}

function runChunkValidate(command: string): ValidateResult {
  const timeoutMs = validateTimeoutMs();
  const result = spawnSync("chunk", ["validate", command], {
    encoding: "utf-8",
    timeout: timeoutMs,
    maxBuffer: 8 * 1024 * 1024,
  });
  // 失敗時にエージェントが detail ファイルから原因を読めるよう、
  // 標準出力+標準エラーの末尾を JSON に載せる(センサーの output_schema
  // は pass だけだが、詳細ファイルにはこの JSON 全体が残る)。
  const combined = `${result.stdout ?? ""}\n${result.stderr ?? ""}`.trim();
  const errorCode = result.error && "code" in result.error ? result.error.code : undefined;
  if (errorCode === "ETIMEDOUT") {
    // 打ち切りは「テストが通ったと確認できなかった」。script error (exit 2)
    // にすると dispatcher は PASSED として記録し、黙って通ってしまうので、
    // pass:false として報告する。
    const reason = `chunk validate ${command} timed out after ${Math.round(timeoutMs / 1000)}s and was killed; the result is unknown.`;
    return { exitCode: null, timedOut: true, output: tail(combined ? `${reason}\n${combined}` : reason) };
  }
  if (result.error) {
    // 実行時に急に chunk が消えた等、probe後の異常系。
    process.stderr.write(`chunk-exec-error: ${result.error.message}\n`);
    process.exit(2);
  }
  return { exitCode: result.status, timedOut: false, output: tail(combined) };
}

// --- main -------------------------------------------------------------------

export function main(argv: string[]): void {
  const args = parseArgs(argv);
  const command = chunkCommand();

  probeChunkAvailable();

  const hash = workingTreeHash(command);
  const cached = readCache();
  if (cached && cached.hash === hash) {
    const out: SensorOutput = {
      pass: cached.pass,
      exitCode: cached.exitCode,
      cached: true,
      command,
      stage: args.stage,
      ...(cached.output ? { output: cached.output } : {}),
    };
    process.stdout.write(`${JSON.stringify(out)}\n`);
    process.exit(0);
  }

  const { exitCode, timedOut, output } = runChunkValidate(command);
  const pass = !timedOut && !isChunkFailure(exitCode);

  // タイムアウトは sidecar の混雑などで次は通りうるので、キャッシュしない。
  if (!timedOut) writeCache({ hash, pass, exitCode, output });

  const out: SensorOutput = {
    pass,
    exitCode,
    cached: false,
    ...(timedOut ? { timedOut } : {}),
    command,
    stage: args.stage,
    output,
  };
  process.stdout.write(`${JSON.stringify(out)}\n`);
  process.exit(0);
}

if (import.meta.main) main(process.argv.slice(2));
