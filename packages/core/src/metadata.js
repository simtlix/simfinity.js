import {
  isObjectType, isScalarType, isEnumType, isNonNullType, isListType,
} from 'graphql';
import SimfinityError from './errors/simfinity.error.js';
import {
  assertVirtualConnection, assertVirtualDeclaration, assertVirtualIndexes, assertVirtualStateField,
} from './virtual-fields.js';
import { assertPlainConnectionField } from './relation-storage.js';
import {
  isProtectedType, isVersionField, recordVersionFieldMisuse, versionConnectionCollision, versionEmbeddedMisuse,
  versionFieldCollision,
} from './record-version.js';

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

// Follows a validated scalar's baseScalarType chain to the scalar it is stored as, stopping where the
// chain repeats, as MongoDB's resolveStorageScalar does.
const rootScalar = (type) => {
  let base = type;
  const visited = new Set();
  while (base?.baseScalarType && !visited.has(base)) {
    visited.add(base);
    base = base.baseScalarType;
  }
  return base;
};

/**
 * Internal: the name of the scalar a field type is stored as: the end of its baseScalarType chain, by
 * its own name (`Date` stays `Date`). An enum or a scalar without a base gives its own name, and a
 * chain that repeats stops where it repeats. Never throws; describeModels rejects cyclic chains and
 * unsupported scalars on top of it.
 */
export const effectiveScalarName = (type) => rootScalar(type)?.name;

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
  // The walk stops on a type that still has a base only where the chain repeats.
  if (rootScalar(type).baseScalarType) invalid(`Cyclic base scalar ${type.name}`);
  const name = effectiveScalarName(type);
  const scalar = ['DateTime', 'Date', 'Time'].includes(name) ? 'DateTime' : name;
  if (!['String', 'ID', 'Int', 'Float', 'Boolean', 'DateTime'].includes(scalar)) {
    invalid(`Unsupported scalar ${type.name}: declare a supported baseScalarType`);
  }
  return { scalar };
};

// The version field of a protected entity, described the same way whether the type carries Simfinity's
// injected field or only declares the extension and createSchema() has not injected it yet.
const versionDescription = () => ({
  name: 'version', storageName: 'version', kind: 'scalar', scalar: 'Version', required: true,
  list: false, itemRequired: false, unique: false, readOnly: true, version: true,
});

/**
 * Describe persistent entities without importing a database driver or mutating GraphQL types.
 * Virtual fields (`extensions.virtual`) store nothing, so they are left out of every entity and
 * embedded type, and their result types are neither described nor required to declare a relation.
 * An entity that declares optimistic concurrency (`extensions.concurrency`), or already carries its
 * injected field, ends with the version field. A field that would collide with it, any other field
 * typed RecordVersion, and a protected type used as an embedded value throw INVALID_MODEL.
 */
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
  for (const registration of registrations) assertVirtualStateField(registration.gqltype, registration.stateMachine);
  for (const registration of registrations) if (registration.endpoint !== false) addEntity(registration.gqltype);

  const fieldsOf = (type, ancestors, path, embedded = false) => {
    if (ancestors.includes(type)) invalid(`Embedded cycle at ${path}`);
    registerType(type);
    const isProtected = isProtectedType(type);
    if (isProtected && embedded) invalid(versionEmbeddedMisuse(type.name, path));
    const collision = isProtected ? versionFieldCollision(type) : null;
    if (collision) invalid(collision);
    const misuse = recordVersionFieldMisuse(type);
    if (misuse) invalid(misuse);
    const stored = Object.values(type.getFields()).filter((field) => !assertVirtualDeclaration(
      type.name, field.name, field, () => typeof field.resolve === 'function',
    ));
    const fields = stored.map((field) => {
      if (isVersionField(field)) return versionDescription();
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
      assertVirtualConnection(type, field.name, field);
      if (relation.embedded) {
        return {
          ...descriptor, kind: 'embedded',
          fields: fieldsOf(named, [...ancestors, type], `${path}.${field.name}`, true),
        };
      }
      assertPlainConnectionField(type.name, field.name, field);
      addEntity(named);
      if (wrappers.list) {
        const connectionCollision = versionConnectionCollision(type, field.name, field);
        if (connectionCollision) invalid(connectionCollision);
        if (!relation.connectionField) invalid(`${path}.${field.name} requires a child connectionField`);
        if (embedded) invalid(`Non-embedded collections inside embedded objects are not supported: ${path}.${field.name}`);
        return { ...descriptor, kind: 'collection', target: named.name, connectionField: relation.connectionField };
      }
      return { ...descriptor, kind: 'reference', target: named.name, storageName: relation.connectionField || field.name };
    });
    if (isProtected && !fields.some((item) => item.version)) fields.push(versionDescription());
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
    assertVirtualIndexes(type);
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
