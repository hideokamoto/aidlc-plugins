# Functional Spec — inventory

## Workflows

1. Reserve: a client reserves one unit while stock remains; otherwise the request is rejected as sold out.
2. Release: a client returns a unit it holds; otherwise the request is rejected.

## Quint Behavior Check

Applicability: applicable

### Source mapping

| Quint name | Transcribes | FR |
|---|---|---|
| inv_conservation | BR1.1 | FR-1 |
| inv_nonNegative | BR1.2 | FR-1 |
| reserve | Workflow 1 | FR-1 |
| release | Workflow 2 | FR-1 |

### Specification

```quint
module inventory {
  pure val CAPACITY = 3
  pure val CLIENTS = Set("a", "b")
  var stock: int
  var reserved: str -> int
  var lastRequest: { op: str, client: str }
  var lastResult: str

  action init = all {
    stock' = CAPACITY,
    reserved' = CLIENTS.mapBy(_ => 0),
    lastRequest' = { op: "init", client: "" },
    lastResult' = "ok",
  }

  action reserve(c: str): bool = all {
    lastRequest' = { op: "reserve", client: c },
    if (stock > 0) all {
      stock' = stock - 1,
      reserved' = reserved.setBy(c, n => n + 1),
      lastResult' = "ok",
    } else all {
      stock' = stock,
      reserved' = reserved,
      lastResult' = "sold_out",
    },
  }

  action release(c: str): bool = all {
    lastRequest' = { op: "release", client: c },
    if (reserved.get(c) > 0) all {
      stock' = stock + 1,
      reserved' = reserved.setBy(c, n => n - 1),
      lastResult' = "ok",
    } else all {
      stock' = stock,
      reserved' = reserved,
      lastResult' = "nothing_to_release",
    },
  }

  action step = nondet c = oneOf(CLIENTS) any { reserve(c), release(c) }

  // BR1.1
  val inv_conservation = stock + CLIENTS.fold(0, (s, c) => s + reserved.get(c)) == CAPACITY
  // BR1.2
  val inv_nonNegative = stock >= 0
}
```

### Check configuration

```json
{"invariants": ["inv_conservation"], "seed": "0x2a", "maxSamples": 200, "maxSteps": 20}
```

## Rules Summary

| Rule | Statement |
|---|---|
| BR1.1 | Reserved units plus stock equal capacity |
| BR1.2 | Stock never goes negative |
