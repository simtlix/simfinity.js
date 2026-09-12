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
  const path = (parts, usage = 'filter') => {
    const steps = resolveModelPath(models, plan.entity, parts);
    let context = { table: root, alias: 't0', json: null, vector: null };
    for (let index = 0; index < steps.length; index++) {
      const field = steps[index];
      const key = parts.slice(0, index + 1).join('.');
      const last = index === steps.length - 1;
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
            const source = `LATERAL (SELECT ${stored}.* FROM ${qualified(database.schema, owned.name)} ${stored} WHERE ${condition} UNION ALL SELECT ${nullRow} WHERE ${col(ownerAlias, owned.ownership.stateColumn)} IS DISTINCT FROM 'present') ${name}`;
            const vector = context.vector
              ? { from: `${context.vector.from} CROSS JOIN ${source}`, where: context.vector.where }
              : { from: source, where: 'TRUE' };
            context = { table: owned, alias: name, json: null, vector };
          }
        } else {
          const json = context.json ? `(${context.json} -> ${literal(field.storageName)})` : col(context.alias, field.storageName);
          if (field.list) {
            const name = alias();
            const source = `${jsonItems(json, '[{}]')} ${name}(value)`;
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
            if (context.vector) unsupported('Queries over scalar lists inside embedded lists are not supported yet');
            const json = `(${context.json} -> ${literal(field.storageName)})`;
            expression = `CASE WHEN ${json} IS NULL OR ${json} = 'null'::jsonb THEN NULL ELSE ARRAY(SELECT (value #>> '{}')::${type} FROM ${jsonItems(json)} j(value)) END`;
          } else expression = `(${context.json} ->> ${literal(field.storageName)})::${type}`;
        } else expression = col(context.alias, identity ? 'id' : field.storageName);
        if (context.vector && field.list) unsupported('Queries over scalar lists inside embedded lists are not supported yet');
        let sql = context.vector ? arrayFrom(context.vector, expression) : expression;
        if (type === 'text') sql = `(${sql}) COLLATE "pg_catalog"."C"`;
        return { sql, field: identity ? { ...field, scalar: 'ID' } : field, type, list: field.list || !!context.vector, vector: !!context.vector };
      }
    }
    unsupported('Invalid query path');
  };
  const predicate = (expression, operator, value) => {
    const { sql, field, type, list, vector } = expression;
    const scalarBind = (item) => bind(encodeScalar(field, item), type);
    const equality = (item) => {
      if (Array.isArray(item)) {
        if (!field.list || vector) invalidValue('Array equality requires a scalar-list field');
        return `${sql} IS NOT DISTINCT FROM ${bind(item.map((v) => encodeScalar(field, v)), `${type}[]`)}`;
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
        if (!['String', 'Enum'].includes(field.scalar)) invalidValue('LIKE requires a string field');
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
    const groupPath = path(plan.aggregation.groupId);
    if (groupPath.vector) unsupported('Grouping by a scalar path inside an embedded list is not supported yet');
    select = `${groupPath.sql} AS "groupId"`;
    group = ` GROUP BY ${groupPath.sql}`;
    plan.aggregation.facts.forEach((fact, index) => {
      const expression = path(fact.path);
      let operation;
      if (fact.operation === 'COUNT') operation = 'count(*)';
      else if (expression.list) unsupported('Array-valued aggregation facts are not supported yet');
      else if (['SUM', 'AVG'].includes(fact.operation) && !['Int', 'Float'].includes(expression.field.scalar)) operation = fact.operation === 'SUM' ? '0' : 'NULL';
      else if (['MIN', 'MAX'].includes(fact.operation) && expression.type === 'boolean') operation = `${fact.operation === 'MIN' ? 'bool_and' : 'bool_or'}(${expression.sql})`;
      else if (['MIN', 'MAX'].includes(fact.operation) && expression.type === 'uuid') operation = `${fact.operation}(${expression.sql}::text COLLATE "pg_catalog"."C")::uuid`;
      else operation = `${fact.operation}(${expression.sql})`;
      if (fact.operation === 'SUM') operation = `COALESCE(${operation}, 0)`;
      select += `, ${operation} AS ${q(`fact_${index}`)}`;
    });
    for (const term of plan.sort.length ? plan.sort : [{ path: ['groupId'], order: 'ASC' }]) {
      const index = plan.aggregation.facts.findIndex((fact) => fact.factName === term.path.join('.'));
      order.push(`${q(index < 0 ? 'groupId' : `fact_${index}`)} ${term.order} NULLS ${term.order === 'ASC' ? 'FIRST' : 'LAST'}`);
    }
  } else for (const term of plan.sort) {
    const expression = path(term.path, 'sort');
    let key = expression.sql;
    if (expression.list) {
      if (!expression.vector) order.push(`CASE WHEN cardinality(${key}) = 0 THEN 0 ELSE 1 END ${term.order}`);
      key = `(SELECT value FROM unnest(${key}) s(value) ORDER BY value ${term.order} NULLS ${term.order === 'ASC' ? 'FIRST' : 'LAST'} LIMIT 1)`;
    }
    order.push(`${key} ${term.order} NULLS ${term.order === 'ASC' ? 'FIRST' : 'LAST'}`);
  }
  let text = `SELECT ${select} FROM ${qualified(database.schema, root.name)} t0 ${[...joins.values()].map((item) => item.sql).join(' ')} WHERE ${condition}${group}`;
  if (order.length) text += ` ORDER BY ${order.join(', ')}`;
  if (plan.pagination) text += ` LIMIT ${bind(plan.pagination.limit, 'bigint')} OFFSET ${bind(plan.pagination.offset, 'bigint')}`;
  return { text, values };
};
