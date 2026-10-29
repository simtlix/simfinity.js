import { analyze, unwrap } from './analysis.js';

const graphs = new WeakMap();
const unknown = Object.freeze({ known: false });
const absent = Object.freeze({ known: true, value: undefined });
const truthy = Object.freeze({ known: true, value: Object.freeze({}) });
const kinds = new Map([
  ['GraphQLObjectType', 'object'], ['GraphQLScalarType', 'scalar'],
  ['GraphQLEnumType', 'enum'], ['GraphQLInterfaceType', 'interface'],
  ['GraphQLUnionType', 'union'], ['GraphQLList', 'list'], ['GraphQLNonNull', 'nonNull'],
]);
const builtinNames = new Set(['String', 'ID', 'Int', 'Float', 'Boolean']);
const key = node => !node.computed && (node.key?.name ?? node.key?.value);
const position = input => typeof input === 'number' ? input : input?.range?.[0] ?? Infinity;

// All budgets are per file. Exhaustion never proves that a registration, field,
// or dependency is absent. There is no evaluation of consumer JavaScript here.
export function buildModelGraph(context) {
  const source = context.sourceCode;
  if (graphs.has(source)) return graphs.get(source);
  const analysis = analyze(context, { model: true });
  const nodes = [];
  const calls = [];
  const assignments = [];
  let truncated = false;
  const pending = [source.ast];
  while (pending.length) {
    if (nodes.length >= 100000) { truncated = true; break; }
    const node = pending.pop();
    nodes.push(node);
    if (node.type === 'CallExpression') {
      if (calls.length >= 2000) { truncated = true; break; }
      calls.push(node);
    }
    if (node.type === 'AssignmentExpression') assignments.push(node);
    for (const name of source.visitorKeys[node.type] || []) {
      const child = node[name];
      if (Array.isArray(child)) pending.push(...child.filter(Boolean));
      else if (child) pending.push(child);
    }
  }
  calls.sort((a, b) => position(a) - position(b));
  const constant = input => {
    if (!input) return absent;
    const resolved = analysis.resolve(input);
    if (['ArrowFunctionExpression', 'FunctionExpression'].includes(resolved?.type)) return truthy;
    return analysis.value(input);
  };
  const property = (map, name) => map ? constant(map.get(name)) : unknown;
  const block = node => {
    let current = node;
    while (current?.parent && !['Program', 'BlockStatement'].includes(current.parent.type)) {
      if (['IfStatement', 'ConditionalExpression', 'LogicalExpression', 'SwitchCase', 'ForStatement', 'ForOfStatement', 'ForInStatement', 'WhileStatement', 'DoWhileStatement', 'TryStatement', 'CatchClause', 'ArrowFunctionExpression', 'FunctionExpression', 'FunctionDeclaration', 'ClassBody'].includes(current.parent.type)) return null;
      current = current.parent;
    }
    const region = current?.parent;
    if (!region) return node?.type === 'Program' ? node : null;
    let parent = region;
    while (parent?.parent) {
      if (!['Program', 'BlockStatement'].includes(parent.parent.type)) return null;
      parent = parent.parent;
    }
    return region;
  };
  const runtimeCache = new Map();
  let escapedGetter = false;
  const runtime = input => {
    if (escapedGetter) return null;
    const origin = input?.kind ? input : analysis.origin(input);
    if (!origin) return null;
    if (origin.kind === 'runtime-function' || origin.kind === 'schema') return runtime(origin.owner);
    const fresh = origin.kind === 'runtime';
    if (!fresh && !(origin.kind === 'module' && ['mongo', 'postgres'].includes(origin.name))) return null;
    const identity = fresh ? origin.node : origin.name;
    if (runtimeCache.has(identity)) return runtimeCache.get(identity);
    let engine = fresh ? ({ createPostgres: 'postgres', createSQL: 'sql', createRuntime: 'core' }[origin.factory] || 'unknown') : origin.name;
    let integrity = engine === 'mongo' ? 'off' : null;
    if (fresh && origin.factory === 'createRuntime') {
      const adapter = analysis.resolve(origin.node.arguments[0]);
      if (adapter?.type === 'CallExpression' && analysis.origin(adapter.callee)?.kind === 'adapter-factory') {
        engine = 'mongo';
        const options = adapter.arguments[0];
        const setting = options ? property(analysis.properties(options), 'referentialIntegrity') : absent;
        integrity = setting.known ? setting.value ?? 'off' : null;
      }
    }
    const result = { key: identity, engine, integrity, fresh, node: origin.node || source.ast };
    runtimeCache.set(identity, result);
    return result;
  };
  const types = new Set();
  const cache = new Map();
  let fieldCount = 0;
  const configOf = input => {
    const node = unwrap(input);
    const direct = analysis.properties(node);
    if (direct) return direct;
    // A copied config may still prove a literal name after its last spread.
    // The schema inspector owns copied-field provenance/materialization.
    if (node?.type !== 'ObjectExpression') return null;
    const trailing = new Map();
    for (const prop of node.properties) {
      if (prop.type === 'SpreadElement') { trailing.clear(); continue; }
      const name = key(prop);
      if (prop.kind !== 'init' || prop.method || name === false || name == null || name === '__proto__') { trailing.clear(); continue; }
      trailing.set(String(name), prop.value);
    }
    return trailing;
  };
  const builtin = (name, node) => {
    const identity = `graphql:${name}`;
    if (!cache.has(identity)) {
      const descriptor = { node, kind: 'scalar', name, config: null, fields: null, item: null, base: null, builtin: true };
      cache.set(identity, descriptor); types.add(descriptor);
    }
    return cache.get(identity);
  };
  const fieldsOf = input => {
    let node = unwrap(input);
    if (['ArrowFunctionExpression', 'FunctionExpression'].includes(node?.type)) {
      if (node.async || node.generator || node.params.length) return null;
      if (node.body.type !== 'BlockStatement') node = unwrap(node.body);
      else {
        const [statement] = node.body.body;
        if (node.body.body.length !== 1 || statement.type !== 'ReturnStatement') return null;
        node = unwrap(statement.argument);
      }
    }
    return analysis.properties(node);
  };
  const type = input => {
    if (input && types.has(input)) return input;
    const node = analysis.resolve(input);
    if (!node) return null;
    const origin = analysis.origin(input);
    if (origin?.kind === 'graphql' && builtinNames.has(origin.name.slice(7))) return builtin(origin.name.slice(7), node);
    const identity = ['scalar', 'date-scalar'].includes(origin?.kind) ? `${origin.kind}:${origin.name}` : node;
    if (cache.has(identity)) return cache.get(identity);
    if (types.size >= 200) { truncated = true; return null; }
    let kind;
    let callee;
    if (['NewExpression', 'CallExpression'].includes(node.type) && !node.arguments.some(arg => arg.type === 'SpreadElement')) {
      callee = analysis.origin(node.callee);
      if (callee?.kind === 'graphql' && node.type === 'NewExpression') kind = kinds.get(callee.name);
      if (callee?.kind === 'scalar-factory' && node.type === 'CallExpression') kind = 'scalar';
    }
    if (['scalar', 'date-scalar'].includes(origin?.kind)) kind = 'scalar';
    if (!kind) return null;
    const config = node.type === 'NewExpression' && !['list', 'nonNull'].includes(kind) ? configOf(node.arguments[0]) : null;
    const name = property(config, 'name');
    const result = { node, kind, name: name.known && typeof name.value === 'string' ? name.value : null, config, fields: null, item: null, base: null, builtin: false };
    cache.set(identity, result); types.add(result);
    if (['list', 'nonNull'].includes(kind)) { result.item = type(node.arguments[0]); return result; }
    if (origin?.kind === 'date-scalar') result.name = origin.name;
    if (origin?.kind === 'scalar') {
      const base = origin.name === 'PositiveIntScalar' ? 'Int' : origin.name === 'PositiveFloatScalar' ? 'Float' : 'String';
      result.name = origin.name; result.base = builtin(base, node);
    }
    if (callee?.kind === 'scalar-factory') {
      result.base = callee.name === 'createValidatedScalar' ? type(node.arguments[2]) ?? undefined
        : builtin(callee.name.includes('Int') ? 'Int' : callee.name.includes('Float') ? 'Float' : 'String', node);
      const label = constant(node.arguments[0]);
      result.name = label.known && typeof label.value === 'string' && result.base ? `${label.value}_${result.base.name}` : null;
    }
    if (kind === 'scalar') {
      const hints = assignments.filter(assignment => assignment.left.type === 'MemberExpression' && !assignment.left.computed
        && assignment.left.property.name === 'baseScalarType' && analysis.resolve(assignment.left.object) === node);
      if (hints.length) {
        const [hint] = hints;
        const firstUse = calls.find(call => ['connect', 'addNoEndpointType', 'createSchema'].includes(analysis.origin(call.callee)?.name));
        const hintValue = constant(hint.right);
        result.base = hints.length === 1 && block(hint) && block(hint) === block(node)
          && (!firstUse || position(hint) < position(firstUse))
          ? hintValue.known && !hintValue.value ? null : type(hint.right) ?? undefined : undefined;
      }
    }
    if (!['object', 'interface'].includes(kind)) return result;
    const fields = fieldsOf(config?.get('fields'));
    if (!fields) return result;
    result.fields = new Map();
    for (const [name, fieldNode] of fields) {
      if (++fieldCount > 10000) { truncated = true; result.fields = null; break; }
      const fieldConfig = analysis.properties(fieldNode);
      const extensionsNode = fieldConfig?.get('extensions');
      const extensions = extensionsNode ? analysis.properties(extensionsNode) : fieldConfig ? new Map() : null;
      const relationNode = extensions?.get('relation');
      const relation = relationNode ? analysis.properties(relationNode) : extensions ? new Map() : null;
      const virtualValue = property(extensions, 'virtual');
      let virtual = virtualValue.known && (virtualValue.value === undefined || virtualValue.value === null || virtualValue.value === false) ? false : null;
      if (virtualValue.known && virtualValue.value === true) virtual = true;
      const virtualObject = analysis.properties(extensions?.get('virtual'));
      if (virtualObject && [...virtualObject.keys()].every(name => name === 'mcp')) {
        const mcp = property(virtualObject, 'mcp');
        if (mcp.known && [undefined, 'tool', 'select', false].includes(mcp.value)) virtual = true;
      }
      result.fields.set(name, {
        name, node: fieldNode, config: fieldConfig, extensions, relation,
        type: type(fieldConfig?.get('type')), readOnly: property(extensions, 'readOnly'),
        resolve: property(fieldConfig, 'resolve'), virtual,
        embedded: property(relation, 'embedded'), connection: property(relation, 'connectionField'),
      });
    }
    return result;
  };
  const shape = input => {
    let named = type(input);
    if (!named) return null;
    let listDepth = 0;
    const nonNull = named.kind === 'nonNull';
    let itemNonNull = false;
    const seen = new Set();
    while (named && ['list', 'nonNull'].includes(named.kind)) {
      if (seen.has(named) || seen.size >= 40) return null;
      seen.add(named);
      if (named.kind === 'list') { listDepth++; itemNonNull ||= named.item?.kind === 'nonNull'; }
      named = named.item;
    }
    return named ? { named, listDepth, nonNull, itemNonNull } : null;
  };
  const registrations = [];
  const builds = [];
  // getType/getRegistrations expose the very objects described above. A local
  // declaration is no longer a shape proof after a write or unknown escape via
  // those views, including a separately imported method of the same facade.
  // Types may be shared between runtimes, so an unknown mutable view invalidates
  // the file's model proofs rather than only the getter's immediate receiver.
  for (const node of calls) {
    const callee = analysis.origin(node.callee, new Set(), false);
    const runtimeView = callee?.kind === 'runtime-function' && ['getType', 'getRegistrations', 'getInputType'].includes(callee.name);
    const receiver = node.callee.type === 'MemberExpression' ? node.callee.object : null;
    const receiverOrigin = analysis.origin(receiver, new Set(), false);
    const allocated = analysis.resolve(receiver, new Set(), false);
    const schemaView = receiver && (receiverOrigin?.kind === 'schema'
      || (allocated?.type === 'NewExpression' && analysis.origin(allocated.callee, new Set(), false)?.name === 'GraphQLSchema'));
    if (!runtimeView && !schemaView) continue;
    if (!analysis.getterSafe(node)) escapedGetter = true;
  }
  for (const node of calls) {
    const callee = analysis.origin(node.callee);
    if (callee?.kind !== 'runtime-function') continue;
    const owner = runtime(callee);
    if (!owner) continue;
    if (callee.name === 'createSchema') builds.push({ node, runtime: owner });
    if (!['connect', 'addNoEndpointType'].includes(callee.name)) continue;
    const endpoint = callee.name === 'connect';
    const spread = node.arguments.some(arg => arg.type === 'SpreadElement');
    registrations.push({ node, runtime: owner, type: spread ? null : type(node.arguments[endpoint ? 1 : 0]), endpoint,
      model: endpoint ? node.arguments[0] : undefined, onModelCreated: endpoint ? node.arguments[5] : undefined,
      stateMachine: endpoint ? node.arguments[6] : undefined });
  }
  const registrationsFor = (owner, before) => {
    const named = new Map();
    const unknowns = [];
    for (const registration of registrations) {
      if (registration.runtime !== owner || position(registration.node) >= position(before)) continue;
      if (registration.type?.name) named.set(registration.type.name, registration);
      else unknowns.push(registration);
    }
    return [...named.values(), ...unknowns];
  };
  const metadata = owner => ['sql', 'postgres'].includes(owner?.engine) || (owner?.engine === 'mongo' && owner.integrity === 'transactional');
  const entities = (owner, regs = registrationsFor(owner)) => {
    const result = new Set();
    const queue = regs.filter(reg => reg.endpoint && reg.type?.kind === 'object').map(reg => reg.type);
    const traversed = new Set();
    const references = current => {
      if (traversed.has(current)) return;
      if (traversed.size >= 200) { truncated = true; return; }
      traversed.add(current);
      for (const field of current.fields?.values() || []) {
        const named = shape(field.type)?.named;
        if (named?.kind !== 'object' || field.virtual !== false || !field.embedded.known
          || !field.extensions?.has('relation') || !constant(field.extensions.get('relation')).value) continue;
        if (field.embedded.value) references(named);
        else queue.push(named);
      }
    };
    while (queue.length && result.size < 200) {
      const current = queue.shift();
      if (result.has(current)) continue;
      result.add(current);
      references(current);
    }
    if (queue.length) truncated = true;
    return result;
  };
  const generated = (reg, regs = registrationsFor(reg.runtime)) => {
    if (reg.runtime.engine !== 'mongo') return false;
    const model = constant(reg.model);
    if (!model.known) return null;
    if (model.value) return false;
    if (reg.endpoint) return true;
    if (!reg.type?.fields) return null;
    let uncertain = false;
    for (const owner of regs) {
      if (!owner.type?.fields) { uncertain = true; continue; }
      for (const field of owner.type.fields.values()) {
        if (!field.extensions || !field.type) { uncertain = true; continue; }
        const relation = property(field.extensions, 'relation');
        if (!relation.known) { uncertain = true; continue; }
        if (!relation.value || field.virtual === true) continue;
        const wrapped = shape(field.type);
        if (owner === reg && (wrapped?.listDepth || wrapped?.named.kind === 'object')) return true;
        if (wrapped?.named.name === reg.type.name && field.embedded.known && !field.embedded.value) return true;
        if (wrapped?.named.name === reg.type.name && !field.embedded.known) uncertain = true;
      }
    }
    return uncertain ? null : false;
  };
  const closed = build => {
    if (!build || truncated || !build.runtime.fresh) return false;
    const region = block(build.node);
    if (!region || block(build.runtime.node) !== region) return false;
    const preceding = registrations.filter(reg => reg.runtime === build.runtime && position(reg.node) < position(build.node));
    if (preceding.some(reg => !reg.type?.name || block(reg.node) !== region)) return false;
    // Capturing a runtime in a callback/function invalidates complete history,
    // even if the callback call does not visibly receive the runtime argument.
    for (const node of nodes) {
      if (node.type !== 'Identifier') continue;
      if (runtime(analysis.origin(node)) !== build.runtime) continue;
      if (block(node) !== region) return false;
    }
    return true;
  };
  const graph = { analysis, type, shape, constant, property, calls, registrations, builds, runtime,
    registrationsFor, metadata, entities, generated, block, closed, types,
    get truncated() { return truncated; } };
  graphs.set(source, graph);
  return graph;
}
