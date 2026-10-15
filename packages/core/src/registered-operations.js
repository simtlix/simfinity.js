import { GraphQLID, GraphQLNonNull, coerceInputValue } from 'graphql';
import SimfinityError from './errors/simfinity.error.js';

const REGISTERED_READ_OPERATIONS = new Set(['find', 'count', 'get_by_id', 'aggregate']);
const REGISTERED_WRITE_OPERATIONS = new Set(['save', 'update', 'delete']);

/** Server ingress shares the runtime lifecycle through explicit dependencies. */
export const createRegisteredOperations = ({
  adapter, getRegistration, getUpdateInputType, executeOperation,
  executeMiddleware, executeScope, getScope, inspectClientPaths, applyJoinedScopes,
}) => {
  // Server-side entry point for the generated lifecycle. It takes GraphQL input values, not
  // resolver arguments/info, and never relies on a captured schema resolver.
  const registered = (typeName) => {
    const type = getRegistration(typeName);
    if (!type?.endpoint || !type.model || !type.inputType) {
      throw new SimfinityError(
        'Entity must be registered and its schema initialized',
        'UNREGISTERED_ENTITY',
        400,
      );
    }
    return type;
  };
  const validateExecutionSession = (type, session) => {
    if (session && adapter.validateSession) adapter.validateSession(type.model, session);
  };

  const validateServerExecution = (type, options) => {
    if ((options.readOptions || options.observer) && !adapter.supportsObservedReads) {
      throw new SimfinityError(
        'Observed reads are unsupported by this backend', 'UNSUPPORTED_CAPABILITY', 400,
      );
    }
    validateExecutionSession(type, options.session);
  };

  const registeredStorageOptions = (type, operation, storage) => {
    if (!storage) {
      return storage;
    }
    if (!adapter.validateStorageOptions) {
      throw new SimfinityError(
        'Storage write options are unsupported by this backend',
        'UNSUPPORTED_CAPABILITY',
        400,
      );
    }
    return adapter.validateStorageOptions(type.model, type.gqltype, operation, storage) || storage;
  };

  const writeInput = (typeName, type, operation) => {
    if (operation === 'delete') return { name: 'id', type: type.inputType, coercion: GraphQLID };
    if (operation === 'update') {
      const inputType = getUpdateInputType(typeName);
      return { name: 'input', type: inputType, coercion: inputType };
    }
    return { name: 'input', type: type.inputType, coercion: type.inputType };
  };

  const executeRegisteredWrite = async (typeName, type, operation, args, options, storage) => {
    const { context, session } = options;
    const inputContract = writeInput(typeName, type, operation);
    const coerced = {
      [inputContract.name]: coerceInputValue(args[inputContract.name], new GraphQLNonNull(inputContract.coercion)),
    };
    const params = { type, operation, context, args: coerced };
    await executeMiddleware(params);
    const input = params.args[inputContract.name];
    return executeOperation(
      type.model,
      type.gqltype,
      type.controller,
      input,
      operation,
      null,
      session,
      context,
      inputContract.type,
      storage,
    );
  };

  const executeRegisteredById = async (type, args, session, readOptions) => {
    const operation = 'get_by_id';
    const params = {
      type,
      operation,
      context: readOptions.context,
      args: { id: coerceInputValue(args.id, new GraphQLNonNull(GraphQLID)) },
    };
    await executeMiddleware(params);
    if (!getScope(type.gqltype, operation)) {
      return adapter.getById(type.model, params.args.id, session, readOptions);
    }
    const queryArgs = { id: { operator: 'EQ', value: params.args.id } };
    await executeScope({ ...params, args: queryArgs });
    const rows = await adapter.find(type.model, type.gqltype, queryArgs, session, readOptions);
    return rows[0] || null;
  };

  const executeRegisteredQuery = async (type, operation, args, options, readOptions) => {
    const queryArgs = { ...args };
    const scopeOperation = operation === 'count' ? 'find' : operation;
    const joinedScopes = inspectClientPaths(type.gqltype, queryArgs, scopeOperation);
    const params = {
      type,
      args: queryArgs,
      context: options.context,
      operation: scopeOperation,
    };
    await executeMiddleware(params);
    await executeScope({ ...params, operation: scopeOperation });
    await applyJoinedScopes(joinedScopes, params);
    const executionOptions = { ...readOptions };
    return adapter[operation](
      type.model,
      type.gqltype,
      params.args,
      options.session,
      executionOptions,
    );
  };

  // Server entry point for the generated lifecycle, without captured resolvers.
  const execute = async (typeName, operation, args = {}, options = {}) => {
    const type = registered(typeName);
    validateServerExecution(type, options);
    const storage = registeredStorageOptions(type, operation, options.storage);
    if (REGISTERED_WRITE_OPERATIONS.has(operation)) {
      return executeRegisteredWrite(typeName, type, operation, args, options, storage);
    }
    if (!REGISTERED_READ_OPERATIONS.has(operation)) {
      throw new SimfinityError('Unsupported registered operation', 'INVALID_OPERATION', 400);
    }
    const readOptions = {
      context: options.context,
      readOptions: options.readOptions,
      observer: options.observer,
    };
    if (operation === 'get_by_id') {
      return executeRegisteredById(type, args, options.session, readOptions);
    }
    return executeRegisteredQuery(type, operation, args, options, readOptions);
  };

  return { execute };
};
