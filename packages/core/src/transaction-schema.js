import {
  GraphQLID, GraphQLInputObjectType, GraphQLList, GraphQLNonNull, GraphQLObjectType,
} from 'graphql';
import SimfinityError from './errors/simfinity.error.js';

// Internal, and never exported from the package. The schema side of the generated transaction field
// (#151): the shape of createSchema()'s `transaction` option, the operation keys of a built Mutation
// type, the checks once the generated mutations are built, and the field with its derived types.
// The runtime checks what needs its registrations and runs the transactions.

// The first sentence of the field's description, stable for SDL and introspection.
export const TRANSACTION_MARKER = 'Simfinity transaction: runs the listed generated mutations in order in one database transaction.';

const DEFAULT_NAME = 'transaction';
const OPTION_KEYS = new Set(['name', 'types']);
const GRAPHQL_NAME = /^[_A-Za-z][_0-9A-Za-z]*$/;
// The operations of the generated mutation roots a transaction runs; registered mutations, marked
// custom_mutation, never are operations.
const TRANSACTION_OPERATIONS = new Set(['save', 'update', 'delete', 'state_changed']);

export const invalidTransactionOption = (reason) => new SimfinityError(
  `Invalid transaction option: ${reason}`, 'INVALID_SCHEMA_OPTIONS', 500,
);
export const transactionUnsupportedError = () => new SimfinityError(
  'The database adapter does not support generated transactions', 'TRANSACTION_UNSUPPORTED', 500,
);
export const noOperationError = () => invalidTransactionOption('none of its types has generated mutations in this schema');

const isPlainObject = (value) => value !== null && typeof value === 'object'
  && [Object.prototype, null].includes(Object.getPrototypeOf(value));

// The shape of the option: undefined or null adds no field; otherwise a plain object with known keys
// only, an optional `name` that is a GraphQL name not starting with __ (such a name builds, but every
// request then fails schema validation), and a non-empty array of distinct GraphQLObjectTypes. Returns
// null or a copy, `{ name, types }`, that later changes to the option do not reach. Whether the types
// are registered is the runtime's check.
export const readTransactionOption = (option) => {
  if (option === undefined || option === null) return null;
  if (!isPlainObject(option)) throw invalidTransactionOption('must be a plain object');
  const unknown = Reflect.ownKeys(option).find((key) => !OPTION_KEYS.has(key));
  if (unknown !== undefined) throw invalidTransactionOption(`unknown key ${String(unknown)}`);
  const { name = DEFAULT_NAME, types } = option;
  if (typeof name !== 'string' || !GRAPHQL_NAME.test(name) || name.startsWith('__')) {
    throw invalidTransactionOption('name must be a GraphQL name that does not start with __');
  }
  const invalidTypes = () => invalidTransactionOption('types must be a non-empty array of GraphQLObjectType');
  if (!Array.isArray(types) || types.length === 0) throw invalidTypes();
  const copy = [];
  for (let index = 0; index < types.length; index += 1) {
    const type = types[index];
    if (!Object.hasOwn(types, index) || !(type instanceof GraphQLObjectType)) throw invalidTypes();
    if (copy.includes(type)) throw invalidTransactionOption(`types lists ${type.name} more than once`);
    copy.push(type);
  }
  return { name, types: copy };
};

// The field's type names: the name with its first letter in upper case, followed by Operation,
// Result and DeleteInput.
export const transactionTypeNames = (name) => {
  const base = name.charAt(0).toUpperCase() + name.slice(1);
  return { operation: `${base}Operation`, result: `${base}Result`, deleteInput: `${base}DeleteInput` };
};

// The operation keys of a built Mutation type, in field order: the generated roots of these type names,
// each with its field and its extensions.simfinityMutation marker.
export const collectOperationFields = (mutation, typeNames) => Object.entries(mutation.getFields())
  .filter(([, field]) => {
    const marker = field.extensions?.simfinityMutation;
    return !!marker && TRANSACTION_OPERATIONS.has(marker.operation) && typeNames.includes(marker.typeName);
  })
  .map(([key, field]) => ({ key, field, marker: field.extensions.simfinityMutation }));

// A delete of an unprotected type takes `{ id }`, which only the DeleteInput type holds.
const needsDeleteInput = (operations) => operations
  .some(({ operation, protected: isProtected }) => operation === 'delete' && !isProtected);

// The names of the types the field adds to the schema.
const addedTypeNames = (name, operations) => {
  const names = transactionTypeNames(name);
  return [names.operation, names.result, ...(needsDeleteInput(operations) ? [names.deleteInput] : [])];
};

// The checks once the generated mutations are built, on the Mutation type without the field: the name
// against the roots built, at least one operation, and the added type names against every type the
// schema reaches. `typeExists(name)` answers whether the schema's roots reach a type of that name,
// input fields included. `operations` are the descriptors buildTransactionField takes.
export const assertTransactionSchema = ({
  name, mutation, operations, typeExists,
}) => {
  if (Object.hasOwn(mutation.getFields(), name)) {
    throw invalidTransactionOption(`name ${name} conflicts with a mutation of this schema`);
  }
  if (operations.length === 0) throw noOperationError();
  const taken = addedTypeNames(name, operations).find(typeExists);
  if (taken) throw invalidTransactionOption(`the schema already has a type named ${taken}`);
};

// The field config: `operations` are `{ key, operation, protected, inputType, returnType }` in key
// order, where `inputType` is the root's named input (null for a delete) and `returnType` the root's
// type. Add, update and action values reuse the roots' inputs, which are nullable and have no defaults
// as @oneOf fields must; a delete takes `{ id }`, or `{ id, version }` (RecordVersionRef) for a
// protected type. The result has `id`, resolved by `resolveId`, and one nullable field per key, typed as
// that root.
export const buildTransactionField = ({
  name, types, operations, recordVersionRef, resolve, resolveId,
}) => {
  const names = transactionTypeNames(name);
  const deleteInput = needsDeleteInput(operations)
    ? new GraphQLInputObjectType({
      name: names.deleteInput,
      description: `The record a delete operation of ${name} removes.`,
      fields: { id: { type: new GraphQLNonNull(GraphQLID) } },
    })
    : null;
  const valueType = ({ operation, protected: isProtected, inputType }) => {
    if (operation !== 'delete') return inputType;
    return isProtected ? recordVersionRef : deleteInput;
  };
  const operationType = new GraphQLInputObjectType({
    name: names.operation,
    description: `One operation of ${name}: exactly one generated mutation, with its input.`,
    isOneOf: true,
    fields: Object.fromEntries(operations.map((operation) => [operation.key, { type: valueType(operation) }])),
  });
  const resultType = new GraphQLObjectType({
    name: names.result,
    description: `The result of one operation of ${name}: the record's id and the field of that operation.`,
    fields: {
      id: { type: GraphQLID, resolve: resolveId },
      ...Object.fromEntries(operations.map(({ key, returnType }) => [key, { type: returnType }])),
    },
  });
  return {
    type: new GraphQLList(new GraphQLNonNull(resultType)),
    description: TRANSACTION_MARKER,
    args: { operations: { type: new GraphQLNonNull(new GraphQLList(new GraphQLNonNull(operationType))) } },
    extensions: { simfinityTransaction: { name, types: Object.freeze([...types]) } },
    resolve,
  };
};

// The Mutation type with the field added after its other fields.
export const withTransactionField = (mutation, name, field) => {
  const config = mutation.toConfig();
  return new GraphQLObjectType({ ...config, fields: { ...config.fields, [name]: field } });
};

// The state of each schema's field, keyed by its extensions.simfinityTransaction object, which every
// copy of the field shares, for instance after `new GraphQLSchema(schema.toConfig())`. The runtime
// records it once the schema exists, so a failed createSchema() leaves nothing.
const transactionStates = new WeakMap();

export const recordTransactionState = (field, state) => {
  transactionStates.set(field.extensions.simfinityTransaction, state);
};

// The state of a field or field config, or undefined for any other field. No runtime code reads it: it is
// a hook for tests, which inspect the state the runtime recorded.
export const transactionStateOf = (field) => {
  const marker = field?.extensions?.simfinityTransaction;
  return marker !== null && typeof marker === 'object' ? transactionStates.get(marker) : undefined;
};
