import { getNamedType } from 'graphql';
import { isVirtualField } from '@simtlix/simfinity-core/internal/relation-storage';

/**
 * Where the virtual fields (`extensions.virtual`) of stored types would hold storage, had they any: for each
 * one, the table of the type that declares it (its entity's table, or the owned table of an embedded value)
 * and the embedded fields between that table's column and the field (empty for a field of the table itself).
 * Model descriptions leave virtual fields out, so they are found on the GraphQL types, through the embedded
 * fields that the descriptions keep. Virtual fields store nothing; plugins use the locations only to name a
 * field whose storage from before it became virtual is still in a database. Empty without virtual fields.
 */
export const locateVirtualFields = (models, plan) => {
  const locations = [];
  const ownedTable = (owner, field) => plan.tables.find((table) => table.ownership?.ownerTable === owner && table.ownership.field === field);
  const visit = (table, type, fields, path) => {
    const gqlFields = type.getFields();
    for (const [name, field] of Object.entries(gqlFields)) {
      if (isVirtualField(field)) locations.push({ table, path, field: `${type.name}.${name}`, name });
    }
    for (const field of fields) {
      if (field.kind !== 'embedded') continue;
      const named = getNamedType(gqlFields[field.name].type);
      // Only a value of the table itself can own a table; values inside a JSON value are part of it.
      const owned = !path.length && ownedTable(table, field.name);
      if (owned) visit(owned.name, named, field.fields, []);
      else visit(table, named, field.fields, [...path, field.storageName]);
    }
  };
  for (const entity of models.entities) visit(entity.name, entity.gqltype, entity.fields, []);
  return locations;
};
