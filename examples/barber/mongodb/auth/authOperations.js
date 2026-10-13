import { GraphQLError, Kind } from 'graphql';

// Mutations that check or hash a password, or issue tokens. They are GraphQL-only: MCP does not
// publish them as tools (see mcpOptions in application.js), and one request may run only one of them.
export const AUTH_OPERATIONS = Object.freeze(['login', 'register', 'registerOwner', 'refreshSession']);
const AUTH_FIELDS = new Set(AUTH_OPERATIONS);

function countAuthFields(selectionSet, fragments, visited) {
  let count = 0;
  for (const selection of selectionSet.selections) {
    if (selection.kind === Kind.FIELD) {
      if (AUTH_FIELDS.has(selection.name.value)) count += 1;
    } else if (selection.kind === Kind.INLINE_FRAGMENT) {
      count += countAuthFields(selection.selectionSet, fragments, visited);
    } else if (selection.kind === Kind.FRAGMENT_SPREAD) {
      const fragment = fragments.get(selection.name.value);
      if (fragment && !visited.has(fragment)) {
        visited.add(fragment);
        count += countAuthFields(fragment.selectionSet, fragments, visited);
      }
    }
  }
  return count;
}

/**
 * Validation rule: a mutation may select at most one auth field, through aliases, inline fragments
 * or fragment spreads, so one rate-limited request cannot run many password checks.
 */
export function SingleAuthOperationRule(context) {
  return {
    OperationDefinition(node) {
      if (node.operation !== 'mutation') return;
      const fragments = new Map(context.getDocument().definitions
        .filter((definition) => definition.kind === Kind.FRAGMENT_DEFINITION)
        .map((definition) => [definition.name.value, definition]));
      if (countAuthFields(node.selectionSet, fragments, new Set()) > 1) {
        context.reportError(new GraphQLError(
          `A request may run only one of ${AUTH_OPERATIONS.join(', ')}.`,
          { nodes: [node], extensions: { code: 'AUTH_OPERATION_LIMIT' } },
        ));
      }
    },
  };
}

/** Envelop/Yoga plugin that adds SingleAuthOperationRule to request validation. */
export const useSingleAuthOperation = () => ({
  onValidate({ addValidationRule }) {
    addValidationRule(SingleAuthOperationRule);
  },
});
