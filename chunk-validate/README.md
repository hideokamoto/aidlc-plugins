# chunk-validate

AI-DLC plugin that adds one **advisory** sensor, `chunk-validate`, to the
`code-generation` stage. Whenever a `*.ts`/`*.tsx` file is written during the
stage, the sensor runs `chunk validate <command>` — a Chunk sidecar gate
command from the project's `.chunk/config.json` — and reports the result back
to the workflow.

## Configuration

Set these in the environment of the Claude Code session (the engine passes it
on to the sensor):

| Variable | Default | Meaning |
| --- | --- | --- |
| `AIDLC_CHUNK_VALIDATE_COMMAND` | `test` | Gate command name passed to `chunk validate` (list them with `chunk validate --list`). Part of the cache key. |
| `AIDLC_CHUNK_VALIDATE_TIMEOUT_MS` | `55000` | Time limit for `chunk validate`. Capped at 55000 so it stays under the manifest's `timeout_seconds: 60`. |

## What it contributes

- `sensors/aidlc-chunk-validate.md` — sensor manifest (`fire_on: write`,
  `matches: **/*.{ts,tsx}`, `timeout_seconds: 60`)
- `tools/aidlc-sensor-chunk-validate.ts` — per-sensor script. It takes the
  `--stage <slug> --output-path <path>` arguments the engine dispatcher passes
  to plugin sensors (`--file-path` is accepted as an alias), probes for the
  `chunk` binary (exit 127, tool-unavailable, when it is missing), deduplicates
  by a working-tree content hash, runs `chunk validate <command>`, and prints
  `{pass, exitCode, cached, command, stage, output}` JSON. `output` carries the
  tail of chunk's stdout/stderr so failure details survive into the
  SENSOR_FAILED detail file.
- `contributions/construction/code-generation.md` — stage fragment wiring the
  sensor into code-generation and instructing the agent to treat `pass: false`
  as a repair directive until `pass: true`.

## Caching

The cache (`.git/aidlc-chunk-validate-cache.json`) is keyed on the gate
command name, `git diff HEAD`, and the bytes of untracked, non-ignored files
(`git stash create` misses untracked files). The AI-DLC workspace `aidlc/` is
left out of the hash: the engine appends audit rows and writes sensor detail
files there around every fire, so including it would change the hash on every
fire and the cache would never hit. Those records are workflow artifacts, not
inputs to the project's tests. Timed-out runs are not cached.

## Severity

Advisory only — the framework has no blocking severity yet. The contribution
fragment instructs the agent to keep editing until `pass: true`, which is where
the effective force comes from.

## Known limitations

- `pass=false` means "`chunk validate` exited non-zero or timed out"
  (`timedOut: true`). Real test failures confirmed in practice; sidecar
  infrastructure failures look the same — check `output` in the detail file.
- Validates the whole test suite, not just the file that triggered the write.

## Tests

`tests/chunk-validate.test.ts` runs the script against a stub `chunk` (never
the real one) and fires the sensor through the engine dispatcher in a project
composed with this plugin. Run them with `pnpm test`.
