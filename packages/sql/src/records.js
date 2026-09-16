import { getNamedType } from 'graphql';
import { SimfinityError } from '@simtlix/simfinity-core';

const missing = (name) => { throw new SimfinityError(`Required value ${name} is missing`, 'REQUIRED_VALUE', 400); };
const shapeError = (name) => { throw new SimfinityError(`Invalid value for ${name}`, 'INVALID_VALUE', 400); };

export const createRecordStore = (models, database, query, plugin) => {
  const { castId, encodeScalar, decodeScalar, createId, encodeEmbedded } = plugin.values;
  const execute = (operation, session) => query(plugin.compileRecord(database, operation), session);
  const model = (name) => models.entities.find((item) => item.name === name);
  const table = (name) => database.tables.find((item) => item.name === name);
  const children = (owner) => database.tables.filter((item) => item.ownership?.ownerTable === owner.name);
  const child = (owner, field) => children(owner).find((item) => item.ownership.field === field.name);
  const gqlFields = (type) => type?.getFields() || {};
  const encodeValue = (field, value) => {
    if (value == null) return null;
    if (field.kind === 'embedded') return mapEmbedded(field, value, encodeFields);
    if (field.list) {
      if (!Array.isArray(value)) shapeError(field.name);
      return value.map((item) => {
        if (item == null && field.itemRequired) missing(`${field.name}[]`);
        return encodeScalar(field, item);
      });
    }
    return encodeScalar(field, value);
  };
  const mapEmbedded = (field, value, mapper, gqltype) => {
    if (value == null) return value;
    if (field.list) {
      if (!Array.isArray(value)) shapeError(field.name);
      return value.map((item) => {
        if (item == null) { if (field.itemRequired) missing(`${field.name}[]`); return null; }
        return mapper(field.fields, item, gqltype);
      });
    }
    return mapper(field.fields, value, gqltype);
  };
  // Mongoose inline objects materialize descendant array defaults and minimize
  // scalar-only empty objects. Embedded array items themselves are retained.
  const normalize = (fields, data, full = true) => {
    if (!data || typeof data !== 'object' || Array.isArray(data)) shapeError('embedded object');
    const result = { ...data };
    for (const field of fields) {
      if (field.kind === 'collection' || (!full && !Object.hasOwn(data, field.storageName))) continue;
      let value = data[field.storageName];
      if (value === undefined && !full) continue;
      if (value === undefined && full && field.list) value = [];
      if (field.kind === 'embedded' && value !== null) {
        if (field.list) {
          if (!Array.isArray(value)) shapeError(field.name);
          value = value.map((item) => item == null ? item : normalize(field.fields, item));
        } else {
          value = normalize(field.fields, value ?? {});
          if (!Object.keys(value).length) value = undefined;
        }
      }
      if (value !== undefined) result[field.storageName] = value;
      else if (full) delete result[field.storageName];
      else result[field.storageName] = undefined;
    }
    return result;
  };
  const encodeFields = (fields, data) => {
    if (!data || typeof data !== 'object' || Array.isArray(data)) shapeError('embedded object');
    const result = {};
    for (const field of fields) {
      if (field.kind === 'collection') continue;
      const value = data[field.storageName];
      if (value == null && field.required) missing(field.name);
      if (value !== undefined) result[field.storageName] = encodeValue(field, value);
      else if (field.list) result[field.storageName] = [];
    }
    return result;
  };
  const decodeFields = (fields, data, gqltype) => {
    const result = {};
    for (const field of fields) {
      if (field.kind === 'collection' || data[field.storageName] === undefined) continue;
      const value = data[field.storageName];
      const gqlField = gqlFields(gqltype)[field.name];
      if (field.kind === 'embedded') result[field.storageName] = mapEmbedded(field, value, decodeFields, gqlField && getNamedType(gqlField.type));
      else result[field.storageName] = field.list && value ? value.map((item) => decodeScalar(field, item, gqlField)) : decodeScalar(field, value, gqlField);
    }
    return result;
  };
  const hydrate = async (storage, fields, rows, gqltype, session) => {
    const result = rows.map((row) => {
      const visible = { ...row };
      for (const column of storage.columns) if (column.presenceColumn && row[column.name] == null && !row[column.presenceColumn]) delete visible[column.name];
      const value = decodeFields(fields, visible, gqltype);
      if (!storage.ownership) { value._id = row.id; value.id = row.id; }
      return value;
    });
    if (!rows.length) return result;
    for (const owned of children(storage)) {
      const field = fields.find((item) => item.name === owned.ownership.field);
      const ids = rows.filter((row) => row[owned.ownership.stateColumn] === 'present').map((row) => row[storage.primaryKey.columns[0]]);
      let ownedRows = [];
      if (ids.length) ownedRows = (await execute({ kind: 'selectOwned', table: owned, ids, ordered: field.list }, session)).rows;
      const decoded = await hydrate(owned, field.fields, ownedRows, getNamedType(gqlFields(gqltype)[field.name].type), session);
      const byOwner = new Map();
      ownedRows.forEach((row, index) => {
        const list = byOwner.get(row.__owner_id) || [];
        list.push(owned.ownership.nullableItems && !row.__item_present ? null : decoded[index]);
        byOwner.set(row.__owner_id, list);
      });
      rows.forEach((row, index) => {
        const state = row[owned.ownership.stateColumn];
        if (state === 'null') result[index][field.storageName] = null;
        else if (state === 'present') {
          const items = byOwner.get(row[storage.primaryKey.columns[0]]) || [];
          result[index][field.storageName] = field.list ? items : items[0] ?? null;
        }
      });
    }
    return result;
  };
  const columnValues = (storage, fields, data, full, nullItem = false) => {
    const result = {};
    for (const field of fields) {
      if (field.kind === 'collection' || (!storage.ownership && ['id', '_id'].includes(field.name))) continue;
      const present = Object.hasOwn(data, field.storageName);
      let value = data[field.storageName];
      if (!present && !full) continue;
      if (!present && full && field.list && !nullItem) value = [];
      const owned = child(storage, field);
      if (owned) {
        if (value == null && field.required && !nullItem) missing(field.name);
        result[owned.ownership.stateColumn] = value === undefined ? 'missing' : value === null ? 'null' : 'present';
      } else {
        if (value == null && field.required && !nullItem) missing(field.name);
        const presenceColumn = storage.columns.find((column) => column.name === field.storageName)?.presenceColumn;
        if (presenceColumn) result[presenceColumn] = value !== undefined && !nullItem;
        if (value !== undefined) {
          const encoded = encodeValue(field, value);
          result[field.storageName] = field.kind === 'embedded' && encoded != null ? encodeEmbedded(encoded) : encoded;
        } else if (full || field.kind === 'embedded') result[field.storageName] = null;
      }
    }
    return result;
  };
  const insertRow = async (storage, data, session) => {
    return (await execute({ kind: 'insert', table: storage, data }, session)).rows[0];
  };
  const persistOwned = async (storage, fields, ownerId, data, session, replace = false) => {
    for (const owned of children(storage)) {
      const field = fields.find((item) => item.name === owned.ownership.field);
      if (!Object.hasOwn(data, field.storageName)) continue;
      if (replace) await execute({ kind: 'deleteOwned', table: owned, ownerId }, session);
      const value = data[field.storageName];
      if (value == null) continue;
      if (field.list && !Array.isArray(value)) shapeError(field.name);
      const entries = field.list ? value : [value];
      for (let index = 0; index < entries.length; index++) {
        const entry = entries[index];
        if (entry == null && (!field.list || field.itemRequired)) missing(`${field.name}[]`);
        if (entry != null && (typeof entry !== 'object' || Array.isArray(entry))) shapeError(field.name);
        const row = { __id: createId(), __owner_id: ownerId, ...columnValues(owned, field.fields, entry || {}, true, entry == null) };
        if (field.list) row.__position = index;
        if (owned.ownership.nullableItems) row.__item_present = entry != null;
        await insertRow(owned, row, session);
        if (entry) await persistOwned(owned, field.fields, row.__id, entry, session);
      }
    }
  };
  const hydrateRows = async (name, rows, session) => {
    const entity = model(name);
    if (!entity) throw new SimfinityError(`Type ${name} is not an entity`, 'INVALID_MODEL', 400);
    return hydrate(table(name), entity.fields, rows, entity.gqltype, session);
  };
  const getById = async (name, value, session, { projection, lock, requiredId } = {}) => {
    if (value == null) return null;
    const id = castId(value);
    if (requiredId != null && id !== castId(requiredId)) return null;
    const rows = (await execute({ kind: 'selectById', table: table(name), id, lock }, session)).rows;
    const [record] = await hydrateRows(name, rows, session);
    if (!record) return null;
    return projection ? Object.fromEntries(Object.entries(record).filter(([key]) => key === '_id' || key === 'id' || projection[key])) : record;
  };
  const create = async (name, record, session) => {
    const entity = model(name);
    if (!entity) throw new SimfinityError(`Type ${name} is not an entity`, 'INVALID_MODEL', 400);
    const storage = table(name);
    const normalized = normalize(entity.fields, record);
    const data = { id: castId(normalized._id || normalized.id), ...columnValues(storage, entity.fields, normalized, true) };
    const row = await insertRow(storage, data, session);
    await persistOwned(storage, entity.fields, row.id, normalized, session);
    return (await hydrateRows(name, [row], session))[0];
  };
  const update = async (name, value, changes, session) => {
    const id = castId(value);
    const entity = model(name); const storage = table(name);
    const source = normalize(entity.fields, changes, false);
    delete source.$unset;
    for (const field of Object.keys(changes.$unset || {})) source[field] = undefined;
    const data = columnValues(storage, entity.fields, source, false);
    for (const field of Object.keys(changes.$unset || {})) {
      const column = storage.columns.find((item) => item.name === field);
      if (column && !['id', '_id'].includes(field)) data[field] = null;
    }
    const operation = Object.keys(data).length ? { kind: 'update', table: storage, id, data } : { kind: 'selectById', table: storage, id };
    const { rows } = await execute(operation, session);
    if (!rows.length) return null;
    await persistOwned(storage, entity.fields, id, source, session, true);
    return (await hydrateRows(name, rows, session))[0];
  };
  const remove = async (name, value, session) => {
    const record = await getById(name, value, session);
    if (!record) return null;
    await execute({ kind: 'deleteById', table: table(name), id: record._id }, session);
    return record;
  };
  return { create, update, remove, getById, hydrateRows };
};
