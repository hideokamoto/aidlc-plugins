---
target: intent-capture
plugin: solo-developer
fragments:
  - anchor: after-step:2
    order: 100
  - anchor: after-step:4
    order: 100
---

## fragment: after-step:2

### Step (solo-developer): 単独開発者宣言があるときの質問の省略

Step 1 で読み込んだ `org.md` / `team.md` / `project.md` のいずれかで、H2 見出しの
直下に `SOLO-DEVELOPER:` で始まる1行の規則（単独開発者宣言）があるかを確かめる。

- **宣言が無い場合**: この節では何もしない。Step 2 のとおりに質問を作る。
- **宣言と初期依頼が食い違う場合**（`[desc]` に宣言の人物以外の発注者・承認者・
  報告先が出てくる等）: 省略せず、Step 2 のとおりに質問を作る。

宣言があり、食い違いも無い場合は次のとおりにする。

1. 宣言の1行を、Step 2 の書式どおり `## Sources` に `[memory:M<n>]` として登録する
   （ファイルパス・H2 見出し・規則の本文を原文のまま写す）。
2. Step 2 の質問のうち、次の3問は作らない。宣言が回答済みの事実として扱う。
   - `Who are the key stakeholders and what does each care about?`
   - `Who decides scope or priority, and who influences those decisions?`
   - `Are there communication requirements or a reporting cadence?`
3. `## Sources` の直後に、省略した理由を1行で書き、宣言の出典タグを付ける。
   例: `ステークホルダー・意思決定者・報告義務の質問は、単独開発者宣言により回答済みのため作らない [memory:M3]`
4. 上の3問以外の質問は、省略せずに作る。`Q<n>` の番号は詰めて振る。

## fragment: after-step:4

### Step (solo-developer): 単独開発者宣言からの stakeholder-map.md

単独開発者宣言を `[memory:M<n>]` として登録した場合、
`stakeholder-map.md` は宣言だけを出典にして次のとおりに作る。

- **ステークホルダー**: 宣言に書かれた人物1名だけを載せる。役割は宣言に書かれた
  範囲（オーナー・意思決定者・承認者など）に限り、`Source` 列に宣言のタグを書く。
  関心（interest）は、確認済みの `[Q<n>]` の回答（課題・成功基準など）から書ける
  場合だけその出典で書き、書けない場合は列を省く。
- **意思決定者と影響者**: 意思決定者は宣言の人物。宣言が他者の不在を明記して
  いる場合に限り、影響者を `None` とし、宣言のタグを付ける。
- **コミュニケーション要件**: 宣言が報告義務の不在を明記している場合に限り
  `None` とし、宣言のタグを付ける。明記していない場合は Step 4 の規定どおり
  `Unknown (open question) [assumption]` とする。

宣言に書かれていない人物・役割・要件を足さない。
