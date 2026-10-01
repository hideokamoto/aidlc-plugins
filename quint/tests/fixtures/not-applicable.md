# Functional Spec — inventory

## Workflows

1. Reserve: a client reserves one unit while stock remains; otherwise the request is rejected as sold out.
2. Release: a client returns a unit it holds; otherwise the request is rejected.

## Quint Behavior Check

Applicability: not-applicable — stateless price formatting: no lifecycle entity, no order-dependent workflow, no retries or concurrency, no cross-operation quantity rule.
