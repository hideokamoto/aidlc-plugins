---
target: functional-design
plugin: quint
adds:
  sensors:
    - quint-check
fragments:
  - anchor: after-step:4
    order: 200
  - anchor: after-step:5
    order: 200
  - anchor: in:Sensors
    order: 200
---

## fragment: after-step:4

### Step (quint): 振る舞いの設計検査

Step 4 で書いた `functional-spec.md` と `rules.md` を Quint の仕様に写し、検査する。
仕様と検査結果は、`functional-spec.md` の末尾に `## Quint Behavior Check` 節として書く。
この節は、このユニットのすべての `functional-spec.md` に必要である。

`## Quint Behavior Check` 節の `quint` ブロックは、実装コードではなく、
設計を検査するためのモデルである。このステージの「コードを書かない」
「コード片は15行まで」という制約は、この節の `quint` ブロックには適用しない。
それ以外の部分には従来どおり適用する。

#### 1. 対象かどうかを決める

次の4つのどれかが、`functional-spec.md` と `rules.md` から読み取れるなら対象とする。

- ライフサイクルを持つエンティティの状態遷移が `functional-spec.md` にある
- 操作の順序で結果が変わるワークフローがある
- 再送・リトライ・並行実行がありうる操作がある
- 操作をまたいで量を縛るルールが `rules.md` にある（在庫、残高、上限、時間をまたぐ一意性）

どれも当てはまらない場合は、節を次の1行だけにする。理由には、4つの条件を
それぞれどう確かめ、なぜどれも当てはまらないかを書く。

```markdown
## Quint Behavior Check

Applicability: not-applicable — <理由>
```

当てはまる場合は、`Applicability: applicable` の1行に続けて、以下の 2〜4 を行う。

#### 2. 仕様を書く

`.claude/knowledge/aidlc-architect-agent/quint-modeling-guide.md` を読んでから、
節の中に次の小見出しを書く。

- `### Source mapping`: 不変条件と action ごとに1行の表。Quint 上の名前、写した元
  （`BRx.y` のルール、または本ファイルのワークフロー・状態遷移）、そのルールが引く
  FR ID を書く。
- `### Specification`: 情報文字列が `quint` のフェンスブロックを1つだけ置き、
  その中にモジュールを1つ書く。
  - ワークフローの各段と状態遷移を `action` にする。
  - 外から来うる操作（Step 2 の Business Scenarios、再送・リトライ・並行実行の端の例）を、
    すべて `step` から `nondet` で選べるようにする。
  - `rules.md` の不変条件型のルールを、名前が `inv_` で始まる `val` にする。
    直前の行に、写した `BRx.y` をコメントで書く。
  - 直前の操作とその引数を `lastRequest` に、その操作にシステムが返すべき結果を
    `lastResult` に持たせる。トレースを実装に再生するために使う。
- `### Check configuration`: 情報文字列が `json` のフェンスブロックを1つだけ置く。

```json
{
  "invariants": ["inv_<name>", "inv_<name>"],
  "seed": "0x2a",
  "maxSamples": 1000,
  "maxSteps": 20
}
```

`invariants` には、モジュール中のすべての `inv_` を並べる（漏れがあると検査は失敗する）。
`seed` は固定する。`maxSamples` は必須である。seed を付けて `--max-samples` を
省くと、`quint run` はトレースを1本しか試さない。

不変条件は、人が要求から決めた `rules.md` のルールの写しである。
シミュレーションを通すために不変条件を作り替えたり、足したり、弱めたりしない。
写せないルールがあれば、その理由を `### Findings` に書く。

#### 3. 検査する

```bash
bun .claude/tools/quint-check.ts --file <record>/construction/{unit-name}/functional-design/functional-spec.md
```

このツールは節の `quint` ブロックを取り出し、`quint typecheck` と、
`quint run --backend typescript` を設定どおりの invariants・seed・サンプル数・
ステップ上限で実行し、JSON を1つ出力する。結果を節の中に次の小見出しで書く。

- `### Result`: ツールの `pass`、`phase`、`command`（実行したコマンド）
- `### Findings`: `phase` が `typecheck` なら型エラー。`simulate` なら、破れた不変条件と、
  ツールの `output` にある反例トレースを1ステップずつ書き、各ステップの `lastRequest` と、
  どの `BRx.y` の組み合わせが違反を生んだかを書く。合格なら `None`
- `### Limits`: ステップ上限とサンプル数、そしてこれが有界のランダムなシミュレーションで
  あり証明ではないこと

#### 4. 承認ゲートの前に結果を片付ける

blocking の `quint-check` センサーは、承認ゲートを出す前と修正の後に、
`functional-spec.md` に同じ検査をかける。不合格ならゲートは開かない。

- **型エラー**と**写し間違い**（仕様がワークフローや `rules.md` と食い違う）は、
  仕様を直して 3 をやり直す。
- **設計そのものが生む違反**は、仕様ではなく設計の誤りである。不変条件を弱める、
  `step` から操作を外す、上限を下げる、のいずれもしない。反例を人に示し、
  `entities.md` / `rules.md` / `functional-spec.md` のどこをどう直すかを人に決めてもらう。
  直したら、2 と 3 をやり直す。

## fragment: after-step:5

### Step (quint): 承認ゲートで人に見てもらう点

Step 6 の完了サマリに、`## Quint Behavior Check` の `Applicability` と
`### Result` を載せる。対象（applicable）の場合は、次の2点を人のレビュー対象として
明示する。

1. 不変条件（`inv_` の `val`）が、引いている `BRx.y` のルールを正しく写しているか
2. `step` が、外から来うる操作（再送・並行実行を含む）をすべて含んでいるか

対象外（not-applicable）の場合は、その理由を見てもらう。

## fragment: in:Sensors

quint プラグインは、このステージに BLOCKING の gate センサー `quint-check` を加える。
`functional-spec.md` の `## Quint Behavior Check` 節を読み、対象外ならその理由の有無を、
対象なら `quint typecheck` と設定どおりの `quint run` の結果を確かめる。
節が無いと不合格になる。`quint` が見つからないと `tool-unavailable` になり、
これもゲートを閉じたままにする。`bun .claude/tools/quint-doctor.ts` で導入状況を確かめられる。
