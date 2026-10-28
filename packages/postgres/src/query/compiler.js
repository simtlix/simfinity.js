import { QLQuantifier, resolveModelPath, SimfinityError } from '@simtlix/simfinity-core';
import {
  assertContainsAllPath, crossingKeys, describeEmptiness, describeModelEmptiness, emptinessScopePaths, enterQueryFrame, isEmptinessOperator,
  resolveContainerContext, resolveQueryContext, textQueryOperator,
  validateComparisonTypes, validateContainsAllValue, validateQuantifiedGroups, validateTextFilterValue, validateTextListFilterValue,
} from '@simtlix/simfinity-core/internal/query-operators';
import { identifier as q, literal, qualified } from '../schema/sql.js';
import { encodeScalar, storageTypes, invalidValue } from '../codecs.js';
import { caseFoldExpression as fold } from './case-fold.js';

const unsupported = (message) => { throw new SimfinityError(message, 'UNSUPPORTED_QUERY', 400); };
// A predicate whose `scopes` do not hold what createQueryPlan writes for it, from a client scope marker the runtime
// filled, is never compiled as trusted (#108 part 2b).
const detached = (message) => {
  throw new SimfinityError(`${message}; only createQueryPlan writes the scopes of a predicate, from the client scope markers the runtime fills (docs/guide/middleware.md)`, 'DETACHED_CLIENT_FILTER', 500);
};
// The compiler compiles emptiness through single references and at references and collections (#108 part 2b), which
// the PostgreSQL plugin declares as queryFeatures.referenceEmptiness. Its quantifiers declaration additionally
// enables correlated frames with element-relative conditions.
const REFERENCE_EMPTINESS = true;
const SCOPE_KINDS = ['predicate', 'and', 'or', 'quantified'];
// Entity identities use UUID operands even when GraphQL exposes id as String; embedded ids keep their scalar.
const operandField = (field, identity) => (identity ? { ...field, scalar: 'ID' } : field);

// The case-insensitive text operators compare the case fold of both sides (see case-fold.js), so an application
// index serves them only on that expression, which caseFoldExpression writes.
// LIKE's default escape character is the backslash, so escaping it, % and _ leaves only literal characters.
const likeLiteral = (value) => value.replace(/[\\%_]/g, '\\$&');
const likePatterns = { contains: (value) => `%${likeLiteral(value)}%`, prefix: (value) => `${likeLiteral(value)}%`, suffix: (value) => `%${likeLiteral(value)}` };

// Alias of each per-parent statement in the batched children statement. The per-parent statement only uses t<n>,
// f<n> and short subquery aliases, so it never shadows this one.
const CHILDREN = 'simfinity_children';
// Stands for the parent's parameter in the per-parent statement that compileChildrenQuery repeats once per parent.
// Compiled statements carry no NUL character, which PostgreSQL rejects in statement text: caller values are
// parameters and identifiers and literals come from GraphQL names.
const PARENT = '\u0000';
// Runs before each batched children statement, in its transaction; SET LOCAL ends with that transaction, so the
// connection goes back to the pool with the server's JIT setting.
const CHILDREN_SETUP = 'SET LOCAL jit = off';

/**
 * Compiles validated paths; all caller values are parameters, identifiers come from metadata.
 * `configuration.explicitNullsOrder: true` keeps the NULLS clause on every sort term, as 3.5.9 did.
 */
export const compileQuery = (models, database, plan, extra = null, configuration = null) => compileSelect(models, database, plan, extra, configuration, false);

// A result column for the batched statement that no column of the child table has. Planning rejects storage names
// that start with `__`, and generated root columns end in `_state` or `_present`, so the loop only guards a
// description built by hand.
const freeColumn = (table, name, taken = []) => {
  let column = name;
  while (taken.includes(column) || table.columns.some((item) => item.name === column)) column = `_${column}`;
  return column;
};

/**
 * The find statement of each parent in `extra.ids`, in one statement: a UNION ALL with one branch per ID, in
 * order. Each branch is the statement compileQuery returns for `{ column, id }`, with the same filters, joins,
 * ORDER BY, LIMIT and OFFSET, and with that ID as a parameter of its own, so PostgreSQL plans every branch for its
 * own parent, with the statistics of that value, as it plans the per-parent statement. The other parameters, such
 * as filter values and the page, are shared by every branch. Each branch tags its rows with the 1-based position of
 * its parent ID, in `parentColumn`, and with their row number in the order its statement returns them: the
 * statement always has a LIMIT, so PostgreSQL keeps it a subquery and never merges it into the branch. The outer
 * ORDER BY on both returns each parent's rows together, in position order, and in its statement's order, which a
 * Parallel Append would not keep.
 * Values are the per-parent statement's values without the parent ID, then one uuid per parent ID.
 * Its `setup` turns JIT compilation off for the transaction the SQL adapter runs it in: the plan of up to 100
 * branches costs about as much as the per-parent plans together, so it can cross jit_above_cost when none of them
 * does, and JIT then compiles every branch's expressions, which can take longer than running the statement.
 */
export const compileChildrenQuery = (models, database, plan, extra, configuration = null) => {
  if (plan?.mode !== 'find' || !plan.pagination) unsupported('Only paginated find queries read children in batches');
  if (!Array.isArray(extra?.ids) || !extra.ids.length) unsupported('Batched children reads require parent IDs');
  const { text, values } = compileSelect(models, database, plan, { column: extra.column, id: null }, configuration, true);
  const [before, after, ...rest] = text.split(PARENT);
  if (after === undefined || rest.length) unsupported('Invalid batched children statement');
  const root = database.tables.find((item) => item.name === plan.entity);
  const parentColumn = freeColumn(root, '__simfinity_parent');
  const ordinalColumn = freeColumn(root, '__simfinity_ordinal', [parentColumn]);
  const branches = extra.ids.map((id, index) => `SELECT ${index + 1}::integer AS ${q(parentColumn)}, row_number() OVER () AS ${q(ordinalColumn)}, ${CHILDREN}.* FROM (${before}$${values.length + index + 1}::uuid${after}) ${CHILDREN}`);
  return { text: `${branches.join(' UNION ALL ')} ORDER BY ${q(parentColumn)}, ${q(ordinalColumn)}`, values: [...values, ...extra.ids], parentColumn, setup: [{ text: CHILDREN_SETUP, values: [] }] };
};
// The compileQuery whose per-parent statements compileChildrenQuery reproduces. bindPlugin binds the children
// compiler only for a plugin whose compileQuery is this one, so a plugin copy that overrides compileQuery reads
// each parent with its own compileQuery.
Object.defineProperty(compileChildrenQuery, 'compileQuery', { value: compileQuery });

/**
 * A text that identifies a scope predicate by its value, so that the client constructs of one statement whose chains
 * carry equal scopes share their scoped joins (#108 part 2b). Plain objects, arrays, strings, numbers, booleans,
 * bigints and dates compare by value; anything else, such as a class instance, identifies only itself, through
 * `identities`, and is never shared.
 */
const scopeIdentity = (value, identities) => {
  if (value === null || value === undefined) return 'null';
  if (typeof value === 'string') return JSON.stringify(value);
  if (['number', 'boolean', 'bigint'].includes(typeof value)) return `${typeof value}:${String(value)}`;
  if (value instanceof Date) return `date:${value.getTime()}`;
  if (Array.isArray(value)) return `[${value.map((item) => scopeIdentity(item, identities)).join(',')}]`;
  const prototype = typeof value === 'object' ? Object.getPrototypeOf(value) : undefined;
  if (prototype === Object.prototype || prototype === null) {
    const members = Object.keys(value).sort().filter((key) => value[key] !== undefined);
    return `{${members.map((key) => `${JSON.stringify(key)}:${scopeIdentity(value[key], identities)}`).join(',')}}`;
  }
  if (!identities.has(value)) identities.set(value, identities.size);
  return `#${identities.get(value)}`;
};

const compileSelect = (models, database, plan, extra, configuration, batched) => {
  const explicitNullsOrder = configuration?.explicitNullsOrder === true;
  const values = [];
  let serial = 0;
  const alias = () => `t${++serial}`;
  const tableByName = (name) => database.tables.find((item) => item.name === name);
  const root = tableByName(plan.entity);
  if (!root) unsupported(`Unknown persistent entity ${plan.entity}`);
  // Paths resolve, and their joins are kept, in a frame: the row of an entity and the joins its paths need. The
  // statement's own frame is its root row, t0. Each subquery of reference and collection emptiness (#108 part 2b)
  // reads a frame of its own, whose joins go into the subquery's FROM. Aliases and parameters stay numbered across
  // the whole statement, so no alias shadows another one that an inner subquery reads.
  const rootFrame = { entity: plan.entity, table: root, alias: 't0', joins: new Map() };
  const logical = (frame) => frame.logical ?? { models, entity: frame.entity };
  const stepsOf = (frame, parts) => frame.logical ? resolveQueryContext(parts, frame.logical).raw : resolveModelPath(models, frame.entity, parts);
  const contextOf = (frame) => frame.context ?? { table: frame.table, alias: frame.alias, json: null, vector: null };
  const identities = new Map();
  const bind = (value, type) => { values.push(value); return `$${values.length}::${type}`; };
  const col = (name, field) => `${name}.${q(field)}`;
  const join = (frame, key, table, condition) => {
    const { joins } = frame;
    if (!joins.has(key)) {
      const name = alias();
      joins.set(key, { alias: name, sql: `LEFT JOIN ${qualified(database.schema, table)} ${name} ON ${condition(name)}` });
    }
    return joins.get(key).alias;
  };
  const joinsOf = (frame) => [...frame.joins.values()].map((item) => item.sql).join(' ');
  // One correlated truth value, even when its joins produce several witnesses for the containing row.
  // The constant FROM row lets every join retain its original correlation to frame.alias outside this SELECT.
  const witness = (frame, condition) => {
    const joins = joinsOf(frame);
    return `EXISTS (SELECT 1 FROM (SELECT 1) simfinity_witness${joins ? ` ${joins}` : ''} WHERE ${condition})`;
  };
  // The owned table that stores `field` of the row `context`, or undefined when the row stores it; values inside
  // jsonb never own tables.
  const ownedOf = (context, field) => context.table && database.tables.find((item) => item.ownership?.ownerTable === context.table.name && item.ownership.field === field.name);
  // The LEFT JOIN of an owned single object, one per path, which filters and the emptiness forms share. A missed
  // join, and an object in another state, read as NULL.
  const joinOwned = (frame, key, context, owned) => join(frame, key, owned.name, (name) => `${col(name, '__owner_id')} = ${col(context.alias, context.table.primaryKey.columns[0])} AND ${col(context.alias, owned.ownership.stateColumn)} = 'present'`);
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
  const sortPath = (parts, frame = rootFrame) => {
    const steps = stepsOf(frame, parts);
    const index = steps.findIndex((field) => field.kind === 'collection');
    if (index >= 0) throw new SimfinityError(`Sort path ${parts.join('.')} crosses the collection ${index ? steps[index - 1].target : frame.entity}.${steps[index].name}; a record has no single value there`, 'INVALID_FILTER_PATH', 400);
    return steps;
  };
  const path = (parts, usage = 'filter', frame = rootFrame, joins = null, bound = null) => {
    const steps = usage === 'sort' ? sortPath(parts, frame) : stepsOf(frame, parts);
    let context = bound ? bound.context : joins && usage !== 'cross' ? cross(frame, parts.slice(0, -1), joins) : contextOf(frame);
    const chain = bound?.chain ?? [];
    let scoped = chain.some((scope) => scope !== null);
    const chainKey = (key) => `scoped ${key} ${scopeIdentity(chain, identities)}`;
    for (let index = bound ? bound.index : joins && usage !== 'cross' ? steps.length - 1 : 0; index < steps.length; index++) {
      const field = steps[index];
      const key = parts.slice(0, index + 1).join('.');
      const last = usage !== 'cross' && index === steps.length - 1;
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
            context = { table: owned, alias: joinOwned(frame, scoped ? chainKey(key) : key, context, owned), json: null, vector: null };
          } else {
            const name = alias();
            const stored = alias();
            // Missing/null lists contribute a missing path, empty lists and null items do not.
            const condition = `${col(stored, '__owner_id')} = ${ownerId} AND ${state}${presence(stored)}`;
            // UNION ALL pairs columns by position, and stored.* would follow the physical column order,
            // which a migration that appends columns changes. Both branches list the description's columns.
            const storedRow = owned.columns.map((column) => col(stored, column.name)).join(', ');
            const nullRow = owned.columns.map((column) => `NULL::${column.type} AS ${q(column.name)}`).join(', ');
            const noItems = usage === 'sort' ? ` OR NOT EXISTS (SELECT 1 FROM ${qualified(database.schema, owned.name)} empty_child WHERE empty_child.__owner_id = ${ownerId})` : '';
            const source = `LATERAL (SELECT ${storedRow} FROM ${qualified(database.schema, owned.name)} ${stored} WHERE ${condition} UNION ALL SELECT ${nullRow} WHERE ${col(ownerAlias, owned.ownership.stateColumn)} IS DISTINCT FROM 'present'${noItems}) ${name}`;
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
        const scope = field.kind === 'reference' ? scopeAt(joins, key) : null;
        if (field.kind === 'reference') chain.push(scope);
        scoped ||= scope !== null;
        if (source.vector && scope !== null) throw new SimfinityError('A reference inside an embedded list cannot apply a target scope', 'FORBIDDEN_FILTER_PATH', 403);
        if (source.vector) frame.multiplying = true;
        const correlation = (name) => {
          if (field.kind === 'collection') return `${col(name, field.connectionField)} = ${col(source.alias, source.table.primaryKey.columns[0])}`;
          const reference = col(source.alias, field.storageName);
          return source.vector
            ? `${col(name, 'id')} = ANY (${arrayFrom(source.vector, reference)})`
            : `${col(name, 'id')} = ${reference}`;
        };
        // A vector with an empty target scope keeps every referenced row. Its restricted base and
        // chain-isolated key still prevent sharing with trusted joins; LIMIT 1 would lose targets.
        const joined = scoped && !source.vector
          ? scopedJoin(frame, chainKey(key), field, context, scope, correlation)
          : join(frame, scoped ? chainKey(key) : key, field.target, correlation);
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
        // `uncollated` is the value before the C collation, which the case-insensitive text operators replace.
        const uncollated = context.vector ? arrayFrom(context.vector, expression) : expression;
        const sql = type === 'text' ? `(${uncollated}) COLLATE "pg_catalog"."C"` : uncollated;
        // A NOT NULL column of the root row has no nulls to place, so its sort needs no NULLS clause and a
        // default-order btree (the primary key or a declared index) can return it in order. Joined and
        // embedded paths can be NULL even for NOT NULL columns, so they keep the clause.
        const notNull = !context.json && !context.vector && !field.list && context.alias === frame.alias
          && context.table.columns.find((item) => item.name === (identity ? 'id' : field.storageName))?.nullable === false;
        return { sql, uncollated, field: operandField(field, identity), type: dateNumeric ? 'double precision' : type, list: field.list || !!context.vector, vector: !!context.vector, dateNumeric, sortKey, notNull };
      }
    }
    if (usage === 'cross') return context;
    unsupported('Invalid query path');
  };
  /**
   * WHERE rejects NULL and FALSE alike, so positive scalar filters use bare, index-friendly operators.
   * Anything under a NOT (NE, NIN or a negated group) keeps the null-safe forms that never yield NULL.
   */
  const predicate = (expression, operator, value, negated = false) => {
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
    const encodeValue = (item) => { const value = encodeFilter(item); return expression.dateNumeric && value ? value.getTime() : value; };
    const scalarBind = (item) => bind(encodeValue(item), type);
    const equality = (item, nullSafe = negated) => {
      if (Array.isArray(item)) {
        if (!field.list || vector) invalidValue('Array equality requires a scalar-list field');
        return `${sql} IS NOT DISTINCT FROM ${bind(item.map(encodeFilter), `${type}[]`)}`;
      }
      if (list) {
        const contains = `array_position(${sql}, ${scalarBind(item)}) IS NOT NULL`;
        return item == null ? `(${sql} IS NULL OR ${contains})` : contains;
      }
      if (item == null) return `${sql} IS NULL`;
      return `${sql} ${nullSafe ? 'IS NOT DISTINCT FROM' : '='} ${scalarBind(item)}`;
    };
    if (operator === 'EQ') return equality(value);
    if (operator === 'NE') {
      if (!list && !Array.isArray(value)) return value == null ? `${sql} IS NOT NULL` : `${sql} IS DISTINCT FROM ${scalarBind(value)}`;
      return `NOT (${equality(value, true)})`;
    }
    if (operator === 'IN' || operator === 'NIN') {
      if (!value.length) return operator === 'IN' ? 'FALSE' : 'TRUE';
      let expressionSQL;
      if (list) expressionSQL = `(${value.map((item) => equality(item)).join(' OR ')})`;
      else {
        // For scalar columns, one array parameter keeps large lists within the 65,535 bind limit.
        const member = `${sql} = ANY (${bind(value.map(encodeValue), `${type}[]`)})`;
        expressionSQL = negated || operator === 'NIN' ? `COALESCE(${member}, FALSE)` : member;
      }
      return operator === 'IN' ? expressionSQL : `NOT ${expressionSQL}`;
    }
    if (operator === 'BTW') return `(${predicate(expression, 'GTE', value[0], negated)} AND ${predicate(expression, 'LTE', value[1], negated)})`;
    if (operator === 'CONTAINS_ALL') {
      validateContainsAllValue(value);
      // One array parameter of the path's element type, cast like IN elements: set containment, as MongoDB's $all. NULL
      // elements of the stored list are ignored, and a NULL list gives NULL, which only the negated form turns into false.
      const contains = `${sql} @> ${bind(value.map(encodeValue), `${type}[]`)}`;
      return negated ? `COALESCE(${contains}, FALSE)` : contains;
    }
    if (operator === 'IIN') {
      validateTextListFilterValue(operator, value, field.scalar);
      if (!value.length) return 'FALSE';
      // The values are folded by the server, once per statement, so that application indexes on the folded column serve it.
      const members = `ANY (ARRAY(SELECT ${fold('w.value')} FROM unnest(${bind(value, 'text[]')}) w(value)))`;
      if (list) return `EXISTS (SELECT 1 FROM unnest(${sql}) v(value) WHERE ${fold('v.value')} = ${members})`;
      const compare = `${fold(expression.uncollated)} = ${members}`;
      return negated ? `COALESCE(${compare}, FALSE)` : compare;
    }
    if (value == null || Array.isArray(value)) invalidValue(`${operator} requires a non-null scalar value`);
    const text = textQueryOperator(operator);
    if (text) return textPredicate(expression, operator, text, value, negated);
    const ordering = { LT: '<', LTE: '<=', GT: '>', GTE: '>=' }[operator];
    if (!ordering && operator !== 'LIKE') unsupported(`Unsupported filter operator ${operator}`);
    const parameter = scalarBind(value);
    const compare = (left) => {
      if (operator === 'LIKE') {
        return `strpos(${left}, ${parameter}) > 0`;
      }
      return `${left} ${ordering} ${parameter}`;
    };
    if (list) return `EXISTS (SELECT 1 FROM unnest(${sql}) v(value) WHERE ${compare('v.value')})`;
    return negated ? `COALESCE(${compare(sql)}, FALSE)` : compare(sql);
  };
  /**
   * The literal text operators (ILIKE, STARTS_WITH, ISTARTS_WITH, ENDS_WITH, IENDS_WITH and IEQ) on a String leaf or
   * list, where some element must match. Values stay bound parameters. The case-sensitive forms, STARTS_WITH and
   * ENDS_WITH, compare code points with starts_with and right under the C collation of text paths, so a column's
   * btree serves STARTS_WITH. The case-insensitive forms compare the case fold of both sides (see case-fold.js): IEQ
   * with =, the others with LIKE and a bound pattern whose metacharacters are escaped, so that a btree on the folded
   * column with text_pattern_ops serves IEQ and ISTARTS_WITH, and a trigram index on it serves ILIKE, ISTARTS_WITH and
   * IENDS_WITH.
   */
  const textPredicate = ({ sql, uncollated, field, list }, operator, { match, ignoreCase }, value, negated) => {
    // createQueryPlan has validated the value; a plan built by hand gets the same INVALID_FILTER_VALUE.
    validateTextFilterValue(operator, value, field.scalar);
    let compare;
    if (!ignoreCase) {
      const parameter = bind(value, 'text');
      compare = match === 'prefix'
        ? (left) => `starts_with(${left}, ${parameter})`
        : (left) => `right(${left}, char_length(${parameter})) = ${parameter}`;
    } else if (match === 'exact') {
      const parameter = bind(value, 'text');
      compare = (left) => `${fold(left)} = ${fold(parameter)}`;
    } else {
      const pattern = bind(likePatterns[match](value), 'text');
      compare = (left) => `${fold(left)} LIKE ${fold(pattern)}`;
    }
    // fold puts its argument in parentheses, so the uncollated value goes in as it is.
    if (list) return `EXISTS (SELECT 1 FROM unnest(${sql}) v(value) WHERE ${compare('v.value')})`;
    const left = ignoreCase ? uncollated : sql;
    return negated ? `COALESCE(${compare(left)}, FALSE)` : compare(left);
  };
  /**
   * A subquery on the entity `entity` in a frame of its own (#108 part 2b), as `{ alias, from }`, `from` being its
   * text from FROM to the end of its WHERE. `correlation(alias)` ties its rows to the enclosing row, and `scope`, a
   * predicate planned on the entity, or null, restricts them. The frame's alias comes first, then the scope's joins
   * and conditions, followed by the optional body, compile before the text is assembled so that FROM holds their
   * joins. A scope is trusted: it reads stored data in its own frame, with plain reference joins and collection frames.
   */
  const subquery = (entity, correlation, scope, body, parent = null) => {
    const table = tableByName(entity);
    if (!table) unsupported(`Unknown persistent entity ${entity}`);
    const frame = { entity, table, alias: alias(), joins: new Map(), parent };
    const restriction = scope ? ` AND ${where(scope, frame)}` : '';
    const condition = body ? ` AND ${body(frame)}` : '';
    const joins = joinsOf(frame);
    return { alias: frame.alias, from: `FROM ${qualified(database.schema, table.name)} ${frame.alias}${joins ? ` ${joins}` : ''} WHERE ${correlation(frame.alias)}${restriction}${condition}` };
  };
  /**
   * The scoped join of a client construct's crossing (#108 part 2b): the record that the reference `field` of the row
   * `context` points to, when `scope` admits it, or NULLs, which is how a hidden record reads as a missing one. LIMIT 1
   * keeps one row whatever joins the scope makes. Its key, apart from those of plain joins, names the path and the
   * scopes of every reference crossed up to this one, so only constructs with the same chain share it.
   */
  const scopedJoin = (frame, key, field, context, scope, correlation = (row) => `${col(row, 'id')} = ${col(context.alias, field.storageName)}`) => {
    if (!frame.joins.has(key)) {
      const name = alias();
      const target = subquery(field.target, correlation, scope);
      frame.joins.set(key, { alias: name, sql: `LEFT JOIN LATERAL (SELECT ${target.alias}.* ${target.from} LIMIT 1) ${name} ON TRUE` });
    }
    return frame.joins.get(key).alias;
  };
  // The scope of `path` in a client construct's scopes, or null for a trusted construct and a scope that added nothing.
  const scopeAt = (scopes, path) => (scopes && Object.hasOwn(scopes, path) ? scopes[path] : null);
  /**
   * The scopes of a client construct (#108 part 2b), checked against its shape: one own key for each scoped join and
   * frame that emptinessScopePaths lists, each a predicate planned on its target, or null. A predicate without
   * `scopes` is trusted. Anything else is not what createQueryPlan writes, and never compiles as trusted.
   */
  const scopesOf = (node, shape, label) => {
    if (!Object.hasOwn(node, 'scopes') || node.scopes === undefined) return null;
    const { scopes } = node;
    if (!scopes || typeof scopes !== 'object' || Array.isArray(scopes)) detached(`${label} has scopes that are not an object`);
    const { joins, frames } = emptinessScopePaths(shape, node.path);
    for (const key of [...joins, ...frames]) {
      if (!Object.hasOwn(scopes, key) || scopes[key] === undefined) detached(`${label} has no scope for ${key}`);
      const scope = scopes[key];
      if (scope !== null && (typeof scope !== 'object' || !SCOPE_KINDS.includes(scope.kind))) detached(`${label} has a scope for ${key} that is neither a query predicate nor null`);
    }
    return scopes;
  };
  // Reuse legacy vector/owned traversal while applying the validated scoped chain in this frame.
  const cross = (frame, parts, joins) => (parts.length
    ? path(parts, 'cross', frame, joins)
    : contextOf(frame));
  /**
   * NONE over a reference or a collection (#108 part 2b), the IS_EMPTY form, or with `empty` false the IS_NOT_EMPTY
   * form, EXISTS: whether a record that `scope` admits is the one the reference `field` of the row `context` points
   * to, or a child whose `shape.connectionField`, the child's storage column, points to that row. Without a scope a
   * reference reads its own column, `IS NULL`, since a foreign key that is validated and not deferred keeps it from
   * dangling; a collection keeps the subquery.
   */
  const frameForm = (context, field, shape, empty, scope) => {
    if (!context.table) unsupported('Unnormalized embedded reference');
    if (shape.rule === 'reference' && !scope) return `${col(context.alias, field.storageName)} IS ${empty ? '' : 'NOT '}NULL`;
    const correlation = shape.rule === 'reference'
      ? (row) => `${col(row, 'id')} = ${col(context.alias, field.storageName)}`
      : (row) => `${col(row, shape.connectionField)} = ${col(context.alias, context.table.primaryKey.columns[0])}`;
    return `${empty ? 'NOT ' : ''}EXISTS (SELECT 1 ${subquery(field.target, correlation, scope).from})`;
  };
  /**
   * The IS_EMPTY form of `field`, stored on the row or jsonb value `context`, by its emptiness shape, or with `empty`
   * false the IS_NOT_EMPTY form: the positive form of a leaf, which a btree can serve, and the NOT of an object or an
   * owned form. Every form is two-valued, and only scopes bind parameters. A leaf is a column of any row, or the text
   * of a jsonb member, never cast, since a cast can fail; a list a native array column, a jsonb list, or an owned
   * list, whose null items are rows too, so `[null]` is not empty; an object a jsonb value or an owned single object
   * whose stored members are all empty; a reference or a collection, members included, a frame (frameForm) with the
   * scope `at.scopes` holds for its path, `at.path`. An owned table is read in a subquery with an alias of its own,
   * correlated to the key of the row that owns it: the root's id, or the `__id` of a joined or enclosing owned row.
   */
  const emptyForm = (context, field, shape, empty = true, at = { path: field.name, scopes: null }) => {
    if (shape.rule === 'reference' || shape.rule === 'collection') return frameForm(context, field, shape, empty, scopeAt(at.scopes, at.path));
    const compare = empty ? '=' : '>';
    const negate = (form) => (empty ? form : `NOT ${form}`);
    const leaf = (value) => {
      if (shape.rule === 'string') return empty ? `(${value} IS NULL OR ${value} = '')` : `(${value} IS NOT NULL AND ${value} <> '')`;
      return `${value} IS ${empty ? '' : 'NOT '}NULL`;
    };
    // The CASE keeps jsonb_array_length from failing (22023) on a value that is not an array.
    const jsonList = (json) => `COALESCE(jsonb_array_length(CASE WHEN jsonb_typeof(${json}) = 'array' THEN ${json} END), 0) ${compare} 0`;
    // An embedded type without stored members is always empty.
    const members = (row) => {
      const forms = shape.members.map((member) => {
        const stored = field.fields?.find((item) => item.name === member.name);
        if (!stored) unsupported('Invalid query path');
        return emptyForm(row, stored, member.shape, true, { path: `${at.path}.${member.name}`, scopes: at.scopes });
      });
      return forms.length ? `(${forms.join(' AND ')})` : 'TRUE';
    };
    const jsonObject = (json) => negate(`(${json} IS NULL OR ${json} = 'null'::jsonb OR ${members({ table: null, alias: null, json })})`);
    if (context.json) {
      const json = `(${context.json} -> ${literal(field.storageName)})`;
      if (shape.rule === 'object') return jsonObject(json);
      if (shape.rule === 'list') return jsonList(json);
      return leaf(`(${context.json} ->> ${literal(field.storageName)})`);
    }
    const owned = ownedOf(context, field);
    if (owned) {
      // A missed join leaves the state NULL, which is not 'present'.
      const state = `${col(context.alias, owned.ownership.stateColumn)} IS DISTINCT FROM 'present'`;
      const name = alias();
      const rows = `SELECT 1 FROM ${qualified(database.schema, owned.name)} ${name} WHERE ${col(name, '__owner_id')} = ${col(context.alias, context.table.primaryKey.columns[0])}`;
      if (shape.rule === 'list') return negate(`(${state} OR NOT EXISTS (${rows}))`);
      // An object marked present without a row, which the owned-shape check rejects, is empty too.
      return negate(`(${state} OR NOT EXISTS (${rows} AND NOT ${members({ table: owned, alias: name, json: null })}))`);
    }
    // The record identity is the uuid primary key, whatever scalar it is declared with.
    const identity = !context.table.ownership && ['id', '_id'].includes(field.name);
    const column = col(context.alias, identity ? 'id' : field.storageName);
    if (field.kind === 'embedded') return shape.rule === 'object' ? jsonObject(column) : jsonList(column);
    if (shape.rule === 'list') return `COALESCE(cardinality(${column}), 0) ${compare} 0`;
    return leaf(column);
  };
  /**
   * IS_EMPTY and IS_NOT_EMPTY (#108, parts 2a and 2b), on the row of `frame`. Every emptiness predicate, leaves
   * included, compiles here from where its path is stored, not from path(), whose values cast jsonb members and
   * materialize jsonb lists, and which rejects paths that end at an embedded field. The checks of createQueryPlan run
   * again, with its codes, on the entity's GraphQL type or on the field descriptions, so a plan built by hand gets the
   * same answers; they leave only single embedded objects and single references before the last field. An owned
   * single object is reached through its LEFT JOIN. A reference is crossed through the plain LEFT JOIN that legacy
   * paths share, for a trusted predicate, which reads stored data; a client construct, whose `scopes` the plan lifted
   * from the marker the runtime filled, crosses it through a scoped join instead from its first crossing whose scope
   * is not null on, so that every later hop, a null scope included, correlates through that scoped join and never
   * shares a join with a trusted or legacy path. Its ends and members are frames with their own scopes.
   */
  const emptiness = (node, frame) => {
    const { path: parts, operator, value } = node;
    const steps = stepsOf(frame, parts);
    const label = parts.join('.');
    const options = { operator, value, path: label, referenceEmptiness: REFERENCE_EMPTINESS };
    const gqltype = !frame.element && models.entities.find((item) => item.name === frame.entity)?.gqltype;
    const shape = gqltype ? describeEmptiness(gqltype, parts, options) : describeModelEmptiness(steps, options);
    const scopes = scopesOf(node, shape, `${operator} on ${label}`);
    const context = cross(frame, parts.slice(0, -1), scopes);
    return emptyForm(context, steps.at(-1), shape, operator === 'IS_EMPTY', { path: label, scopes });
  };
  const queryScope = (scope) => scope === null || (scope && typeof scope === 'object' && !Array.isArray(scope) && SCOPE_KINDS.includes(scope.kind));
  const inspectJoins = (node, frame, paths = [node.path]) => {
    if (!Object.hasOwn(node, 'joins')) return { joins: null };
    if (node.anchor) return { reason: 'A quantified anchor has joins' };
    const { joins } = node;
    if (!joins || typeof joins !== 'object' || Array.isArray(joins) || ![Object.prototype, null].includes(Object.getPrototypeOf(joins))) return { reason: 'A predicate has joins that are not a plain object' };
    for (const key of new Set(paths.flatMap((parts) => crossingKeys(parts, logical(frame))))) {
      if (!Object.hasOwn(joins, key) || !queryScope(joins[key])) return { reason: `A predicate has no valid join scope for ${key}` };
    }
    return { joins };
  };
  const joinsOfNode = (node, frame) => {
    const result = inspectJoins(node, frame);
    if (result.reason) detached(result.reason);
    return result.joins;
  };
  // Visibility of references already crossed by aggregate J aliases. Only references get scoped
  // joins; collection rows stay attached to their original legacy aliases and their cardinality.
  const visibilityGuards = (frame, parts, scopes) => crossingKeys(parts, logical(frame))
    .filter((key) => scopeAt(scopes, key) !== null).map((key) => {
      const parts = key.split('.');
      const reference = stepsOf(frame, parts).at(-1);
      const source = cross(frame, parts.slice(0, -1), null);
      const name = scopedJoin(frame, `anchor ${key} ${scopeIdentity(scopes, identities)}`, reference, source, scopes[key]);
      return `${col(name, 'id')} IS NOT NULL`;
    });
  const hasComparison = (node) => Boolean(node && (Object.hasOwn(node, 'operand') || hasComparison(node.where) || node.terms?.some(hasComparison)));
  const quantified = (node, frame) => {
    const parts = node.path;
    if (node.anchor && Object.hasOwn(node, 'joins') && !hasComparison(node.where)) detached('A quantified anchor has joins without a field comparison');
    // Resolve before crossing so malformed client metadata cannot fall back to trusted joins.
    const targetContext = node.anchor ? resolveQueryContext(node.anchor, logical(frame)).end : logical(frame);
    const steps = resolveQueryContext(parts, targetContext).raw;
    const field = steps.at(-1);
    const element = field?.kind === 'embedded' && field.list;
    if (!field || field.inferred || !element && (!['reference', 'collection'].includes(field.kind) || field.list && field.kind !== 'collection')) {
      throw new SimfinityError('A quantified path must end at a reference, collection or embedded object list', 'INVALID_FILTER_PATH', 400);
    }
    if (!QLQuantifier.getValue(node.quantifier)) throw new SimfinityError('Unknown quantifier', 'INVALID_FILTER_VALUE', 400);
    if (node.anchor && parts.length !== 1) detached('An anchored quantified path must name the collection or reference alone');
    const joins = joinsOfNode(node.anchor ? { ...node, anchor: null, path: [...node.anchor, ...parts] } : node, frame);
    if (Object.hasOwn(node, 'scope') && !queryScope(node.scope)) detached('A quantified predicate has an invalid scope');
    if (node.quantifier === 'ALL' && node.where === null) return 'TRUE';
    // An implicit vector prefix belongs to this predicate, never the containing record's outer row stream.
    // Anchors deliberately retain the legacy joins/multiplicity of aggregate groupId and facts.
    const isolatedPrefix = !node.anchor && steps.slice(0, -1).some((step) => step.list);
    const prefix = isolatedPrefix ? { ...frame, joins: new Map(), multiplying: false } : frame;
    const context = node.anchor ? cross(frame, node.anchor, null) : cross(prefix, parts.slice(0, -1), joins);
    if (!element && !context.table) unsupported('Unnormalized embedded reference');
    const correlation = field.kind === 'reference'
      ? (row) => `${col(row, 'id')} = ${col(context.alias, field.storageName)}`
      : (row) => `${col(row, field.connectionField)} = ${col(context.alias, context.table.primaryKey.columns[0])}`;
    const childLogical = enterQueryFrame(logical(frame), [...(node.anchor ?? []), ...parts]);
    const body = node.where === null ? undefined : (child) => {
      child.logical = childLogical;
      child.parentJoins = joins;
      // A scope admits the child independently of the body's vector witness. Otherwise retain shared
      // nonmultiplying joins and their aliases; complete compounds within each body still share one map.
      const scopedVector = child.multiplying === true;
      const positiveFrame = { ...child, joins: new Map(scopedVector ? [] : child.joins), multiplying: false, aggregateAnchor: node.anchor };
      const positive = where(node.where, positiveFrame, node.quantifier === 'ALL');
      if (scopedVector || (node.quantifier === 'ALL' && positiveFrame.multiplying)) {
        const complete = witness(positiveFrame, positive);
        return node.quantifier === 'ALL' ? `NOT ${complete}` : complete;
      }
      child.joins = positiveFrame.joins;
      return node.quantifier === 'ALL' ? `NOT ${positive}` : positive;
    };
    let candidate;
    if (element) {
      if (node.scope != null) detached('An embedded element cannot have an entity scope');
      const name = alias();
      const owned = ownedOf(context, field);
      const json = context.json ? `(${context.json} -> ${literal(field.storageName)})` : col(context.alias, field.storageName);
      const source = owned ? `${qualified(database.schema, owned.name)} ${name}` : `${jsonItems(json)} ${name}(value)`;
      const present = owned
        ? `${col(name, '__owner_id')} = ${col(context.alias, context.table.primaryKey.columns[0])} AND ${col(context.alias, owned.ownership.stateColumn)} = 'present'${owned.ownership.nullableItems ? ` AND ${col(name, '__item_present')}` : ''}`
        : `jsonb_typeof(${name}.value) = 'object'`;
      const child = { entity: frame.entity, table: owned ?? null, alias: name, joins: new Map(), parent: frame, element: true,
        logical: childLogical, parentJoins: joins, context: { table: owned ?? null, alias: name, json: owned ? null : `${name}.value`, vector: null } };
      const condition = body ? ` AND ${body(child)}` : '';
      const childJoins = joinsOf(child);
      const from = context.vector ? `${context.vector.from} CROSS JOIN LATERAL ${source}` : source;
      candidate = `EXISTS (SELECT 1 FROM ${from}${childJoins ? ` ${childJoins}` : ''} WHERE ${present}${context.vector ? ` AND ${context.vector.where}` : ''}${condition})`;
    } else candidate = `EXISTS (SELECT 1 ${subquery(field.target, correlation, node.scope, body, frame).from})`;
    const result = `(${node.quantifier === 'ANY' ? '' : 'NOT '}${isolatedPrefix ? witness(prefix, candidate) : candidate})`;
    if (!node.anchor || !joins) return result;
    // An aggregate's J aliases still own cardinality. Scoped references before its anchor only guard
    // that joined row's visibility; following their scoped aliases through J would add fresh witnesses.
    const keys = crossingKeys([...node.anchor, ...parts], logical(frame));
    if (Object.keys(joins).some((key) => !keys.includes(key))) detached('A quantified anchor has an unrelated join scope');
    const guards = visibilityGuards(frame, [...node.anchor, ...parts], joins);
    return guards.length ? `(${guards.join(' AND ')} AND ${result})` : result;
  };
  // Field operands are validated independently of literal predicates, including plans built by hand. A
  // collection may occur here only on an aggregate's already joined row chain; other collection reads are
  // explicit quantified frames. Embedded lists must already be bound to element frames.
  const comparisonPath = (parts, frame, right = false, leftCollections = null) => {
    if (!Array.isArray(parts)) throw new SimfinityError('A comparison operand requires a path array', 'INVALID_FILTER_PATH', 400);
    const steps = stepsOf(frame, parts);
    const leaf = steps.at(-1);
    if (leaf.kind !== 'scalar' && !leaf.inferred || right && leaf.list) {
      throw new SimfinityError(`Comparison path ${parts.join('.')} must end at a scalar${right ? ' right operand' : ' field'}`, 'INVALID_FILTER_PATH', 400);
    }
    const collections = [];
    for (let index = 0; index < steps.length; index++) {
      const field = steps[index];
      const prefix = parts.slice(0, index + 1).join('.');
      if (field.kind === 'embedded' && field.list) unsupported(`Field comparison across embedded list ${prefix} requires an element frame`);
      if (field.kind === 'collection') {
        const joined = frame === rootFrame && plan.mode === 'aggregate' && [plan.aggregation?.groupId, ...(plan.aggregation?.facts ?? []).map((fact) => fact.path)]
          .some((path) => Array.isArray(path) && parts.slice(0, index + 1).every((part, offset) => part === path[offset]));
        if (!joined || right && !leftCollections?.includes(prefix)) throw new SimfinityError(`Comparison path ${parts.join('.')} crosses an unbound collection; use an explicit group`, 'INVALID_FILTER_PATH', 400);
        collections.push(prefix);
      }
    }
    const identity = ['id', '_id'].includes(leaf.name) && (steps.length === 1 ? !frame.element && !frame.table?.ownership : steps.at(-2).kind !== 'embedded');
    return { field: { ...leaf, identity }, collections };
  };
  const comparisonRead = (parts, frame, joins) => {
    const steps = stepsOf(frame, parts);
    const index = steps.findLastIndex((field) => field.kind === 'collection');
    if (index < 0) return path(parts, 'filter', frame, joins);
    const anchor = parts.slice(0, index + 1);
    const context = cross(frame, anchor, null);
    const guards = visibilityGuards(frame, anchor, joins);
    const chain = crossingKeys(anchor, logical(frame)).map((key) => scopeAt(joins, key));
    const expression = path(parts, 'filter', frame, joins, { context, index: index + 1, chain });
    return guards.length ? { ...expression, sql: `CASE WHEN ${guards.join(' AND ')} THEN ${expression.sql} END` } : expression;
  };
  const comparison = (node, frame) => {
    const operand = node.operand;
    const operator = node.operator ?? 'EQ';
    if (!operand || typeof operand !== 'object' || Array.isArray(operand) || ![Object.prototype, null].includes(Object.getPrototypeOf(operand))
      || !Number.isSafeInteger(operand.up) || operand.up < 0 || Object.keys(operand).some((key) => !['up', 'path', 'joins', 'container'].includes(key))) {
      throw new SimfinityError('A comparison operand requires a nonnegative integer up and a path', 'INVALID_FILTER_VALUE', 400);
    }
    if (node.value !== null) invalidValue('A field-comparison predicate requires a null value placeholder');
    if (!Array.isArray(operand.path)) throw new SimfinityError('A comparison operand requires a path array', 'INVALID_FILTER_PATH', 400);
    const container = operand.container;
    const containerContext = container === undefined ? null : resolveContainerContext(container, logical(frame));
    if (container && operand.up !== 0) throw new SimfinityError('A structural operand must have up zero', 'INVALID_FILTER_PATH', 400);
    const up = container?.up ?? operand.up;
    const rightPath = [...(container?.path ?? []), ...operand.path];
    let origin = frame;
    let entering = frame;
    const anchors = [];
    for (let index = 0; index < up; index++) {
      entering = origin;
      if (origin.aggregateAnchor) anchors.push({ frame: origin.parent, path: origin.aggregateAnchor });
      origin = origin.parent;
      if (!origin) throw new SimfinityError('A comparison operand names an unavailable ancestor frame', 'INVALID_FILTER_PATH', 400);
    }
    const left = comparisonPath(node.path, frame);
    const anchoredCollections = anchors.filter((anchor) => anchor.frame === origin).flatMap((anchor) => stepsOf(origin, anchor.path)
      .flatMap((field, index) => field.kind === 'collection' ? [anchor.path.slice(0, index + 1).join('.')] : []));
    const right = comparisonPath(rightPath, origin, true, origin === frame ? left.collections : anchoredCollections);
    validateComparisonTypes(left.field, right.field, operator, node.path.join('.'), operand.path.join('.'));
    if (Object.hasOwn(node, 'scopes')) detached('A field comparison has scopes instead of joins');
    const sharedJoins = up === 0 && !container;
    if (sharedJoins && Object.hasOwn(operand, 'joins')) detached('A same-frame field operand must share its predicate joins');
    const leftJoins = inspectJoins(node, frame, sharedJoins ? [node.path, operand.path] : [node.path]);
    if (leftJoins.reason) detached(leftJoins.reason);
    const rightOwner = container ? { ...origin, logical: containerContext } : origin;
    const rightJoins = sharedJoins ? leftJoins : inspectJoins(operand, rightOwner);
    if (rightJoins.reason) detached(rightJoins.reason);
    for (const [checked, paths, owner] of [[leftJoins, sharedJoins ? [node.path, operand.path] : [node.path], frame], ...(sharedJoins ? [] : [[rightJoins, [operand.path], rightOwner]])]) {
      const expected = new Set(paths.flatMap((parts) => crossingKeys(parts, logical(owner))));
      if (checked.joins && Object.keys(checked.joins).some((key) => !expected.has(key))) detached('A field comparison has an unrelated join scope');
    }
    const a = comparisonRead(node.path, frame, leftJoins.joins);
    let scopes = rightJoins.joins;
    if (container) {
      const prefix = container.path.join('.');
      const inherited = Object.entries(entering.parentJoins ?? {}).filter(([key]) => key === prefix || prefix.startsWith(`${key}.`));
      scopes = scopes || inherited.length ? {
        ...Object.fromEntries(inherited),
        ...Object.fromEntries(Object.entries(scopes ?? {}).map(([key, value]) => [[prefix, key].filter(Boolean).join('.'), value])),
      } : null;
    }
    const b = comparisonRead(rightPath, origin, scopes);
    // Native dates and jsonb dates use the same epoch-millisecond unit. Literals retain their existing
    // timestamp bindings and SQL unchanged; only comparisons normalize the two physical representations.
    const normalize = (expression) => {
      if (expression.field.scalar !== 'DateTime' || expression.dateNumeric) return expression.sql;
      if (expression.list) return `CASE WHEN ${expression.sql} IS NULL THEN NULL ELSE ARRAY(SELECT extract(epoch FROM value) * 1000 FROM unnest(${expression.sql}) d(value)) END`;
      return `(extract(epoch FROM ${expression.sql}) * 1000)`;
    };
    const leftSQL = normalize(a);
    const rightSQL = normalize(b);
    if (operator === 'EQ' || operator === 'NE') {
      const equality = a.list
        ? `((${rightSQL} IS NULL AND ${leftSQL} IS NULL) OR array_position(${leftSQL}, ${rightSQL}) IS NOT NULL)`
        : `${leftSQL} IS NOT DISTINCT FROM ${rightSQL}`;
      return `(${operator === 'NE' ? a.list ? `NOT (${equality})` : `${leftSQL} IS DISTINCT FROM ${rightSQL}` : equality})`;
    }
    const ordering = { LT: '<', LTE: '<=', GT: '>', GTE: '>=' }[operator];
    let condition;
    if (ordering) condition = `${leftSQL} ${ordering} ${rightSQL}`;
    else if (operator === 'LIKE') condition = `strpos(${leftSQL}, ${rightSQL}) > 0`;
    else if (operator === 'STARTS_WITH') condition = `starts_with(${leftSQL}, ${rightSQL})`;
    else condition = `right(${leftSQL}, char_length(${rightSQL})) = ${rightSQL}`;
    return `(COALESCE(${condition}, FALSE))`;
  };
  // A negation reaches every predicate below it, including those nested in AND/OR groups; the emptiness forms are
  // two-valued, so they need no null-safe form under it. A frame's scope is never negated.
  const where = (node, frame = rootFrame, negated = false) => {
    if (!node) return 'TRUE';
    if (node.kind === 'quantified') return quantified(node, frame);
    if (node.kind === 'predicate' && Object.hasOwn(node, 'operand')) return comparison(node, frame);
    if (node.kind === 'predicate' && isEmptinessOperator(node.operator)) return `(${emptiness(node, frame)})`;
    // CONTAINS_ALL's path and leaf rules (#108 part 4), with core's codes, before any join or alias, so that a plan built
    // by hand never compiles to the legacy collection join or the multiplying vector join, or raises 42883.
    if (node.kind === 'predicate' && node.operator === 'CONTAINS_ALL') assertContainsAllPath(stepsOf(frame, node.path));
    if (node.kind === 'predicate') {
      // Check ordinary paths and values before the new client metadata, without creating joins or aliases.
      if (Object.hasOwn(node, 'joins')) validateQuantifiedGroups({ AND: [{ conditions: [{ field: node.path.join('.'), operator: node.operator, value: node.value }] }] }, { ...logical(frame), referenceEmptiness: true, quantifiers: true, elementFrames: true });
      const checked = inspectJoins(node, frame);
      if (checked.reason) {
        // Only this already-rejected request needs a non-crossing native-value checkpoint. Accepted
        // requests retain path/scope compilation before encoding, including its bind order and single coercion.
        const steps = stepsOf(frame, node.path);
        const leaf = steps.at(-1);
        const identity = ['id', '_id'].includes(leaf.name) && (steps.length === 1 ? !frame.element && !frame.table?.ownership : steps.at(-2).kind !== 'embedded');
        const field = operandField(leaf, identity);
        // The placeholders are never emitted: detached() follows. They must be non-empty, because textPredicate and the IIN
        // branch fold `uncollated` with caseFoldExpression, which rejects an empty expression (case-fold.js:60).
        predicate({ field, type: storageTypes[field.scalar], list: field.list, sql: 'NULL', uncollated: 'NULL' }, node.operator, node.value, negated);
        detached(checked.reason);
      }
      const sql = predicate(path(node.path, 'filter', frame, checked.joins), node.operator, node.value, negated);
      if (Object.hasOwn(node, 'scopes') && node.scopes !== undefined) detached(`${node.operator} on ${[].concat(node.path).join('.')} has scopes, but is not an emptiness condition`);
      return `(${sql})`;
    }
    return `(${node.terms.map((term) => where(term, frame, negated)).join(node.kind === 'and' ? ' AND ' : ' OR ')})`;
  };
  // Count ignores valid ordering, but still rejects a collection sort without adding joins to its statement.
  if (plan.mode === 'count') for (const term of plan.sort) sortPath(term.path);
  let condition = where(plan.where);
  if (extra) {
    const column = root.columns.find((item) => item.name === extra.column);
    if (!column || column.type !== 'uuid') unsupported('Invalid inverse connection field');
    condition += ` AND ${col('t0', column.name)} = ${batched ? PARENT : bind(extra.id, 'uuid')}`;
  }
  let select = 't0.*';
  // List values that MIN and MAX facts read, each evaluated once per row in a lateral subquery.
  const laterals = new Map();
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
        else {
          // The list value is a correlated subquery that the aggregate reads four times; MIN and MAX of the
          // same path share one evaluation per row. OFFSET 0 keeps the planner from pulling the subquery up
          // and copying the expression back, and a subquery without FROM keeps one row per root row.
          const key = fact.path.join('.');
          if (!laterals.has(key)) laterals.set(key, { alias: `f${laterals.size}`, sql: expression.sql });
          const value = `${laterals.get(key).alias}.value`;
          operation = `(array_agg(${value} ORDER BY ${helper('value_key', value, literal(expression.field.scalar))} ${fact.operation === 'MIN' ? 'ASC' : 'DESC'}) FILTER (WHERE ${value} IS NOT NULL AND ${value} <> 'null'::jsonb))[1]`;
        }
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
    order.push(expression.notNull && !explicitNullsOrder ? `${key} ${term.order}` : `${key} ${term.order} NULLS ${term.order === 'ASC' ? 'FIRST' : 'LAST'}`);
  }
  // Laterals follow every join, so their expressions can read the root row and any joined alias.
  const lateralSQL = [...laterals.values()].map((item) => ` CROSS JOIN LATERAL (SELECT ${item.sql} AS value OFFSET 0) ${item.alias}`).join('');
  let text = `SELECT ${select} FROM ${qualified(database.schema, root.name)} t0 ${joinsOf(rootFrame)}${lateralSQL} WHERE ${condition}${group}`;
  if (plan.mode === 'aggregate') text = `SELECT * FROM (${text}) aggregated`;
  if (order.length) text += ` ORDER BY ${order.join(', ')}`;
  if (plan.pagination) text += ` LIMIT ${bind(plan.pagination.limit, 'bigint')} OFFSET ${bind(plan.pagination.offset, 'bigint')}`;
  return { text, values, ...(plan.mode === 'aggregate' ? { aggregateFields: [resolveModelPath(models, plan.entity, plan.aggregation.groupId).at(-1), ...plan.aggregation.facts.map((fact) => resolveModelPath(models, plan.entity, fact.path).at(-1))] } : {}) };
};
