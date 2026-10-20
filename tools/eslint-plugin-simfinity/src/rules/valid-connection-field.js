import { analyze, unwrap } from '../analysis.js';

export default {
  meta: {
    type: 'problem',
    docs: { description: 'Use field names for registered relation links under Simfinity 3.8', url: 'https://simtlix.github.io/simfinity.js/guide/linting#valid-connection-field' },
    schema: [],
    messages: { invalid: 'Simfinity 3.8 connectionField must name a field, not a dotted path or a non-string value. Declare a reference belonging to an embedded value inside that embedded type.' },
  },
  create(context) {
    const analysis = analyze(context);
    const visited = new Set();
    const fieldsOf = node => {
      const fields = unwrap(node);
      if (['ArrowFunctionExpression', 'FunctionExpression'].includes(fields?.type)) {
        if (fields.async || fields.generator || fields.params.length) return null;
        if (fields.body.type !== 'BlockStatement') return analysis.properties(fields.body);
        const [statement] = fields.body.body;
        return fields.body.body.length === 1 && statement.type === 'ReturnStatement' ? analysis.properties(statement.argument) : null;
      }
      return analysis.properties(fields);
    };
    const inspectType = input => {
      const type = analysis.resolve(input);
      if (!type || visited.has(type) || visited.size >= 200) return;
      visited.add(type);
      if (type.type !== 'NewExpression' || type.arguments.some(argument => argument.type === 'SpreadElement')) return;
      const constructor = analysis.origin(type.callee);
      if (constructor?.kind !== 'graphql') return;
      if (['GraphQLList', 'GraphQLNonNull'].includes(constructor.name)) {
        inspectType(type.arguments[0]);
        return;
      }
      if (constructor.name !== 'GraphQLObjectType') return;
      const fields = fieldsOf(analysis.properties(type.arguments[0])?.get('fields'));
      for (const field of fields?.values() || []) {
        const config = analysis.properties(field);
        const extension = analysis.properties(config?.get('extensions'));
        const relation = analysis.properties(extension?.get('relation'));
        if (!relation) continue;
        const embeddedNode = relation.get('embedded');
        const embedded = embeddedNode ? analysis.value(embeddedNode) : { known: true, value: false };
        if (!embedded.known) continue;
        if (embedded.value) {
          inspectType(config?.get('type'));
          continue;
        }
        const connection = relation.get('connectionField');
        const result = analysis.value(connection);
        if (result.known && result.value !== null && result.value !== undefined
          && (typeof result.value !== 'string' || result.value.includes('.'))) context.report({ node: connection, messageId: 'invalid' });
      }
    };
    return {
      CallExpression(node) {
        if (node.arguments.some(argument => argument.type === 'SpreadElement')) return;
        const callee = analysis.origin(node.callee);
        if (callee?.kind !== 'runtime-function') return;
        if (callee.name === 'connect') inspectType(node.arguments[1]);
        if (callee.name === 'addNoEndpointType') inspectType(node.arguments[0]);
      },
    };
  },
};
