import { identifier as q, qualified, literal, generatedName, invalid } from './sql.js';

/** Database-side validation and multikey maintenance. All bodies resolve names in pg_catalog. */
export const constraintBuilder = (schema, tables, { addTable, addColumn, addReference, addIndex, addCheck }) => {
  const functions = []; const triggers = []; const uniquePaths = [];
  const fn = (name, args, returns, body, immutable = false) => {
    if (functions.some((item) => item.name === name)) invalid(`Function name collision: ${name}`);
    const result = { name, arguments: args, returns, language: 'plpgsql', volatility: immutable ? 'IMMUTABLE' : 'VOLATILE', configuration: ['search_path=pg_catalog', 'TimeZone=UTC', 'DateStyle=ISO, YMD'], body };
    functions.push(result);
    return qualified(schema, name);
  };
  const jsonValidator = (table, field, path = []) => {
    const name = generatedName(table.name, ...path, field.name, 'json_valid');
    let test;
    if (field.list) {
      const item = jsonValidator(table, { ...field, name: field.name, list: false, required: field.itemRequired }, [...path, field.name, 'item']);
      test = `IF jsonb_typeof($1) <> 'array' THEN RETURN false; END IF;
  RETURN NOT EXISTS (SELECT 1 FROM jsonb_array_elements($1) AS e(value) WHERE NOT ${item}(e.value));`;
    } else if (field.kind === 'embedded') {
      const checks = field.fields.map((child) => `${jsonValidator(table, child, [...path, field.name])}($1 -> ${literal(child.storageName)})`);
      test = `IF jsonb_typeof($1) <> 'object' THEN RETURN false; END IF; RETURN ${checks.join(' AND ') || 'true'};`;
    } else {
      const value = '($1 #>> \'{}\')';
      const conditions = {
        String: 'jsonb_typeof($1) = \'string\'', Boolean: 'jsonb_typeof($1) = \'boolean\'',
        Enum: `jsonb_typeof($1) = 'string' AND ${value} = ANY (ARRAY[${(field.values || []).map(literal).join(', ')}]::text[])`,
        ID: `jsonb_typeof($1) = 'string' AND ${value} ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'`,
        Int: `jsonb_typeof($1) = 'number' AND ${value}::numeric = trunc(${value}::numeric) AND ${value}::numeric BETWEEN -2147483648 AND 2147483647`,
        Float: `jsonb_typeof($1) = 'number' AND ${value}::double precision BETWEEN '-1.7976931348623157e308'::double precision AND '1.7976931348623157e308'::double precision`,
        DateTime: `jsonb_typeof($1) = 'string' AND ${value} ~ '^[+-]?[0-9]{4,6}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}[.][0-9]{3}Z$' AND isfinite(${value}::timestamp with time zone)`,
      };
      test = `RETURN ${conditions[field.scalar]};`;
    }
    return fn(name, ['jsonb'], 'boolean', `BEGIN
  IF $1 IS NULL OR $1 = 'null'::jsonb THEN RETURN ${!field.required}; END IF;
  ${test}
EXCEPTION WHEN data_exception THEN RETURN false;
END`, true);
  };
  const addJSON = (table, field) => addCheck(table, field.storageName, 'shape', `${table.ownership?.nullableItems ? `(NOT ${q('__item_present')}) OR ` : ''}${jsonValidator(table, field)}(${q(field.storageName)})`);
  const addUnique = (table, field, type) => { uniquePaths.push({ table, field, type }); };
  const chain = (table) => {
    const result = [table];
    while (result[0].ownership) result.unshift(tables.find((item) => item.name === result[0].ownership.ownerTable));
    return result;
  };
  const joins = (path, left = false) => path.map((table, index) => {
    if (!index) return `${qualified(schema, table.name)} t0`;
    const parent = path[index - 1];
    return `${left ? 'LEFT ' : ''}JOIN ${qualified(schema, table.name)} t${index} ON t${index}.__owner_id = t${index - 1}.${q(parent.primaryKey.columns[0])}${left ? ` AND t${index - 1}.${q(table.ownership.stateColumn)} = 'present'${parent.ownership?.nullableItems ? ` AND t${index - 1}.__item_present` : ''}` : ''}`;
  }).join(' ');
  const finish = () => {
    const sources = [...tables];
    const roots = sources.filter((table) => !table.ownership && (sources.some((owned) => owned.ownership && chain(owned)[0] === table) || uniquePaths.some((key) => chain(key.table)[0] === table)));
    const maintenance = [];
    for (const root of roots) {
      const ownedTables = sources.filter((table) => table.ownership && chain(table)[0] === root);
      const guard = addTable(generatedName(root.name, 'guard'));
      guard.auxiliary = { rootTable: root.name, kind: 'guard' };
      guard.columns = [{ name: '__owner_id', type: 'uuid', nullable: false }, { name: 'version', type: 'bigint', nullable: false, default: '0' }];
      guard.primaryKey.columns = ['__owner_id'];
      addReference(guard, '__owner_id', root.name, 'id', true);
      let checks = '';
      for (const table of ownedTables) {
        const parentPath = chain(table).slice(0, -1); const parent = parentPath.at(-1); const alias = `t${parentPath.length - 1}`;
        const children = `SELECT * FROM ${qualified(schema, table.name)} c WHERE c.__owner_id = ${alias}.${q(parent.primaryKey.columns[0])}`;
        const invalidCount = table.ownership.list ? 'n > 0 AND (lo <> 0 OR hi <> n - 1)' : 'n <> 1';
        checks += `
  IF EXISTS (SELECT 1 FROM ${joins(parentPath)} CROSS JOIN LATERAL (SELECT count(*) n, ${table.ownership.list ? 'min(c.__position) lo, max(c.__position) hi' : '0 lo, 0 hi'} FROM (${children}) c) counts
    WHERE t0.id = $1 AND ((${alias}.${q(table.ownership.stateColumn)} <> 'present' AND n <> 0) OR (${alias}.${q(table.ownership.stateColumn)} = 'present' AND (${invalidCount})))) THEN
    RAISE EXCEPTION 'Invalid owned shape: %', ${literal(table.name)} USING ERRCODE = '23514'; END IF;`;
        if (table.ownership.nullableItems) {
          const nested = ownedTables.filter((item) => item.ownership.ownerTable === table.name);
          const payload = table.columns.filter((column) => !column.name.startsWith('__')).map((column) => `c.${q(column.name)} IS NOT NULL`);
          for (const child of nested) payload.push(`c.${q(child.ownership.stateColumn)} <> 'missing'`, `EXISTS (SELECT 1 FROM ${qualified(schema, child.name)} x WHERE x.__owner_id = c.__id)`);
          if (payload.length) checks += `
  IF EXISTS (SELECT 1 FROM ${joins(chain(table))} JOIN ${qualified(schema, table.name)} c ON c.__id = t${parentPath.length}.__id WHERE t0.id = $1 AND NOT c.__item_present AND (${payload.join(' OR ')})) THEN
    RAISE EXCEPTION 'Null owned item has payload: %', ${literal(table.name)} USING ERRCODE = '23514'; END IF;`;
        }
      }
      const validateName = generatedName(root.name, 'owned_valid');
      const validate = fn(validateName, ['uuid'], 'void', `BEGIN${checks}\nEND`);
      let rebuild = '';
      for (const key of uniquePaths.filter((item) => chain(item.table)[0] === root)) {
        const path = chain(key.table); const alias = `t${path.length - 1}`;
        const column = `${alias}.${q(key.field.storageName)}`;
        const source = key.table.ownership?.nullableItems ? `CASE WHEN ${alias}.__item_present THEN ${column} END` : column;
        const value = key.field.list ? 'v.value' : source;
        const kind = `CASE ${key.field.list ? `WHEN cardinality(${source}) = 0 THEN 'empty' ` : ''}WHEN ${value} IS NULL THEN 'null' ELSE 'value' END`;
        const query = `SELECT DISTINCT t0.id AS __owner_id, ${kind}::text COLLATE pg_catalog."C" AS kind, ${value} AS value FROM ${joins(path, true)}${key.field.list ? ` LEFT JOIN LATERAL unnest(${source}) v(value) ON true` : ''} WHERE t0.id = $1`;
        const storage = addTable(generatedName(key.table.name, key.field.name, 'keys'));
        storage.uniqueKeys = { rootTable: root.name, sourceTable: key.table.name, field: key.field.storageName };
        storage.auxiliary = { rootTable: root.name, kind: 'uniqueKeys' };
        addColumn(storage, { name: '__owner_id', type: 'uuid', nullable: false });
        addColumn(storage, { name: 'kind', type: 'text', nullable: false });
        addColumn(storage, { name: 'value', type: key.type.replace(/\[\]$/, ''), nullable: true });
        addReference(storage, '__owner_id', root.name, 'id', true);
        addIndex(storage, ['kind', 'value'], true);
        addCheck(storage, 'kind', 'key', '((kind = \'value\'::text) AND (value IS NOT NULL)) OR ((kind = ANY (ARRAY[\'null\'::text, \'empty\'::text])) AND (value IS NULL))');
        rebuild += `\n  DELETE FROM ${qualified(schema, storage.name)} WHERE __owner_id = $1;\n  INSERT INTO ${qualified(schema, storage.name)} (__owner_id, kind, value) ${query};`;
      }
      const refreshName = generatedName(root.name, 'refresh');
      const refresh = fn(refreshName, ['uuid'], 'void', `BEGIN\n  PERFORM ${validate}($1);${rebuild}\nEND`);
      maintenance.push({ rootTable: root.name, guardTable: guard.name, validateFunction: validateName, refreshFunction: refreshName });
      // Touch a real shared tuple at write time, not only at deferred-check time.
      // RR writers must conflict on its version; RC writers then refresh using a new
      // command snapshot after acquiring it. Lock-only reads permit stale RR keys.
      for (const table of [root, ...ownedTables]) {
        const path = chain(table);
        const owner = (record) => table === root ? `${record}.id` : `(SELECT t0.id FROM ${joins(path.slice(0, -1))} WHERE t${path.length - 2}.${q(path.at(-2).primaryKey.columns[0])} = ${record}.__owner_id)`;
        for (const deferred of [false, true]) {
          const name = generatedName(table.name, deferred ? 'deferred' : 'touch');
          const action = deferred ? `PERFORM ${refresh}(__root_id);` : `INSERT INTO ${qualified(schema, guard.name)} (__owner_id) SELECT __root_id WHERE EXISTS (SELECT 1 FROM ${qualified(schema, root.name)} WHERE id = __root_id) ON CONFLICT (__owner_id) DO UPDATE SET version = ${q(guard.name)}.version + 1;`;
          fn(name, [], 'trigger', `DECLARE __root_id uuid; __old_root_id uuid; BEGIN
  IF TG_OP <> 'INSERT' THEN __old_root_id := ${owner('OLD')}; END IF;
  IF TG_OP <> 'DELETE' THEN __root_id := ${owner('NEW')}; END IF;
  IF __old_root_id IS NOT NULL AND __old_root_id IS DISTINCT FROM __root_id THEN
    DECLARE __new_root_id uuid := __root_id; BEGIN __root_id := __old_root_id; ${action} __root_id := __new_root_id; END;
  END IF;
  IF __root_id IS NOT NULL THEN ${action} END IF;
  RETURN NULL;
END`);
          triggers.push({ name, table: table.name, function: name, constraint: deferred, deferrable: deferred, initiallyDeferred: deferred });
        }
      }
    }
    return { functions, triggers, maintenance };
  };
  return { addJSON, addUnique, finish };
};
