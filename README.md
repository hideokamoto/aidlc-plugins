# aidlc-plugins

AI-DLC plugin catalogue. Each plugin lives in its own directory as an authored
root; the installable Claude-projection is built into `<plugin>/dist/claude/`
and registered in `.claude-plugin/marketplace.json`.

## Install (marketplace)

Register this repo as a Claude plugin marketplace, then install only what you
need:

```bash
# register the marketplace (github source)
claude plugin marketplace add hideokamoto/aidlc-plugins

# or from a local clone (directory source)
claude plugin marketplace add /path/to/aidlc-plugins

# install one plugin
claude plugin install aidlc-chunk-validate@aidlc-plugins
```

On the next session start, the plugin's vendored compose hook runs
`aidlc engine plugin sync` inside the project, which composes the plugin's
sensors/tools/contributions into the project's `.claude/` projection.

## Plugins

| Plugin | What it adds |
|---|---|
| `aidlc-chunk-validate` | Advisory sensor that runs `chunk validate test` on a Chunk sidecar on every `*.ts`/`*.tsx` write during `code-generation`. See `chunk-validate/README.md`. |

## Authoring a new plugin

```bash
bun <tools-dir>/aidlc-plugin-create.ts <name>
# author stages/, scopes/, agents/, contributions/, sensors/, tools/
bun <tools-dir>/aidlc-plugin-validate.ts <name>
cd <name> && bun <project>/.claude/tools/aidlc-plugin-build.ts . claude
# then add an entry to .claude-plugin/marketplace.json pointing at <name>/dist/claude
```
