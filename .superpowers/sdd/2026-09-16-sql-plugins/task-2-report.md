# Task 2 report: SQL runtime and PostgreSQL plugin

Status: implemented and verified; no push performed.

## Changes

- Added driver-free SQL runtime, adapter, record reconstruction, transaction orchestration, and eager version-1 plugin validation/binding.
- SQL snapshots top-level methods, grouped methods, options and capabilities. Connection objects remain caller-owned. Requirements are checked after logical planning and before physical schema compilation or initialization.
- Added `postgresPlugin(options)` and PostgreSQL record statement compilation. The PostgreSQL facade delegates to `createSQL`, while adapter/records/transactions low-level imports remain compatibility wrappers.
- SQL delegates record/query compilation, IDs, scalar and embedded encoding, result decoding, configuration checks, connection/transaction operations, error normalization, and retry classification. PostgreSQL owns the original SQL statements and UUID/date codecs.
- Preserved configure-once, initialize-before-use, independent registries/sessions, transaction lifecycle, at most five retries of confirmed aborts, and caller-owned pools.
- Added eleven plugin tests, including a non-PostgreSQL recording store with opaque identifiers and owned records, a public runtime recording driver, immutable binding, missing guarantees, independent configuration, facade metadata equivalence, foreign sessions, retry limits, and unknown commit outcomes.
- Added real PostgreSQL integration coverage showing `createSQL({plugin:postgresPlugin(...)})` and `createPostgres(...)` reading/updating/deleting the same records with matching descriptions.

## Interface details for Task 3 declarations

- `createSQL({ plugin })` returns the same runtime operations as `createPostgres` (including configure, initializeDatabase, describeDatabase, withTransaction and helper namespaces).
- `postgresPlugin()` permits no initial configuration, enabling later runtime.configure.
- `compileRecord(description, operation)` receives `operation.table` as a physical table metadata object from `describeSchema`, not merely a table name. Operations match the specified kinds and fields.
- Session `query(text, values)` delegates to `driver.query(configuration, {text,values}, client)`.
- Required capability list is `logicalPlan.requirements`.
- SQL package internal exports used by PG wrappers: `./internal/adapter`, `./internal/records`, `./internal/transactions`.
- New validation errors are SimfinityError with codes INVALID_SQL_PLUGIN, UNSUPPORTED_SQL_PLUGIN_VERSION, and UNSUPPORTED_SQL_CAPABILITY. Unknown PG record compiler operations use INVALID_RECORD_OPERATION.

## Verification

Initial fail-first command: `npx vitest run tests/sql-plugin.test.js` failed because the SQL plugin module did not yet exist. The initial error assertions were corrected to use the repository's SimfinityError.extensions.code shape. All subsequent tests pass.

Final verification uses Node24.2.0 through `PATH=/Users/claudiogonzalez/.nvm/versions/node/v24.2.0/bin:$PATH` (the initial shell default was Node23.10).

- `npm test`: 678 passed, 346 skipped, 34 passing files/17 skipped files. This was before adding the final retry-limit test; the subsequent targeted run includes that test.
- `npx vitest run tests/sql-plugin.test.js`: 11 passed.
- `SIMFINITY_POSTGRES_URI=postgresql://postgres:sql-task2-disposable@127.0.0.1:51205/sql_task2 npx vitest run tests/sql-plugin.test.js tests/postgres-configuration.test.js tests/postgres-query.test.js tests/mutation-transactions.test.js tests/integration/postgres-runtime.test.js tests/integration/postgres-options.test.js tests/integration/postgres-lifecycle.test.js tests/integration/sql-entry-point.test.js`: 69 passed, 8 files, zero skips.
- `npm run lint`: passed, repository-wide.
- `git diff --check`: passed.

Real database checks used a newly created, disposable `postgres:18` container named `simfinity-sql-task2-20260916`, on auto-assigned localhost port51205. Existing Barber application/database containers were untouched. Root was informed of the disposable URI for any further combined checks.

## Scope and remaining work

No Task1 schema planner/lowerer, manifests, declarations, public documentation, release metadata or package boundary tests were edited. Root/Task3 owns those follow-up changes. No implementation concerns remain from the targeted runtime checks. Full MongoDB parity, package consumers, release validation and full version-matrix checks remain the root task's responsibility.
