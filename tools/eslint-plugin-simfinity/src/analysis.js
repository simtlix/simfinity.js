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
  if (/^@simtlix\/(?:simfinity-core\/scalars|simfinity-js\/src\/scalars)(?:\.js)?$/.test(source)) return { kind: 'module', name: 'scalars' };
  if (/^@simtlix\/simfinity-js\/src\/mongo\/adapter(?:\.js)?$/.test(source)) return { kind: 'module', name: 'mongo-adapter' };
  if (source === 'graphql-iso-date') return { kind: 'module', name: 'dates' };
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
      ? { kind: 'runtime-function', name, owner: object } : null;
  }
  if (object.kind !== 'module') return null;
  if (['core', 'mongo', 'sql', 'postgres'].includes(object.name) && name === 'auth') return { kind: 'auth', subset: 'index' };
  if ((['mongo', 'postgres'].includes(object.name) && (runtimeMembers.has(name) || otherRuntimeMembers.has(name)))
    || (object.name === 'postgres' && sqlMembers.has(name))
    || (object.name === 'core' && name === 'configureQueryLimits')) return { kind: 'runtime-function', name, owner: object };
  if ((['core', 'mongo'].includes(object.name) && name === 'createRuntime')
    || (object.name === 'sql' && name === 'createSQL')
    || (object.name === 'postgres' && name === 'createPostgres')) return { kind: 'runtime-factory', name, module: object.name, auth: name !== 'createRuntime' };
  if (['mongo', 'mongo-adapter'].includes(object.name) && name === 'createMongoAdapter') return { kind: 'adapter-factory', name };
  if (['core', 'mongo'].includes(object.name) && name === 'scalars') return { kind: 'module', name: 'scalars' };
  if ((['core', 'mongo', 'scalars'].includes(object.name) && name === 'createValidatedScalar')
    || (object.name === 'scalars' && ['createBoundedStringScalar', 'createPatternStringScalar', 'createBoundedIntScalar', 'createBoundedFloatScalar'].includes(name))) return { kind: 'scalar-factory', name };
  if (object.name === 'scalars' && ['EmailScalar', 'URLScalar', 'PositiveIntScalar', 'PositiveFloatScalar'].includes(name)) return { kind: 'scalar', name };
  if (object.name === 'dates' && ['GraphQLDateTime', 'GraphQLDate', 'GraphQLTime'].includes(name)) return { kind: 'date-scalar', name: name.slice(7) };
  if (object.name === 'graphql' && ['GraphQLObjectType', 'GraphQLList', 'GraphQLNonNull', 'GraphQLScalarType', 'GraphQLEnumType', 'GraphQLInterfaceType', 'GraphQLUnionType', 'GraphQLSchema', 'GraphQLString', 'GraphQLID', 'GraphQLInt', 'GraphQLFloat', 'GraphQLBoolean', 'buildClientSchema', 'introspectionFromSchema', 'getIntrospectionQuery', 'graphqlSync'].includes(name)) return { kind: 'graphql', name };
  if ((object.name === 'graphql-middleware' && name === 'applyMiddleware')
    || (object.name === '@graphql-tools/utils' && name === 'mapSchema')) return { kind: 'cloner', name };
  return null;
};

export const analyze = (context, options = {}) => {
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

  // Lists, non-null wrappers and object fields retain their type objects. A
  // known constructor is safe only while the resulting container stays stable:
  // mutating wrapper.ofType or container.getFields() can mutate the input type.
  const stableGraphQLContainer = (input, seen, depth = 0) => {
    if (depth >= 40) return false;
    // Introspection produces data, not aliases to the original type objects.
    if (options.model && input.type === 'CallExpression'
      && origin(input.callee)?.name === 'introspectionFromSchema') return true;
    let expression = input;
    while (wrappers.has(expression.parent?.type) && expression.parent.expression === expression) expression = expression.parent;
    const parent = expression.parent;
    if (parent?.type === 'VariableDeclarator' && parent.init === expression) {
      return parent.parent.kind === 'const' && parent.id.type === 'Identifier'
        && source.getDeclaredVariables(parent).every(variable => stable(variable, seen));
    }
    if (['CallExpression', 'NewExpression'].includes(parent?.type) && parent.callee !== expression) {
      const callee = origin(parent.callee);
      if (callee?.kind === 'runtime-function') return true;
      if (options.model && (callee?.kind === 'cloner'
        || (callee?.kind === 'graphql' && callee.name === 'introspectionFromSchema'))) return true;
      return parent.type === 'NewExpression' && callee?.kind === 'graphql'
        && stableGraphQLContainer(parent, seen, depth + 1);
    }
    if (parent?.type === 'Property' && parent.value === expression && keyName(parent) === 'type') {
      if (isViewType(parent)) return true;
      let constructor = parent;
      while (constructor && !['NewExpression', 'Program'].includes(constructor.type)) constructor = constructor.parent;
      return constructor?.type === 'NewExpression' && origin(constructor.callee, new Set(), false)?.kind === 'graphql'
        && stableGraphQLContainer(constructor, seen, depth + 1);
    }
    // External mutation through exports is outside the local proof model.
    return ['ExpressionStatement', 'ExportDefaultDeclaration'].includes(parent?.type);
  };

  const stableReflection = (input, seen, depth = 0) => {
    if (depth >= 40) return false;
    let expression = input;
    while ((expression.parent?.type === 'MemberExpression' && expression.parent.object === expression)
      || (wrappers.has(expression.parent?.type) && expression.parent.expression === expression)) expression = expression.parent;
    const parent = expression.parent;
    if (isWriteTarget(expression)) return false;
    if (parent?.type === 'VariableDeclarator' && parent.init === expression) {
      return parent.parent.kind === 'const' && source.getDeclaredVariables(parent).every(alias => stable(alias, seen));
    }
    if (['CallExpression', 'NewExpression'].includes(parent?.type)) {
      if (parent.callee === expression) return false;
      return origin(parent.callee)?.kind === 'graphql' && stableGraphQLContainer(parent, seen);
    }
    if (parent?.type === 'ExpressionStatement') return true;
    // Only field/config copies retained by a stable GraphQL constructor are
    // understood. Arbitrary helpers, returned aliases and exports may mutate.
    let owner = parent;
    while (owner && !['NewExpression', 'Program', 'VariableDeclarator'].includes(owner.type)) owner = owner.parent;
    if (owner?.type === 'NewExpression' && origin(owner.callee)?.kind === 'graphql') return stableGraphQLContainer(owner, seen);
    if (owner?.type === 'VariableDeclarator' && owner.parent.kind === 'const') return source.getDeclaredVariables(owner).every(alias => stable(alias, seen));
    return false;
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
      if (isWriteTarget(expression)) {
        // Model analysis separately validates the unique, ordered scalar hint.
        // All other member writes still invalidate the object identity.
        const allocated = resolve(definition?.node.init, new Set(), false);
        const allocatedOrigin = ['NewExpression', 'CallExpression'].includes(allocated?.type) ? origin(allocated.callee, new Set(), false) : null;
        const scalarHint = options.model && (allocatedOrigin?.name === 'GraphQLScalarType' || allocatedOrigin?.kind === 'scalar-factory')
          && expression.type === 'MemberExpression'
          && expression.object === ref.identifier && memberName(expression) === 'baseScalarType'
          && parent?.type === 'AssignmentExpression' && parent.operator === '=';
        if (!scalarHint) return false;
      }
      if (parent?.type === 'VariableDeclarator' && parent.init === expression) {
        if (!['Identifier', 'ObjectPattern'].includes(parent.id.type) || parent.parent.kind !== 'const') return false;
        const aliases = source.getDeclaredVariables(parent);
        if (aliases.some(alias => !stable(alias, seen))) return false;
      }
      if ((parent?.type === 'CallExpression' || parent?.type === 'NewExpression') && parent.callee !== expression) {
        // These known consumers read declarations/functions; arbitrary calls may
        // replace methods or mutate a type's field configuration.
        const callee = origin(parent.callee);
        if (!callee || !['auth-function', 'runtime-function', 'runtime-factory', 'adapter-factory', 'scalar-factory', 'cloner', 'graphql'].includes(callee.kind)) return false;
        if (container && callee.kind === 'graphql' && !stableGraphQLContainer(parent, seen)) return false;
      }
      if (parent?.type === 'CallExpression' && parent.callee === expression && expression.type === 'MemberExpression') {
        const name = memberName(expression);
        const reflection = options.model && ['getFields', 'toConfig'].includes(name)
          && parent.arguments.length === 0;
        if (reflection && !stableReflection(parent, seen)) return false;
        if (!reflection && (!name || ![...runtimeMembers, ...otherRuntimeMembers, ...sqlMembers, ...factories, 'createAuthPlugin', 'createRuntime', 'createSQL', 'createPostgres', 'createMongoAdapter', 'createValidatedScalar'].includes(name))) return false;
      }
      if (parent?.type === 'ReturnStatement' || parent?.type === 'SpreadElement'
        || (parent?.type === 'AssignmentExpression' && parent.right === expression
          && !(options.model && parent.operator === '=' && parent.left.type === 'MemberExpression' && memberName(parent.left) === 'baseScalarType'))) return false;
      const exposesContainer = expression === ref.identifier ? container
        : ['module', 'auth', 'runtime'].includes(origin(expression, new Set(), false)?.kind);
      if (exposesContainer && (parent?.type === 'Property' || parent?.type === 'ArrayExpression')) {
        if (options.model && parent.type === 'ArrayExpression') {
          const consumer = parent.parent;
          const called = consumer?.type === 'CallExpression' ? origin(consumer.callee) : null;
          if (called?.kind === 'runtime-function' && called.name === 'createSchema'
            && consumer.arguments.slice(0, 2).includes(parent)) continue;
          let arrayOwner = consumer;
          if (arrayOwner?.type === 'ArrowFunctionExpression' && arrayOwner.body === parent
            && !arrayOwner.async && !arrayOwner.params.length) arrayOwner = arrayOwner.parent;
          if (arrayOwner?.type === 'Property' && ['interfaces', 'types'].includes(keyName(arrayOwner))
            && arrayOwner.parent?.parent?.type === 'NewExpression'
            && origin(arrayOwner.parent.parent.callee)?.kind === 'graphql'
            && stableGraphQLContainer(arrayOwner.parent.parent, seen)) continue;
        }
        // A type in a local GraphQL field declaration, or as the `type` of
        // registerView's options, is a known read. Other containers may expose
        // this object to arbitrary mutation through aliases.
        let constructor = parent;
        while (constructor && !['NewExpression', 'Program'].includes(constructor.type)) constructor = constructor.parent;
        if (!isViewType(parent) && (keyName(parent) !== 'type' || constructor?.type !== 'NewExpression'
          || origin(constructor.callee, new Set(), false)?.kind !== 'graphql'
          || !stableGraphQLContainer(constructor, seen))) return false;
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
    if (def.node.type === 'ImportDefaultSpecifier') return module?.kind === 'auth' || module?.name === 'scalars' ? module : null;
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
      if (callee?.kind === 'runtime-factory') return { kind: 'runtime', auth: callee.auth, factory: callee.name, module: callee.module, node };
      if (callee?.kind === 'runtime-function' && callee.name === 'createSchema') return { kind: 'schema', owner: callee.owner, node };
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

  return { origin, resolve, value, properties, variableFor, stable };
};
