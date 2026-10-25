// This is deliberately a local syntax analysis, not a JavaScript interpreter.
const roots = new Map([
  ['@simtlix/simfinity-core', 'core'],
  ['@simtlix/simfinity-js', 'mongo'],
  ['@simtlix/simfinity-js/src', 'mongo'],
  ['@simtlix/simfinity-js/src/index.js', 'mongo'],
  ['@simtlix/simfinity-js/src/index', 'mongo'],
  ['@simtlix/simfinity-sql', 'sql'],
  ['@simtlix/simfinity-postgres', 'postgres'],
]);
export const factories = new Set([
  'requireAuth', 'requireRole', 'requirePermission', 'isOwner', 'allow', 'deny',
  'createRule', 'createRuleFromExpression', 'composeRules', 'anyRule',
]);
const runtimeMembers = new Set(['createSchema', 'connect', 'addNoEndpointType', 'configureQueryLimits']);
const otherRuntimeMembers = new Set([
  'configureMutationLimits', 'configureAfterCommit', 'getModel', 'getType', 'getInputType', 'getRegistrations',
  'use', 'registerMutation', 'registerCustomQuery', 'registerView', 'saveObject', 'preventCreatingCollection',
]);
const sqlMembers = new Set(['configure', 'initializeDatabase', 'describeDatabase', 'compileDatabaseSchema', 'withTransaction']);
const wrappers = new Set(['TSAsExpression', 'TSTypeAssertion', 'TSNonNullExpression', 'TSSatisfiesExpression', 'ChainExpression']);
const unknown = Object.freeze({ known: false });

export const unwrap = input => {
  let node = input;
  while (node && wrappers.has(node.type)) node = node.expression;
  return node;
};

const keyName = node => !node.computed && (node.key?.name ?? node.key?.value);
const memberName = node => !node.computed && node.property?.type === 'Identifier' ? node.property.name : null;

const isWriteTarget = expression => {
  let target = expression;
  let parent = target.parent;
  while ((parent?.type === 'Property' && parent.value === target && parent.parent.type === 'ObjectPattern')
    || ['ArrayPattern', 'ObjectPattern'].includes(parent?.type)
    || (parent?.type === 'RestElement' && parent.argument === target)
    || (parent?.type === 'AssignmentPattern' && parent.left === target)) {
    target = parent;
    parent = target.parent;
  }
  return (['AssignmentExpression', 'ForOfStatement', 'ForInStatement'].includes(parent?.type) && parent.left === target)
    || parent?.type === 'UpdateExpression'
    || (parent?.type === 'UnaryExpression' && parent.operator === 'delete');
};

const moduleInfo = source => {
  if (roots.has(source)) return { kind: 'module', name: roots.get(source) };
  if (['graphql', 'graphql-middleware', '@graphql-tools/utils'].includes(source)) return { kind: 'module', name: source };
  const match = source.match(/^@simtlix\/(?:simfinity-core\/auth|simfinity-js\/src\/auth)(?:\/(index|rules|expressions)(?:\.js)?)?$/);
  return match ? { kind: 'auth', subset: match[1] || 'index' } : null;
};

const member = (object, name) => {
  if (!object || !name) return null;
  if (object.kind === 'auth') {
    const isRule = factories.has(name) && (object.subset === 'index'
      || (object.subset === 'rules' && name !== 'createRuleFromExpression')
      || (object.subset === 'expressions' && name === 'createRuleFromExpression'));
    if (isRule || (object.subset === 'index' && name === 'createAuthPlugin')) return { kind: 'auth-function', name };
    return null;
  }
  if (object.kind === 'runtime') {
    if (name === 'auth' && object.auth) return { kind: 'auth', subset: 'index' };
    return runtimeMembers.has(name) || otherRuntimeMembers.has(name) || (object.auth && sqlMembers.has(name))
      ? { kind: 'runtime-function', name } : null;
  }
  if (object.kind !== 'module') return null;
  if (['core', 'mongo', 'sql', 'postgres'].includes(object.name) && name === 'auth') return { kind: 'auth', subset: 'index' };
  if ((['mongo', 'postgres'].includes(object.name) && (runtimeMembers.has(name) || otherRuntimeMembers.has(name)))
    || (object.name === 'postgres' && sqlMembers.has(name))
    || (object.name === 'core' && name === 'configureQueryLimits')) return { kind: 'runtime-function', name };
  if ((['core', 'mongo'].includes(object.name) && name === 'createRuntime')
    || (object.name === 'sql' && name === 'createSQL')
    || (object.name === 'postgres' && name === 'createPostgres')) return { kind: 'runtime-factory', auth: name !== 'createRuntime' };
  if (object.name === 'graphql' && ['GraphQLObjectType', 'GraphQLList', 'GraphQLNonNull'].includes(name)) return { kind: 'graphql', name };
  if ((object.name === 'graphql-middleware' && name === 'applyMiddleware')
    || (object.name === '@graphql-tools/utils' && name === 'mapSchema')) return { kind: 'cloner', name };
  return null;
};

export const analyze = context => {
  const source = context.sourceCode;
  const variableFor = node => {
    for (let scope = source.getScope(node); scope; scope = scope.upper) {
      const variable = scope.set.get(node.name);
      if (variable) return variable;
    }
    return null;
  };

  // A binding is not an immutable object. Reject member writes, alias writes and
  // escapes to unknown functions before assigning an import/runtime identity.
  const evaluating = new Set();
  const stable = (variable, seen = new Set()) => {
    if (seen.has(variable) || evaluating.has(variable)) return true;
    if (seen.size >= 40 || evaluating.size >= 40) return false;
    evaluating.add(variable);
    try {
      return inspectStable(variable, new Set([...seen, variable]));
    } finally {
      evaluating.delete(variable);
    }
  };

  // registerView(name, { type }) only reads the type to publish a root query field.
  // The options may be wrapped (`as`, `satisfies`, `!`), and the callee must be a
  // stable runtime function, like any other known consumer of a type.
  const isViewType = property => {
    let options = property.parent;
    while (wrappers.has(options?.parent?.type) && options.parent.expression === options) options = options.parent;
    const call = options?.parent;
    if (property.type !== 'Property' || keyName(property) !== 'type'
      || call?.type !== 'CallExpression' || call.arguments[1] !== options) return false;
    const callee = origin(call.callee);
    return callee?.kind === 'runtime-function' && callee.name === 'registerView';
  };

  const inspectStable = (variable, seen) => {
    const [definition] = variable.defs;
    const rawOrigin = definition?.type === 'ImportBinding'
      ? importOrigin(definition)
      : declarationOrigin(definition, variable.name, new Set(), false);
    const container = ['module', 'auth', 'runtime'].includes(rawOrigin?.kind)
      || resolve(definition?.node.init, new Set(), false)?.type === 'NewExpression';
    for (const ref of variable.references) {
      if (ref.isWrite() && !ref.init) return false;
      if (!ref.isRead()) continue;
      let expression = ref.identifier;
      let parent = expression.parent;
      while ((parent?.type === 'MemberExpression' && parent.object === expression)
        || (wrappers.has(parent?.type) && parent.expression === expression)) {
        expression = parent;
        parent = expression.parent;
      }
      if (isWriteTarget(expression)) return false;
      if (parent?.type === 'VariableDeclarator' && parent.init === expression) {
        if (!['Identifier', 'ObjectPattern'].includes(parent.id.type) || parent.parent.kind !== 'const') return false;
        const aliases = source.getDeclaredVariables(parent);
        if (aliases.some(alias => !stable(alias, seen))) return false;
      }
      if ((parent?.type === 'CallExpression' || parent?.type === 'NewExpression') && parent.callee !== expression) {
        // These known consumers read declarations/functions; arbitrary calls may
        // replace methods or mutate a type's field configuration.
        const callee = origin(parent.callee);
        if (!callee || !['auth-function', 'runtime-function', 'cloner', 'graphql'].includes(callee.kind)) return false;
      }
      if (parent?.type === 'CallExpression' && parent.callee === expression && expression.type === 'MemberExpression') {
        const name = memberName(expression);
        if (!name || ![...runtimeMembers, ...otherRuntimeMembers, ...sqlMembers, ...factories, 'createAuthPlugin', 'createRuntime', 'createSQL', 'createPostgres'].includes(name)) return false;
      }
      if (parent?.type === 'ReturnStatement' || parent?.type === 'SpreadElement'
        || (parent?.type === 'AssignmentExpression' && parent.right === expression)) return false;
      const exposesContainer = expression === ref.identifier ? container
        : ['module', 'auth', 'runtime'].includes(origin(expression, new Set(), false)?.kind);
      if (exposesContainer && (parent?.type === 'Property' || parent?.type === 'ArrayExpression')) {
        // A type in a local GraphQL field declaration, or as the `type` of
        // registerView's options, is a known read. Other containers may expose
        // this object to arbitrary mutation through aliases.
        let constructor = parent;
        while (constructor && !['NewExpression', 'Program'].includes(constructor.type)) constructor = constructor.parent;
        if (!isViewType(parent) && (keyName(parent) !== 'type' || constructor?.type !== 'NewExpression'
          || origin(constructor.callee, new Set(), false)?.kind !== 'graphql')) return false;
      }
    }
    return true;
  };

  const resolve = (input, seen = new Set(), checkStability = true) => {
    const node = unwrap(input);
    if (node?.type !== 'Identifier') return node;
    const variable = variableFor(node);
    if (!variable || seen.has(variable) || seen.size >= 40) return node;
    const [def] = variable.defs;
    if (def?.type !== 'Variable' || def.parent.kind !== 'const' || def.node.id.type !== 'Identifier'
      || (checkStability && !stable(variable))) return node;
    return resolve(def.node.init, new Set([...seen, variable]), checkStability);
  };

  function importOrigin(def) {
    if (def.parent.importKind === 'type' || def.node.importKind === 'type') return null;
    const module = moduleInfo(def.parent.source.value);
    if (def.node.type === 'ImportNamespaceSpecifier') return module;
    if (def.node.type === 'ImportDefaultSpecifier') return module?.kind === 'auth' ? module : null;
    return member(module, def.node.imported.name ?? def.node.imported.value);
  }

  function declarationOrigin(def, name, seen, checkStability) {
    if (def?.type !== 'Variable' || def.parent.kind !== 'const') return null;
    if (def.node.id.type === 'Identifier') return origin(def.node.init, seen, checkStability);
    if (def.node.id.type !== 'ObjectPattern') return null;
    const property = def.node.id.properties.find(prop => prop.type === 'Property' && prop.value.type === 'Identifier' && prop.value.name === name);
    return property ? member(origin(def.node.init, seen, checkStability), keyName(property)) : null;
  }

  function origin(input, seen = new Set(), checkStability = true) {
    const node = unwrap(input);
    if (!node || seen.size >= 40) return null;
    if (node.type === 'Identifier') {
      const variable = variableFor(node);
      if (!variable || seen.has(variable)) return null;
      const [def] = variable.defs;
      const next = new Set([...seen, variable]);
      if (def?.type === 'ImportBinding') {
        return !checkStability || stable(variable, new Set(seen)) ? importOrigin(def) : null;
      }
      if (def?.type === 'Variable' && (!checkStability || stable(variable, new Set(seen)))) return declarationOrigin(def, variable.name, next, checkStability);
      return null;
    }
    if (node.type === 'MemberExpression') return member(origin(node.object, seen, checkStability), memberName(node));
    if (node.type === 'CallExpression') {
      if (node.arguments.some(argument => argument.type === 'SpreadElement')) return null;
      const callee = origin(node.callee, seen, checkStability);
      if (callee?.kind === 'runtime-factory') return { kind: 'runtime', auth: callee.auth };
      if (callee?.kind === 'runtime-function' && callee.name === 'createSchema') return { kind: 'schema' };
    }
    return null;
  }

  const value = input => {
    const node = resolve(input);
    if (!node) return unknown;
    if (node.type === 'Literal') return { known: true, value: node.value };
    if (['ObjectExpression', 'ArrayExpression'].includes(node.type)) return { known: true, value: {} };
    if (node.type === 'TemplateLiteral' && node.expressions.length === 0) return { known: true, value: node.quasis[0].value.cooked };
    if (node.type === 'Identifier' && (!variableFor(node) || variableFor(node).defs.length === 0)) {
      if (node.name === 'undefined') return { known: true, value: undefined };
      if (node.name === 'NaN') return { known: true, value: NaN };
      if (node.name === 'Infinity') return { known: true, value: Infinity };
    }
    if (node.type === 'UnaryExpression' && ['-', '+'].includes(node.operator)) {
      const operand = value(node.argument);
      if (operand.known && typeof operand.value === 'number') return { known: true, value: node.operator === '-' ? -operand.value : operand.value };
    }
    return unknown;
  };

  // Objects intentionally must be inline. A const object can be mutated through
  // arbitrary code; primitive const aliases are safe to evaluate separately.
  const properties = input => {
    const node = unwrap(input);
    if (node?.type !== 'ObjectExpression') return null;
    const entries = new Map();
    for (const prop of node.properties) {
      const key = keyName(prop);
      if (prop.type !== 'Property' || prop.kind !== 'init' || prop.method || key === false || key === undefined || key === null || key === '__proto__') return null;
      entries.set(String(key), prop.value);
    }
    return entries;
  };

  return { origin, resolve, value, properties };
};
