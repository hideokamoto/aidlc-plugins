# Alloy modeling guide for the Alloy Structural Check

Checked against Alloy 6.2.0 (`org.alloytools.alloy.dist.jar`) on OpenJDK 21.
Used by the `## Alloy Structural Check` section of `functional-spec.md`, which
the alloy plugin adds to functional-design.

## What goes where

| `entities.md` / `rules.md` | Alloy |
|---|---|
| entity | `sig` |
| attribute that references another entity | field: `one` (required), `lone` (optional), `set` (many) |
| allowed values of an attribute | `abstract sig` with `one sig` children, or an `enum` |
| constraint the system **enforces** (validation, authorization check, uniqueness) | `fact` |
| property the design **promises** (no one outside the team can edit) | `assert` + `check` |

A `fact` restricts which worlds Alloy considers. Put a rule in a `fact` only
when the system enforces it on every write. Anything the design merely hopes
for is an `assert`: Alloy then searches for a world that breaks it.

## Model shape

```alloy
sig User {}
sig Team { members: set User }
sig Doc { owner: one User, team: lone Team, editors: set User }

-- BR1.1
fact EditorsInTeam { all d: Doc | d.editors in d.team.members }

pred canEdit[u: User, d: Doc] { u = d.owner or u in d.editors }

-- BR2.1
assert OnlyOwnerOrTeamCanEdit {
  all d: Doc, u: User | canEdit[u, d] implies (u = d.owner or u in d.team.members)
}

check OnlyOwnerOrTeamCanEdit for 4
run Example { some d: Doc | some d.editors } for 3
```

- Put the cited `BRx.y` in a `--` comment directly above each `fact` and `assert`.
- Every `assert` needs its own `check <Name> for <n>` command. Use a scope of
  at least 3; 4 or 5 finds most combination bugs and still runs in seconds.
- Add at least one `run` that asks for an interesting instance (for example a
  document that has editors). If `run` finds nothing, the facts contradict each
  other and every `check` passes vacuously; the check tool fails in that case.
- `lone` fields are where combination bugs hide: a rule written for "the
  document's team" says nothing about documents without a team. Alloy finds
  that case; the check above fails if BR1.1 is written as
  `some d.team implies d.editors in d.team.members`.

## Reading a counterexample

The tool reports the failing check's instance as Alloy's text solution:
one line per relation (`this/Doc<:editors={Doc$0->User$1}`), then
`skolem $OnlyOwnerOrTeamCanEdit_d={Doc$0}` naming the witness that breaks the
assert. An atom missing from a relation line has no value for that field (for
example a document without a team). Write it
back in domain words: which user, which document, which team, and which `fact`s
allowed that combination.

## Running

```bash
java -jar org.alloytools.alloy.dist.jar exec -f -q -t text -c '*' -o out model.als
```

- `-c '*'` runs every command; without it only the first one runs.
- `exec` exits 0 even when a check finds a counterexample. The verdict is in
  `out/receipt.json`: a command with a `solution` entry found an instance.
  Read the instance itself from `out/<command>-solution-0.txt`; the instance
  values inside `receipt.json` are wrong in 6.2.0.
- A syntax or type error makes `exec` exit 1 and print the line and column
  within the model.
