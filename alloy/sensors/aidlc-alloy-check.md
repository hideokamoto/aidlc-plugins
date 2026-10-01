---
id: alloy-check
kind: deterministic
command: bun {{HARNESS_DIR}}/tools/alloy-check.ts
default_severity: blocking
description: Checks the Alloy Structural Check section of functional-spec.md for counterexamples and contradictory facts
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

# alloy-check sensor

functional-design の `functional-spec.md` にある `## Alloy Structural Check` 節を検査する。

- 節が無い、または `Applicability:` の宣言が無い場合は失敗にする。
  対象外のユニットも、対象外である理由を書くことを求める。
- `Applicability: not-applicable — <理由>` の場合は、理由があり、`alloy` ブロックが
  無ければ合格にする。Java は呼ばない。
- `Applicability: applicable` の場合は、`alloy` フェンスブロックを取り出し、
  `java -jar org.alloytools.alloy.dist.jar exec -t json -c '*'` で全コマンドを実行する。
  次のすべてを満たすときだけ合格にする。
  - すべての `assert` に `check` コマンドがある
  - `run` コマンドが1つ以上ある
  - Alloy が構文・型を受け付ける
  - どの `check` も反例を見つけない
  - どの `run` もインスタンスを見つける（見つからなければ `fact` 同士が矛盾しており、
    すべての `check` が空虚に合格してしまう）

`exec` は反例があっても終了コード 0 を返すため、判定は出力の `receipt.json` で行う。
`solution` を持つコマンドが、インスタンス（`check` なら反例）を見つけたコマンドである。

## Gate behaviour

`fire_on: gate` かつ `blocking` のため、承認ゲートを出す前（`awaiting-approval`）と
修正後（`revised`）に発火し、合格の判定が無い限りゲートは開かない。
エンジンは `--stage <slug> --output-path <functional-spec.md の絶対パス>` を渡す。

検査が必要なのに Java か Alloy の JAR が見つからない場合は、スクリプトが終了コード
127 を返し、ディスパッチャは `tool-unavailable` 付きの PASSED を記録する。ゲート側は
注記付きの PASSED を合格として扱わないため、ゲートは閉じたままになる。

## Failure mode

`SENSOR_FAILED` の詳細ファイルに、スクリプトが出力した JSON（`phase` が
`applicability` / `extract` / `parse` / `check` のどれで落ちたか、各コマンドの結果、
反例のインスタンス）が残る。`parse` の行番号は、取り出した `alloy` ブロックの中の
行番号である。
