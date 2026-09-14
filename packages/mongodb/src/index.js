import {
  InternalServerError,
  SimfinityError,
  buildErrorFormatter,
  createRuntime,
  createValidatedScalar,
} from '@simtlix/simfinity-core';

import { createMongoAdapter } from './mongo/adapter.js';

const mongoAdapter = createMongoAdapter();
const runtime = createRuntime(mongoAdapter);

export const configureQueryLimits = runtime.configureQueryLimits;
export const connect = runtime.connect;
export const addNoEndpointType = runtime.addNoEndpointType;
export const createSchema = runtime.createSchema;
export const getModel = runtime.getModel;
export const getType = runtime.getType;
export const getInputType = runtime.getInputType;
export const getRegistrations = runtime.getRegistrations;
export const use = runtime.use;
export const registerMutation = runtime.registerMutation;
export const saveObject = runtime.saveObject;
export const preventCreatingCollection = runtime.preventCreatingCollection;

export const buildQuery = (...args) => mongoAdapter.buildQuery(...args);
export const buildFilterGroupMatch = (...args) => mongoAdapter.buildFilterGroupMatch(...args);

export {
  buildErrorFormatter,
  createMongoAdapter,
  createRuntime,
  createValidatedScalar,
  InternalServerError,
  SimfinityError,
};

export { default as validators } from './validators.js';
export { default as scalars } from './scalars.js';
export { default as plugins } from './plugins.js';
export { default as auth } from './auth/index.js';
export { default as mcp } from './mcp.js';
export {
  generateMCPTools,
  graphqlArgsToJSONSchema,
  createMCPServer,
  startStdioMCPServer,
  createHTTPMCPHandler,
} from './mcp.js';
