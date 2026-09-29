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

Wraps `chunk validate test`(このプロジェクトの `.chunk/config.json` に設定した
ゲートコマンド)の結果を報告する。組み込みの `linter` / `type-check` センサーが
静的解析なのに対し、これはプロジェクト自身のテストスイートを実際に
Chunk sidecar 上で走らせるため、他の advisory センサーより1回の発火にかかる
時間が長くなりうる。

## Failure mode

`SENSOR_FAILED` を発し、詳細を
`aidlc/spaces/<active-space>/intents/<active-intent>/.aidlc-engine/sensors/<stage-slug>/chunk-validate-<fire-id>.md`
に書く(space/intent はアクティブなカーソルから、fire-id はアクティブな記録の
`audit/<host>-<clone-id>.md` シャード中の `SENSOR_FIRED` 行にある8桁hex)。
エージェントはこの詳細ファイルの `pass`/`exitCode` を読み、テストを直す。

## Advisory note

フレームワークにはまだ blocking severity が存在しない(test-pro 出荷センサーの
注記で確認済み)。したがってここでの `SENSOR_FAILED` は「報告されるだけ」で
強制力を持たない。実際にエージェントがテストを直すかどうかは、
`contributions/construction/code-generation.md` の fragment 側の指示文が
握っている。

## Known caveats(このワークショップ限定)

- 重複排除は `chunk` 自身のキャッシュではなく、ラッパスクリプト自前の
  ワーキングツリーハッシュキャッシュで行っている。`chunk validate` の
  キャッシュ挙動は一次情報間で矛盾しており(GitHub docs vs circleci.com公式)、
  当てにしていない。ハッシュは `git diff HEAD` + untracked ファイル内容の
  sha256 で、code-generation が書く新規ファイルにも反応する
  (`git stash create` ベースでは untracked が見えず stale 返しする問題が
  あった)。
- `pass=false` は「`chunk validate` が非ゼロ終了した」の意味。実テスト失敗が
  `pass:false, exitCode:1` として届くことは実測済み。ただし sidecar 側の
  インフラ障害(認証切れ、プール枯渇、ネットワーク等)との切り分けは未実装で、
  インフラ起因も同じ形で `SENSOR_FAILED` になる。診断用に chunk の
  stdout/stderr 末尾を JSON の `output` フィールドに載せているので、
  detail ファイルで判別すること。
- `--file-path` で指定されたファイル個別ではなく、ワーキングツリー全体の
  テストスイートを検証する。`chunk validate` が全体ゲートであるため。