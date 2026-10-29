import { buildModelGraph } from './model-analysis.js';

export const makeModelRule = (name, description, messages, inspect, mode = 'errors') => ({
  meta: {
    type: mode === 'warnings' ? 'suggestion' : 'problem',
    docs: { description, url: `https://simtlix.github.io/simfinity.js/guide/linting#${name}` },
    schema: [], messages,
  },
  create(context) {
    return {
      'Program:exit'() {
        const diagnostics = inspect(buildModelGraph(context))[mode];
        const seen = new Set();
        for (const diagnostic of diagnostics) {
          const identity = `${diagnostic.node.range?.join(':')}:${diagnostic.messageId}:${JSON.stringify(diagnostic.data)}`;
          if (seen.has(identity)) continue;
          seen.add(identity);
          context.report(diagnostic);
        }
      },
    };
  },
});
