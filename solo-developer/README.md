# solo-developer

AI-DLC plugin for projects with exactly one developer, who is also the only
stakeholder, decision-maker, and approver.

Without it, `intent-capture` asks every workflow who the stakeholders are, who
decides scope, and what the reporting cadence is. On a solo project the answer
never changes. This plugin lets one line of project memory answer those
questions once.

## Setup

1. Install the plugin (see the repository README).
2. Add one single-line rule that starts with `SOLO-DEVELOPER:` directly under
   any H2 heading of `aidlc/spaces/<space>/memory/project.md` (or `team.md` /
   `org.md`), for example:

   ```markdown
   ## Team Structure

   - SOLO-DEVELOPER: 岡本 is the only stakeholder, decision-maker, and approver of this project; there are no other stakeholders, communication requirements, or reporting obligations.
   ```

   Keep it on one line: `intent-capture` cites memory rules as
   `[memory:M<n>]` sources, and the `claim-sources` sensor requires the quoted
   rule to match one visible line under the named H2 exactly.

State the absence of other stakeholders and of reporting obligations
explicitly. The plugin only records what the declaration says; anything the
declaration leaves out stays an open question.

## What it contributes

`contributions/ideation/intent-capture.md` appends two blocks to the core
`intent-capture` stage:

| Anchor | Effect |
|---|---|
| `after-step:2` | When the declaration exists and the initial request does not name anyone else, register it as a `[memory:M<n>]` source and skip the three stakeholder / decision-maker / communication questions. |
| `after-step:4` | Build `stakeholder-map.md` from the declaration alone, citing it in every `Source` cell. |

Overlays can only add prose, so the core questions are still written in the
stage; the appended block tells the agent to skip them. `tests/` pins the core
wording this relies on for every release in `aidlc-versions.json`.

## Known limitations

- The tests prove the prose lands in the right place of the composed stage.
  They cannot prove the agent obeys it; check one real `intent-capture` run
  after upgrading the AI-DLC core.
