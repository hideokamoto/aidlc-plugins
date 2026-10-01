# Functional Spec — documents

## Workflows

1. Share: the owner adds a user as an editor of a document.
2. Move: the owner moves a document into a team, or out of every team.

## Alloy Structural Check

Applicability: applicable

### Source mapping

| Alloy name | Kind | Transcribes | FR |
|---|---|---|---|
| EditorsInTeam | fact | BR1.1 | FR-2 |
| OwnerNotEditor | fact | BR1.2 | FR-2 |
| OnlyOwnerOrTeamCanEdit | assert | BR2.1 | FR-2 |

### Model

```alloy
sig User {}
sig Team { members: set User }
sig Doc { owner: one User, team: lone Team, editors: set User }

-- BR1.1
fact EditorsInTeam { all d: Doc | d.editors in d.team.members
  some Doc
  no Doc }
-- BR1.2
fact OwnerNotEditor { all d: Doc | d.owner not in d.editors }

pred canEdit[u: User, d: Doc] { u = d.owner or u in d.editors }

-- BR2.1
assert OnlyOwnerOrTeamCanEdit {
  all d: Doc, u: User | canEdit[u, d] implies (u = d.owner or u in d.team.members)
}

check OnlyOwnerOrTeamCanEdit for 4
run Example { some d: Doc | some d.editors } for 3
```

## Rules Summary

| Rule | Statement |
|---|---|
| BR1.1 | A team document's editors are members of that team |
| BR2.1 | Only the owner or a member of the document's team can edit it |
