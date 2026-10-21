import type { ESLint, Linter, Rule } from 'eslint';

type RuleName = 'no-schema-cloning' | 'no-uncalled-auth-factory'
  | 'valid-default-policy' | 'valid-query-limits' | 'valid-connection-field'
  | 'valid-permissions' | 'valid-auth-composition' | 'valid-required-claims'
  | 'no-async-auth-extractor' | 'no-auth-plugin-as-middleware' | 'valid-policy-expression';

declare const plugin: ESLint.Plugin & {
  rules: Record<RuleName, Rule.RuleModule>;
  configs: { 'recommended-3.8': Linter.Config };
};

export default plugin;
