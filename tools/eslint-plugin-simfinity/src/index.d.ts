import type { ESLint, Linter, Rule } from 'eslint';

type RuleName = 'no-schema-cloning' | 'no-uncalled-auth-factory'
  | 'valid-default-policy' | 'valid-query-limits' | 'valid-connection-field';

declare const plugin: ESLint.Plugin & {
  rules: Record<RuleName, Rule.RuleModule>;
  configs: { 'recommended-3.8': Linter.Config };
};

export default plugin;
