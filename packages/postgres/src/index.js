import { createSQL } from '@simtlix/simfinity-sql';
import { postgresPlugin } from './plugin.js';
import { describeDatabase as describeSchema } from './schema/describe.js';
import { compileDatabaseSchema as compileSchemaSQL } from './schema/ddl.js';
import { initializeDatabase as initializeSchema } from './schema/initialize.js';

export { postgresPlugin } from './plugin.js';
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
export const { configureQueryLimits, configureMutationLimits, configure, connect, addNoEndpointType, createSchema, getModel, getType, getInputType, getRegistrations, use, registerMutation, saveObject, preventCreatingCollection, withTransaction } = defaultInstance;

/** Preserve the foundation low-level API while allowing initialization of the configured default instance. */
export const initializeDatabase = (poolOrOptions, description, options) => description
  ? initializeSchema(poolOrOptions, description, options)
  : defaultInstance.initializeDatabase(poolOrOptions);
/**
 * With arguments, the low-level describer, whose schema defaults to `public`; without, the configured
 * default instance's description, in the schema given to configure().
 */
export const describeDatabase = (registrations, options) => registrations === undefined && options === undefined
  ? defaultInstance.describeDatabase()
  : describeSchema(registrations, options);
/** With a description, the low-level DDL compiler; without, the configured default instance's DDL. */
export const compileDatabaseSchema = (description) => description === undefined
  ? defaultInstance.compileDatabaseSchema()
  : compileSchemaSQL(description);
