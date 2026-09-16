import { SimfinityError } from '@simtlix/simfinity-core';

const invalid = (message) => { throw new SimfinityError(message, 'INVALID_DATABASE_SCHEMA', 400); };
const validateIdentifier = (value) => {
  if (typeof value !== 'string' || !value.length || value.includes('\0')) invalid(`Invalid SQL identifier: ${String(value)}`);
};
const defaultNaming = { validateIdentifier, generatedName: (...parts) => parts.join('__') };
const hasOwnedFields = (fields) => fields.some((field) => field.kind === 'reference' || field.unique || (field.fields && hasOwnedFields(field.fields)));
// Enum runtime values can be arbitrary JavaScript objects. Storage needs only their strings.
const storedField = (field) => Object.fromEntries(Object.entries(field).filter(([key]) => key !== 'enumValues').map(([key, value]) => [key, key === 'fields' ? value.map(storedField) : value]));

/** Plan relational guarantees without physical types, SQL expressions or driver objects. */
export const planRelationalSchema = (models, { schema = 'public', naming = defaultNaming } = {}) => {
  naming.validateIdentifier(schema);
  const tables = [];
  const names = new Set();
  const requirements = new Set(['transactions']);
  const checkOrder = [];
  const uniqueValues = [];
  const addTable = (name, ownership) => {
    naming.validateIdentifier(name);
    if (names.has(name)) invalid(`Table name collision: ${name}`);
    names.add(name);
    const key = ownership ? '__id' : 'id';
    const table = {
      name, columns: [{ name: key, scalar: 'ID', list: false, nullable: false, default: { kind: 'identity' } }],
      primaryKey: { name: naming.generatedName(name, 'pk'), columns: [key] },
      foreignKeys: [], indexes: [], checks: [],
      ...(ownership ? { ownership } : {}),
    };
    tables.push(table);
    return table;
  };
  const addColumn = (table, column) => {
    naming.validateIdentifier(column.name);
    if (table.columns.some((item) => item.name === column.name)) invalid(`Column collision: ${table.name}.${column.name}`);
    table.columns.push({ ...column, list: column.list === true });
  };
  const addIndex = (table, columns, unique = false) => {
    if (table.indexes.some((index) => JSON.stringify(index.columns) === JSON.stringify(columns) && index.unique === unique)) return;
    table.indexes.push({ name: naming.generatedName(table.name, ...columns, unique ? 'uq' : 'idx'), columns, unique, nullsEqual: unique });
    if (unique) { requirements.add('uniqueValues'); requirements.add('nullableUnique'); }
  };
  const addCheck = (table, column, suffix, condition) => {
    const name = naming.generatedName(table.name, column, suffix);
    table.checks.push({ name, column, ...condition });
    checkOrder.push({ table: table.name, name });
  };
  const addReference = (table, column, targetTable, targetColumn = 'id', owned = false) => {
    requirements.add('foreignKeys'); requirements.add('deferredForeignKeys');
    table.foreignKeys.push({
      name: naming.generatedName(table.name, column, 'fk'), columns: [column], targetTable, targetColumns: [targetColumn],
      onDelete: owned ? 'CASCADE' : 'NO ACTION', onUpdate: 'NO ACTION', deferrable: true, initiallyDeferred: false,
    });
    addIndex(table, [column]);
  };
  const fieldsInto = (table, fields, path = []) => {
    for (const field of fields) {
      if (field.kind === 'collection') continue;
      if (field.kind === 'embedded' && field.unique) invalid(`Whole embedded-object uniqueness is not supported: ${table.name}.${field.name}`);
      if (!table.ownership && ['id', '_id'].includes(field.name)) {
        if (field.kind !== 'scalar' || field.list || !['ID', 'String'].includes(field.scalar)) invalid(`Reserved identity field ${table.name}.${field.name} must be a scalar ID or String`);
        continue;
      }
      if (field.storageName.startsWith('__')) invalid(`Reserved private column name ${table.name}.${field.storageName}`);
      const conditional = table.ownership?.nullableItems === true;
      const required = field.required && !conditional;
      if (field.kind === 'embedded' && hasOwnedFields(field.fields)) {
        requirements.add('ownedRecords');
        const stateColumn = `__${field.name}_state`;
        addColumn(table, { name: stateColumn, scalar: 'String', nullable: false, default: { kind: 'value', value: 'missing' } });
        const values = field.required && !conditional ? ['present'] : ['missing', 'null', 'present'];
        if (conditional && field.required) addCheck(table, stateColumn, 'required', { kind: 'presentWhenItem' });
        addCheck(table, stateColumn, 'state', { kind: 'state', values });
        const owned = addTable(naming.generatedName(table.name, field.name), {
          ownerTable: table.name, ownerColumn: table.primaryKey.columns[0], field: field.name,
          path: [...path, field.name], list: field.list, required: field.required,
          nullableItems: field.list && !field.itemRequired, stateColumn,
        });
        addColumn(owned, { name: '__owner_id', scalar: 'ID', nullable: false });
        addReference(owned, '__owner_id', table.name, table.primaryKey.columns[0], true);
        if (field.list) {
          addColumn(owned, { name: '__position', scalar: 'Int', nullable: false });
          addCheck(owned, '__position', 'nonnegative', { kind: 'nonnegative' });
          addIndex(owned, ['__owner_id', '__position'], true);
          if (!field.itemRequired) addColumn(owned, { name: '__item_present', scalar: 'Boolean', nullable: false, default: { kind: 'value', value: true } });
        } else addIndex(owned, ['__owner_id'], true);
        fieldsInto(owned, field.fields, [...path, field.name]);
        continue;
      }
      const scalar = field.kind === 'embedded' ? 'Embedded' : field.kind === 'reference' ? 'ID' : field.scalar;
      if (!['ID', 'String', 'Enum', 'Int', 'Float', 'Boolean', 'DateTime', 'Embedded'].includes(scalar)) invalid(`Unsupported scalar at ${table.name}.${field.name}`);
      if (field.kind === 'embedded') requirements.add('embeddedValues');
      else if (field.list) requirements.add('scalarLists');
      const presenceColumn = table.ownership || field.kind === 'embedded' ? naming.generatedName('__field', field.name, 'present') : null;
      addColumn(table, { name: field.storageName, scalar, list: field.kind !== 'embedded' && field.list, nullable: !required, ...(presenceColumn ? { presenceColumn } : {}) });
      if (presenceColumn) addColumn(table, { name: presenceColumn, scalar: 'Boolean', nullable: false, default: { kind: 'value', value: false } });
      if (conditional && field.required) addCheck(table, field.storageName, 'required', { kind: 'requiredWhenItem' });
      if (field.kind === 'reference') addReference(table, field.storageName, field.target);
      if (field.scalar === 'ID') addIndex(table, [field.storageName]);
      if (field.kind === 'embedded') addCheck(table, field.storageName, 'shape', { kind: 'embeddedShape', field: storedField(field) });
      if (field.unique) {
        if (field.list || table.ownership) {
          requirements.add('uniqueValues'); requirements.add('nullableUnique');
          uniqueValues.push({ table: table.name, field: storedField(field) });
        } else addIndex(table, [field.storageName], true);
      }
      if (field.scalar === 'Enum') addCheck(table, field.storageName, 'enum', { kind: 'enum', values: [...field.values], list: field.list });
      if (field.kind === 'scalar' && field.list && field.itemRequired) addCheck(table, field.storageName, 'items', { kind: 'itemsRequired', scalar: field.scalar });
    }
  };
  for (const entity of models.entities) addTable(entity.name);
  for (const entity of models.entities) {
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
  return { schema, tables, checkOrder, uniqueValues, requirements: [...requirements].sort() };
};
