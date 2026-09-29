# chunk-validate

AI-DLC plugin that adds one **advisory** sensor, `chunk-validate`, to the
`code-generation` stage. Whenever a `*.ts`/`*.tsx` file is written during the
stage, the sensor runs `chunk validate test` — this repository's Chunk sidecar
gate command from `.chunk/config.json` — and reports the result back to the
workflow.

## What it contributes

- `sensors/aidlc-chunk-validate.md` — sensor manifest (`fire_on: write`,
  `matches: **/*.{ts,tsx}`, `input_schema.file_path`, `timeout_seconds: 60`)
- `tools/aidlc-sensor-chunk-validate.ts` — per-sensor script that probes for the
  `chunk` binary, deduplicates by a working-tree content hash (tracked diffs +
  untracked file bytes — `git stash create` misses untracked files), runs
  `chunk validate test`, and prints `{pass, exitCode, cached, stage, output}`
  JSON. `output` carries the tail of chunk's stdout/stderr so failure details
  survive into the SENSOR_FAILED detail file.
- `contributions/construction/code-generation.md` — stage fragment wiring the
  sensor into code-generation and instructing the agent to treat `pass: false`
  as a repair directive until `pass: true`.

## Severity

Advisory only — the framework has no blocking severity yet. The contribution
fragment instructs the agent to keep editing until `pass: true`, which is where
the effective force comes from.

## Known limitations

- `pass=false` means "`chunk validate` exited non-zero". Real test failures
  confirmed in practice; sidecar infrastructure failures look the same — check
  `output` in the detail file.
- Validates the whole test suite, not just the file that triggered the write.
