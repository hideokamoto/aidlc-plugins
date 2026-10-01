# Quint modeling guide for the Quint Behavior Check

Checked against `@informalsystems/quint` 0.33.0 with `--backend typescript`.
Used by the `## Quint Behavior Check` section of `functional-spec.md`, which
the quint plugin adds to functional-design.

## Module shape

```quint
module reservation {
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

  action step = nondet c = oneOf(CLIENTS) any { reserve(c) }

  // BR1.1: reserved units plus remaining stock always equal capacity
  val inv_conservation = stock + CLIENTS.fold(0, (s, c) => s + reserved.get(c)) == CAPACITY
}
```

- Every action assigns every state variable (`x' = x` when unchanged).
  A missing assignment is a typecheck or runtime error.
- `step` uses `nondet ... = oneOf(...)` and `any { ... }` so that the simulator
  can pick any external operation at every step.
- A rejected operation (sold out, unauthorized, duplicate) is still a
  transition: it records `lastRequest` and the error `lastResult` and leaves
  the business state unchanged. Model it; do not guard it away, or the trace
  never exercises the rejection path.
- Retries and re-sends: give the request an id in `lastRequest` and let `step`
  choose an already-used id, so idempotency rules are exercised.

## Invariants

- Name each invariant `inv_<what>` and put the cited `BRx.y` in a comment
  directly above it.
- An invariant is a state predicate. Rules about a transition ("a cancelled
  order never becomes paid") need a history variable (e.g. `everCancelled`)
  that the invariant can read.

## Running

The check tool runs, in this order:

```bash
quint typecheck <spec>.qnt
quint run <spec>.qnt --backend typescript --seed <seed> --max-samples <n> --max-steps <m> --invariants <inv_a> <inv_b>
```

- The input file must come before `--invariants`; the option takes every
  following word as an invariant name.
- With `--seed` and no `--max-samples`, quint simulates exactly one trace.
  Always configure `maxSamples`.
- Exit code 0 means no violation within the bounds. A violation prints
  `[violation]` and exits 1, as do parse and type errors.
