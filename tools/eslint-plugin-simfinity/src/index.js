import noSchemaCloning from './rules/no-schema-cloning.js';
import noUncalledAuthFactory from './rules/no-uncalled-auth-factory.js';
import validDefaultPolicy from './rules/valid-default-policy.js';
import validQueryLimits from './rules/valid-query-limits.js';
import validConnectionField from './rules/valid-connection-field.js';

const plugin = {
  meta: { name: '@simtlix/eslint-plugin-simfinity', version: '0.1.0', namespace: 'simfinity' },
  rules: {
    'no-schema-cloning': noSchemaCloning,
    'no-uncalled-auth-factory': noUncalledAuthFactory,
    'valid-default-policy': validDefaultPolicy,
    'valid-query-limits': validQueryLimits,
    'valid-connection-field': validConnectionField,
  },
  configs: {},
};

plugin.configs['recommended-3.8'] = {
  name: 'simfinity/recommended-3.8',
  plugins: { simfinity: plugin },
  rules: Object.fromEntries(Object.keys(plugin.rules).map(name => [`simfinity/${name}`, 'error'])),
};

export default plugin;
