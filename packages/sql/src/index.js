import { auth, createRuntime, plugins, scalars, validators } from '@simtlix/simfinity-core';
import { createSQLAdapter } from './adapter.js';

export { planRelationalSchema } from './schema/plan.js';
export { auth, buildErrorFormatter, createValidatedScalar, InternalServerError, plugins, scalars, SimfinityError, validators } from '@simtlix/simfinity-core';

/** Create a runtime permanently bound to one SQL plugin and configuration. */
export const createSQL = ({ plugin } = {}) => {
  const adapter = createSQLAdapter(plugin);
  const runtime = createRuntime(adapter);
  return {
    ...runtime,
    auth,
    configure: (configuration) => adapter.configure(configuration),
    initializeDatabase: (initialization) => adapter.initialize(initialization),
    describeDatabase: () => adapter.describeDatabase(),
    plugins,
    scalars,
    validators,
    withTransaction: (session, callback) => adapter.withTransaction(session, callback),
  };
};
