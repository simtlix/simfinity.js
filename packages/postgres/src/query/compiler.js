import { resolveModelPath, SimfinityError } from '@simtlix/simfinity-core';
import { identifier as q, literal, qualified } from '../schema/sql.js';
import { encodeScalar, storageTypes, invalidValue } from '../codecs.js';

const unsupported = (message) => { throw new SimfinityError(message, 'UNSUPPORTED_QUERY', 400); };

/** Compiles validated paths; all caller values are parameters, identifiers come from metadata. */
export const compileQuery = (models, database, plan, extra = null) => {
  const values = [];
  const joins = new Map();
  let serial = 0;
  const alias = () => `t${++serial}`;
  const tableByName = (name) => database.tables.find((item) => item.name === name);
  const root = tableByName(plan.entity);
  if (!root) unsupported(`Unknown persistent entity ${plan.entity}`);
  const bind = (value, type) => { values.push(value); return `$${values.length}::${type}`; };
  const col = (name, field) => `${name}.${q(field)}`;
  const join = (key, table, condition) => {
    if (!joins.has(key)) {
      const name = alias();
      joins.set(key, { alias: name, sql: `LEFT JOIN ${qualified(database.schema, table)} ${name} ON ${condition(name)}` });
    }
    return joins.get(key).alias;
  };
  const arrayFrom = (vector, expression) => `ARRAY(SELECT ${expression} FROM ${vector.from} WHERE ${vector.where})`;
  const jsonItems = (expression, missing = '[]') => `jsonb_array_elements(CASE WHEN jsonb_typeof(${expression}) = 'array' THEN ${expression} ELSE '${missing}'::jsonb END)`;
  const helper = (name, ...args) => `${qualified(database.schema, `__simfinity_${name}`)}(${args.join(', ')})`;
  const dateJSON = (field, sql) => field.scalar === 'DateTime' ? helper('date_value', sql) : sql;
  const nativeJSON = (field, sql) => {
    if (field.scalar !== 'DateTime') return `to_jsonb(${sql})`;
    if (field.list) return `CASE WHEN ${sql} IS NULL THEN NULL ELSE (SELECT COALESCE(jsonb_agg(extract(epoch FROM value) * 1000 ORDER BY position), '[]'::jsonb) FROM unnest(${sql}) WITH ORDINALITY d(value, position)) END`;
    return `to_jsonb(extract(epoch FROM ${sql}) * 1000)`;
  };
  const project = (context, steps) => {
    const [field, ...rest] = steps;
    const owned = context.table && database.tables.find((item) => item.ownership?.ownerTable === context.table.name && item.ownership.field === field.name);
    if (owned) {
      const name = alias();
      const value = project({ table: owned, alias: name, json: null }, rest);
      const state = col(context.alias, owned.ownership.stateColumn);
      const condition = `${col(name, '__owner_id')} = ${col(context.alias, context.table.primaryKey.columns[0])}${owned.ownership.nullableItems ? ` AND ${col(name, '__item_present')}` : ''}`;
      const selection = field.list ? `COALESCE(jsonb_agg(${value} ORDER BY ${col(name, '__position')}) FILTER (WHERE ${value} IS NOT NULL), '[]'::jsonb)` : value;
      return `CASE WHEN ${state} = 'present' THEN (SELECT ${selection} FROM ${qualified(database.schema, owned.name)} ${name} WHERE ${condition}) END`;
    }
    let value;
    if (context.json) value = `(${context.json} -> ${literal(field.storageName)})`;
    else {
      const identity = !context.table.ownership && ['id', '_id'].includes(field.name);
      const column = context.table.columns.find((item) => item.name === (identity ? 'id' : field.storageName));
      const sql = col(context.alias, column.name);
      value = `COALESCE(${nativeJSON(field, sql)}, 'null'::jsonb)`;
      if (column.presenceColumn) value = `CASE WHEN ${sql} IS NOT NULL OR ${col(context.alias, column.presenceColumn)} THEN ${value} END`;
      else value = nativeJSON(field, sql);
    }
    if (!rest.length) return context.json ? dateJSON(field, value) : value;
    if (field.kind !== 'embedded') unsupported('Unnormalized embedded reference');
    if (!field.list) return project({ json: value }, rest);
    const name = alias();
    const child = project({ json: `${name}.value` }, rest);
    return `CASE WHEN jsonb_typeof(${value}) = 'array' THEN (SELECT COALESCE(jsonb_agg(${child} ORDER BY ${name}.ordinality) FILTER (WHERE ${child} IS NOT NULL), '[]'::jsonb) FROM ${jsonItems(value)} WITH ORDINALITY ${name}(value, ordinality)) END`;
  };
  const path = (parts, usage = 'filter') => {
    const steps = resolveModelPath(models, plan.entity, parts);
    let context = { table: root, alias: 't0', json: null, vector: null };
    for (let index = 0; index < steps.length; index++) {
      const field = steps[index];
      const key = parts.slice(0, index + 1).join('.');
      const last = index === steps.length - 1;
      if (usage === 'aggregate' && steps.slice(index).some((item) => item.list) && !steps.slice(index).some((item, offset, remaining) => item.target && offset < remaining.length - 1)) {
        const leaf = steps.at(-1);
        if (leaf.kind !== 'scalar') unsupported('Whole embedded objects cannot be sorted or aggregated');
        return { sql: project(context, steps.slice(index)), field: leaf, type: storageTypes[leaf.scalar], list: true, json: true };
      }
      if (field.kind === 'embedded') {
        if (last) unsupported('Whole embedded objects cannot be sorted or aggregated');
        const owned = context.table && database.tables.find((item) => item.ownership?.ownerTable === context.table.name && item.ownership.field === field.name);
        if (owned) {
          const ownerAlias = context.alias;
          const ownerId = col(ownerAlias, context.table.primaryKey.columns[0]);
          const state = `${col(ownerAlias, owned.ownership.stateColumn)} = 'present'`;
          const presence = (name) => owned.ownership.nullableItems && usage !== 'sort' ? ` AND ${col(name, '__item_present')}` : '';
          if (!field.list && !context.vector) {
            const joined = join(key, owned.name, (name) => `${col(name, '__owner_id')} = ${ownerId} AND ${state}`);
            context = { table: owned, alias: joined, json: null, vector: null };
          } else {
            const name = alias();
            const stored = alias();
            // Missing/null lists contribute a missing path, empty lists and null items do not.
            const condition = `${col(stored, '__owner_id')} = ${ownerId} AND ${state}${presence(stored)}`;
            const nullRow = owned.columns.map((column) => `NULL::${column.type} AS ${q(column.name)}`).join(', ');
            const noItems = usage === 'sort' ? ` OR NOT EXISTS (SELECT 1 FROM ${qualified(database.schema, owned.name)} empty_child WHERE empty_child.__owner_id = ${ownerId})` : '';
            const source = `LATERAL (SELECT ${stored}.* FROM ${qualified(database.schema, owned.name)} ${stored} WHERE ${condition} UNION ALL SELECT ${nullRow} WHERE ${col(ownerAlias, owned.ownership.stateColumn)} IS DISTINCT FROM 'present'${noItems}) ${name}`;
            const vector = context.vector
              ? { from: `${context.vector.from} CROSS JOIN ${source}`, where: context.vector.where }
              : { from: source, where: 'TRUE' };
            context = { table: owned, alias: name, json: null, vector };
          }
        } else {
          const json = context.json ? `(${context.json} -> ${literal(field.storageName)})` : col(context.alias, field.storageName);
          if (field.list) {
            const name = alias();
            const source = `${jsonItems(usage === 'sort' ? `CASE WHEN ${json} = '[]'::jsonb THEN '[{}]'::jsonb ELSE ${json} END` : json, '[{}]')} ${name}(value)`;
            const present = usage === 'sort' ? 'TRUE' : `jsonb_typeof(${name}.value) = 'object'`;
            const vector = context.vector
              ? { from: `${context.vector.from} CROSS JOIN LATERAL ${source}`, where: `${context.vector.where} AND ${present}` }
              : { from: source, where: present };
            context = { table: null, alias: name, json: `${name}.value`, vector };
          } else context = { ...context, table: null, json };
        }
      } else if (field.target && !last) {
        if (context.json) unsupported('Unnormalized embedded reference');
        const source = context;
        const joined = join(key, field.target, (name) => {
          if (field.kind === 'collection') return `${col(name, field.connectionField)} = ${col(source.alias, source.table.primaryKey.columns[0])}`;
          const reference = col(source.alias, field.storageName);
          return source.vector
            ? `${col(name, 'id')} = ANY (${arrayFrom(source.vector, reference)})`
            : `${col(name, 'id')} = ${reference}`;
        });
        context = { table: tableByName(field.target), alias: joined, json: null, vector: null };
      } else {
        if (!last || (field.kind !== 'scalar' && !field.inferred)) unsupported('A query path must end at a scalar field');
        const identity = context.table && !context.table.ownership && ['id', '_id'].includes(field.name);
        const type = identity || field.kind === 'reference' ? 'uuid' : storageTypes[field.scalar];
        let expression;
        if (context.json) {
          if (field.list) {
            const json = `(${context.json} -> ${literal(field.storageName)})`;
            const typedJSON = dateJSON(field, json);
            expression = `CASE WHEN ${json} IS NULL OR ${json} = 'null'::jsonb THEN NULL ELSE ARRAY(SELECT (value #>> '{}')::${field.scalar === 'DateTime' ? 'double precision' : type} FROM ${jsonItems(typedJSON)} j(value)) END`;
          } else expression = field.scalar === 'DateTime' ? `(${dateJSON(field, `(${context.json} -> ${literal(field.storageName)})`)} #>> '{}')::double precision` : `(${context.json} ->> ${literal(field.storageName)})::${type}`;
        } else expression = col(context.alias, identity ? 'id' : field.storageName);
        if (usage === 'aggregate' && field.stateNames) expression = `CASE ${expression} ${field.stateNames.map((item) => `WHEN ${literal(item.value)} THEN ${literal(item.name)}`).join(' ')} END`;
        const dateNumeric = field.scalar === 'DateTime' && !!context.json;
        let sortKey;
        if (usage === 'sort' && (context.vector || field.list)) {
          const json = dateNumeric ? `to_jsonb(${expression})` : nativeJSON(field, expression);
          const candidate = (order) => helper('sort_key', json, literal(field.scalar), order === 'ASC' ? 'true' : 'false');
          sortKey = (order) => context.vector
            ? `COALESCE((SELECT value FROM unnest(${arrayFrom(context.vector, candidate(order))}) s(value) ORDER BY value ${order} LIMIT 1), ${helper('value_key', 'NULL::jsonb', literal(field.scalar))})`
            : candidate(order);
        }
        if (context.vector && field.list) {
          const name = alias();
          const vector = { from: `${context.vector.from} CROSS JOIN LATERAL unnest(COALESCE(${expression}, ARRAY[NULL]::${dateNumeric ? 'double precision' : type}[])) ${name}(value)`, where: context.vector.where };
          const sql = arrayFrom(vector, `${name}.value`);
          return { sql: type === 'text' ? `(${sql}) COLLATE "pg_catalog"."C"` : sql, field, type: dateNumeric ? 'double precision' : type, list: true, vector: true, dateNumeric, sortKey };
        }
        let sql = context.vector ? arrayFrom(context.vector, expression) : expression;
        if (type === 'text') sql = `(${sql}) COLLATE "pg_catalog"."C"`;
        return { sql, field: identity ? { ...field, scalar: 'ID' } : field, type: dateNumeric ? 'double precision' : type, list: field.list || !!context.vector, vector: !!context.vector, dateNumeric, sortKey };
      }
    }
    unsupported('Invalid query path');
  };
  const predicate = (expression, operator, value) => {
    const { sql, field, type, list, vector } = expression;
    // Filters accept member names first; writes already receive internal enum values.
    const encodeFilter = (item) => {
      if (field.scalar !== 'Enum' || item == null) return encodeScalar(field, item);
      const entry = field.enumValues.find((candidate) => candidate.name === item)
        || field.enumValues.find((candidate) => candidate.value === item);
      if (!entry) invalidValue(`Invalid enum value for ${field.name}`);
      return encodeScalar(field, entry.value);
    };
    if (operator === 'LIKE' && field.scalar !== 'String') invalidValue('LIKE requires a string field');
    const scalarBind = (item) => { const value = encodeFilter(item); return bind(expression.dateNumeric && value ? value.getTime() : value, type); };
    const equality = (item) => {
      if (Array.isArray(item)) {
        if (!field.list || vector) invalidValue('Array equality requires a scalar-list field');
        return `${sql} IS NOT DISTINCT FROM ${bind(item.map(encodeFilter), `${type}[]`)}`;
      }
      if (list) {
        const contains = `array_position(${sql}, ${scalarBind(item)}) IS NOT NULL`;
        return item == null ? `(${sql} IS NULL OR ${contains})` : contains;
      }
      return item == null ? `${sql} IS NULL` : `${sql} IS NOT DISTINCT FROM ${scalarBind(item)}`;
    };
    if (operator === 'EQ') return equality(value);
    if (operator === 'NE') {
      if (!list && !Array.isArray(value)) return value == null ? `${sql} IS NOT NULL` : `${sql} IS DISTINCT FROM ${scalarBind(value)}`;
      return `NOT (${equality(value)})`;
    }
    if (operator === 'IN' || operator === 'NIN') {
      const expressionSQL = value.length ? `(${value.map(equality).join(' OR ')})` : 'FALSE';
      return operator === 'IN' ? expressionSQL : value.length ? `NOT ${expressionSQL}` : 'TRUE';
    }
    if (operator === 'BTW') return `(${predicate(expression, 'GTE', value[0])} AND ${predicate(expression, 'LTE', value[1])})`;
    if (value == null || Array.isArray(value)) invalidValue(`${operator} requires a non-null scalar value`);
    const parameter = scalarBind(value);
    const compare = (left) => {
      if (operator === 'LIKE') {
        return `strpos(${left}, ${parameter}) > 0`;
      }
      return `${left} ${{ LT: '<', LTE: '<=', GT: '>', GTE: '>=' }[operator]} ${parameter}`;
    };
    return list ? `EXISTS (SELECT 1 FROM unnest(${sql}) v(value) WHERE ${compare('v.value')})` : `COALESCE(${compare(sql)}, FALSE)`;
  };
  const where = (node) => {
    if (!node) return 'TRUE';
    if (node.kind === 'predicate') return `(${predicate(path(node.path), node.operator, node.value)})`;
    return `(${node.terms.map(where).join(node.kind === 'and' ? ' AND ' : ' OR ')})`;
  };
  let condition = where(plan.where);
  if (extra) {
    const column = root.columns.find((item) => item.name === extra.column);
    if (!column || column.type !== 'uuid') unsupported('Invalid inverse connection field');
    condition += ` AND ${col('t0', column.name)} = ${bind(extra.id, 'uuid')}`;
  }
  let select = 't0.*';
  let group = '';
  const order = [];
  if (plan.mode === 'count') select = 'count(*) AS size';
  else if (plan.mode === 'aggregate') {
    const groupPath = path(plan.aggregation.groupId, 'aggregate');
    // Mongo merges missing and explicit-null group keys, but retains nulls inside arrays.
    const groupSQL = groupPath.json ? `NULLIF(${groupPath.sql}, 'null'::jsonb)` : groupPath.sql;
    select = `${groupSQL} AS "groupId"`;
    group = ` GROUP BY ${groupSQL}`;
    const outputs = [groupPath];
    plan.aggregation.facts.forEach((fact, index) => {
      const expression = path(fact.path, 'aggregate');
      outputs.push({ ...expression, list: ['MIN', 'MAX'].includes(fact.operation) && expression.list });
      let operation;
      if (fact.operation === 'COUNT') operation = 'count(*)';
      else if (expression.list) {
        if (fact.operation === 'SUM' || fact.operation === 'AVG') operation = fact.operation === 'SUM' ? '0' : 'NULL';
        else operation = `(array_agg(${expression.sql} ORDER BY ${helper('value_key', expression.sql, literal(expression.field.scalar))} ${fact.operation === 'MIN' ? 'ASC' : 'DESC'}) FILTER (WHERE ${expression.sql} IS NOT NULL AND ${expression.sql} <> 'null'::jsonb))[1]`;
      }
      else if (['SUM', 'AVG'].includes(fact.operation) && !['Int', 'Float'].includes(expression.field.scalar)) operation = fact.operation === 'SUM' ? '0' : 'NULL';
      else if (['MIN', 'MAX'].includes(fact.operation) && expression.type === 'boolean') operation = `${fact.operation === 'MIN' ? 'bool_and' : 'bool_or'}(${expression.sql})`;
      else if (['MIN', 'MAX'].includes(fact.operation) && expression.type === 'uuid') operation = `${fact.operation}(${expression.sql}::text COLLATE "pg_catalog"."C")::uuid`;
      else operation = `${fact.operation}(${expression.sql})`;
      if (fact.operation === 'SUM') operation = `COALESCE(${operation}, 0)`;
      select += `, ${operation} AS ${q(`fact_${index}`)}`;
    });
    for (const term of plan.sort.length ? plan.sort : [{ path: ['groupId'], order: 'ASC' }]) {
      const index = plan.aggregation.facts.findIndex((fact) => fact.factName === term.path.join('.'));
      const column = q(index < 0 ? 'groupId' : `fact_${index}`);
      const output = outputs[index + 1];
      const key = output.list ? helper('sort_key', column, literal(output.field.scalar), term.order === 'ASC' ? 'true' : 'false') : column;
      order.push(`${key} ${term.order} NULLS ${term.order === 'ASC' ? 'FIRST' : 'LAST'}`);
    }
  } else for (const term of plan.sort) {
    const expression = path(term.path, 'sort');
    const key = expression.sql;
    if (expression.sortKey) { order.push(`${expression.sortKey(term.order)} ${term.order} NULLS ${term.order === 'ASC' ? 'FIRST' : 'LAST'}`); continue; }
    order.push(`${key} ${term.order} NULLS ${term.order === 'ASC' ? 'FIRST' : 'LAST'}`);
  }
  let text = `SELECT ${select} FROM ${qualified(database.schema, root.name)} t0 ${[...joins.values()].map((item) => item.sql).join(' ')} WHERE ${condition}${group}`;
  if (plan.mode === 'aggregate') text = `SELECT * FROM (${text}) aggregated`;
  if (order.length) text += ` ORDER BY ${order.join(', ')}`;
  if (plan.pagination) text += ` LIMIT ${bind(plan.pagination.limit, 'bigint')} OFFSET ${bind(plan.pagination.offset, 'bigint')}`;
  return { text, values, ...(plan.mode === 'aggregate' ? { aggregateFields: [resolveModelPath(models, plan.entity, plan.aggregation.groupId).at(-1), ...plan.aggregation.facts.map((fact) => resolveModelPath(models, plan.entity, fact.path).at(-1))] } : {}) };
};
