import { describeModels } from '@simtlix/simfinity-core';
import { identifier, literal, generatedName, invalid } from './sql.js';

const scalarTypes = { ID: 'uuid', String: 'text', Enum: 'text', Int: 'integer', Float: 'double precision', Boolean: 'boolean', DateTime: 'timestamp with time zone' };
const hasOwnedFields = (fields) => fields.some((field) => field.kind === 'reference' || field.unique || (field.fields && hasOwnedFields(field.fields)));
const hasUniqueFields = (fields) => fields.some((field) => field.unique || (field.fields && hasUniqueFields(field.fields)));

/** Compile GraphQL storage metadata into a serializable PostgreSQL description. */
export const describeDatabase = (registrations, { schema = 'public' } = {}) => {
  identifier(schema);
  const { entities } = describeModels(registrations);
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
  const addCheck = (table, field, suffix, expression) => {
    table.checks.push({ name: generatedName(table.name, field, suffix), expression });
  };
  const addReference = (table, column, targetTable, targetColumn = 'id', owned = false) => {
    table.foreignKeys.push({
      name: generatedName(table.name, column, 'fk'), columns: [column], targetTable, targetColumns: [targetColumn],
      onDelete: owned ? 'CASCADE' : 'NO ACTION', onUpdate: 'NO ACTION', deferrable: true, initiallyDeferred: false,
    });
    addIndex(table, [column]);
  };
  const fieldsInto = (table, fields, path = [], insideList = false) => {
    for (const field of fields) {
      if (field.kind === 'collection') continue;
      if (field.kind === 'embedded' && (field.unique || hasUniqueFields(field.fields))) invalid(`Embedded uniqueness requires absent-owner and multikey handling and is not supported yet: ${table.name}.${field.name}`);
      if (field.unique && (field.list || insideList)) invalid(`Multikey uniqueness requires owner-aware storage and is not supported yet: ${table.name}.${field.name}`);
      if (!table.ownership && ['id', '_id'].includes(field.name)) {
        if (field.kind !== 'scalar' || field.list || !['ID', 'String'].includes(field.scalar)) invalid(`Reserved identity field ${table.name}.${field.name} must be a scalar ID or String`);
        continue;
      }
      if (field.storageName.startsWith('__')) invalid(`Reserved private column name ${table.name}.${field.storageName}`);
      const conditional = table.ownership?.nullableItems === true;
      const required = field.required && !conditional;
      if (field.kind === 'embedded' && hasOwnedFields(field.fields)) {
        // State preserves absent/null/empty values when the runtime reassembles nested objects.
        const stateColumn = `__${field.name}_state`;
        addColumn(table, { name: stateColumn, type: 'text', nullable: false, default: '\'missing\'::text' });
        const values = field.required && !conditional ? ['present'] : ['missing', 'null', 'present'];
        addCheck(table, stateColumn, 'state', `${identifier(stateColumn)} = ANY (ARRAY[${values.map((v) => `${literal(v)}::text`).join(', ')}])`);
        const owned = addTable(generatedName(table.name, field.name), {
          ownerTable: table.name, ownerColumn: table.primaryKey.columns[0], field: field.name,
          path: [...path, field.name], list: field.list, required: field.required,
          nullableItems: field.list && !field.itemRequired, stateColumn,
        });
        addColumn(owned, { name: '__owner_id', type: 'uuid', nullable: false });
        addReference(owned, '__owner_id', table.name, table.primaryKey.columns[0], true);
        if (field.list) {
          addColumn(owned, { name: '__position', type: 'integer', nullable: false });
          addCheck(owned, '__position', 'nonnegative', `${identifier('__position')} >= 0`);
          addIndex(owned, ['__owner_id', '__position'], true);
          if (!field.itemRequired) addColumn(owned, { name: '__item_present', type: 'boolean', nullable: false, default: 'true' });
        } else addIndex(owned, ['__owner_id'], true);
        fieldsInto(owned, field.fields, [...path, field.name], insideList || field.list);
        continue;
      }
      const type = field.kind === 'embedded' ? 'jsonb' : field.kind === 'reference' ? 'uuid' : `${scalarTypes[field.scalar]}${field.list ? '[]' : ''}`;
      if (!type || type.startsWith('undefined')) invalid(`Unsupported scalar at ${table.name}.${field.name}`);
      addColumn(table, { name: field.storageName, type, nullable: !required });
      if (conditional && field.required) addCheck(table, field.storageName, 'required', `(NOT ${identifier('__item_present')}) OR (${identifier(field.storageName)} IS NOT NULL)`);
      if (field.kind === 'reference') addReference(table, field.storageName, field.target);
      if (field.scalar === 'ID') addIndex(table, [field.storageName]);
      if (field.unique) addIndex(table, [field.storageName], true);
      if (field.scalar === 'Enum') {
        const values = `ARRAY[${field.values.map((value) => `${literal(value)}::text`).join(', ')}]`;
        const expression = field.list
          ? `array_remove(${identifier(field.storageName)}, NULL::text) <@ ${values}`
          : `${identifier(field.storageName)} = ANY (${values})`;
        addCheck(table, field.storageName, 'enum', expression);
      }
      if (field.kind === 'scalar' && field.list && field.itemRequired) {
        addCheck(table, field.storageName, 'items', `array_position(${identifier(field.storageName)}, NULL::${scalarTypes[field.scalar]}) IS NULL`);
      }
    }
  };
  for (const entity of entities) addTable(entity.name);
  for (const entity of entities) {
    const table = tables.find((item) => item.name === entity.name);
    fieldsInto(table, entity.fields);
    for (const index of entity.indexes) {
      const columns = index.fields.map((name) => {
        const field = entity.fields.find((item) => item.name === name || item.storageName === name);
        if (!field || !['scalar', 'reference'].includes(field.kind) || field.list) invalid(`Index ${entity.name}.${name} must refer to a stored scalar or reference`);
        return field.name === '_id' ? 'id' : field.storageName;
      });
      addIndex(table, columns, index.unique);
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
  return { schema, tables: tables.sort((a, b) => a.name.localeCompare(b.name)) };
};
