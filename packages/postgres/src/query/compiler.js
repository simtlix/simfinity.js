import { resolveModelPath, SimfinityError } from '@simtlix/simfinity-core';
import {
  describeEmptiness, describeModelEmptiness, isEmptinessOperator, textQueryOperator, validateTextFilterValue,
} from '@simtlix/simfinity-core/internal/query-operators';
import { identifier as q, literal, qualified } from '../schema/sql.js';
import { encodeScalar, storageTypes, invalidValue } from '../codecs.js';
import { caseFoldExpression as fold } from './case-fold.js';

const unsupported = (message) => { throw new SimfinityError(message, 'UNSUPPORTED_QUERY', 400); };

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

const compileSelect = (models, database, plan, extra, configuration, batched) => {
  const explicitNullsOrder = configuration?.explicitNullsOrder === true;
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
  // The owned table that stores `field` of the row `context`, or undefined when the row stores it; values inside
  // jsonb never own tables.
  const ownedOf = (context, field) => context.table && database.tables.find((item) => item.ownership?.ownerTable === context.table.name && item.ownership.field === field.name);
  // The LEFT JOIN of an owned single object, one per path, which filters and the emptiness forms share. A missed
  // join, and an object in another state, read as NULL.
  const joinOwned = (key, context, owned) => join(key, owned.name, (name) => `${col(name, '__owner_id')} = ${col(context.alias, context.table.primaryKey.columns[0])} AND ${col(context.alias, owned.ownership.stateColumn)} = 'present'`);
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
            context = { table: owned, alias: joinOwned(key, context, owned), json: null, vector: null };
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
        // `uncollated` is the value before the C collation, which the case-insensitive text operators replace.
        const uncollated = context.vector ? arrayFrom(context.vector, expression) : expression;
        const sql = type === 'text' ? `(${uncollated}) COLLATE "pg_catalog"."C"` : uncollated;
        // A NOT NULL column of the root row has no nulls to place, so its sort needs no NULLS clause and a
        // default-order btree (the primary key or a declared index) can return it in order. Joined and
        // embedded paths can be NULL even for NOT NULL columns, so they keep the clause.
        const notNull = !context.json && !context.vector && !field.list && context.alias === 't0'
          && context.table.columns.find((item) => item.name === (identity ? 'id' : field.storageName))?.nullable === false;
        return { sql, uncollated, field: identity ? { ...field, scalar: 'ID' } : field, type: dateNumeric ? 'double precision' : type, list: field.list || !!context.vector, vector: !!context.vector, dateNumeric, sortKey, notNull };
      }
    }
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
   * The IS_EMPTY form of `field`, stored on the row or jsonb value `context`, by its emptiness shape, or with `empty`
   * false the IS_NOT_EMPTY form: the positive form of a leaf, which a btree can serve, and the NOT of an object or an
   * owned form. Every form is two-valued and binds no parameters. A leaf is a column of any row, or the text of a
   * jsonb member, never cast, since a cast can fail; a list a native array column, a jsonb list, or an owned list,
   * whose null items are rows too, so `[null]` is not empty; an object a jsonb value or an owned single object whose
   * stored members are all empty. An owned table is read in a subquery with an alias of its own, correlated to the
   * key of the row that owns it: the root's id, or the `__id` of a joined or enclosing owned row.
   */
  const emptyForm = (context, field, shape, empty = true) => {
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
        return emptyForm(row, stored, member.shape);
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
   * IS_EMPTY and IS_NOT_EMPTY (#108, part 2a). Every emptiness predicate, leaves included, compiles here from where
   * its path is stored, not from path(), whose values cast jsonb members and materialize jsonb lists, and which
   * rejects paths that end at an embedded field. The checks of createQueryPlan run again, with its codes, on the
   * entity's GraphQL type or on the field descriptions, so a plan built by hand gets the same answers; they leave
   * only single embedded objects before the last field, reached through the LEFT JOIN of each owned single object.
   */
  const emptiness = ({ path: parts, operator, value }) => {
    const steps = resolveModelPath(models, plan.entity, parts);
    const options = { operator, value, path: parts.join('.') };
    const gqltype = models.entities.find((item) => item.name === plan.entity)?.gqltype;
    const shape = gqltype ? describeEmptiness(gqltype, parts, options) : describeModelEmptiness(steps, options);
    let context = { table: root, alias: 't0', json: null };
    steps.slice(0, -1).forEach((field, index) => {
      if (field.kind !== 'embedded' || field.list) unsupported('Invalid query path');
      const owned = ownedOf(context, field);
      context = owned
        ? { table: owned, alias: joinOwned(parts.slice(0, index + 1).join('.'), context, owned), json: null }
        : { table: null, alias: null, json: context.json ? `(${context.json} -> ${literal(field.storageName)})` : col(context.alias, field.storageName) };
    });
    return emptyForm(context, steps.at(-1), shape, operator === 'IS_EMPTY');
  };
  // A negation reaches every predicate below it, including those nested in AND/OR groups; the emptiness forms are
  // two-valued, so they need no null-safe form under it.
  const where = (node, negated = false) => {
    if (!node) return 'TRUE';
    if (node.kind === 'predicate' && isEmptinessOperator(node.operator)) return `(${emptiness(node)})`;
    if (node.kind === 'predicate') return `(${predicate(path(node.path), node.operator, node.value, negated)})`;
    return `(${node.terms.map((term) => where(term, negated)).join(node.kind === 'and' ? ' AND ' : ' OR ')})`;
  };
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
  let text = `SELECT ${select} FROM ${qualified(database.schema, root.name)} t0 ${[...joins.values()].map((item) => item.sql).join(' ')}${lateralSQL} WHERE ${condition}${group}`;
  if (plan.mode === 'aggregate') text = `SELECT * FROM (${text}) aggregated`;
  if (order.length) text += ` ORDER BY ${order.join(', ')}`;
  if (plan.pagination) text += ` LIMIT ${bind(plan.pagination.limit, 'bigint')} OFFSET ${bind(plan.pagination.offset, 'bigint')}`;
  return { text, values, ...(plan.mode === 'aggregate' ? { aggregateFields: [resolveModelPath(models, plan.entity, plan.aggregation.groupId).at(-1), ...plan.aggregation.facts.map((fact) => resolveModelPath(models, plan.entity, fact.path).at(-1))] } : {}) };
};
