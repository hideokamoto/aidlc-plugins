# quint

AI-DLC plugin that gates `functional-design` on a Quint behaviour check. The
unit's workflows and business rules are transcribed into a Quint module, and a
**blocking** gate sensor simulates its invariants before the approval gate can
be presented. `code-generation` then replays traces from the same module
against the implementation, and `ci-pipeline` runs that replay as a merge gate
and on a schedule with varying seeds.

## What it contributes

| File | Effect |
|---|---|
| `contributions/construction/functional-design.md` | Adds the `quint-check` sensor and fragments after Step 4 (write the `## Quint Behavior Check` section of `functional-spec.md`, run the check, resolve findings), after Step 5 (what the human reviews at the gate), and in `## Sensors` |
| `sensors/aidlc-quint-check.md` | `fire_on: gate`, `default_severity: blocking`, `matches: **/functional-design/functional-spec.md` |
| `tools/quint-check.ts` | The one check CLI for the sensor, Chunk, and CI (see below) |
| `tools/quint-doctor.ts` | Install check: Node.js, the `quint` CLI, and `--backend typescript` support |
| `knowledge/aidlc-architect-agent/quint-modeling-guide.md` | Modeling rules loaded by functional-design's lead agent |
| `contributions/construction/code-generation.md` | Plans an ITF decoder and a vitest replay of `lastRequest` / `lastResult` (e.g. through Hono's `app.request()`) |
| `contributions/construction/ci-pipeline.md` | Plans a commit-driven replay gate and a scheduled seed-varying run that does not block merges |

## The section in functional-spec.md

Every unit's `functional-spec.md` must end with:

````markdown
## Quint Behavior Check

Applicability: applicable

### Source mapping
| Quint name | Transcribes | FR |

### Specification
```quint
module reservation { ... val inv_conservation = ... }
```

### Check configuration
```json
{ "invariants": ["inv_conservation"], "seed": "0x2a", "maxSamples": 1000, "maxSteps": 20 }
```

### Result / ### Findings / ### Limits
````

or, for a unit without state, ordering, retries, or cross-operation quantities:

```markdown
## Quint Behavior Check

Applicability: not-applicable — <why none of the four conditions holds>
```

The sensor fails when the section is missing, when a not-applicable line has no
reason, when an `inv_` value is missing from `invariants`, when `maxSamples` is
absent (a seeded `quint run` without it simulates one trace), when
`quint typecheck` fails, or when `quint run` finds a violation.

## quint-check.ts

```bash
# what the gate sensor runs (always exits 0; the verdict is the JSON `pass`)
bun .claude/tools/quint-check.ts --stage functional-design --output-path <functional-spec.md>

# Chunk / CI / by hand: exits 0 pass, 1 fail, 127 quint missing, 2 usage error
bun .claude/tools/quint-check.ts --file <functional-spec.md | spec.qnt> \
  [--seed s] [--max-samples n] [--max-steps n] [--invariants a,b] \
  [--out-itf .quint-traces/u1/t_{seq}.itf.json --n-traces 20]
```

`quint` is resolved from `$QUINT_BIN`, then `PATH`, then
`./node_modules/.bin/quint`. The backend is fixed to `--backend typescript`.

## Install

```bash
claude plugin install aidlc-quint@aidlc-plugins
npm i -D @informalsystems/quint     # in the project
bun .claude/tools/quint-doctor.ts   # check prerequisites
```

When `quint` is missing and a unit's check applies, the sensor reports
`tool-unavailable` and the gate stays closed.

## Differences from the original plan

- **No own stage.** In AI-DLC 2.10.0 a plugin stage is numbered after every
  existing stage of its phase (`3.8`, after `ci-pipeline`), and the router walks
  stages in that order, so a stage cannot run between functional-design and
  code-generation. The check therefore rides on functional-design's own gate.
- **No separate artifacts.** Adding `produces` to functional-design through a
  contribution fails to compile (`review_artifact "functional-spec" is pruned
  for applicable unit kinds: packaging`) because contributions cannot add
  `produces_kinds`. The spec and its result live in `functional-spec.md`, which
  code-generation already consumes.
- **No support agent.** functional-design runs `mode: inline`, so the modeling
  guide is shipped as knowledge for its lead agent instead.
- **Doctor is not run by `/aidlc --doctor`.** AI-DLC discovers plugin doctor
  scripts only for plugins that own a stage or scope. Run
  `bun .claude/tools/quint-doctor.ts` directly.

## Verified and not verified

Verified in this repository's tests (AI-DLC 2.10.0, quint 0.33.0): composition,
fragment placement, the compiled graph carrying `quint-check` as a blocking gate
sensor of functional-design, the tool's verdicts on passing / violating /
type-error / dropped-invariant / not-applicable / missing-section fixtures, and
the engine's sensor dispatcher reporting `passed` / `failed` for them.

Not verified: a full AI-DLC workflow reaching functional-design's approval gate
and being refused by the sensor (the gate code path was read, not run), the
replay tests and CI workflows that code-generation and ci-pipeline generate, and
Chunk sidecar execution. `quint run` is a bounded random simulation, not a proof.
