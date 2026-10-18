import { SimfinityError } from '@simtlix/simfinity-core';
import { identifier, qualified, generatedName, literal } from './sql.js';
import { createTableSQL, createForeignKeySQL, createIndexSQL, createFunctionSQL, createTriggerSQL, triggerEvents } from './ddl.js';
import { maintenanceLayouts, layoutOf, withLayouts } from './constraints.js';

const mismatch = (object, reason) => {
  throw new SimfinityError(`Schema mismatch at ${object}: ${reason}. Apply an explicit migration before startup.`, 'SCHEMA_MISMATCH', 409);
};
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// literal() writes a value containing a backslash as E'' with doubled backslashes, while pg_get_expr,
// read with standard_conforming_strings on, never renders E'' and doubles only quotes. Compare string
// constants by value: decode either form and re-emit one standard form. The decoder inverts only the
// escapes literal() emits (\\ and ''); it is not a general E'' decoder (\n or \x41 would be wrong).
const canonicalString = (token) => {
  const escape = token[0] !== '\'';
  const body = token.slice(escape ? 2 : 1, -1);
  const value = escape ? body.replace(/\\(.)|''/gs, (match, character) => character ?? '\'') : body.replaceAll('\'\'', '\'');
  return `'${value.replaceAll('\'', '\'\'')}'`;
};

// Ignore renderer whitespace/optional quotes, keeping string contents and expression grouping.
export const normalizeExpression = (expression) => {
  if (expression == null) return null;
  // An E-string is one token unless the E ends an identifier.
  const tokens = expression.match(/(?<![\w$"])[Ee]'(?:\\.|''|[^'\\])*'|'(?:[^']|'')*'|"(?:[^"]|"")*"|\s+|./gs) || [];
  let value = tokens.map((token) => {
    if (token.length > 1 && /^[Ee]?'/.test(token)) return canonicalString(token);
    if (/^"[a-z_][a-z0-9_]*"$/.test(token)) return token.slice(1, -1);
    return /^\s+$/.test(token) ? '' : token;
  }).join('');
  while (value.startsWith('(') && value.endsWith(')')) {
    const parts = value.match(/'(?:[^']|'')*'|"(?:[^"]|"")*"|./gs);
    let depth = 0;
    let encloses = true;
    for (let i = 0; i < parts.length; i += 1) {
      if (parts[i] === '(') depth += 1;
      if (parts[i] === ')') depth -= 1;
      if (depth === 0 && i < parts.length - 1) { encloses = false; break; }
    }
    if (!encloses) break;
    value = value.slice(1, -1);
  }
  return value;
};

// Catalog columns read for each managed relation, function and trigger.
const relationColumns = 'c.oid, c.relkind, c.relpersistence, c.relrowsecurity, c.relforcerowsecurity';
const columnRows = `a.attname AS name, format_type(a.atttypid, a.atttypmod) AS type,
    NOT a.attnotnull AS nullable, pg_get_expr(d.adbin, d.adrelid) AS "default", a.attidentity, a.attgenerated,
    col.collname AS collation, ns.nspname AS collation_schema
    FROM pg_attribute a LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
    LEFT JOIN pg_collation col ON col.oid = a.attcollation LEFT JOIN pg_namespace ns ON ns.oid = col.collnamespace`;
const constraintRows = `c.conname AS name, c.contype AS type,
    c.condeferrable AS deferrable, c.condeferred AS deferred, c.convalidated AS validated,
    COALESCE((to_jsonb(c)->>'conenforced')::boolean, true) AS enforced,
    c.confdeltype AS delete_action, c.confupdtype AS update_action, c.confmatchtype AS match_type, c.connoinherit AS no_inherit,
    (SELECT count(*) = 4 AND bool_and(t.tgenabled IN ('O', 'A') AND t.tgisinternal)
      FROM pg_trigger t WHERE t.tgconstraint = c.oid) AS enforcement_enabled,
    n.nspname AS target_schema, t.relname AS target_table, pg_get_expr(c.conbin, c.conrelid) AS expression,
    ARRAY(SELECT a.attname::text FROM unnest(c.conkey) WITH ORDINALITY k(num, pos)
      JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k.num ORDER BY k.pos) AS columns,
    ARRAY(SELECT a.attname::text FROM unnest(c.confkey) WITH ORDINALITY k(num, pos)
      JOIN pg_attribute a ON a.attrelid = c.confrelid AND a.attnum = k.num ORDER BY k.pos) AS target_columns
    FROM pg_constraint c LEFT JOIN pg_class t ON t.oid = c.confrelid LEFT JOIN pg_namespace n ON n.oid = t.relnamespace`;
const indexRows = `ic.relname AS name, i.indisprimary AS primary,
    i.indisunique AS unique, i.indnullsnotdistinct AS nulls_not_distinct, i.indisvalid AS valid, i.indisready AS ready,
    i.indimmediate AS immediate, am.amname AS method, i.indnatts = i.indnkeyatts AS no_include,
    i.indpred IS NULL AS no_predicate, i.indexprs IS NULL AS no_expression,
    ARRAY(SELECT a.attname::text FROM unnest(i.indkey) WITH ORDINALITY k(num, pos)
      LEFT JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = k.num ORDER BY k.pos) AS columns,
    NOT EXISTS (SELECT 1 FROM unnest(i.indoption) opt WHERE opt <> 0) AS default_order,
    NOT EXISTS (SELECT 1 FROM unnest(i.indclass) cls JOIN pg_opclass opc ON opc.oid = cls WHERE NOT opc.opcdefault) AS default_ops,
    NOT EXISTS (SELECT 1 FROM unnest(i.indcollation) WITH ORDINALITY col(oid, pos)
      JOIN unnest(i.indkey) WITH ORDINALITY k(num, pos) USING(pos)
      JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = k.num WHERE col.oid <> a.attcollation) AS default_collation
    FROM pg_index i JOIN pg_class ic ON ic.oid = i.indexrelid JOIN pg_am am ON am.oid = ic.relam`;
const functionRows = `p.oid, pg_get_function_identity_arguments(p.oid) AS arguments,
      pg_get_function_result(p.oid) AS returns, p.prosrc AS body, l.lanname AS language, p.provolatile AS volatility,
      p.proconfig AS configuration, p.prosecdef, p.proisstrict, p.proleakproof, p.proparallel, p.prokind,
      p.proretset, p.pronargdefaults, p.procost, p.prorows, p.prosupport::oid AS support
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace JOIN pg_language l ON l.oid = p.prolang`;
// `definition` and `function_text` locate a WHEN condition in pg_get_triggerdef (whenClause).
const triggerRows = `t.tgtype, t.tgenabled, t.tgisinternal, t.tgdeferrable, t.tginitdeferred,
      t.tgnargs, t.tgqual IS NULL AS no_when, t.tgattr::text AS columns, p.proname AS function, n.nspname AS function_schema,
      p.pronargs, t.tgconstraint <> 0 AS constraint, t.tgconstrrelid::oid AS constraint_relation,
      t.tgparentid::oid AS parent, c.condeferrable, c.condeferred, c.convalidated,
      COALESCE((to_jsonb(c)->>'conenforced')::boolean, true) AS enforced,
      t.tgoldtable, t.tgnewtable,
      CASE WHEN t.tgqual IS NOT NULL THEN pg_get_triggerdef(t.oid) END AS definition, quote_ident(n.nspname) || '.' || quote_ident(p.proname) AS function_text
      FROM pg_trigger t JOIN pg_proc p ON p.oid = t.tgfoid JOIN pg_namespace n ON n.oid = p.pronamespace
      LEFT JOIN pg_constraint c ON c.oid = t.tgconstraint`;
const ordinaryTable = (schema, name, relation) => {
  if (relation.relkind !== 'r' || relation.relpersistence !== 'p' || relation.relrowsecurity || relation.relforcerowsecurity) mismatch(`${schema}.${name}`, 'expected a persistent ordinary table without row security');
};

/** Re-reads one table, such as a table this run has just created. */
const readTable = async (client, schema, name) => {
  const { rows: relations } = await client.query(`SELECT ${relationColumns}
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = $1 AND c.relname = $2`, [schema, name]);
  if (!relations.length) return null;
  const relation = relations[0];
  ordinaryTable(schema, name, relation);
  const { rows: columns } = await client.query(`SELECT ${columnRows}
    WHERE a.attrelid = $1 AND a.attnum > 0 AND NOT a.attisdropped ORDER BY a.attnum`, [relation.oid]);
  const { rows: constraints } = await client.query(`SELECT ${constraintRows}
    WHERE c.conrelid = $1`, [relation.oid]);
  const { rows: indexes } = await client.query(`SELECT ${indexRows} WHERE i.indrelid = $1`, [relation.oid]);
  return { columns, constraints, indexes };
};

/**
 * Reads every managed relation, function and trigger in six statements, whatever the schema size. Names
 * include both refresh-trigger layouts. Takes no table lock.
 */
const loadCatalog = async (client, schema, names) => {
  const { rows: relations } = await client.query(`SELECT c.relname AS __name, ${relationColumns}
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = $1 AND c.relname = ANY ($2::text[])`, [schema, names.tables]);
  const oids = relations.map((relation) => relation.oid);
  const { rows: columns } = await client.query(`SELECT a.attrelid AS __relation, ${columnRows}
    WHERE a.attrelid = ANY ($1::oid[]) AND a.attnum > 0 AND NOT a.attisdropped ORDER BY a.attrelid, a.attnum`, [oids]);
  const { rows: constraints } = await client.query(`SELECT c.conrelid AS __relation, ${constraintRows}
    WHERE c.conrelid = ANY ($1::oid[])`, [oids]);
  const { rows: indexes } = await client.query(`SELECT i.indrelid AS __relation, ${indexRows} WHERE i.indrelid = ANY ($1::oid[])`, [oids]);
  const { rows: functions } = await client.query(`SELECT p.proname AS __name, ${functionRows}
      WHERE n.nspname = $1 AND p.proname = ANY ($2::text[])`, [schema, names.functions]);
  const { rows: triggers } = await client.query(`SELECT t.tgrelid AS __relation, t.tgname AS __name, ${triggerRows}
      WHERE t.tgrelid = ANY ($1::oid[]) AND t.tgname = ANY ($2::text[])`, [oids, names.triggers]);
  const group = (rows, key) => {
    const map = new Map();
    for (const { __relation: relation, __name: name, ...row } of rows) {
      const id = key(relation, name);
      if (!map.has(id)) map.set(id, []);
      map.get(id).push(row);
    }
    return map;
  };
  const relationNames = new Map(relations.map((relation) => [relation.oid, relation.__name]));
  const byRelation = (rows) => group(rows, (relation) => relation);
  const tableColumns = byRelation(columns); const tableConstraints = byRelation(constraints); const tableIndexes = byRelation(indexes);
  const functionsByName = group(functions, (relation, name) => name);
  const triggersByName = group(triggers, (relation, name) => JSON.stringify([relationNames.get(relation), name]));
  return {
    tables: new Map(relations.map(({ __name: name, ...relation }) => [name, {
      relation, columns: tableColumns.get(relation.oid) || [], constraints: tableConstraints.get(relation.oid) || [], indexes: tableIndexes.get(relation.oid) || [],
    }])),
    functions: (name) => functionsByName.get(name) || [],
    triggers: (table, name) => triggersByName.get(JSON.stringify([table, name])) || [],
  };
};
// The stored table, as readTable returns it, or null when it does not exist.
const fromCatalog = (schema, name, catalog) => {
  const entry = catalog.tables.get(name);
  if (!entry) return null;
  ordinaryTable(schema, name, entry.relation);
  return { columns: entry.columns, constraints: entry.constraints, indexes: entry.indexes };
};

const validateBase = (schema, table, actual, triggers = []) => {
  const name = `${schema}.${table.name}`;
  if (!actual) mismatch(name, 'table is missing');
  if (actual.columns.length !== table.columns.length) mismatch(name, 'column set differs');
  for (const column of table.columns) {
    const stored = actual.columns.find((item) => item.name === column.name);
    if (!stored || stored.type !== column.type || stored.nullable !== column.nullable
      || (column.collation && (stored.collation !== column.collation || stored.collation_schema !== 'pg_catalog'))
      || normalizeExpression(stored.default) !== normalizeExpression(column.default || null) || stored.attidentity || stored.attgenerated) {
      mismatch(`${name}.${column.name}`, 'column type, collation, nullability or default differs');
    }
  }
  const primary = actual.constraints.find((item) => item.type === 'p');
  if (!primary || primary.name !== table.primaryKey.name || !same(primary.columns, table.primaryKey.columns) || primary.deferrable || !primary.validated) mismatch(name, 'primary key differs');
  const primaryIndex = actual.indexes.find((item) => item.primary);
  if (!primaryIndex?.valid || !primaryIndex.ready) mismatch(name, 'primary key index is invalid');
  for (const check of table.checks) {
    const stored = actual.constraints.find((item) => item.name === check.name);
    if (!stored || stored.type !== 'c' || !stored.validated || !stored.enforced || stored.no_inherit
      || normalizeExpression(stored.expression) !== normalizeExpression(check.expression)) {
      mismatch(`${name}.${check.name}`, `check constraint differs (expected ${check.expression}; found ${stored?.expression || 'missing'})`);
    }
  }
  const expectedNames = new Set([table.primaryKey.name, ...table.checks.map((c) => c.name), ...table.foreignKeys.map((c) => c.name), ...triggers.filter((t) => t.table === table.name && t.constraint).map((t) => t.name)]);
  for (const constraint of actual.constraints) {
    // PostgreSQL 18 also catalogs table NOT NULL constraints (already checked via pg_attribute).
    if (constraint.type === 'n') {
      const column = table.columns.find((item) => same(constraint.columns, [item.name]));
      if (!column || column.nullable || !constraint.validated || !constraint.enforced) mismatch(`${name}.${constraint.name}`, 'NOT NULL enforcement differs');
      continue;
    }
    if (!expectedNames.has(constraint.name)) mismatch(`${name}.${constraint.name}`, 'unexpected constraint');
  }
};

const validateForeignKey = (schema, table, key, actual) => {
  if (actual.type !== 'f' || !same(actual.columns, key.columns) || actual.target_schema !== schema
    || actual.target_table !== key.targetTable || !same(actual.target_columns, key.targetColumns)
    || actual.delete_action !== (key.onDelete === 'CASCADE' ? 'c' : 'a') || actual.update_action !== 'a'
    || actual.deferrable !== key.deferrable || actual.deferred !== key.initiallyDeferred || !actual.validated || !actual.enforced || actual.match_type !== 's' || !actual.enforcement_enabled) {
    mismatch(`${schema}.${table.name}.${key.name}`, 'foreign key target, columns, actions, deferrability or enforcement differs');
  }
};
const validateIndex = (schema, table, index, actual) => {
  if (!same(actual.columns, index.columns) || actual.unique !== index.unique || actual.nulls_not_distinct !== index.nullsNotDistinct
    || !actual.valid || !actual.ready || !actual.immediate || actual.method !== 'btree' || !actual.no_include
    || !actual.no_predicate || !actual.no_expression || !actual.default_order || !actual.default_ops || !actual.default_collation) {
    mismatch(`${schema}.${table.name}.${index.name}`, 'index definition differs');
  }
};

// Earlier versions generated a btree index on every [ID] list column. It caps each list at about 167
// identifiers (btree row size) and no generated query uses it. Initialization keeps it, as it keeps
// any extra non-unique index, but reports it when it carries the exact generated name and shape.
const legacyListIndexes = (schema, table, actual) => table.columns
  .filter((column) => column.type === 'uuid[]')
  .map((column) => ({ column: column.name, name: generatedName(table.name, column.name, 'idx') }))
  .filter(({ column, name }) => !table.indexes.some((item) => item.name === name) && actual.indexes.some((index) => index.name === name
    && !index.unique && !index.primary && index.method === 'btree' && same(index.columns, [column]) && index.no_predicate && index.no_expression))
  .map(({ name }) => `${identifier(schema)}.${identifier(name)}`);

// Each pass walks the description in the same order and rejects drift of an existing object at the same
// point: 'validate' also rejects a missing object, 'plan' records it without DDL, and 'create' creates it
// and records it.
const ensureFunctions = async (client, description, catalog, pass, missing, created) => {
  for (const fn of description.functions || []) {
    const rows = catalog.functions(fn.name);
    if (!rows.length) {
      if (pass === 'validate') mismatch(`${description.schema}.${fn.name}`, 'function is missing');
      missing.push({ kind: 'function', name: fn.name });
      if (pass === 'plan') continue;
      await client.query(createFunctionSQL(description.schema, fn));
      created.push(`function:${description.schema}.${fn.name}`);
      continue;
    }
    const stored = rows[0];
    if (rows.length !== 1 || stored.arguments !== fn.arguments.join(', ') || stored.returns !== fn.returns
      || stored.body !== fn.body || stored.language !== fn.language || stored.volatility !== fn.volatility[0].toLowerCase()
      || !same(stored.configuration, fn.configuration) || stored.prosecdef || stored.proisstrict || stored.proleakproof
      || stored.proparallel !== 'u' || stored.prokind !== 'f' || stored.proretset || stored.pronargdefaults
      || stored.procost !== 100 || stored.prorows !== 0 || stored.support !== 0) {
      mismatch(`${description.schema}.${fn.name}`, 'function identity, body, signature or configuration differs');
    }
  }
};

// pg_trigger.tgtype of an AFTER ... FOR EACH ROW trigger: the row bit plus one bit per event.
const eventBits = { INSERT: 4, DELETE: 8, UPDATE: 16 };
const triggerType = (trigger) => triggerEvents(trigger).reduce((type, event) => type + eventBits[event], 1);
// pg_get_triggerdef renders `... FOR EACH ROW WHEN (<condition>) EXECUTE FUNCTION <function>()`.
const whenClause = ({ definition, function_text: target }) => {
  const head = ' FOR EACH ROW WHEN (';
  const tail = `) EXECUTE FUNCTION ${target}()`;
  if (!definition?.endsWith(tail)) return null;
  const start = definition.lastIndexOf(head, definition.length - tail.length);
  return start < 0 ? null : definition.slice(start + head.length, definition.length - tail.length);
};

const ensureTriggers = async (client, description, catalog, pass, missing, created) => {
  for (const trigger of description.triggers || []) {
    const rows = catalog.triggers(trigger.table, trigger.name);
    if (!rows.length) {
      if (pass === 'validate') mismatch(`${description.schema}.${trigger.name}`, 'trigger is missing');
      missing.push({ kind: 'trigger', table: trigger.table, name: trigger.name });
      if (pass === 'plan') continue;
      const collision = await client.query('SELECT 1 FROM pg_constraint WHERE conrelid = to_regclass($1) AND conname = $2', [qualified(description.schema, trigger.table), trigger.name]);
      if (collision.rowCount) mismatch(`${description.schema}.${trigger.table}.${trigger.name}`, 'constraint name is already in use');
      await client.query(createTriggerSQL(description.schema, trigger));
      created.push(`trigger:${description.schema}.${trigger.table}.${trigger.name}`);
      continue;
    }
    const stored = rows[0];
    if (stored.tgtype !== triggerType(trigger) || stored.tgenabled !== 'O' || stored.tgisinternal || stored.tgdeferrable !== trigger.deferrable
      || stored.tginitdeferred !== trigger.initiallyDeferred || stored.tgnargs || stored.no_when !== !trigger.when
      || (trigger.when && normalizeExpression(whenClause(stored)) !== normalizeExpression(trigger.when)) || stored.columns !== ''
      || stored.function !== trigger.function || stored.function_schema !== description.schema || stored.pronargs
      || stored.constraint !== trigger.constraint || stored.constraint_relation || stored.parent || stored.tgoldtable || stored.tgnewtable
      || (trigger.constraint && (!stored.condeferrable || !stored.condeferred || !stored.convalidated || !stored.enforced))) {
      mismatch(`${description.schema}.${trigger.table}.${trigger.name}`, 'trigger definition or enforcement differs');
    }
  }
};

/** One pass over the description: schema, functions, tables, foreign keys and indexes, then triggers. */
const traverse = async (client, description, catalog, pass, missing, created) => {
  const { schema, tables } = description;
  const legacy = [];
  const namespace = await client.query('SELECT 1 FROM pg_namespace WHERE nspname = $1', [schema]);
  if (!namespace.rowCount) {
    if (pass === 'validate') mismatch(schema, 'schema is missing');
    missing.push({ kind: 'schema' });
    if (pass === 'plan') return legacy;
    await client.query(`CREATE SCHEMA ${identifier(schema)}`);
    created.push(`schema:${schema}`);
  }
  await ensureFunctions(client, description, catalog, pass, missing, created);
  const actuals = new Map();
  for (const table of tables) {
    let actual = fromCatalog(schema, table.name, catalog);
    if (!actual) {
      if (pass === 'validate') mismatch(`${schema}.${table.name}`, 'table is missing');
      missing.push({ kind: 'table', table: table.name });
      // A table that does not exist has none of its foreign keys, indexes or triggers either.
      if (pass === 'plan') continue;
      await client.query(createTableSQL(schema, table));
      created.push(`table:${schema}.${table.name}`);
      actual = await readTable(client, schema, table.name);
    }
    validateBase(schema, table, actual, description.triggers);
    actuals.set(table.name, actual);
  }
  for (const table of tables.filter((item) => actuals.has(item.name))) {
    const actual = actuals.get(table.name);
    for (const key of table.foreignKeys) {
      const stored = actual.constraints.find((item) => item.name === key.name);
      if (stored) validateForeignKey(schema, table, key, stored);
      else {
        if (pass === 'validate') mismatch(`${schema}.${table.name}.${key.name}`, 'foreign key is missing');
        missing.push({ kind: 'foreignKey', table: table.name, name: key.name });
        if (pass === 'plan') continue;
        await client.query(createForeignKeySQL(schema, table, key));
        created.push(`foreignKey:${schema}.${table.name}.${key.name}`);
      }
    }
    for (const index of table.indexes) {
      const stored = actual.indexes.find((item) => item.name === index.name);
      if (stored) validateIndex(schema, table, index, stored);
      else {
        if (pass === 'validate') mismatch(`${schema}.${table.name}.${index.name}`, 'index is missing');
        missing.push({ kind: 'index', table: table.name, name: index.name });
        if (pass === 'plan') continue;
        const collision = await client.query('SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = $1 AND c.relname = $2', [schema, index.name]);
        if (collision.rowCount) mismatch(`${schema}.${index.name}`, 'relation name is already in use');
        await client.query(createIndexSQL(schema, table, index));
        created.push(`index:${schema}.${index.name}`);
      }
    }
    for (const index of actual.indexes) {
      if (index.unique && !index.primary && !table.indexes.some((item) => item.name === index.name)) mismatch(`${schema}.${table.name}.${index.name}`, 'unexpected unique index');
    }
    legacy.push(...legacyListIndexes(schema, table, actual));
  }
  await ensureTriggers(client, description, catalog, pass, missing, created);
  return legacy;
};

// The table that an embedded value holding a virtual member owned while that member was stored, when the description
// no longer has it: the value then has no member with its own table, so it is stored as JSON.
const formerOwnedTable = (description, location) => {
  if (!location.path.length) return null;
  const name = generatedName(location.table, location.path[0]);
  return description.tables.some((table) => table.name === name) ? null : name;
};

// Names to read from the catalog: the description's, plus the refresh-trigger objects of both layouts. With virtual
// fields, also the touch trigger of each root that owns nothing, and the former owned table of each embedded value
// that holds one (see formerOwnedTable), which only storage no longer described can leave.
const catalogNames = (description, layouts, virtualFields) => {
  const functions = new Set((description.functions || []).map((fn) => fn.name));
  const triggers = new Set((description.triggers || []).map((trigger) => trigger.name));
  for (const layout of layouts.values()) {
    for (const objects of [layout.perRow, layout.perRoot]) {
      for (const fn of objects.functions) functions.add(fn.name);
      for (const trigger of objects.triggers) triggers.add(trigger.name);
    }
  }
  const tables = new Set(description.tables.map((table) => table.name));
  if (virtualFields.length) {
    const maintained = new Set((description.maintenance || []).map((item) => item.rootTable));
    for (const table of description.tables) {
      if (!table.ownership && !table.auxiliary && !maintained.has(table.name)) triggers.add(generatedName(table.name, 'touch'));
    }
    for (const location of virtualFields) {
      const former = formerOwnedTable(description, location);
      if (former) tables.add(former);
    }
  }
  return { tables: [...tables], functions: [...functions], triggers: [...triggers] };
};

// Each maintained root keeps the refresh-trigger layout its database already has: a function or trigger
// that only one layout has, or a touch function with one layout's body. A root with neither, such as a
// new one, gets the description's layout. Objects of both layouts in one root are drift.
const resolveLayouts = (description, catalog, layouts) => {
  const holds = (own, other) => own.functions.some((fn) => {
    const twin = other.functions.find((item) => item.name === fn.name);
    const stored = catalog.functions(fn.name);
    return twin ? twin.body !== fn.body && stored.some((row) => row.body === fn.body) : stored.length > 0;
  }) || own.triggers.some((trigger) => !other.triggers.some((item) => item.name === trigger.name && item.table === trigger.table)
    && catalog.triggers(trigger.table, trigger.name).length > 0);
  const choices = new Map();
  for (const item of description.maintenance || []) {
    const { perRow, perRoot } = layouts.get(item.rootTable);
    const row = holds(perRow, perRoot);
    const root = holds(perRoot, perRow);
    if (row && root) mismatch(`${description.schema}.${item.rootTable}`, 'refresh triggers of two layouts are present');
    const described = layoutOf(description, item);
    const layout = row ? 'perRow' : root ? 'perRoot' : described;
    if (layout !== described) choices.set(item.rootTable, layout);
  }
  return choices.size ? withLayouts(description, choices, layouts) : description;
};

// The maintained root a table belongs to: itself, the root of its ownership chain, or the root an
// auxiliary (guard or keys) table serves.
const rootOf = (description, name) => {
  let table = description.tables.find((item) => item.name === name);
  if (table?.auxiliary) return table.auxiliary.rootTable;
  while (table?.ownership) table = description.tables.find((item) => item.name === table.ownership.ownerTable);
  return table?.name;
};
// Keys can be stale only for roots whose maintenance objects are missing: guard and keys tables, the
// validate and refresh functions, and the refresh triggers and their functions. A missing foreign key or
// index validates existing rows itself when it is created, and checks only arrive with new tables.
const staleRoots = (description, objects) => {
  const maintenance = description.maintenance || [];
  const maintained = new Set(maintenance.map((item) => item.rootTable));
  const roots = new Set();
  for (const object of objects) {
    let root;
    if (object.kind === 'table' || object.kind === 'trigger') root = rootOf(description, object.table);
    else if (object.kind === 'function') {
      const item = maintenance.find((entry) => entry.validateFunction === object.name || entry.refreshFunction === object.name);
      const trigger = (description.triggers || []).find((entry) => entry.function === object.name);
      root = item ? item.rootTable : trigger && rootOf(description, trigger.table);
    }
    if (maintained.has(root)) roots.add(root);
  }
  return roots;
};
// Rebuilding keys needs the rows of their root to stay still until commit: lock the existing tables of
// those roots (root, owned, guard and keys tables) in one statement. Other DDL takes its own locks.
const lockRoots = async (client, description, catalog, roots) => {
  const names = description.tables.filter((table) => catalog.tables.has(table.name) && roots.has(rootOf(description, table.name)));
  if (names.length) await client.query(`LOCK TABLE ${names.map((table) => qualified(description.schema, table.name)).join(', ')} IN SHARE ROW EXCLUSIVE MODE`);
};

const UPGRADE_NOTES = 'https://simtlix.github.io/simfinity.js/resources/compatibility.html';
const series = (items) => (items.length < 3 ? items.join(' and ') : `${items.slice(0, -1).join(', ')} and ${items.at(-1)}`);
// A name longer than PostgreSQL identifiers was never stored, so nothing can refer to it.
const quotedName = (name) => (Buffer.byteLength(name) <= 63 ? identifier(name) : null);

// The described functions whose bodies could refer to the storage of a virtual field's location: for a member of a
// JSON value, the validation functions of its column, which the column's shape check calls; for a column, the
// maintenance functions of its table's root and the functions of that root's triggers. Each set includes the
// described functions that its functions call.
const functionOwners = (description) => {
  const functions = description.functions || [];
  const called = (text) => functions.filter((fn) => text.includes(qualified(description.schema, fn.name)));
  const closure = (seeds) => {
    const names = new Set();
    const queue = [...seeds];
    while (queue.length) {
      const fn = queue.pop();
      if (names.has(fn.name)) continue;
      names.add(fn.name);
      queue.push(...called(fn.body));
    }
    return names;
  };
  const ofRoot = (table) => {
    const root = rootOf(description, table);
    const item = (description.maintenance || []).find((entry) => entry.rootTable === root);
    const triggered = new Set((description.triggers || []).filter((trigger) => rootOf(description, trigger.table) === root).map((trigger) => trigger.function));
    return closure(functions.filter((fn) => triggered.has(fn.name) || (item && [item.validateFunction, item.refreshFunction].includes(fn.name))));
  };
  const ofColumn = (tableName, column) => {
    const table = description.tables.find((item) => item.name === tableName);
    const check = table?.checks.find((item) => item.name === generatedName(tableName, column, 'shape'));
    return closure(check ? called(check.expression) : []);
  };
  return { ofRoot, ofColumn };
};

// Storage that virtual fields (`extensions.virtual`) left in a database created while they were stored, found in
// the catalog this run has read, with no further statement: a column of a described table named as such a field's
// column, presence flag or owned-records state, a described function whose stored body still refers to such a
// field while its description does not, and the owned table of an embedded value that such a field, as its last
// member with its own table, made the value own. A state column means the field owned tables, which are dropped. An
// embedded value that no longer owns a table is stored as JSON instead, which needs a data migration. A root that
// now owns nothing but still has its refresh triggers loses them and its guard table, since the functions they call
// refer to the storage being dropped. Only the functions of a field's own column or root are compared (see
// functionOwners). Returns the explanation, with the migration, that a SCHEMA_MISMATCH appends, or null when
// nothing is left.
const virtualLeftovers = (description, catalog, virtualFields) => {
  const { schema } = description;
  const maintained = new Set((description.maintenance || []).map((item) => item.rootTable));
  const owners = functionOwners(description);
  const left = new Set();
  const columns = new Map();
  const owned = [];
  const moved = new Map();
  const has = (actual, name) => actual.columns.some((column) => column.name === name);
  for (const location of virtualFields) {
    const former = formerOwnedTable(description, location);
    const table = former && description.tables.find((item) => item.name === location.table);
    const actual = table && catalog.tables.get(table.name);
    const ownedActual = former && catalog.tables.get(former);
    const [value, member = location.name] = location.path;
    const state = `__${value}_state`;
    if (!actual || !ownedActual || table.columns.some((column) => column.name === state) || !has(actual, state)) continue;
    // The member, or the value inside the owned table that holds it, had storage there.
    if (![member, generatedName('__field', member, 'present'), `__${member}_state`].some((name) => has(ownedActual, name))) continue;
    left.add(location.field);
    moved.set(former, { table: table.name, value, state, location });
  }
  for (const location of virtualFields.filter((item) => !item.path.length)) {
    const table = description.tables.find((item) => item.name === location.table);
    const actual = table && catalog.tables.get(table.name);
    if (!actual) continue;
    const state = `__${location.name}_state`;
    const names = [location.name, generatedName('__field', location.name, 'present'), state].filter((name) => !table.columns.some((column) => column.name === name)
      && actual.columns.some((column) => column.name === name));
    if (!names.length) continue;
    left.add(location.field);
    columns.set(table.name, [...(columns.get(table.name) || []), ...names]);
    if (names.includes(state)) owned.push(location);
  }
  const statements = [...columns].map(([table, names]) => `ALTER TABLE ${qualified(schema, table)} ${names.map((name) => `DROP COLUMN ${identifier(name)}`).join(', ')};`);
  const add = (statement) => { if (!statements.includes(statement)) statements.push(statement); };
  for (const location of owned) add(`DROP TABLE IF EXISTS ${qualified(schema, generatedName(location.table, location.name))} CASCADE;`);
  for (const [former, { table, value, state }] of moved) {
    const json = [value, generatedName('__field', value, 'present')].map(identifier).join(' and ');
    add(`The embedded value ${value} of ${qualified(schema, table)} now has no member with its own table, so it is stored as JSON in the columns ${json} `
      + `of that table, with the checks and functions that compileDatabaseSchema() gives them, instead of in the table ${qualified(schema, former)}: `
      + `add them, fill them from the rows of ${qualified(schema, former)}, then drop the column ${identifier(state)} and run DROP TABLE IF EXISTS ${qualified(schema, former)} CASCADE;`);
  }
  for (const root of new Set([...columns.keys(), ...[...moved.values()].map((item) => item.table)].map((table) => rootOf(description, table)))) {
    if (maintained.has(root) || !catalog.triggers(root, generatedName(root, 'touch')).length) continue;
    for (const suffix of ['touch', 'deferred']) add(`DROP TRIGGER IF EXISTS ${identifier(generatedName(root, suffix))} ON ${qualified(schema, root)};`);
    add(`DROP TABLE IF EXISTS ${qualified(schema, generatedName(root, 'guard'))};`);
  }
  // A column is referred to as `alias."name"`, a member of a JSON value as `($1 -> 'name')`, and a former owned table
  // by its qualified name.
  const references = [
    ...virtualFields.map((location) => ({
      field: location.field,
      functions: location.path.length ? owners.ofColumn(location.table, location.path[0]) : owners.ofRoot(location.table),
      tokens: location.path.length
        ? [`($1 -> ${literal(location.name)})`]
        : [location.name, generatedName('__field', location.name, 'present'), `__${location.name}_state`].map(quotedName).filter(Boolean).map((name) => `.${name}`),
    })),
    ...[...moved].map(([former, { table, location }]) => ({ field: location.field, functions: owners.ofRoot(table), tokens: [qualified(schema, former)] })),
  ];
  const functions = [];
  for (const fn of description.functions || []) {
    const rows = catalog.functions(fn.name);
    if (rows.length !== 1 || rows[0].body === fn.body) continue;
    const matched = references.filter(({ functions: owned, tokens }) => owned.has(fn.name)
      && tokens.some((token) => rows[0].body.includes(token) && !fn.body.includes(token)));
    if (!matched.length) continue;
    functions.push(qualified(schema, fn.name));
    for (const { field } of matched) left.add(field);
  }
  if (!left.size) return null;
  const fields = [...new Set(virtualFields.map((item) => item.field))].filter((field) => left.has(field));
  const many = fields.length > 1;
  if (functions.length) {
    statements.push(`Replace ${functions.length > 1 ? 'the functions' : 'the function'} ${series(functions)} with ${functions.length > 1 ? 'their CREATE FUNCTION statements' : 'its CREATE FUNCTION statement'} `
      + 'from compileDatabaseSchema(), run as CREATE OR REPLACE FUNCTION.');
  }
  return `${series(fields)} ${many ? 'are' : 'is'} virtual (extensions.virtual), so ${many ? 'they are' : 'it is'} never stored, but this database still holds ${many ? 'their' : 'its'} `
    + `earlier storage. Once nothing reads that storage, migrate it: ${statements.join(' ')} See the upgrade notes at ${UPGRADE_NOTES}`;
};
// A SCHEMA_MISMATCH of a database that still holds storage of fields that are now virtual also names them.
const explainMismatch = (error, description, catalog, layouts, virtualFields) => {
  if (!virtualFields.length || !catalog || !(error instanceof SimfinityError) || error.extensions?.code !== 'SCHEMA_MISMATCH') return error;
  let resolved = description;
  // Refresh-trigger objects of two layouts in one root are themselves the mismatch; compare with the description.
  try { resolved = resolveLayouts(description, catalog, layouts); } catch { /* keep the description */ }
  try {
    const explanation = virtualLeftovers(resolved, catalog, virtualFields);
    return explanation ? new SimfinityError(`${error.message} ${explanation}`, 'SCHEMA_MISMATCH', 409) : error;
  } catch {
    // An explanation never replaces the mismatch it explains.
    return error;
  }
};

const backfill = async (client, description, roots) => {
  // The keys of these roots can be stale because maintenance objects were recreated. Their tables are
  // locked; rebuild their complete derived key set before testing owners against one another. Rollback
  // restores the old set.
  for (const table of description.tables.filter((item) => item.uniqueKeys && roots.has(item.uniqueKeys.rootTable))) {
    await client.query(`DELETE FROM ${qualified(description.schema, table.name)}`);
  }
  for (const item of (description.maintenance || []).filter((entry) => roots.has(entry.rootTable))) {
    await client.query(`INSERT INTO ${qualified(description.schema, item.guardTable)} (__owner_id)
      SELECT id FROM ${qualified(description.schema, item.rootTable)} ON CONFLICT (__owner_id) DO NOTHING`);
    await client.query(`SELECT ${qualified(description.schema, item.refreshFunction)}(id) FROM ${qualified(description.schema, item.rootTable)} ORDER BY id`);
  }
};

/**
 * Create missing objects or validate an existing schema; never alter/drop existing storage. The catalog is
 * read in a fixed number of statements without table locks. Create mode changes nothing, and locks nothing,
 * when nothing is missing; otherwise it locks only the tables of roots whose keys it must rebuild.
 * `context.virtualFields`, which the SQL runtime passes when its types declare virtual fields, lets a
 * SCHEMA_MISMATCH name such a field whose earlier storage the database still holds, with its migration.
 */
export const initializeDatabase = async (pool, description, { mode = 'create' } = {}, context) => {
  if (!['create', 'validate'].includes(mode)) throw new SimfinityError(`Unknown initialization mode: ${mode}`, 'INVALID_INITIALIZATION_MODE', 400);
  const { schema } = description;
  identifier(schema);
  if (schema.startsWith('pg_') || schema === 'information_schema') throw new SimfinityError('System schemas cannot be managed', 'INVALID_DATABASE_SCHEMA', 400);
  const layouts = maintenanceLayouts(description);
  const virtualFields = Array.isArray(context?.virtualFields) ? context.virtualFields : [];
  const names = catalogNames(description, layouts, virtualFields);
  const client = await pool.connect();
  const created = [];
  let legacy = [];
  let rollbackError;
  // The catalog most recently read, which explains a mismatch.
  let latest = null;
  try {
    await client.query(mode === 'validate' ? 'BEGIN READ ONLY' : 'BEGIN');
    await client.query('SET LOCAL search_path = pg_catalog');
    await client.query('SET LOCAL standard_conforming_strings = \'on\'');
    const version = await client.query('SELECT current_setting(\'server_version_num\')::integer AS version');
    if (version.rows[0].version < 150000) throw new SimfinityError('PostgreSQL 15 or later is required', 'UNSUPPORTED_DATABASE_VERSION', 400);
    // Serializes initializers of this schema before anything is read.
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [`simfinity:${schema}`]);
    const inspected = await loadCatalog(client, schema, names);
    latest = inspected;
    if (mode === 'validate') legacy = await traverse(client, resolveLayouts(description, inspected, layouts), inspected, 'validate', [], created);
    else {
      // Inspect first, without table locks or DDL. Drift before the first missing object is reported as
      // before; drift after one is left to the create pass, which reports what earlier versions did, such
      // as a foreign key that existing rows violate.
      const missing = [];
      let planned;
      try {
        planned = resolveLayouts(description, inspected, layouts);
        legacy = await traverse(client, planned, inspected, 'plan', missing, []);
      } catch (error) {
        if (!(error instanceof SimfinityError) || !missing.length) throw error;
      }
      if (missing.length) {
        const roots = staleRoots(planned, missing);
        await lockRoots(client, planned, inspected, roots);
        const catalog = await loadCatalog(client, schema, names);
        latest = catalog;
        const effective = resolveLayouts(description, catalog, layouts);
        const objects = [];
        legacy = await traverse(client, effective, catalog, 'create', objects, created);
        // A missing schema stops the plan early; its new tables need no lock. Lock any other root the
        // plan did not reach, such as one whose objects an operator dropped meanwhile, before rebuilding.
        const late = new Set([...staleRoots(effective, objects)].filter((root) => !roots.has(root)));
        await lockRoots(client, effective, catalog, late);
        if (roots.size || late.size) await backfill(client, effective, new Set([...roots, ...late]));
      }
    }
    await client.query('COMMIT');
    if (legacy.length) {
      console.warn(`Simfinity: PostgreSQL schema ${identifier(schema)} has btree indexes that earlier versions generated on [ID] list columns: ${legacy.join(', ')}. `
        + 'Each limits its list to about 167 identifiers and no generated query uses it. Once every process that uses this schema runs this version, drop them: '
        + `${legacy.map((name) => `DROP INDEX CONCURRENTLY IF EXISTS ${name};`).join(' ')} See the upgrade notes at https://simtlix.github.io/simfinity.js/resources/compatibility.html`);
    }
    return { mode, created };
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch (failure) { rollbackError = failure; }
    throw explainMismatch(error, description, latest, layouts, virtualFields);
  } finally {
    // A failed ROLLBACK can leave the transaction open; the error makes pg-pool destroy the connection.
    client.release(rollbackError);
  }
};
