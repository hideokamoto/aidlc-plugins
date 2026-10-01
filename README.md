# aidlc-plugins

AI-DLC plugin catalogue. Each plugin lives in its own top-level directory as an
authored plugin root. CD builds the installable Claude projection of every
plugin and publishes it, with the marketplace catalogue, on the `release`
branch.

## Install (marketplace)

Register the `release` branch as a Claude plugin marketplace, then install only
what you need:

```bash
claude plugin marketplace add hideokamoto/aidlc-plugins#release
claude plugin install aidlc-solo-developer@aidlc-plugins
```

`main` holds sources only and has no `.claude-plugin/marketplace.json`, so
adding the marketplace without `#release` fails.

On the next session start, the plugin's compose hook runs
`aidlc engine plugin sync` inside the project, which composes the plugin into
the project's `.claude/` projection. Updates reach you when a plugin's version
changes: run `/plugin marketplace update aidlc-plugins`, or turn on
auto-update for the marketplace in `/plugin`.

## Plugins

| Plugin | What it adds |
|---|---|
| `aidlc-alloy` | Blocking gate on functional-design: an Alloy model of the unit's entities and rules must have no counterexample; code-generation turns its asserts into fast-check properties. See `alloy/README.md`. |
| `aidlc-chunk-validate` | Advisory sensor that runs `chunk validate <command>` (default `test`, set by `AIDLC_CHUNK_VALIDATE_COMMAND`) on a Chunk sidecar on every `*.ts`/`*.tsx` write during `code-generation`. See `chunk-validate/README.md`. |
| `aidlc-quint` | Blocking gate on functional-design: a Quint spec of the unit's workflows and rules must keep its invariants under simulation; code-generation and ci-pipeline replay its traces. See `quint/README.md`. |
| `aidlc-solo-developer` | Lets one `SOLO-DEVELOPER:` memory line answer intent-capture's stakeholder, decision-maker, and reporting questions. See `solo-developer/README.md`. |

## Development

Requirements: Node.js 22, pnpm, bun (runs the AI-DLC plugin tooling), and a Java
runtime (the alloy plugin's tests run Alloy 6.2.0, downloaded into `.aidlc-cache/`).

```bash
pnpm install
pnpm fetch-runtime   # download every core release in aidlc-versions.json
pnpm typecheck
pnpm test            # Vitest: compose, core premises, catalogue, release rules
pnpm build           # <plugin>/dist/claude + .claude-plugin/marketplace.json (git-ignored)
```

Tests run against the official `aidlc-copy-runtime-X.Y.Z.tar.gz` of every
version in `aidlc-versions.json` (sha256-verified, cached in `.aidlc-cache/`).
To support a new core release, add its version there and fix whatever fails.

| Test | Catches |
|---|---|
| `test/compose.test.ts` | Validation errors, dropped contributions (an anchor heading no longer exists), and non-idempotent composition, for every plugin |
| `<plugin>/tests/` | Core wording or step order that a plugin's prose depends on, and where the prose lands in the composed stage |
| `test/catalog.test.ts` | Catalogue entries that Claude Code would reject or fail to resolve |
| `test/release.test.ts` | Release planning, version-bump detection, and changelog rules |

### Authoring a new plugin

```bash
bun .aidlc-cache/<version>/runtime/claude/.claude/tools/aidlc-plugin-create.ts <name>
```

Author `stages/`, `scopes/`, `agents/`, `contributions/`, `sensors/`, or
`tools/`, put tests under `<name>/tests/`, and run `pnpm test`. The catalogue
entry is generated; do not write it by hand.

## Release

Merging to `main` runs `.circleci/config.yml`: the `test` job, then `release`.
`release` publishes every plugin whose `.aidlc-plugin/plugin.json` version has
no `aidlc-<name>--v<version>` tag yet:

1. build every plugin and the catalogue with the first version in
   `aidlc-versions.json`
2. commit `main` plus the build outputs onto `release` (fast-forward only)
3. tag that commit `aidlc-<name>--v<version>` for each pending plugin and push
   the branch and tags atomically
4. create a GitHub Release per tag, with the `feat` / `fix` / other commits
   under `<name>/` since the previous tag as its body

To release, bump the plugin's version in the same PR as the change. The `test`
job fails when files that reach an install (`.aidlc-plugin`, `contributions`,
`sensors`, `tools`, and the other contribution directories) changed after the
current version was tagged, because users only receive a new copy when the
version changes. README and `tests/` changes need no bump.

`pnpm release publish --dry-run` prints the release commit and changelogs
without pushing.

The `release` job needs the CircleCI project environment variable
`GITHUB_TOKEN`: a token with `contents: write` on this repository.
