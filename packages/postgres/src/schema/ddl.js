import { identifier, qualified, columnsSQL, literal } from './sql.js';

export const createTableSQL = (schema, table) => {
  const columns = table.columns.map((column) => `${identifier(column.name)} ${column.type}${column.collation ? ` COLLATE ${qualified('pg_catalog', column.collation)}` : ''}${column.nullable ? '' : ' NOT NULL'}${column.default ? ` DEFAULT ${column.default}` : ''}`);
  columns.push(`CONSTRAINT ${identifier(table.primaryKey.name)} PRIMARY KEY (${columnsSQL(table.primaryKey.columns)})`);
  for (const check of table.checks) columns.push(`CONSTRAINT ${identifier(check.name)} CHECK (${check.expression})`);
  return `CREATE TABLE ${qualified(schema, table.name)} (\n  ${columns.join(',\n  ')}\n)`;
};
export const createForeignKeySQL = (schema, table, key) => `ALTER TABLE ${qualified(schema, table.name)} ADD CONSTRAINT ${identifier(key.name)} FOREIGN KEY (${columnsSQL(key.columns)}) REFERENCES ${qualified(schema, key.targetTable)} (${columnsSQL(key.targetColumns)}) ON UPDATE ${key.onUpdate} ON DELETE ${key.onDelete} ${key.deferrable ? `DEFERRABLE INITIALLY ${key.initiallyDeferred ? 'DEFERRED' : 'IMMEDIATE'}` : 'NOT DEFERRABLE'}`;
export const createIndexSQL = (schema, table, index) => `CREATE ${index.unique ? 'UNIQUE ' : ''}INDEX ${identifier(index.name)} ON ${qualified(schema, table.name)} (${columnsSQL(index.columns)})${index.nullsNotDistinct ? ' NULLS NOT DISTINCT' : ''}`;

export const createFunctionSQL = (schema, fn) => {
  const settings = fn.configuration.map((setting) => {
    const position = setting.indexOf('=');
    return `SET ${identifier(setting.slice(0, position))} TO ${literal(setting.slice(position + 1))}`;
  }).join(' ');
  return `CREATE FUNCTION ${qualified(schema, fn.name)}(${fn.arguments.join(', ')}) RETURNS ${fn.returns} LANGUAGE ${fn.language} ${fn.volatility} CALLED ON NULL INPUT SECURITY INVOKER PARALLEL UNSAFE ${settings} AS ${literal(fn.body)}`;
};
export const createTriggerSQL = (schema, trigger) => `CREATE ${trigger.constraint ? 'CONSTRAINT ' : ''}TRIGGER ${identifier(trigger.name)} AFTER INSERT OR UPDATE OR DELETE ON ${qualified(schema, trigger.table)} ${trigger.constraint ? 'DEFERRABLE INITIALLY DEFERRED ' : ''}FOR EACH ROW EXECUTE FUNCTION ${qualified(schema, trigger.function)}()`;

/** Tables/primary keys precede all FKs so forward and cyclic references work. */
export const compileDatabaseSchema = (description) => [
  `CREATE SCHEMA IF NOT EXISTS ${identifier(description.schema)}`,
  ...(description.functions || []).map((fn) => createFunctionSQL(description.schema, fn)),
  ...description.tables.map((table) => createTableSQL(description.schema, table)),
  ...description.tables.flatMap((table) => table.foreignKeys.map((key) => createForeignKeySQL(description.schema, table, key))),
  ...description.tables.flatMap((table) => table.indexes.map((index) => createIndexSQL(description.schema, table, index))),
  ...(description.triggers || []).map((trigger) => createTriggerSQL(description.schema, trigger)),
];
