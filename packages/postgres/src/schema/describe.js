import { describeModels } from '@simtlix/simfinity-core';
import { planRelationalSchema } from '@simtlix/simfinity-sql';
import { queryFunctions } from '../query/functions.js';
import { constraintBuilder, withLayouts } from './constraints.js';
import { identifier, literal, generatedName, invalid } from './sql.js';

const scalarTypes = { ID: 'uuid', String: 'text', Enum: 'text', Int: 'integer', Float: 'double precision', Boolean: 'boolean', DateTime: 'timestamp with time zone', Embedded: 'jsonb' };
const physicalType = (column) => `${scalarTypes[column.scalar]}${column.list ? '[]' : ''}`;
const physicalDefault = (value) => value.kind === 'identity' ? 'gen_random_uuid()' : typeof value.value === 'string' ? `${literal(value.value)}::text` : String(value.value);
// The first value is the default, which keeps the 3.5.9 description.
const option = (name, value, values) => {
  if (value !== undefined && !values.includes(value)) invalid(`Unknown PostgreSQL ${name} option: ${String(value)}. Use ${values.map((item) => `'${item}'`).join(' or ')}`);
  return value ?? values[0];
};

/**
 * Lower engine-independent relational guarantees into PostgreSQL storage and enforcement. Two opt-in
 * options change what new databases get:
 * - `refreshTriggers: 'perRoot'` refreshes each maintained root once per transaction, while its guard trigger
 *   stays deferred, instead of once per changed row ('perRow'). Initialization keeps each existing root on
 *   the layout its database holds;
 * - `ownerIndexes: 'minimal'` omits the (__owner_id) index of owned and guard tables, which their primary
 *   key or a unique index already covers ('all' keeps it). 'minimal' accepts existing owner indexes; a
 *   database created with 'minimal' fails validation under 'all', and create mode adds the indexes back.
 */
export const describeRelationalSchema = (plan, options) => {
  const refreshTriggers = option('refreshTriggers', options?.refreshTriggers, ['perRow', 'perRoot']);
  const ownerIndexes = option('ownerIndexes', options?.ownerIndexes, ['all', 'minimal']);
  const { schema } = plan;
  identifier(schema);
  const tables = [];
  const names = new Set();
  const addTable = (name, ownership) => {
    identifier(name);
    if (names.has(name)) invalid(`Table name collision: ${name}`);
    names.add(name);
    const key = ownership ? '__id' : 'id';
    const table = {
      name, columns: [{ name: key, type: 'uuid', nullable: false, default: 'gen_random_uuid()' }],
      primaryKey: { name: generatedName(name, 'pk'), columns: [key] },
      foreignKeys: [], indexes: [], checks: [],
      ...(ownership ? { ownership } : {}),
    };
    tables.push(table);
    return table;
  };
  const addColumn = (table, column) => {
    identifier(column.name);
    if (table.columns.some((item) => item.name === column.name)) invalid(`Column collision: ${table.name}.${column.name}`);
    if (column.type === 'text' || column.type === 'text[]') column.collation = 'C';
    table.columns.push(column);
  };
  const addIndex = (table, columns, unique = false) => {
    if (table.indexes.some((index) => JSON.stringify(index.columns) === JSON.stringify(columns) && index.unique === unique)) return;
    table.indexes.push({ name: generatedName(table.name, ...columns, unique ? 'uq' : 'idx'), columns, unique, nullsNotDistinct: unique });
  };
  const addCheck = (table, field, suffix, expression) => table.checks.push({ name: generatedName(table.name, field, suffix), expression });
  const addReference = (table, column, targetTable, targetColumn = 'id', owned = false) => {
    table.foreignKeys.push({ name: generatedName(table.name, column, 'fk'), columns: [column], targetTable, targetColumns: [targetColumn], onDelete: owned ? 'CASCADE' : 'NO ACTION', onUpdate: 'NO ACTION', deferrable: true, initiallyDeferred: false });
    addIndex(table, [column]);
  };
  for (const logical of plan.tables) {
    const table = addTable(logical.name, logical.ownership && structuredClone(logical.ownership));
    table.columns = [];
    for (const column of logical.columns) addColumn(table, {
      name: column.name, type: physicalType(column), nullable: column.nullable,
      ...(column.default ? { default: physicalDefault(column.default) } : {}),
      ...(column.presenceColumn ? { presenceColumn: column.presenceColumn } : {}),
    });
    table.primaryKey = structuredClone(logical.primaryKey);
    table.foreignKeys = structuredClone(logical.foreignKeys);
    table.indexes = logical.indexes.map(({ name, columns, unique, nullsEqual }) => ({ name, columns: [...columns], unique, nullsNotDistinct: nullsEqual }));
  }
  const constraints = constraintBuilder(schema, tables, { addTable, addColumn, addReference, addIndex, addCheck });
  for (const item of plan.checkOrder) {
    const table = tables.find((entry) => entry.name === item.table);
    const check = plan.tables.find((entry) => entry.name === item.table).checks.find((entry) => entry.name === item.name);
    const column = identifier(check.column);
    if (check.kind === 'embeddedShape') { constraints.addJSON(table, check.field); continue; }
    let expression;
    if (check.kind === 'presentWhenItem') expression = `(NOT ${identifier('__item_present')}) OR (${column} = 'present'::text)`;
    else if (check.kind === 'requiredWhenItem') expression = `(NOT ${identifier('__item_present')}) OR (${column} IS NOT NULL)`;
    else if (check.kind === 'nonnegative') expression = `${column} >= 0`;
    else if (check.kind === 'state') expression = `${column} = ANY (ARRAY[${check.values.map((value) => `${literal(value)}::text`).join(', ')}])`;
    else if (check.kind === 'enum') {
      const values = `ARRAY[${check.values.map((value) => `${literal(value)}::text`).join(', ')}]`;
      expression = check.list ? `array_remove(${column}, NULL::text) <@ ${values}` : `${column} = ANY (${values})`;
    } else if (check.kind === 'itemsRequired') expression = `array_position(${column}, NULL::${scalarTypes[check.scalar]}) IS NULL`;
    else invalid(`Unsupported relational check: ${check.kind}`);
    table.checks.push({ name: check.name, expression });
  }
  for (const item of plan.uniqueValues) {
    const table = tables.find((entry) => entry.name === item.table);
    constraints.addUnique(table, item.field, table.columns.find((entry) => entry.name === item.field.storageName).type);
  }
  const generated = constraints.finish();
  generated.functions.push(...queryFunctions(schema));
  if (ownerIndexes === 'minimal') {
    for (const table of tables.filter((item) => item.ownership || item.auxiliary?.kind === 'guard')) {
      const covered = table.primaryKey.columns[0] === '__owner_id' || table.indexes.some((index) => index.unique && index.columns[0] === '__owner_id');
      if (covered) table.indexes = table.indexes.filter((index) => index.unique || index.columns.length !== 1 || index.columns[0] !== '__owner_id');
    }
  }
  // PostgreSQL shares one namespace for table and index names.
  const relationNames = new Set(tables.map((table) => table.name));
  for (const table of tables) {
    const constraints = new Set();
    for (const constraint of [table.primaryKey, ...table.foreignKeys, ...table.checks]) {
      if (constraints.has(constraint.name)) invalid(`Constraint name collision: ${table.name}.${constraint.name}`);
      constraints.add(constraint.name);
    }
    for (const index of [table.primaryKey, ...table.indexes]) {
      if (relationNames.has(index.name)) invalid(`Index name collision: ${index.name}`);
      relationNames.add(index.name);
    }
  }
  const description = { schema, tables: tables.sort((a, b) => a.name.localeCompare(b.name)), ...generated };
  if (refreshTriggers === 'perRow') return description;
  const result = withLayouts(description, new Map(description.maintenance.map((item) => [item.rootTable, 'perRoot'])));
  const functionNames = new Set();
  for (const fn of result.functions) {
    if (functionNames.has(fn.name)) invalid(`Function name collision: ${fn.name}`);
    functionNames.add(fn.name);
  }
  return result;
};

/** Compile GraphQL storage metadata into the compatible PostgreSQL description. */
export const describeDatabase = (registrations, { schema = 'public', refreshTriggers, ownerIndexes } = {}) => describeRelationalSchema(planRelationalSchema(describeModels(registrations), {
  schema, naming: { validateIdentifier: identifier, generatedName },
}), { refreshTriggers, ownerIndexes });
