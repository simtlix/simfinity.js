import { analyze } from '../analysis.js';
import { buildModelGraph } from '../model-analysis.js';

export default {
  meta: {
    type: 'problem',
    docs: { description: 'Keep the identity of a Simfinity schema and its introspection types', url: 'https://simtlix.github.io/simfinity.js/guide/linting#no-schema-cloning' },
    schema: [],
    messages: {
      invalid: 'Do not pass a Simfinity schema to {{name}}: rebuilding it duplicates injected introspection types. Use Envelop plugins or in-place resolver wrapping.',
      introspection: 'Do not reconstruct this same-process Simfinity 3.8 introspection with buildClientSchema: its metadata types duplicate the installed introspection types. Keep the existing schema or reconstruct the client schema in a separate process.',
    },
  },
  create(context) {
    const analysis = analyze(context);
    const reported = new Set();
    return {
      CallExpression(node) {
        if (node.arguments.some(argument => argument.type === 'SpreadElement')) return;
        const callee = analysis.origin(node.callee);
        if (callee?.kind === 'cloner' && analysis.origin(node.arguments[0])?.kind === 'schema') {
          context.report({ node, messageId: 'invalid', data: { name: callee.name } });
          reported.add(node);
        }
      },
      'Program:exit'() {
        const graph = buildModelGraph(context);
        const model = graph.analysis;
        const imported = (input, name) => {
          const origin = model.origin(input);
          return origin?.kind === 'graphql' && origin.name === name;
        };
        // toConfig retains the original type objects; constructing this schema
        // is legal, but feeding it to a type-cloning tool still loses identity.
        const schema = (input, depth = 0) => {
          if (depth >= 40) return false;
          const node = model.resolve(input);
          if (model.origin(node)?.kind === 'schema') return true;
          if (node?.type !== 'NewExpression' || !imported(node.callee, 'GraphQLSchema')
            || node.arguments.length !== 1) return false;
          const config = model.resolve(node.arguments[0]);
          return config?.type === 'CallExpression' && config.arguments.length === 0
            && config.callee.type === 'MemberExpression' && !config.callee.computed
            && config.callee.property.name === 'toConfig' && schema(config.callee.object, depth + 1);
        };
        const introspection = input => {
          const node = model.resolve(input);
          if (node?.type === 'CallExpression' && !node.arguments.some(arg => arg.type === 'SpreadElement')
            && imported(node.callee, 'introspectionFromSchema')) return schema(node.arguments[0]);
          if (node?.type !== 'MemberExpression' || node.computed || node.property.name !== 'data') return false;
          const call = model.resolve(node.object);
          if (call?.type !== 'CallExpression' || call.arguments.length !== 1 || !imported(call.callee, 'graphqlSync')) return false;
          const options = model.properties(call.arguments[0]);
          const query = model.resolve(options?.get('source'));
          return query?.type === 'CallExpression' && !query.arguments.some(arg => arg.type === 'SpreadElement')
            && imported(query.callee, 'getIntrospectionQuery') && schema(options?.get('schema'));
        };
        for (const node of graph.calls) {
          if (reported.has(node) || node.arguments.some(arg => arg.type === 'SpreadElement')) continue;
          const callee = model.origin(node.callee);
          if (callee?.kind === 'cloner' && schema(node.arguments[0])) {
            context.report({ node, messageId: 'invalid', data: { name: callee.name } });
          } else if (imported(node.callee, 'buildClientSchema') && introspection(node.arguments[0])) {
            context.report({ node, messageId: 'introspection' });
          }
        }
      },
    };
  },
};
