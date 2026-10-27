import {
  astFromValue, getNamedType, isEnumType, isInputObjectType, isInterfaceType, isNonNullType,
  isObjectType, isScalarType, isUnionType, print,
} from 'graphql';
import SimfinityError from '@simtlix/simfinity-core/internal/errors';
import { schemaRegistrations, schemaTransaction } from '@simtlix/simfinity-core/internal/schema-registrations';
import { getFieldStorageName, getListShape, isVirtualField, normalizeConnectionField, virtualFieldOptions } from '@simtlix/simfinity-core/internal/relation-storage';
import { packageInfo } from './package-info.js';

// Exact schema ownership. No global adoption or field-name inference across module instances.
const snapshots = new WeakMap();
const textOrNull = (value) => (typeof value === 'string' ? value : null);
const descriptionOf = (value) => ({ description: textOrNull(value.description) });
const deprecated = (value) => (value.deprecationReason == null ? {} : { deprecationReason: textOrNull(value.deprecationReason) });
const mapOf = (entries) => Object.fromEntries(entries);
const sortedMap = (entries) => mapOf([...entries].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
const freeze = (value) => {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.values(value).forEach(freeze);
    Object.freeze(value);
  }
  return value;
};

const scalarBase = (type) => {
  if (!type.baseScalarType) return null;
  const seen = new Set([type]);
  let base = type.baseScalarType;
  while (base && !seen.has(base)) {
    seen.add(base);
    if (!base.baseScalarType) return textOrNull(base.name);
    base = base.baseScalarType;
  }
  return null;
};

const collectTypes = (schema) => {
  const found = new Map();
  const pending = [schema.getQueryType(), schema.getMutationType()];
  while (pending.length) {
    const type = getNamedType(pending.pop());
    if (!type || found.has(type.name)) continue;
    found.set(type.name, type);
    if (isUnionType(type)) pending.push(...type.getTypes());
    if (isInterfaceType(type)) pending.push(...schema.getPossibleTypes(type));
    if (isObjectType(type) || isInterfaceType(type)) pending.push(...type.getInterfaces());
    if (isObjectType(type) || isInterfaceType(type) || isInputObjectType(type)) {
      for (const field of Object.values(type.getFields())) {
        pending.push(field.type, ...(field.args || []).map((arg) => arg.type));
      }
    }
  }
  return found;
};

// A collection can name the child's GraphQL member or its stored alias. Never invent a private link.
const inverseOfCollection = (child, connectionField) => {
  if (!isObjectType(child) || !connectionField) return null;
  const normalized = normalizeConnectionField(child, connectionField).graphqlFieldName;
  const matches = Object.entries(child.getFields()).filter(([name, field]) => (
    name === connectionField || getFieldStorageName(name, field) === connectionField
  ));
  return matches.length === 1 ? normalized : null;
};
const relationOf = (owner, field) => {
  const relation = field.extensions?.relation;
  const target = getNamedType(field.type);
  if (!relation || !isObjectType(target)) return null;
  const collection = getListShape(field.type);
  let inverseField = null;
  if (!relation.embedded) {
    if (collection) inverseField = inverseOfCollection(target, relation.connectionField);
    else {
      const matches = Object.entries(target.getFields()).filter(([, candidate]) => (
        !candidate.extensions?.relation?.embedded && candidate.extensions?.relation
        && getListShape(candidate.type)?.itemType === owner
        && inverseOfCollection(owner, candidate.extensions.relation.connectionField) === field.name
      ));
      if (matches.length === 1) [inverseField] = matches[0];
    }
  }
  return {
    target: target.name, embedded: !!relation.embedded,
    connectionField: textOrNull(relation.connectionField), displayField: textOrNull(relation.displayField), inverseField,
  };
};
const fieldKind = (field, relation) => {
  const named = getNamedType(field.type);
  if (relation) return relation.embedded ? 'embedded' : getListShape(field.type) ? 'collection' : 'reference';
  if (isScalarType(named)) return 'scalar';
  if (isEnumType(named)) return 'enum';
  if (isInterfaceType(named)) return 'interface';
  if (isUnionType(named)) return 'union';
  return 'object';
};

const createDescriptor = (schema, registrations) => {
  const types = collectTypes(schema);
  const registered = new Map(registrations.map((entry) => [entry.gqltype, entry]));
  const defaults = [];
  const inputValues = new Map();
  const input = (field) => {
    if (inputValues.has(field)) return inputValues.get(field);
    const result = { name: field.name, type: String(field.type), ...descriptionOf(field), ...deprecated(field), hasDefault: field.defaultValue !== undefined };
    // Do not invoke application scalar serializers during createSchema(). Keep these references only
    // until the first explicit descriptor build, then release them. Nothing executable enters JSON.
    inputValues.set(field, result);
    if (result.hasDefault) defaults.push({ target: result, type: field.type, value: field.defaultValue });
    return result;
  };
  const operation = (field) => ({ args: field.args.map(input), returns: String(field.type), ...descriptionOf(field), ...deprecated(field) });
  const queryEntries = Object.entries(schema.getQueryType()?.getFields() || {}).map(([name, field]) => {
    const registration = registrations.find((entry) => entry.endpoint
      && entry.simpleEntityEndpointName === name && field.type === entry.gqltype);
    const marker = field.extensions?.simfinityQuery;
    const kind = registration ? 'get' : marker?.operation === 'find' ? 'list' : marker?.operation === 'aggregate' ? 'aggregate' : 'customQuery';
    return [name, { ...operation(field), type: registration?.gqltype.name || (kind !== 'customQuery' ? marker.typeName : null), operation: kind,
      ...(marker?.view ? { view: marker.view.name } : {}) }];
  });
  const mutationKinds = { save: 'add', update: 'update', delete: 'delete', state_changed: 'transition', custom_mutation: 'customMutation' };
  const transaction = schemaTransaction(schema);
  const mutationEntries = Object.entries(schema.getMutationType()?.getFields() || {}).map(([name, field]) => {
    const marker = field.extensions?.simfinityMutation;
    const kind = field === transaction ? 'transaction' : mutationKinds[marker?.operation] || 'customMutation';
    const result = { ...operation(field), type: marker?.typeName || null, operation: kind };
    if (['add', 'update', 'delete'].includes(kind) && result.description === kind) result.description = null;
    if (kind === 'transition') Object.assign(result, { action: marker.action, from: textOrNull(marker.from), to: textOrNull(marker.to) });
    return [name, result];
  });
  const operations = { query: sortedMap(queryEntries), mutation: sortedMap(mutationEntries) };
  const typeEntries = [...types].map(([name, type]) => {
    const entry = registered.get(type);
    let kind = 'object';
    if (isInputObjectType(type)) kind = 'input';
    else if (isScalarType(type)) kind = 'scalar';
    else if (isEnumType(type)) kind = 'enum';
    else if (isInterfaceType(type)) kind = 'interface';
    else if (isUnionType(type)) kind = 'union';
    const associated = [...queryEntries, ...mutationEntries].filter(([, op]) => op.type === name);
    if (entry?.endpoint && associated.length) kind = 'entity';
    const result = { kind, ...descriptionOf(type) };
    if (kind === 'entity') {
      result.endpoints = mapOf(associated.filter(([, op]) => !op.view && ['get', 'list', 'aggregate', 'add', 'update', 'delete'].includes(op.operation)).map(([key, op]) => [op.operation, key]));
    }
    const rootInputs = ['add', 'update'].flatMap((operation) => {
      const endpoint = result.endpoints?.[operation];
      const root = endpoint && schema.getMutationType().getFields()[endpoint];
      const inputType = root && getNamedType(root.args.find((arg) => arg.name === 'input')?.type);
      return isInputObjectType(inputType) ? [[operation, inputType.getFields()]] : [];
    });
    if (entry) {
      const inputs = Object.entries({ add: entry.inputType, update: entry.updateInputType })
        .filter(([, item]) => item && types.get(item.name) === item).map(([key, item]) => [key, item.name]);
      if (inputs.length) result.inputs = mapOf(inputs);
      if (kind === 'entity') {
        const state = type.getFields().state;
        const enumType = state && getNamedType(state.type);
        result.stateMachine = entry.stateMachine && isEnumType(enumType) ? {
          field: 'state', enum: enumType.name, initialState: textOrNull(entry.stateMachine.initialState?.name),
          states: enumType.getValues().map((value) => value.name),
          actions: mutationEntries.filter(([, op]) => op.type === name && op.operation === 'transition').map(([mutation, op]) => ({ name: op.action, mutation, description: op.description, from: op.from, to: op.to })),
        } : null;
      }
    }
    if (isInputObjectType(type)) result.fields = Object.values(type.getFields()).map(input);
    else if (isObjectType(type) || isInterfaceType(type)) {
      result.interfaces = type.getInterfaces().map((item) => item.name);
      result.fields = Object.values(type.getFields()).map((field) => {
        const relation = relationOf(type, field);
        const virtual = virtualFieldOptions(field);
        return {
          name: field.name, type: String(field.type), kind: fieldKind(field, relation), ...descriptionOf(field), ...deprecated(field),
          readOnly: !!field.extensions?.readOnly || !!virtual, unique: field.extensions?.unique === true,
          stateMachine: !!entry?.stateMachine && field.name === 'state' && !field.extensions?.readOnly,
          ...(relation ? { relation } : {}), ...(virtual ? { virtual } : {}),
          ...(entry ? { queryable: !isVirtualField(field) && entry.queryableFields[field.name] } : {}),
          ...(rootInputs.length ? { rootInputUsage: mapOf(rootInputs.flatMap(([operation, fields]) => {
            const inputField = fields[field.name];
            return inputField ? [[operation, isNonNullType(inputField.type) && inputField.defaultValue === undefined ? 'required' : 'optional']] : [];
          })) } : {}),
          ...(field.args.length ? { args: field.args.map(input) } : {}),
        };
      });
    }
    if (isInterfaceType(type)) result.possibleTypes = schema.getPossibleTypes(type).map((item) => item.name);
    if (isUnionType(type)) result.possibleTypes = type.getTypes().map((item) => item.name);
    if (isEnumType(type)) result.values = type.getValues().map((item) => ({ name: item.name, ...descriptionOf(item), deprecationReason: textOrNull(item.deprecationReason) }));
    if (isScalarType(type)) result.baseScalar = scalarBase(type);
    return [name, result];
  });
  snapshots.set(schema, { document: { formatVersion: 1, generator: packageInfo,
    roots: { query: schema.getQueryType()?.name || null, mutation: schema.getMutationType()?.name || null },
    operations, types: sortedMap(typeEntries) }, defaults });
};

export const buildClientDescriptor = (schema) => {
  const registrations = schemaRegistrations(schema);
  if (!registrations) throw new SimfinityError('Expected a Simfinity schema returned by this core installation', 'NOT_A_SIMFINITY_SCHEMA', 500);
  if (!snapshots.has(schema)) createDescriptor(schema, registrations);
  const snapshot = snapshots.get(schema);
  if (snapshot.defaults) {
    const pending = snapshot.defaults;
    snapshot.defaults = null;
    for (const { target, type, value } of pending) {
      try {
        const ast = astFromValue(value, type);
        if (ast) target.defaultValue = print(ast);
      } catch { /* Opaque custom scalar defaults are deliberately omitted. */ }
    }
    freeze(snapshot.document);
  }
  return snapshot.document;
};
