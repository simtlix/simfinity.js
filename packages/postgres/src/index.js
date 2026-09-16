import { createSQL } from '@simtlix/simfinity-sql';
import { postgresPlugin } from './plugin.js';
import { initializeDatabase as initializeSchema } from './schema/initialize.js';

export { postgresPlugin } from './plugin.js';
export { describeDatabase } from './schema/describe.js';
export { compileDatabaseSchema } from './schema/ddl.js';
export {
  auth,
  buildErrorFormatter,
  createValidatedScalar,
  InternalServerError,
  plugins,
  scalars,
  SimfinityError,
  validators,
} from '@simtlix/simfinity-core';

/** Each instance permanently binds one pool/schema; getModel exposes PostgreSQL native helpers. */
export const createPostgres = (options) => createSQL({ plugin: postgresPlugin(options) });
const defaultInstance = createPostgres();
export const { configureQueryLimits, configure, connect, addNoEndpointType, createSchema, getModel, getType, getInputType, getRegistrations, use, registerMutation, saveObject, preventCreatingCollection, withTransaction } = defaultInstance;

/** Preserve the foundation low-level API while allowing initialization of the configured default instance. */
export const initializeDatabase = (poolOrOptions, description, options) => description
  ? initializeSchema(poolOrOptions, description, options)
  : defaultInstance.initializeDatabase(poolOrOptions);
