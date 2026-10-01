---
target: ci-pipeline
plugin: quint
adds:
  consumes:
    - functional-spec
fragments:
  - anchor: after-step:4
    order: 200
---

## fragment: after-step:4

### Step (quint): Quint 仕様の検査と再生を CI に載せる

`<record>/construction/*/functional-design/functional-spec.md` のうち、
`## Quint Behavior Check` 節が `Applicability: applicable` のユニットを集める。1つも無ければ、この節では何もしない。

ある場合は、Step 4 で作る CI 設定に、次の2つを分けて定義する。
CI ランナーには Node.js、`@informalsystems/quint`（devDependency）、bun が要る。

1. **commit 駆動（マージの関門）**: 対象ユニットごとに、
   `bun .claude/tools/quint-check.ts --file <functional-spec.md>` と、
   code-generation で加えた `quint:replay` を、`### Check configuration` の seed のまま実行する。
   どちらかが失敗したらマージを止める。`quality-gates.md` に必須チェックとして書く。
2. **定期実行（マージを止めない）**: スケジュール実行で、実行ごとに異なる seed を作り
   （例: 実行番号や日時から作る）、その seed を `--seed` と `QUINT_SEED` に渡して
   同じ2つを実行する。失敗しても既存のマージは止めず、seed をログに出して通知する。
   その seed で `quint-check.ts --file <functional-spec.md> --seed <seed>` を再実行すれば
   手元で再現できることを `quality-gates.md` に書く。

seed を変えた探索で見つかった違反は、実装の誤りか設計の誤りかを人が判断する。
設計の誤りなら functional-design に戻す。
