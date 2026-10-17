---
name: simfinity-pr-review
description: Use when reviewing or re-reviewing Simfinity pull requests, especially changes to the shared API, runtime, adapters, authorization, transactions, MCP, declarations or application guidance.
---

# Review Simfinity PRs

Protect Simfinity's generated, typed data API and its lifecycle across database engines. Review the application problem as well as the implementation: an application using Simfinity as a collection repository can motivate the wrong library API. Native database access remains a supported application boundary.

## Establish the review

- Confirm repository, PR number, base and current head SHA, diff, existing feedback and CI for that head. If a number identifies an issue instead, clarify the target. Preserve unrelated working changes; reuse an appropriate checkout.
- Read [AGENTS.md](../../../AGENTS.md) and its relevant `.cursor/rules/` links. They own the current contract. For API or usage changes, read [server-side operations](../../../docs/guide/server-side-operations.md) and [anti-patterns](../../../docs/guide/anti-patterns.md).
- Read the linked issue and apply the [motivation check](references/review-lenses.md#verify-the-motivation). Every PR needs a relevant repository issue with rationale; missing context blocks approval or merge, not continued technical review. Do not invent the author's use case.
- Trace changed entry points to their callers, implementation, public types and tests. A PR description, resolved thread or green CI is evidence to verify, not proof of correctness.

## Evaluate architectural fit

For a new capability, answer: what domain need does it serve; can existing relationships, scopes, aggregates, controllers or registered operations express it; what lifecycle must run; and what contract can both engines implement?

Classify each part as a reusable library capability, application business rule, engine implementation detail, or operational concern. Use [review lenses](references/review-lenses.md#choose-the-owning-layer) to identify the supported alternative. Do not invent missing APIs: check the current code and distinguish proposals from shipped behavior.

An architectural objection needs a concrete consequence: bypassed authorization or hooks, changed transaction ownership, driver-shaped public inputs, incompatible engine semantics, or unnecessary duplication of an existing path. “Not the spirit of Simfinity” alone is not a finding. Equally, a new API is not wrong merely because the library does not have it yet.

## Verify the contract

Read the relevant sections of [review lenses](references/review-lenses.md) for lifecycle/auth, transactions, engine parity, observations/reads, package surfaces and documentation. Trace one complete affected request, including failure and retry paths where applicable. Compare with the old behavior, not just the proposed implementation's tests.

For shared behavior changes, require MongoDB and PostgreSQL evidence, including scopes, hooks and rollback where affected. Engine-specific fixes need engine-specific evidence, not duplicate implementations. Use focused reproductions and the checks required by AGENTS.md; real database tests use disposable databases. State which checks were local, CI-only, skipped or unavailable. Recheck fixes at the new head; reproduce the original failure when practical.

## Deliver the review

Lead with actionable findings: priority, current file/line, concrete trigger, impact and smallest correction. Separate demonstrated defects from architectural recommendations and unverified risks. Then state what is acceptable, what belongs in application code, and any verification limits. Mixed PRs can retain independently useful fixes while splitting broader redesigns.

Review alone authorizes neither GitHub comments/approval nor merge, deployment or release. Honor actions already authorized for the current task without asking again. If release is requested, follow the repository's publication contract through verification; docs, tests and tooling changes do not themselves require a library release. Keep application-specific names and internals out of upstream feedback unless needed and authorized.
