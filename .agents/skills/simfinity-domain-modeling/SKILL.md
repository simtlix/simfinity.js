---
name: simfinity-domain-modeling
description: Use when defining or changing Simfinity application entities, GraphQL types, relationships, generated inputs, validation or server-managed fields.
---

# Model the domain

Inspect the installed Simfinity version, chosen engine and existing schema before editing. This guidance targets the 3.7.0 contract; verify differences against installed source or matching documentation. Preserve the application's approved domain and data.

For each affected entity, identify identity, typed fields, nullability, server-owned values, sensitive data, relationships, lifecycle and exposed operations. Use the [modeling guide](references/modeling.md) for storage choices and input semantics. Keep the diagram and field/relationship table proportional to the change; reuse an existing model rather than requiring another design exercise.

Implement the model with `GraphQLObjectType`, extensions and registration. Inspect the resulting schema instead of guessing input/operation names. Keep fields needed for business rules/querying typed; opaque content remains valid when opacity is intentional. Distinguish API IDs from backend identifiers.

Verify representative create/update/read operations, invalid values, omitted/null/list behavior and nested ownership/rollback where affected. Test both engines if the model claims portability, or clearly identify the application's supported engine. State which migration existing stored data requires.

For access policy use `simfinity-access-control` when available; for controller/state behavior use `simfinity-business-workflows`. Their public guide links remain usable independently.
