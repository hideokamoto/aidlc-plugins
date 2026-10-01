---
target: code-generation
plugin: alloy
fragments:
  - anchor: after-step:2
    order: 100
---

## fragment: after-step:2

### Step (alloy): assert を fast-check の性質テストにする

このユニットの `<record>/construction/{unit-name}/functional-design/functional-spec.md` の
`## Alloy Structural Check` 節を読む。節が無い、または `Applicability: not-applicable` なら、
この節では何もしない。

`applicable` なら、functional-design の承認ゲートで人が承認した `assert` が、
このユニットの実装の正解になる。`code-generation-plan.md` に、Testing Contract の順序に
従って次のステップを加える（TDD なら、性質テストは対応する実装より前の Red に置く）。

1. **依存の追加**: `fast-check` を devDependency に加える（既にあれば使う）。
2. **生成器**: 実装の公開された操作（作成・共有・移動など、`functional-spec.md` の
   ワークフロー）を、ランダムな順序と引数で呼ぶ fast-check の生成器を書く。
   エンティティを直接組み立てて `fact` を満たす状態を作るのではなく、操作を通して状態を
   作る。`fact` は実装が強制すべきルールなので、操作を通した状態がそれを満たすかどうかも
   テストの対象である。
3. **性質テスト**: `### Model` の `assert` ごとに1つ、`fc.assert(fc.property(...))` の
   テストを書く。テスト名に `assert` の名前と `BRx.y` を入れ、生成した操作列の後の状態で
   `assert` の述語が成り立つことを確かめる。
4. **fact のテスト**: `fact` ごとに、それを破る操作が拒否されることを確かめるテストを書く。
5. **実行コマンド**: 性質テストをこのユニットに絞って実行するコマンドを
   `unit-test-instructions.md` に記録する。

性質テストが失敗したら、まず実装を疑う。`assert` は人が承認した設計なので、
テストを通すために性質を弱めない。設計が誤っていると判断した場合は、
コードを直さずに人に示し、functional-design へ戻すかどうかを決めてもらう。

Chunk の sidecar で内側のループを回す場合は、次の名前付きコマンドを登録するかどうかを
人に確認し、承認されたら `chunk validate <name> --cmd "<command>" --save` で
`.chunk/config.json` に保存する。sidecar には Java と Alloy の JAR が要る。

| 名前 | コマンド | 使う場面 |
|---|---|---|
| `alloy-check` | `bun .claude/tools/alloy-check.ts --file <functional-spec.md>` | モデルを変えた直後 |
