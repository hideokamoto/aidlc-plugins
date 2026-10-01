---
id: quint-check
kind: deterministic
command: bun {{HARNESS_DIR}}/tools/quint-check.ts
default_severity: blocking
description: Checks the Quint Behavior Check section of functional-spec.md by typechecking and simulating its invariants
category: design-check
fire_on: gate
matches: "**/functional-design/functional-spec.md"
input_schema:
  output_path: string
  stage_slug: string
output_schema:
  pass: boolean
timeout_seconds: 300
---

# quint-check sensor

functional-design の `functional-spec.md` にある `## Quint Behavior Check` 節を検査する。

- 節が無い、または `Applicability:` の宣言が無い場合は失敗にする。
  対象外のユニットも、対象外である理由を書くことを求める。
- `Applicability: not-applicable — <理由>` の場合は、理由があり、`quint` ブロックが
  無ければ合格にする。`quint` は呼ばない。
- `Applicability: applicable` の場合は、`quint` フェンスブロックを取り出し、
  `quint typecheck` と、`### Check configuration` の JSON に書いた invariants・seed・
  サンプル数・ステップ上限で `quint run --backend typescript` を実行する。
  両方が成功したときだけ合格にする。モジュール中の `inv_` が設定から漏れていても
  失敗にする。

## Gate behaviour

`fire_on: gate` かつ `blocking` のため、承認ゲートを出す前（`awaiting-approval`）と
修正後（`revised`）に発火し、合格の判定が無い限りゲートは開かない。
エンジンは `--stage <slug> --output-path <functional-spec.md の絶対パス>` を渡す。

検査が必要なのに `quint` が見つからない場合は、スクリプトが終了コード 127 を返し、
ディスパッチャは `tool-unavailable` 付きの PASSED を記録する。ゲート側は注記付きの
PASSED を合格として扱わないため、ゲートは閉じたままになる。

## Failure mode

`SENSOR_FAILED` の詳細ファイルに、スクリプトが出力した JSON（`phase` が
`applicability` / `extract` / `typecheck` / `simulate` のどれで落ちたか、
実行したコマンド、quint の出力末尾）が残る。
