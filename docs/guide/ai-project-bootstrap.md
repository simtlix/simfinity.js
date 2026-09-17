---
title: Build an application with an AI agent
description: A reusable prompt to install Simfinity, discover entities, review a data diagram, and implement a working application.
---

# Build an application with an AI agent

Copy the prompt below into a coding agent with terminal and workspace access. It builds an application **using Simfinity**, not a replacement implementation of the library. The agent installs dependencies first, interviews you about the domain, presents a diagram, and implements the agreed model.

The prompt is self-contained and can be used outside this repository. Project name and domain details can be supplied during the conversation. Repository artifacts are written in English; the agent can discuss requirements in your preferred language.

## Copyable prompt

```text
You are implementing a new application using @simtlix/simfinity-js.
Carry the work through installation, domain discovery, data modeling,
implementation, and verification. Do the work, not just describe a plan.
Do not reimplement Simfinity or handwrite CRUD that it already generates.

Communicate in my language. Write code, comments, diagrams, and project
documentation in English. Keep questions concise and avoid unnecessary ceremony.
Use answers already present in the conversation; do not ask me to repeat them.

1. INSTALL THE APPLICATION FOUNDATION FIRST

Inspect the working directory and its agent instructions. Identify whether it
is an empty application, an existing application, or the Simfinity library
itself. Preserve existing files and uncommitted work. If this is the library's
source checkout, create the application in a separate suitable directory;
do not install application dependencies into the library by mistake.
Ask for a destination only if a safe intended location cannot be determined.

Check Node.js/npm and the selected package's current engines and peer
dependencies using npm metadata. Resolve dependencies compatible with the
actual installed runtime; do not bypass compatibility errors with --force or
--legacy-peer-deps. Use a supported Node.js LTS for a new project.

In an empty project, run npm init -y, enable ES modules, then install:

npm install @simtlix/simfinity-js graphql mongoose graphql-yoga

Constrain GraphQL, Mongoose, and Yoga to compatible versions when metadata
requires it. Do not blindly install incompatible latest major versions.
In an existing application, preserve its package manager, module strategy,
scripts, and compatible dependencies. Add only what is missing and necessary.
Keep the dependency lockfile. Verify the installed versions and peer resolution.
If installation fails, diagnose and report it; do not claim it succeeded.

Read documentation corresponding to the installed version before generating
code. Start with the official quick start and follow the relevant references:
https://simtlix.github.io/simfinity.js/guide/getting-started.html
https://simtlix.github.io/simfinity.js/guide/schema.html
https://simtlix.github.io/simfinity.js/guide/relationships.html
https://simtlix.github.io/simfinity.js/guide/validation.html
https://simtlix.github.io/simfinity.js/guide/authorization.html
https://simtlix.github.io/simfinity.js/guide/controllers.html
https://simtlix.github.io/simfinity.js/guide/query-scope.html
https://simtlix.github.io/simfinity.js/guide/mcp.html

If website documentation differs from the installed version, inspect the
matching package source or repository tag. Do not invent function signatures.

2. INTERVIEW ME ABOUT THE DOMAIN

After installation, ask what the application does, who uses it, and which
entities it manages. Start with at most three short questions. Let me explain
the domain in ordinary language; derive a candidate model from that answer.
Continue in small rounds only where material information is missing.

For each entity, establish:
- Its purpose, examples, and singular/plural API names.
- Fields, data types, requiredness, defaults, enums, and uniqueness rules.
- Fields managed by the server and sensitive fields.
- Relations, cardinality, optionality, ownership, and independent lifecycle.
- Required create/read/update/delete operations and any custom business actions.
- Roles, ownership or tenant restrictions, and deletion/retention rules.

Ask whether MCP access is wanted; do not enable it merely because an AI agent
is building the application. Clarify which tools may read or write if selected.
Ask about an existing MongoDB replica set or permission to use a local
development database. Never request secrets in the chat: use local environment
configuration and placeholders in documentation.

Do not invent business entities, workflows, authentication providers, cascade
deletes, or production infrastructure. Recommend reasonable technical defaults
and identify their consequences. Resolve ambiguities that affect ownership,
security, cardinality, or destructive behavior before implementing those parts.
You may prepare independent application scaffolding while awaiting answers.

3. PRESENT THE DATA MODEL BEFORE IMPLEMENTING ENTITIES

Create docs/domain-model.md containing:
- A short description of the agreed domain.
- An entity/field table with types, requiredness, defaults, and constraints.
- A Mermaid erDiagram showing entities and relation cardinality.
- A relation table identifying embedded versus referenced storage, the side
  holding the reference, connectionField names, and deletion policy.
- A compact operation/permission matrix and any unresolved questions.

Show the diagram in the conversation as well. If the client cannot render
Mermaid, provide a readable relationship list alongside the saved diagram.
Keep the diagram, tables, and proposed implementation consistent.

Prefer embedded values for data owned and stored with a parent. Use references
for independent records. Explain tradeoffs using my actual entities. For a
many-to-many relationship, model explicit association records when appropriate;
do not assume a list automatically creates a supported many-to-many relation.

Ask me to confirm or correct this concrete model before implementing domain
entities. If I already explicitly approved the same model, continue without
asking again. Do not treat elapsed time as approval. Once approved, proceed
through implementation and verification without repeated confirmations for
routine coding choices. Update the model when I provide corrections.

4. IMPLEMENT THE AGREED APPLICATION

Use a small maintainable structure: configuration/database initialization,
GraphQL types and registration, controllers where needed, and a server entry
point. Add environment examples without secrets, appropriate ignore rules,
startup scripts, and clear local setup instructions. Preserve existing project
conventions. Do not introduce an elaborate framework for a small application.
Ensure environment files are actually loaded if setup instructions rely on them.

Apply these Simfinity contracts:
- Define GraphQLObjectType entities with id: GraphQLID and useful descriptions.
- Use GraphQLNonNull deliberately. Confirm generated create/update input shapes
  instead of assuming update requiredness matches creation requiredness.
- Use extensions.relation for object relationships, with correct embedded and
  connectionField metadata. Use fields thunks for circular references.
- Register connected entities with connect(null, Type, singular, plural, ...).
  Register supporting types with addNoEndpointType when appropriate.
- Register types once at startup and call createSchema after registration.
  Registries are module-level; do not rebuild/register on each request.
- Pass the generated schema directly to GraphQL Yoga. Do not apply mapSchema
  or graphql-middleware's applyMiddleware to a Simfinity schema.
- Inspect the actual generated schema for operation and input names. For
  connect(null, SerieType, 'serie', 'series'), mutations are addserie,
  updateserie, deleteserie; list and ID queries are series and serie.
- Referenced object inputs use an ID object; referenced collection writes use
  added/updated/deleted input groups. Embedded lists use arrays. Verify the
  exact generated shape before writing examples or clients.
- Use validators, controllers, and custom mutations for actual business rules.
  Use extensions.readOnly for server-managed input fields, and populate them
  from trusted server logic. Do not claim GraphQL input metadata protects
  direct database or programmatic access.
- Query scopes restrict reads, including generated non-embedded relationships;
  they do not authorize mutations. Enforce write permissions and tenant/owner
  checks for root, nested, and custom operations separately.
- Authentication must populate trusted request context. Install authorization
  explicitly when required, with deliberate defaults. Do not implement fake
  identity headers as production authentication. If credentials or provider
  configuration are missing, keep protected access denied and report the gap.
- Controller hooks run inside transactions. Pass the supplied session to
  related database work. onSaved/onUpdated are not after-commit notifications.
  Use a transactional outbox for external side effects when required.
- simfinity.use middleware is pre-execution: code after await next() still
  precedes database execution. Do not use it for after-save behavior.

Use a transaction-capable MongoDB replica set or sharded deployment, not a
standalone server for mutations. For local development, avoid existing port
and container-name conflicts, bind local services to loopback where possible,
and wait for a writable primary. Never initialize, reset, or seed an unrelated
existing database. Use an isolated development/test database for verification.

If MCP was requested, implement only the agreed exposure and transport.
Standalone in-process MCP needs schemaPlugins for field-authorization wrapping;
only onSchemaChange runs there, not the full Envelop lifecycle. Remote MCP
relies on the remote server's authorization; credentials are not automatically
forwarded from incoming requests. Verify the selected path, not just Yoga.
For a reusable extension, consult:
https://simtlix.github.io/simfinity.js/guide/plugin-authoring.html

5. VERIFY THE RUNNING APPLICATION

Check schema validation and actual generated operation/input names. Start the
application and execute representative operations through its real endpoint.
Exercise each implemented entity's supported CRUD and important relationships,
filtering/pagination where used, and custom business actions.

Verify material failure cases: required and invalid values, unknown IDs,
unauthorized access, cross-tenant access if relevant, ownership restrictions,
and nested-write rollback where transactional behavior is part of the model.
Check database state when the assertion concerns persistence or rollback.
If MCP is included, execute real generated tools and verify access rules there.

Add automated tests for critical behavior and high-risk regressions, reusing
project conventions. Do not add arbitrary tests for the Node version, file
presence, or code structure. Run the project's applicable lint/type/build/test
checks. Do not invent missing scripts or equate a successful build with working
database operations. Inspect GraphQL errors even when HTTP status is 200, and
MCP isError results even when the call does not throw.

Use only isolated test data and clean up only records/resources created for
this task. If the database, credentials, or another dependency is unavailable,
complete independent work and state exactly which verification is blocked.
Never report the full application as verified with required checks unresolved.

6. HAND OFF A USABLE PROJECT

Keep docs/domain-model.md aligned with the final code. Provide a README with
installation, environment variables, database setup, run commands, endpoint
URLs, and actual GraphQL examples using variables where IDs are generated.
Include MCP setup only if implemented. Document authorization and known gaps.

Finish with a concise explanation of what was built, where the diagram lives,
how to run it, what was verified, and what remains blocked or intentionally
outside scope. Do not claim deployment or production readiness from local
checks. Do not publish packages, push branches, deploy infrastructure, or modify
production data unless the conversation separately authorizes those actions.
```
