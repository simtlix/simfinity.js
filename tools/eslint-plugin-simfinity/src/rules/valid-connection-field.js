import { analyze, unwrap } from '../analysis.js';
import { buildModelGraph } from '../model-analysis.js';
import { messages, connectionDiagnostics } from '../model-storage.js';

export default {
  meta: {
    type: 'problem',
    docs: { description: 'Use field names for registered relation links under Simfinity 3.8', url: 'https://simtlix.github.io/simfinity.js/guide/linting#valid-connection-field' },
    schema: [],
    messages: {
      invalid: 'Simfinity 3.8 connectionField must name a field, not a dotted path or a non-string value. Declare a reference belonging to an embedded value inside that embedded type.',
      missing: 'A writable referenced object collection without its own resolver requires a nonempty connectionField. Declare the child field that links each item to its parent.',
      storageMissingConnection: messages.storageMissingConnection,
    },
  },
  create(context) {
    const analysis = analyze(context);
    const calls = [];
    const visited = new Set();
    const registered = new Set();
    const reported = new Set();
    const report = diagnostic => {
      if (!reported.has(diagnostic.node)) context.report(diagnostic);
      reported.add(diagnostic.node);
    };
    const constructed = (input, name) => {
      const node = analysis.resolve(input);
      if (node?.type !== 'NewExpression' || node.arguments.some(argument => argument.type === 'SpreadElement')) return null;
      const constructor = analysis.origin(node.callee);
      return constructor?.kind === 'graphql' && constructor.name === name ? node : null;
    };
    const nullable = input => constructed(input, 'GraphQLNonNull')?.arguments[0] ?? input;
    const isObjectCollection = input => {
      const list = constructed(nullable(input), 'GraphQLList');
      return !!list && !!constructed(nullable(list.arguments[0]), 'GraphQLObjectType');
    };
    const valueOrAbsent = input => input ? analysis.value(input) : { known: true, value: undefined };
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
    const inspectType = (input, directlyRegistered = false) => {
      const type = analysis.resolve(input);
      const seen = visited.has(type);
      const checkRequired = directlyRegistered && !registered.has(type);
      if (!type || (seen && !checkRequired) || (!seen && visited.size >= 200)) return;
      visited.add(type);
      if (checkRequired) registered.add(type);
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
          if (!seen) inspectType(config?.get('type'));
          continue;
        }
        const connection = relation.get('connectionField');
        const result = valueOrAbsent(connection);
        if (result.known && result.value !== null && result.value !== undefined
          && (typeof result.value !== 'string' || result.value.includes('.'))) {
          if (!seen) report({ node: connection, messageId: 'invalid' });
          continue;
        }
        // Core checks missing links only on registered types. Embedded traversal
        // above serves the existing plain-link check; reaching a type there must
        // not suppress its later registration or add a storage-mode assumption.
        if (!checkRequired || extension.has('virtual') || !result.known
          || (result.value !== null && result.value !== undefined && result.value !== '')
          || !isObjectCollection(config.get('type'))) continue;
        const readOnly = valueOrAbsent(extension.get('readOnly'));
        const resolver = valueOrAbsent(config.get('resolve'));
        if (readOnly.known && !readOnly.value && resolver.known && resolver.value == null) {
          report({ node: connection || extension.get('relation'), messageId: 'missing' });
        }
      }
    };
    return {
      'Program:exit'() {
        const graph = buildModelGraph(context);
        if (graph.truncated) return;
        for (const node of calls) {
          if (node.arguments.some(argument => argument.type === 'SpreadElement')) continue;
          const callee = analysis.origin(node.callee);
          if (callee?.kind !== 'runtime-function' || !graph.runtime(callee)) continue;
          if (callee.name === 'connect') inspectType(node.arguments[1], true);
          if (callee.name === 'addNoEndpointType') inspectType(node.arguments[0], true);
        }
        for (const diagnostic of connectionDiagnostics(graph)) report(diagnostic);
      },
      CallExpression(node) {
        calls.push(node);
      },
    };
  },
};
