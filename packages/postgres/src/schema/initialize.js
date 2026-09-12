import { SimfinityError } from '@simtlix/simfinity-core';
import { identifier } from './sql.js';
import { createTableSQL, createForeignKeySQL, createIndexSQL } from './ddl.js';

const mismatch = (object, reason) => {
  throw new SimfinityError(`Schema mismatch at ${object}: ${reason}. Apply an explicit migration before startup.`, 'SCHEMA_MISMATCH', 409);
};
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// Ignore renderer whitespace/optional quotes, keeping string contents and expression grouping.
const normalizeExpression = (expression) => {
  if (expression == null) return null;
  const tokens = expression.match(/'(?:[^']|'')*'|"(?:[^"]|"")*"|\s+|./gs) || [];
  let value = tokens.map((token) => {
    if (token.startsWith('\'')) return token;
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

const readTable = async (client, schema, name) => {
  const { rows: relations } = await client.query(`SELECT c.oid, c.relkind, c.relpersistence, c.relrowsecurity, c.relforcerowsecurity
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = $1 AND c.relname = $2`, [schema, name]);
  if (!relations.length) return null;
  const relation = relations[0];
  if (relation.relkind !== 'r' || relation.relpersistence !== 'p' || relation.relrowsecurity || relation.relforcerowsecurity) mismatch(`${schema}.${name}`, 'expected a persistent ordinary table without row security');
  const { rows: columns } = await client.query(`SELECT a.attname AS name, format_type(a.atttypid, a.atttypmod) AS type,
    NOT a.attnotnull AS nullable, pg_get_expr(d.adbin, d.adrelid) AS "default", a.attidentity, a.attgenerated,
    col.collname AS collation, ns.nspname AS collation_schema
    FROM pg_attribute a LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
    LEFT JOIN pg_collation col ON col.oid = a.attcollation LEFT JOIN pg_namespace ns ON ns.oid = col.collnamespace
    WHERE a.attrelid = $1 AND a.attnum > 0 AND NOT a.attisdropped ORDER BY a.attnum`, [relation.oid]);
  const { rows: constraints } = await client.query(`SELECT c.conname AS name, c.contype AS type,
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
    FROM pg_constraint c LEFT JOIN pg_class t ON t.oid = c.confrelid LEFT JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE c.conrelid = $1`, [relation.oid]);
  const { rows: indexes } = await client.query(`SELECT ic.relname AS name, i.indisprimary AS primary,
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
    FROM pg_index i JOIN pg_class ic ON ic.oid = i.indexrelid JOIN pg_am am ON am.oid = ic.relam WHERE i.indrelid = $1`, [relation.oid]);
  return { columns, constraints, indexes };
};

const validateBase = (schema, table, actual) => {
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
  const expectedNames = new Set([table.primaryKey.name, ...table.checks.map((c) => c.name), ...table.foreignKeys.map((c) => c.name)]);
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

/** Create missing objects or validate an existing schema; never alter/drop existing storage. */
export const initializeDatabase = async (pool, description, { mode = 'create' } = {}) => {
  if (!['create', 'validate'].includes(mode)) throw new SimfinityError(`Unknown initialization mode: ${mode}`, 'INVALID_INITIALIZATION_MODE', 400);
  const { schema, tables } = description;
  identifier(schema);
  if (schema.startsWith('pg_') || schema === 'information_schema') throw new SimfinityError('System schemas cannot be managed', 'INVALID_DATABASE_SCHEMA', 400);
  const client = await pool.connect();
  const created = [];
  try {
    await client.query(mode === 'validate' ? 'BEGIN READ ONLY' : 'BEGIN');
    await client.query('SET LOCAL search_path = pg_catalog');
    await client.query('SET LOCAL standard_conforming_strings = \'on\'');
    const version = await client.query('SELECT current_setting(\'server_version_num\')::integer AS version');
    if (version.rows[0].version < 150000) throw new SimfinityError('PostgreSQL 15 or later is required', 'UNSUPPORTED_DATABASE_VERSION', 400);
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [`simfinity:${schema}`]);
    const namespace = await client.query('SELECT 1 FROM pg_namespace WHERE nspname = $1', [schema]);
    if (!namespace.rowCount) {
      if (mode === 'validate') mismatch(schema, 'schema is missing');
      await client.query(`CREATE SCHEMA ${identifier(schema)}`);
      created.push(`schema:${schema}`);
    }
    const catalog = new Map();
    for (const table of tables) {
      let actual = await readTable(client, schema, table.name);
      if (!actual) {
        if (mode === 'validate') mismatch(`${schema}.${table.name}`, 'table is missing');
        await client.query(createTableSQL(schema, table));
        created.push(`table:${schema}.${table.name}`);
        actual = await readTable(client, schema, table.name);
      }
      validateBase(schema, table, actual);
      catalog.set(table.name, actual);
    }
    for (const table of tables) {
      const actual = catalog.get(table.name);
      for (const key of table.foreignKeys) {
        const stored = actual.constraints.find((item) => item.name === key.name);
        if (stored) validateForeignKey(schema, table, key, stored);
        else {
          if (mode === 'validate') mismatch(`${schema}.${table.name}.${key.name}`, 'foreign key is missing');
          await client.query(createForeignKeySQL(schema, table, key));
          created.push(`foreignKey:${schema}.${table.name}.${key.name}`);
        }
      }
      for (const index of table.indexes) {
        const stored = actual.indexes.find((item) => item.name === index.name);
        if (stored) validateIndex(schema, table, index, stored);
        else {
          if (mode === 'validate') mismatch(`${schema}.${table.name}.${index.name}`, 'index is missing');
          await client.query(createIndexSQL(schema, table, index));
          created.push(`index:${schema}.${index.name}`);
        }
      }
      for (const index of actual.indexes) {
        if (index.unique && !index.primary && !table.indexes.some((item) => item.name === index.name)) mismatch(`${schema}.${table.name}.${index.name}`, 'unexpected unique index');
      }
    }
    await client.query('COMMIT');
    return { mode, created };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
};
