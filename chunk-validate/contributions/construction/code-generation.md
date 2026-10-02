---
target: code-generation
plugin: chunk-validate
adds:
  sensors:
    - chunk-validate
fragments:
  - anchor: in:Sensors
    order: 100
---

## fragment: in:Sensors

chunk-validate プラグインは、このステージに ADVISORY センサーを1本だけ配線する:
`chunk-validate`(このプロジェクトの Chunk sidecar 上で、今書いたコードに対して
`chunk validate <ゲートコマンド>` を実行する。ゲートコマンドは環境変数
`AIDLC_CHUNK_VALIDATE_COMMAND`、未指定なら `test`)。これはプロジェクト自身のテストスイートが
通るかどうかを「報告」するだけで、ステージをブロックしない
(フレームワークにはまだ blocking severity が存在しない)。この報告は
権威ある指示として扱うこと: `pass: false` が返ってきたら、
`.aidlc-engine/sensors/code-generation/chunk-validate-<fire-id>.md` に
書かれた詳細ファイルを読み、原因を直し、`pass: true` になるまで編集を
続けてから次に進むこと。