---
id: chunk-validate
kind: deterministic
command: bun {{HARNESS_DIR}}/tools/aidlc-sensor-chunk-validate.ts
default_severity: advisory
description: Runs chunk validate on the sidecar against generated code
category: code-quality
fire_on: write
matches: "**/*.{ts,tsx}"
input_schema:
  file_path: string
  stage_slug: string
output_schema:
  pass: boolean
timeout_seconds: 60
---

# chunk-validate sensor

Wraps `chunk validate <command>` の結果を報告する。`<command>` は
プロジェクトの `.chunk/config.json` に設定したゲートコマンド名で、
環境変数 `AIDLC_CHUNK_VALIDATE_COMMAND` で指定する(未指定なら `test`)。
組み込みの `linter` / `type-check` センサーが静的解析なのに対し、これは
プロジェクト自身のテストスイートを実際に Chunk sidecar 上で走らせるため、
他の advisory センサーより1回の発火にかかる時間が長くなりうる。

## Configuration

| 環境変数 | 既定値 | 意味 |
| --- | --- | --- |
| `AIDLC_CHUNK_VALIDATE_COMMAND` | `test` | `chunk validate` に渡すゲートコマンド名(`chunk validate --list` で確認できる)。キャッシュキーにも含まれる |
| `AIDLC_CHUNK_VALIDATE_TIMEOUT_MS` | `55000` | `chunk validate` の打ち切り時間(ミリ秒)。manifest の `timeout_seconds` (60) を超えないよう、55000 が上限 |

どちらも engine がセンサーを起動するプロセス(Claude Code のセッション)の
環境に置く。

## Failure mode

`SENSOR_FAILED` を発し、詳細を
`aidlc/spaces/<active-space>/intents/<active-intent>/.aidlc-engine/sensors/<stage-slug>/chunk-validate-<fire-id>.md`
に書く(space/intent はアクティブなカーソルから、fire-id はアクティブな記録の
`audit/<host>-<clone-id>.md` シャード中の `SENSOR_FIRED` 行にある8桁hex)。
エージェントはこの詳細ファイルの `pass`/`exitCode`/`output` を読み、テストを直す。

`chunk validate` が打ち切り時間内に終わらなかった場合も `pass: false`
(`timedOut: true`, `exitCode: null`)として報告する。テストが通ったと確認
できていないものを PASSED にしないため。タイムアウトの結果はキャッシュしない。

## Advisory note

フレームワークにはまだ blocking severity が存在しない(test-pro 出荷センサーの
注記で確認済み)。したがってここでの `SENSOR_FAILED` は「報告されるだけ」で
強制力を持たない。実際にエージェントがテストを直すかどうかは、
`contributions/construction/code-generation.md` の fragment 側の指示文が
握っている。

## Known caveats

- 重複排除は `chunk` 自身のキャッシュではなく、ラッパスクリプト自前の
  ワーキングツリーハッシュキャッシュ(`.git/aidlc-chunk-validate-cache.json`)
  で行っている。`chunk validate` のキャッシュ挙動は一次情報間で矛盾しており
  (GitHub docs vs circleci.com公式)、当てにしていない。ハッシュは
  ゲートコマンド名 + `git diff HEAD` + untracked ファイル内容の sha256 で、
  code-generation が書く新規ファイルにも反応する(`git stash create` ベース
  では untracked が見えず stale 返しする問題があった)。
- AI-DLC のワークスペース `aidlc/` はハッシュから除外している。engine は
  発火のたびに記録の audit シャードへ行を追記し、詳細ファイルを書くので、
  含めるとキャッシュが一度も当たらない。`aidlc/` はワークフローの成果物で
  あってテストの入力ではないため、除外しても古い結果は返らない。
- `pass=false` は「`chunk validate` が非ゼロ終了した、またはタイムアウトした」
  の意味。実テスト失敗が `pass:false, exitCode:1` として届くことは実測済み。
  ただし sidecar 側のインフラ障害(認証切れ、プール枯渇、ネットワーク等)との
  切り分けは未実装で、インフラ起因も同じ形で `SENSOR_FAILED` になる。
  診断用に chunk の stdout/stderr 末尾を JSON の `output` フィールドに
  載せているので、detail ファイルで判別すること。
- engine から渡される `--output-path` のファイル個別ではなく、ワーキング
  ツリー全体のテストスイートを検証する。`chunk validate` が全体ゲートであるため。
