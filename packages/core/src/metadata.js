import {
  isObjectType, isScalarType, isEnumType, isNonNullType, isListType,
} from 'graphql';
import SimfinityError from './errors/simfinity.error.js';

const invalid = (message) => {
  throw new SimfinityError(message, 'INVALID_MODEL', 400);
};

const unwrap = (type) => {
  const required = isNonNullType(type);
  const outer = required ? type.ofType : type;
  const list = isListType(outer);
  const item = list ? outer.ofType : outer;
  const itemRequired = list && isNonNullType(item);
  const named = isNonNullType(item) ? item.ofType : item;
  if (isListType(named)) invalid('Nested scalar/object lists are not supported');
  return { named, required, list, itemRequired };
};

const scalarDescription = (type) => {
  if (isEnumType(type)) {
    const storedValues = new Map();
    for (const entry of type.getValues()) {
      const stored = String(entry.value);
      if (storedValues.has(stored) && !Object.is(storedValues.get(stored), entry.value)) invalid(`Enum storage collision in ${type.name}: distinct internal values serialize to ${stored}`);
      storedValues.set(stored, entry.value);
    }
    return { scalar: 'Enum', values: [...storedValues.keys()], enumValues: type.getValues().map(({ name, value }) => ({ name, value })) };
  }
  let base = type;
  const visited = new Set();
  while (base.baseScalarType) {
    if (visited.has(base)) invalid(`Cyclic base scalar ${type.name}`);
    visited.add(base);
    base = base.baseScalarType;
  }
  const scalar = ['DateTime', 'Date', 'Time'].includes(base.name) ? 'DateTime' : base.name;
  if (!['String', 'ID', 'Int', 'Float', 'Boolean', 'DateTime'].includes(scalar)) {
    invalid(`Unsupported scalar ${type.name}: declare a supported baseScalarType`);
  }
  return { scalar };
};

/** Describe persistent entities without importing a database driver or mutating GraphQL types. */
export const describeModels = (registrations) => {
  if (!Array.isArray(registrations)) invalid('registrations must be an array');
  const knownTypes = new Map();
  const entities = new Map();
  const queue = [];
  const registerType = (type) => {
    if (!isObjectType(type)) invalid('Each registration must contain a GraphQLObjectType in gqltype');
    if (knownTypes.has(type.name) && knownTypes.get(type.name) !== type) invalid(`Conflicting GraphQL types named ${type.name}`);
    knownTypes.set(type.name, type);
  };
  const addEntity = (type) => {
    registerType(type);
    if (!entities.has(type.name)) {
      entities.set(type.name, { name: type.name, gqltype: type, fields: [], indexes: [] });
      queue.push(type);
    }
  };
  for (const registration of registrations) registerType(registration.gqltype);
  for (const registration of registrations) if (registration.endpoint !== false) addEntity(registration.gqltype);

  const fieldsOf = (type, ancestors, path, embedded = false) => {
    if (ancestors.includes(type)) invalid(`Embedded cycle at ${path}`);
    registerType(type);
    const fields = Object.values(type.getFields()).map((field) => {
      const { named, ...wrappers } = unwrap(field.type);
      const extensions = field.extensions || {};
      const descriptor = {
        name: field.name, storageName: field.name, ...wrappers,
        unique: extensions.unique === true, readOnly: extensions.readOnly === true,
      };
      if (isScalarType(named) || isEnumType(named)) {
        return { ...descriptor, kind: 'scalar', ...scalarDescription(named) };
      }
      if (!isObjectType(named)) invalid(`Unsupported field type at ${path}.${field.name}`);
      const relation = extensions.relation;
      if (!relation) invalid(`${path}.${field.name} requires extensions.relation`);
      if (relation.embedded) {
        return {
          ...descriptor, kind: 'embedded',
          fields: fieldsOf(named, [...ancestors, type], `${path}.${field.name}`, true),
        };
      }
      addEntity(named);
      if (wrappers.list) {
        if (!relation.connectionField) invalid(`${path}.${field.name} requires a child connectionField`);
        if (embedded) invalid(`Non-embedded collections inside embedded objects are not supported: ${path}.${field.name}`);
        return { ...descriptor, kind: 'collection', target: named.name, connectionField: relation.connectionField };
      }
      return { ...descriptor, kind: 'reference', target: named.name, storageName: relation.connectionField || field.name };
    });
    const storage = new Set();
    for (const field of fields.filter((item) => item.kind !== 'collection')) {
      if (storage.has(field.storageName)) invalid(`Storage collision at ${path}.${field.storageName}`);
      storage.add(field.storageName);
    }
    return fields;
  };

  for (let position = 0; position < queue.length; position += 1) {
    const type = queue[position];
    const entity = entities.get(type.name);
    entity.fields = fieldsOf(type, [], type.name);
    entity.indexes = (type.extensions?.indexes || []).map((index) => {
      if (!Array.isArray(index.fields) || !index.fields.length || new Set(index.fields).size !== index.fields.length) {
        invalid(`Invalid index on ${type.name}: fields must be a nonempty list of distinct field names`);
      }
      return { fields: [...index.fields], unique: index.unique === true };
    });
  }
  for (const entity of entities.values()) {
    for (const field of entity.fields.filter((item) => item.kind === 'collection')) {
      const child = entities.get(field.target);
      if (child.fields.some((item) => item.name === field.connectionField && item.kind === 'collection')) {
        invalid(`Implicit many-to-many relation at ${entity.name}.${field.name}: use an explicit link entity`);
      }
      const named = child.fields.find((item) => item.name === field.connectionField && item.kind !== 'collection');
      const stored = child.fields.find((item) => item.storageName === field.connectionField && item.kind !== 'collection');
      if (named && stored && named !== stored) invalid(`Conflicting connectionField ${child.name}.${field.connectionField}`);
      const inverse = named || stored;
      if (inverse) {
        if (inverse.kind === 'scalar' && inverse.scalar === 'ID' && !inverse.list) {
          Object.assign(inverse, { kind: 'reference', target: entity.name, inferred: true });
        }
        if (inverse.kind !== 'reference' || inverse.target !== entity.name) invalid(`Conflicting inverse relation at ${child.name}.${field.connectionField}`);
        field.connectionField = inverse.storageName;
      } else {
        child.fields.push({
          name: field.connectionField, storageName: field.connectionField, kind: 'reference', target: entity.name,
          required: false, list: false, itemRequired: false, unique: false, readOnly: false, private: true,
        });
      }
    }
  }
  return { entities: [...entities.values()].sort((a, b) => a.name.localeCompare(b.name)) };
};
