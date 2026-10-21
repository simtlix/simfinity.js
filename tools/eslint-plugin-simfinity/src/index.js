import noSchemaCloning from './rules/no-schema-cloning.js';
import noUncalledAuthFactory from './rules/no-uncalled-auth-factory.js';
import validDefaultPolicy from './rules/valid-default-policy.js';
import validQueryLimits from './rules/valid-query-limits.js';
import validConnectionField from './rules/valid-connection-field.js';
import validPermissions from './rules/valid-permissions.js';
import validAuthComposition from './rules/valid-auth-composition.js';
import validRequiredClaims from './rules/valid-required-claims.js';
import noAsyncAuthExtractor from './rules/no-async-auth-extractor.js';
import noAuthPluginAsMiddleware from './rules/no-auth-plugin-as-middleware.js';
import validPolicyExpression from './rules/valid-policy-expression.js';

const plugin = {
  meta: { name: '@simtlix/eslint-plugin-simfinity', version: '0.2.0', namespace: 'simfinity' },
  rules: {
    'no-schema-cloning': noSchemaCloning,
    'no-uncalled-auth-factory': noUncalledAuthFactory,
    'valid-default-policy': validDefaultPolicy,
    'valid-query-limits': validQueryLimits,
    'valid-connection-field': validConnectionField,
    'valid-permissions': validPermissions,
    'valid-auth-composition': validAuthComposition,
    'valid-required-claims': validRequiredClaims,
    'no-async-auth-extractor': noAsyncAuthExtractor,
    'no-auth-plugin-as-middleware': noAuthPluginAsMiddleware,
    'valid-policy-expression': validPolicyExpression,
  },
  configs: {},
};

plugin.configs['recommended-3.8'] = {
  name: 'simfinity/recommended-3.8',
  plugins: { simfinity: plugin },
  rules: Object.fromEntries(Object.keys(plugin.rules).map(name => [`simfinity/${name}`, 'error'])),
};

export default plugin;
