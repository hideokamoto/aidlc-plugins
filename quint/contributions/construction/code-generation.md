---
target: code-generation
plugin: quint
fragments:
  - anchor: after-step:2
    order: 200
---

## fragment: after-step:2

### Step (quint): Quint トレースの再生テストを計画に入れる

このユニットの `<record>/construction/{unit-name}/functional-design/functional-spec.md` の
`## Quint Behavior Check` 節を読む。節が無い、または `Applicability: not-applicable` なら、
この節では何もしない。

`applicable` なら、functional-design の承認ゲートで人が承認した不変条件と `step` が、
このユニットの実装の正解になる。`code-generation-plan.md` に、Testing Contract の順序に
従って次のステップを加える（TDD なら、再生テストは対応する実装より前の Red に置く）。

1. **トレース生成コマンド**: `package.json` に、seed を環境変数で差し替えられる
   スクリプトを加える。仕様は functional-design の `functional-spec.md` から直接読み、
   リポジトリに `.qnt` の写しを作らない。

   ```bash
   bun .claude/tools/quint-check.ts \
     --file <functional-design の functional-spec.md への相対パス> \
     --seed "${QUINT_SEED:-<### Check configuration の seed>}" \
     --out-itf .quint-traces/{unit-name}/t_{seq}.itf.json --n-traces 20
   ```

   `.quint-traces/` は `.gitignore` に加える。トレースは毎回この仕様から作り直す。

2. **ITF デコーダ**: ITF の値を TypeScript の値に戻すモジュールを書く。
   `{"#bigint": "3"}` は数値、`{"#map": [[k, v], ...]}` は `Map`、
   `{"#set": [...]}` は `Set`、`{"#tup": [...]}` は配列、それ以外のオブジェクトは
   レコードとして再帰的に戻す。デコーダ自体の単体テストも書く。

3. **再生テスト**: トレース1本ごとに、新しい状態のアプリケーションを作り、
   2番目以降の各状態について、`lastRequest` をリクエストに変換して実装に送り、
   応答がその状態の `lastResult` と一致することを確かめる vitest のテストを書く。
   HTTP API なら、サーバーを起動せずにリクエストを送れる口を使う
   （Hono なら `app.request()`）。`lastRequest` から実装のリクエストへの対応表は
   テスト内に1か所だけ置く。

4. **実行コマンド**: 1 と 3 を続けて実行する `quint:replay` スクリプトを加え、
   `unit-test-instructions.md` に、このユニットに絞ったコマンドとして記録する。

再生テストが失敗したら、まず実装を疑う。不変条件と `step` は人が承認した設計なので、
テストを通すために仕様側を書き換えない。仕様が誤っていると判断した場合は、
コードを直さずに人に示し、functional-design へ戻すかどうかを決めてもらう。

Chunk の sidecar で内側のループを回す場合は、次の名前付きコマンドを登録するかどうかを
人に確認し、承認されたら `chunk validate <name> --cmd "<command>" --save` で
`.chunk/config.json` に保存する。

| 名前 | コマンド | 使う場面 |
|---|---|---|
| `quint-check` | `bun .claude/tools/quint-check.ts --file <functional-spec.md>` | 仕様を変えた直後 |
| `quint-replay` | `npm run quint:replay` など、4 のスクリプト | 実装を変えた直後 |
