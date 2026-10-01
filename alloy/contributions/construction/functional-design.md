---
target: functional-design
plugin: alloy
adds:
  sensors:
    - alloy-check
fragments:
  - anchor: after-step:4
    order: 100
  - anchor: after-step:5
    order: 100
  - anchor: in:Sensors
    order: 100
---

## fragment: after-step:4

### Step (alloy): 構造の設計検査

Step 4 で書いた `entities.md` と `rules.md` を Alloy のモデルに写し、検査する。
モデルと検査結果は、`functional-spec.md` の末尾に `## Alloy Structural Check` 節として書く。
この節は、このユニットのすべての `functional-spec.md` に必要である。

`## Alloy Structural Check` 節の `alloy` ブロックは、実装コードではなく、
設計を検査するためのモデルである。このステージの「コードを書かない」
「コード片は15行まで」という制約は、この節の `alloy` ブロックには適用しない。
それ以外の部分には従来どおり適用する。

#### 1. 対象かどうかを決める

`entities.md` の関係と `rules.md` の制約から、関係の組み合わせに起因する誤りが
ありうるかを判定する。次のうち2つ以上が同じエンティティに重なるなら対象とする。

- 所有（owner、作成者）
- 権限・認可（誰が読める・書ける・承認できる）
- 他のエンティティへの参照（とくに任意の参照 `lone`）
- 一意性・件数・排他の制約

対象でない場合は、節を次の1行だけにする。理由には、どの制約がどのエンティティに
いくつ重なるかを書く。

```markdown
## Alloy Structural Check

Applicability: not-applicable — <理由>
```

対象の場合は、`Applicability: applicable` の1行に続けて、以下の 2〜4 を行う。

#### 2. モデルを書く

`.claude/knowledge/aidlc-architect-agent/alloy-modeling-guide.md` を読んでから、
節の中に次の小見出しを書く。

- `### Source mapping`: `fact` と `assert` ごとに1行の表。Alloy 上の名前、種別
  （fact / assert）、写した `BRx.y`、そのルールが引く FR ID を書く。
- `### Model`: 情報文字列が `alloy` のフェンスブロックを1つだけ置く。
  - `entities.md` のエンティティを `sig` に、参照をフィールドに写す。
  - システムが書き込みのたびに強制するルールを `fact` に写す。
  - 設計が保証すると約束している性質を `assert` に写し、`assert` ごとに
    `check <名前> for <スコープ>` を書く。
  - インスタンスを1つ求める `run` を1つ以上書く。
  - `fact` と `assert` の直前の行に、写した `BRx.y` を `--` コメントで書く。

`assert` は、人が要求から決めた `rules.md` のルールの写しである。検査を通すために
`assert` を弱めたり、`fact` を足して反例を消したりしない。写せないルールがあれば、
その理由を `### Findings` に書く。

#### 3. 検査する

```bash
bun .claude/tools/alloy-check.ts --file <record>/construction/{unit-name}/functional-design/functional-spec.md
```

このツールは節の `alloy` ブロックを取り出して全コマンドを実行し、JSON を1つ出力する。
結果を節の中に次の小見出しで書く。

- `### Result`: ツールの `pass`、`phase`、各コマンドの結果（`commands`）
- `### Findings`: `phase` が `parse` なら構文・型エラー。`check` なら、反例の構造を
  ドメインの言葉で書き（どの利用者・どの文書・どのチームか）、どの `fact` の組み合わせが
  その状態を許したかを書く。`run` がインスタンスを見つけなかった場合は、矛盾している
  `fact` の候補を書く。合格なら `None`
- `### Limits`: 各 `check` のスコープと、これがスコープ内の有界な探索であり
  証明ではないこと

#### 4. 承認ゲートの前に結果を片付ける

blocking の `alloy-check` センサーは、承認ゲートを出す前と修正の後に、
`functional-spec.md` に同じ検査をかける。不合格ならゲートは開かない。

- **構文・型のエラー**と**写し間違い**（モデルが `entities.md` / `rules.md` と食い違う）は、
  モデルを直して 3 をやり直す。
- **反例**と**矛盾した `fact`** は、モデルではなく設計の誤りである。`assert` を弱める、
  `fact` を足して反例を消す、スコープを下げる、のいずれもしない。反例を人に示し、
  `entities.md` / `rules.md` のどこをどう直すかを人に決めてもらう。直したら、2 と 3 を
  やり直す。

## fragment: after-step:5

### Step (alloy): 承認ゲートで人に見てもらう点

Step 6 の完了サマリに、`## Alloy Structural Check` の `Applicability` と
`### Result` を載せる。対象（applicable）の場合は、次の2点を人のレビュー対象として
明示する。

1. 各 `assert` が、引いている `BRx.y` のルールを正しく写しているか
2. 各 `fact` が、システムが実際に強制するルールだけを置いており、現実にない前提を
   置いていないか

対象外（not-applicable）の場合は、その理由を見てもらう。

## fragment: in:Sensors

alloy プラグインは、このステージに BLOCKING の gate センサー `alloy-check` を加える。
`functional-spec.md` の `## Alloy Structural Check` 節を読み、対象外ならその理由の有無を、
対象なら Alloy の全コマンドの結果を確かめる。反例を見つけた `check`、インスタンスを
見つけない `run`、`check` の無い `assert` は不合格になる。節が無くても不合格になる。
Java か Alloy の JAR が見つからないと `tool-unavailable` になり、これもゲートを
閉じたままにする。`bun .claude/tools/alloy-doctor.ts` で導入状況を確かめられる。
