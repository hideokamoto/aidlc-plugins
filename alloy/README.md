# alloy

AI-DLC plugin that gates `functional-design` on an Alloy structural check. The
unit's entities and business rules are transcribed into an Alloy model, and a
**blocking** gate sensor runs every `check` and `run` before the approval gate
can be presented. `code-generation` then turns each approved `assert` into a
fast-check property test.

## What it contributes

| File | Effect |
|---|---|
| `contributions/construction/functional-design.md` | Adds the `alloy-check` sensor and fragments after Step 4 (write the `## Alloy Structural Check` section of `functional-spec.md`, run the check, resolve findings), after Step 5 (what the human reviews at the gate), and in `## Sensors` |
| `sensors/aidlc-alloy-check.md` | `fire_on: gate`, `default_severity: blocking`, `matches: **/functional-design/functional-spec.md` |
| `tools/alloy-check.ts` | The one check CLI for the sensor, Chunk, and CI (see below) |
| `tools/alloy-doctor.ts` | Install check: Java, the Alloy JAR, and its version (6.2.0) |
| `knowledge/aidlc-architect-agent/alloy-modeling-guide.md` | Modeling rules loaded by functional-design's lead agent |
| `contributions/construction/code-generation.md` | Plans one fast-check property per `assert` and a rejection test per `fact` |

## The section in functional-spec.md

````markdown
## Alloy Structural Check

Applicability: applicable

### Source mapping
| Alloy name | Kind | Transcribes | FR |

### Model
```alloy
sig User {} ...
-- BR1.1
fact EditorsInTeam { ... }
-- BR2.1
assert OnlyOwnerOrTeamCanEdit { ... }
check OnlyOwnerOrTeamCanEdit for 4
run Example { some d: Doc | some d.editors } for 3
```

### Result / ### Findings / ### Limits
````

or `Applicability: not-applicable — <reason>` for a unit where no ownership,
permission, reference, or uniqueness constraints overlap.

The sensor fails when the section is missing, when a not-applicable line has no
reason, when an `assert` has no `check`, when there is no `run`, when Alloy
cannot parse the model, when a `check` finds a counterexample, or when a `run`
finds no instance (contradictory facts, which would make every `check` pass
vacuously).

## alloy-check.ts

```bash
# what the gate sensor runs (always exits 0; the verdict is the JSON `pass`)
bun .claude/tools/alloy-check.ts --stage functional-design --output-path <functional-spec.md>

# Chunk / CI / by hand: exits 0 pass, 1 fail, 127 Java or JAR missing, 2 usage error
bun .claude/tools/alloy-check.ts --file <functional-spec.md | model.als>
```

It runs `java -jar org.alloytools.alloy.dist.jar exec -f -q -t text -c '*'`.
`exec` exits 0 even when a counterexample exists, so the verdict is read from
the `receipt.json` it writes: a command with a `solution` found an instance.
The counterexample is reported from the text solution file, because the
instance values inside `receipt.json` are wrong in 6.2.0 (atom indices shifted
by one, `one` fields shown empty).
The JAR is resolved from `$ALLOY_JAR`, `./.alloy/`, then `~/.alloy/`.

## Install

```bash
claude plugin install aidlc-alloy@aidlc-plugins
mkdir -p .alloy && curl -fsSL -o .alloy/org.alloytools.alloy.dist.jar \
  https://github.com/AlloyTools/org.alloytools.alloy/releases/download/v6.2.0/org.alloytools.alloy.dist.jar
bun .claude/tools/alloy-doctor.ts
```

## Differences from the original plan

The same engine constraints as the quint plugin apply (see `quint/README.md`):
no own stage (it would run after ci-pipeline), no separate artifacts (a
contribution cannot add them to functional-design without breaking its
compile), no support agent, and the doctor script is run directly rather than by
`/aidlc --doctor`.

## Verified and not verified

Verified in this repository's tests (AI-DLC 2.10.0, Alloy 6.2.0, OpenJDK 21):
composition, fragment placement, the compiled graph carrying `alloy-check` as a
blocking gate sensor, the tool's verdicts on passing / counterexample /
contradictory-facts / unchecked-assert / syntax-error / not-applicable /
missing-section fixtures, and the engine's sensor dispatcher reporting
`passed` / `failed` for them.

Trial run (same setup as `quint/README.md`): with BR1.1 written only for
clients that have a tenant, the functional-design gate was refused naming
`alloy-check`; the counterexample was a guest client holding a tenant's item.
That trial also showed that the instance values inside 6.2.0's `receipt.json`
are wrong (atom indices shifted by one), so counterexamples are now reported
from the text solution. After the fix the gate was presented. A fast-check
property for the assert and a rejection test for the fact passed on a correct
implementation and failed when guests skipped the tenant check (shrunk to one
guest reservation).

Not verified: the reviewer step and summary confirmation together with the
sensor, and Chunk sidecar execution (named commands were run with `--local`).
Alloy's `check` is a bounded search within the stated scope, not a proof.
