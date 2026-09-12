import { identifier, qualified, columnsSQL } from './sql.js';

export const createTableSQL = (schema, table) => {
  const columns = table.columns.map((column) => `${identifier(column.name)} ${column.type}${column.collation ? ` COLLATE ${qualified('pg_catalog', column.collation)}` : ''}${column.nullable ? '' : ' NOT NULL'}${column.default ? ` DEFAULT ${column.default}` : ''}`);
  columns.push(`CONSTRAINT ${identifier(table.primaryKey.name)} PRIMARY KEY (${columnsSQL(table.primaryKey.columns)})`);
  for (const check of table.checks) columns.push(`CONSTRAINT ${identifier(check.name)} CHECK (${check.expression})`);
  return `CREATE TABLE ${qualified(schema, table.name)} (\n  ${columns.join(',\n  ')}\n)`;
};
export const createForeignKeySQL = (schema, table, key) => `ALTER TABLE ${qualified(schema, table.name)} ADD CONSTRAINT ${identifier(key.name)} FOREIGN KEY (${columnsSQL(key.columns)}) REFERENCES ${qualified(schema, key.targetTable)} (${columnsSQL(key.targetColumns)}) ON UPDATE ${key.onUpdate} ON DELETE ${key.onDelete} ${key.deferrable ? `DEFERRABLE INITIALLY ${key.initiallyDeferred ? 'DEFERRED' : 'IMMEDIATE'}` : 'NOT DEFERRABLE'}`;
export const createIndexSQL = (schema, table, index) => `CREATE ${index.unique ? 'UNIQUE ' : ''}INDEX ${identifier(index.name)} ON ${qualified(schema, table.name)} (${columnsSQL(index.columns)})${index.nullsNotDistinct ? ' NULLS NOT DISTINCT' : ''}`;

/** Tables/primary keys precede all FKs so forward and cyclic references work. */
export const compileDatabaseSchema = (description) => [
  `CREATE SCHEMA IF NOT EXISTS ${identifier(description.schema)}`,
  ...description.tables.map((table) => createTableSQL(description.schema, table)),
  ...description.tables.flatMap((table) => table.foreignKeys.map((key) => createForeignKeySQL(description.schema, table, key))),
  ...description.tables.flatMap((table) => table.indexes.map((index) => createIndexSQL(description.schema, table, index))),
];
