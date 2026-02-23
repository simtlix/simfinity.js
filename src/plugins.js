import { createAuthPlugin } from './auth/index.js';

export { createAuthPlugin } from './auth/index.js';

/**
 * Apollo Server plugin to add count to GraphQL response extensions
 * @returns {Object} Apollo Server plugin
 */
export const apolloCountPlugin = () => {
  return {
    async requestDidStart() {
      return {
        async willSendResponse({ contextValue, response }) {
          if (response.body.kind === 'single' && contextValue?.count) {
            response.body.singleResult.extensions = {
              ...(response.body.singleResult.extensions || {}),
              count: contextValue.count,
            };
          }
        },
      };
    },
  };
};

/**
 * Envelop plugin to add count to GraphQL response extensions
 * @returns {Object} Envelop plugin
 */
export const envelopCountPlugin = () => {
  return {
    onExecute() {
      return {
        onExecuteDone({ result, args }) {
          if (args.contextValue?.count) {
            result.extensions = {
              ...result.extensions,
              count: args.contextValue.count,
            };
          }
        },
      };
    },
  };
};

const plugins = {
  createAuthPlugin,
  apolloCountPlugin,
  envelopCountPlugin,
};

export default plugins;
