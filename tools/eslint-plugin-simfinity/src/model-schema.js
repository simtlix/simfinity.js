import { unwrap } from './analysis.js';

export const messages = {
  schemaUnregisteredTarget: '{{owner}}.{{field}} requires {{target}} to be registered in this runtime before createSchema(). Register it with connect() or addNoEndpointType().',
  schemaUnregisteredReference: '{{owner}}.{{field}} has a generated reference resolver but {{target}} is not registered in this runtime. Register the target or provide the intended application resolver.',
  schemaRequiredEmpty: '{{owner}}.{{field}} is a required embedded value whose create input has no fields, and generated mutations reach it. Make it nullable, or mark it readOnly and supply it in a controller.',
  schemaEmptyCreate: '{{owner}} has no generated create input fields, so its add mutation is omitted. Use a registered mutation with its own input for intentional server-owned records.',
  schemaEmptyUpdate: '{{owner}} has no generated update input fields, so its update mutation and state actions are omitted. Use a registered mutation for intentional server-owned records.',
  schemaEmptyEmbedded: '{{owner}}.{{field}} is omitted from generated {{operations}} inputs because its embedded input is empty. A controller or registered mutation can supply intentional server-owned values.',
  schemaEmptyAdded: '{{owner}}.{{field}} has no generated added operation after excluding the child back-reference. Create children through their own or a registered mutation.',
  schemaEmptyUpdated: '{{owner}}.{{field}} has no generated updated operation because its child update input is empty. Use a registered mutation to update these children.',
  schemaBoundType: '{{owner}} was bound to another runtime by an earlier schema. Define a fresh GraphQL type for this runtime; generated relation resolvers retain their original runtime.',
  schemaBoundField: '{{owner}}.{{field}} retains a relation resolver or its extensions from another runtime. Define this field for the receiving runtime or omit the copied resolver.',
};

const known = value => ({ known: true, value });
const key = node => !node.computed && (node.key?.name ?? node.key?.value);
const member = (node, name) => node?.type === 'MemberExpression' && !node.computed && node.property.name === name;

const writable = field => field.virtual === true || (field.readOnly.known && field.readOnly.value) ? false
  : field.virtual === false && field.readOnly.known ? true : null;
const relationDeclared = field => field.extensions ? field.extensions.has('relation') : null;

function projections(graph, registrations) {
  const byName = new Map(registrations.filter(reg => reg.type?.name).map(reg => [reg.type.name, reg]));
  const results = new Map();
  for (let pass = 0; pass < 200; pass++) {
    let changed = false;
    for (const registration of registrations) {
      const type = registration.type;
      if (!type?.fields || results.has(type)) continue;
      const create = new Set();
      const update = new Set();
      const machine = graph.constant(registration.stateMachine);
      let complete = true;
      for (const field of type.fields.values()) {
        const writing = writable(field);
        if (writing === false) continue;
        if (writing === null) { complete = false; continue; }
        if (field.name === 'state') {
          if (!machine.known) { complete = false; continue; }
          if (machine.value) continue;
        }
        const shape = graph.shape(field.type);
        if (!shape) { complete = false; continue; }
        const target = shape.named;
        if (['interface', 'union'].includes(target.kind)) continue;
        if (shape.listDepth > 1) { complete = false; continue; }
        if (['scalar', 'enum'].includes(target.kind)) {
          if (field.name !== 'id' || shape.listDepth) create.add(field.name);
          update.add(field.name);
          continue;
        }
        if (target.kind !== 'object') { complete = false; continue; }
        if (!shape.listDepth && relationDeclared(field) === false) continue;
        if (!field.embedded.known) { complete = false; continue; }
        if (!field.embedded.value) {
          create.add(field.name); update.add(field.name);
          continue;
        }
        const dependency = results.get(byName.get(target.name)?.type);
        if (!dependency) { complete = false; continue; }
        if (dependency.create.size) create.add(field.name);
        if (dependency.update.size) update.add(field.name);
      }
      if (complete) { results.set(type, { create, update }); changed = true; }
    }
    if (!changed) break;
  }
  return { byName, results };
}

function includedRoots(graph, build, registrations) {
  const input = build.node.arguments[1];
  const literal = graph.constant(input);
  if (literal.known && !literal.value) return registrations.filter(reg => reg.endpoint);
  const node = graph.analysis.resolve(input);
  if (node?.type !== 'ArrayExpression' || node.elements.some(item => !item || item.type === 'SpreadElement')) return null;
  const types = node.elements.map(item => graph.type(item));
  if (types.some(type => !type)) return null;
  return registrations.filter(reg => reg.endpoint && types.includes(reg.type));
}

function reachableInputs(graph, roots, byName) {
  const reached = new Set();
  const pending = roots?.map(reg => reg.type) || [];
  while (pending.length && reached.size < 200) {
    const type = pending.pop();
    if (!type || reached.has(type)) continue;
    reached.add(type);
    for (const field of type.fields?.values() || []) {
      if (writable(field) !== true) continue;
      const shape = graph.shape(field.type);
      if (shape?.named.kind === 'object' && (shape.listDepth === 1 || (field.embedded.known && field.embedded.value))) {
        pending.push(byName.get(shape.named.name)?.type);
      }
    }
  }
  return reached;
}

function inspectInputs(graph, errors, warnings) {
  for (const build of graph.builds) {
    if (!graph.closed(build)) continue;
    const registrations = graph.registrationsFor(build.runtime, build.node);
    const { byName, results } = projections(graph, registrations);
    const roots = includedRoots(graph, build, registrations);
    const reachable = reachableInputs(graph, roots, byName);
    for (const registration of registrations) {
      const type = registration.type;
      if (!type?.fields) continue;
      const result = results.get(type);
      if (roots?.includes(registration) && result) {
        if (!result.create.size) warnings.push({ node: registration.node, messageId: 'schemaEmptyCreate', data: { owner: type.name } });
        if (!result.update.size) warnings.push({ node: registration.node, messageId: 'schemaEmptyUpdate', data: { owner: type.name } });
      }
      for (const field of type.fields.values()) {
        const shape = graph.shape(field.type);
        if (!shape || shape.named.kind !== 'object' || shape.listDepth > 1 || field.virtual !== false) continue;
        const target = shape.named;
        if (!target.name) continue;
        const child = byName.get(target.name);
        const writing = writable(field);
        const relation = relationDeclared(field);
        const embedded = field.embedded.known ? !!field.embedded.value : null;
        const generatedCollection = shape.listDepth === 1 && relation === true && embedded === false
          && field.resolve.known && !field.resolve.value;
        const needsInput = writing === true && (shape.listDepth === 1 || (relation === true && embedded === true));
        const data = { owner: type.name, field: field.name, target: target.name };
        if (!child && (needsInput || generatedCollection)) {
          errors.push({ node: field.node, messageId: 'schemaUnregisteredTarget', data });
          continue;
        }
        if (!child && !shape.listDepth && relation === true && embedded === false
          && field.resolve.known && !field.resolve.value) {
          warnings.push({ node: field.node, messageId: 'schemaUnregisteredReference', data });
        }
        const projected = child && results.get(child.type);
        if (writing !== true || !projected || embedded === null) continue;
        if (embedded) {
          if (!projected.create.size && shape.nonNull && reachable.has(type)) {
            errors.push({ node: field.node, messageId: 'schemaRequiredEmpty', data });
          } else if (reachable.has(type) && (!projected.create.size || !projected.update.size)) {
            warnings.push({ node: field.node, messageId: 'schemaEmptyEmbedded', data: {
              ...data, operations: [!projected.create.size && 'create', !projected.update.size && 'update'].filter(Boolean).join(' and '),
            } });
          }
        } else if (shape.listDepth === 1 && reachable.has(type)) {
          const added = new Set(projected.create);
          // A collection connection can name the child's GraphQL reference or
          // its storage alias. An unknown alias must not prove an empty input.
          let normalized = field.connection.known;
          if (normalized && field.connection.value) {
            let excluded = field.connection.value;
            for (const candidate of child.type.fields?.values() || []) {
              if (!candidate.connection.known) { normalized = false; break; }
              const otherShape = graph.shape(candidate.type);
              if (candidate.connection.value === field.connection.value && otherShape?.named.kind === 'object'
                && !otherShape.listDepth && candidate.embedded.known && !candidate.embedded.value) excluded = candidate.name;
            }
            added.delete(excluded);
          }
          if (normalized && !added.size) warnings.push({ node: field.node, messageId: 'schemaEmptyAdded', data });
          if (!projected.update.size) warnings.push({ node: field.node, messageId: 'schemaEmptyUpdated', data });
        }
      }
    }
  }
}

// A separate finite interpreter for field *syntax*, not JavaScript execution.
// It keeps the two WeakMap identities the runtime actually checks. Snapshots
// from toConfig are eager; pure field thunks are read at first materialization.
function inspectOwnership(graph, errors) {
  const analysis = graph.analysis;
  const materialized = new Map();
  const snapshots = new Map();
  const bound = new Map();
  const names = new Map();
  let budget = 10000;
  const resolving = new Set();
  const regions = new Map();
  const fieldValue = field => ({ ...field, resolverOwner: null, extensionsOwner: null });
  const resolve = input => analysis.resolve(unwrap(input));
  const typeOf = input => graph.type(input);
  const typeName = type => names.get(type) || type?.name || 'copied type';
  const reflected = input => {
    const node = resolve(input);
    if (node?.type !== 'CallExpression' || node.arguments.length || node.callee.type !== 'MemberExpression'
      || node.callee.computed || !['getFields', 'toConfig'].includes(node.callee.property.name)) return null;
    const type = typeOf(node.callee.object);
    return type && ['object', 'interface'].includes(type.kind) ? { node, type, method: node.callee.property.name } : null;
  };
  const snapshot = (reflection, at) => {
    if (snapshots.has(reflection.node)) return snapshots.get(reflection.node);
    const fields = materialize(reflection.type, at);
    return fields && new Map([...fields].map(([name, field]) => [name, { ...field }]));
  };
  const reflectedFields = (input, at) => {
    const node = resolve(input);
    const reflection = reflected(node);
    if (reflection?.method === 'getFields') return { fields: snapshot(reflection, at), raw: true };
    if (member(node, 'fields')) {
      const config = reflected(node.object);
      if (config?.method === 'toConfig') return { fields: snapshot(config, at), raw: false };
    }
    return null;
  };
  const sourceField = (input, at) => {
    const node = resolve(input);
    if (node?.type !== 'MemberExpression' || node.computed) return null;
    const from = reflectedFields(node.object, at);
    const field = from?.fields?.get(node.property.name);
    return field ? { ...field, raw: from.raw } : null;
  };
  const copiedMember = (input, name, at) => {
    const node = resolve(input);
    return member(node, name) ? sourceField(node.object, at) : null;
  };
  const parseField = (input, at, name) => {
    if (--budget < 0) return null;
    const copied = sourceField(input, at);
    if (copied) return { ...copied, name, node: input };
    const node = resolve(input);
    if (node?.type !== 'ObjectExpression') return null;
    let base = null;
    const own = new Map();
    for (const entry of node.properties) {
      if (entry.type === 'SpreadElement') {
        const other = sourceField(entry.argument, at);
        if (!other) return null;
        base = { ...other }; own.clear();
      } else {
        const name = key(entry);
        if (entry.kind !== 'init' || entry.method || name === false || name == null || name === '__proto__') return null;
        own.set(String(name), entry.value);
      }
    }
    if (!base) {
      // Literal additions to a copied field map are not present in the shared
      // type.fields map, whose conservative parser rejects the outer spread.
      const config = analysis.properties(node);
      if (!config) return null;
      const extensions = config.has('extensions') ? analysis.properties(config.get('extensions')) : new Map();
      const relation = extensions?.has('relation') ? analysis.properties(extensions.get('relation')) : new Map();
      const virtual = graph.property(extensions, 'virtual');
      base = fieldValue({ name, node, config, extensions, relation,
        type: typeOf(config.get('type')), resolve: graph.property(config, 'resolve'),
        readOnly: graph.property(extensions, 'readOnly'), embedded: graph.property(relation, 'embedded'),
        connection: graph.property(relation, 'connectionField'),
        virtual: virtual.known && virtual.value === undefined ? false : virtual.known && virtual.value === true ? true : null,
      });
    }
    if (own.has('resolve')) {
      const previous = copiedMember(own.get('resolve'), 'resolve', at);
      base.resolve = previous?.resolve || graph.constant(own.get('resolve'));
      base.resolverOwner = previous?.resolverOwner || null;
    }
    if (own.has('extensions')) {
      const previous = copiedMember(own.get('extensions'), 'extensions', at);
      if (previous) {
        base.extensionsOwner = previous.extensionsOwner;
        base.extensions = previous.extensions;
      } else {
        const extensionNode = resolve(own.get('extensions'));
        // A fresh literal, including {...old.extensions}, has no WeakMap tag.
        if (extensionNode?.type !== 'ObjectExpression') return null;
        base.extensionsOwner = null;
        const extensions = new Map();
        for (const property of extensionNode.properties) {
          if (property.type === 'SpreadElement') {
            const inherited = copiedMember(property.argument, 'extensions', at);
            if (!inherited?.extensions) return null;
            for (const [name, value] of inherited.extensions) extensions.set(name, value);
          } else {
            const name = key(property);
            if (property.kind !== 'init' || property.method || name === false || name == null) return null;
            extensions.set(String(name), property.value);
          }
        }
        base.extensions = extensions;
        base.relation = extensions.has('relation') ? analysis.properties(extensions.get('relation')) : new Map();
        base.embedded = graph.property(base.relation, 'embedded');
      }
    }
    if (own.has('type')) base.type = typeOf(own.get('type'));
    if (own.has('args')) base.raw = false;
    return { ...base, name, node: input };
  };
  const parseFields = (input, at) => {
    if (--budget < 0) return null;
    let node = resolve(input);
    if (['ArrowFunctionExpression', 'FunctionExpression'].includes(node?.type)) {
      if (node.async || node.generator || node.params.length) return null;
      if (node.body.type === 'BlockStatement') {
        if (node.body.body.length !== 1 || node.body.body[0].type !== 'ReturnStatement') return null;
        node = resolve(node.body.body[0].argument);
      } else node = resolve(node.body);
    }
    const reflected = reflectedFields(node, at);
    if (reflected) return reflected.raw ? null : reflected.fields;
    if (node?.type !== 'ObjectExpression') return null;
    const result = new Map();
    for (const entry of node.properties) {
      if (entry.type === 'SpreadElement') {
        const other = reflectedFields(entry.argument, at);
        if (!other?.fields || other.raw) return null;
        for (const [name, field] of other.fields) result.set(name, { ...field });
      } else {
        const name = key(entry);
        if (entry.kind !== 'init' || entry.method || name === false || name == null || name === '__proto__') return null;
        const field = parseField(entry.value, at, String(name));
        if (!field || field.raw) return null;
        result.set(String(name), field);
      }
    }
    return result;
  };
  const configFields = (type, at) => {
    const config = resolve(type.node.arguments?.[0]);
    const reflection = reflected(config);
    if (reflection?.method === 'toConfig') {
      names.set(type, typeName(reflection.type));
      return snapshot(reflection, at);
    }
    if (config?.type !== 'ObjectExpression') return null;
    let fields;
    for (const entry of config.properties) {
      if (entry.type === 'SpreadElement') {
        const reflection = reflected(entry.argument);
        if (reflection?.method !== 'toConfig') return null;
        fields = snapshot(reflection, at);
        names.set(type, typeName(reflection.type));
      } else {
        const name = key(entry);
        if (entry.kind !== 'init' || entry.method || name === false || name == null) return null;
        if (name === 'fields') fields = parseFields(entry.value, at);
        if (name === 'name') {
          const value = graph.constant(entry.value);
          if (value.known && typeof value.value === 'string') names.set(type, value.value);
        }
      }
    }
    return fields || null;
  };
  function materialize(type, at) {
    if (materialized.has(type)) return materialized.get(type);
    if (resolving.has(type) || !type || --budget < 0) return null;
    resolving.add(type);
    const fields = type.fields && [...type.fields.values()].every(field => field.config)
      ? new Map([...type.fields].map(([name, field]) => [name, fieldValue(field)]))
      : configFields(type, at);
    resolving.delete(type);
    materialized.set(type, fields);
    return fields;
  }
  const outputGraph = (roots, at) => {
    const result = new Set();
    const queue = [...roots];
    while (queue.length && result.size < 200) {
      const shape = graph.shape(queue.pop());
      const type = shape?.named;
      if (!type || result.has(type)) continue;
      if (!['object', 'interface', 'union'].includes(type.kind)) continue;
      result.add(type);
      if (type.kind === 'union') {
        const types = resolve(type.config?.get('types'));
        if (types?.type === 'ArrayExpression') queue.push(...types.elements.map(typeOf));
      } else {
        const fields = materialize(type, at);
        for (const field of fields?.values() || []) queue.push(field.type);
        const interfaces = resolve(type.config?.get('interfaces'));
        if (interfaces?.type === 'ArrayExpression') queue.push(...interfaces.elements.map(typeOf));
      }
    }
    return result;
  };
  const diagnoseType = (type, runtime, node) => {
    const owner = bound.get(type);
    if (owner && owner !== runtime) {
      errors.push({ node, messageId: 'schemaBoundType', data: { owner: typeName(type) } });
      return true;
    }
    return false;
  };
  for (const node of graph.calls) {
    const region = graph.block(node);
    if (graph.truncated || budget < 0) continue;
    const reflection = reflected(node);
    if (reflection && region) {
      snapshots.set(node, snapshot(reflection, node));
      continue;
    }
    const callee = analysis.origin(node.callee);
    if (callee?.kind !== 'runtime-function') continue;
    const runtime = graph.runtime(callee);
    if (!runtime) continue;
    const state = regions.get(runtime) || { registrations: new Map(), outputs: [], complete: true, failed: false };
    regions.set(runtime, state);
    if (!region || graph.block(runtime.node) !== region) {
      // A declaration in an unmodeled callback/conditional can replace a name
      // or materialize fields at an unknown time. Textual order is not proof.
      if (['connect', 'addNoEndpointType', 'createSchema', 'registerMutation'].includes(callee.name)) state.complete = false;
      continue;
    }
    if (state.failed) continue;
    if (['connect', 'addNoEndpointType'].includes(callee.name)) {
      const type = typeOf(node.arguments[callee.name === 'connect' ? 1 : 0]);
      if (!type) { state.complete = false; continue; }
      if (diagnoseType(type, runtime, node)) { state.failed = true; continue; }
      if (callee.name === 'addNoEndpointType') materialize(type, node);
      // toConfig copies can inherit a name that the shared local shape parser
      // deliberately leaves unknown. Read their configuration without executing it.
      if (!type.name && !names.has(type)) configFields(type, node);
      const name = names.get(type) || type.name;
      if (!name) state.complete = false;
      else state.registrations.set(name, type);
    } else if (callee.name === 'registerMutation') {
      const output = typeOf(node.arguments[3]);
      if (output) state.outputs.push(output);
    } else if (callee.name === 'createSchema' && state.complete) {
      const types = outputGraph([...state.registrations.values(), ...state.outputs], node);
      let failed = false;
      for (const type of types) {
        if (diagnoseType(type, runtime, node)) { failed = true; continue; }
        if (type.kind === 'interface') continue;
        for (const field of materialized.get(type)?.values() || []) {
          if (!field.resolve.known || !field.resolve.value) continue;
          const owner = field.resolverOwner || field.extensionsOwner;
          if (owner && owner !== runtime) {
            errors.push({ node: field.node, messageId: 'schemaBoundField', data: { owner: typeName(type), field: field.name } });
            failed = true;
          }
        }
      }
      if (failed) { state.failed = true; continue; }
      const missingTarget = [...state.registrations.values()].some(type =>
        [...(materialized.get(type)?.values() || [])].some(field => {
          const shape = graph.shape(field.type);
          if (shape?.named.kind !== 'object' || shape.listDepth > 1 || field.virtual !== false
            || state.registrations.has(shape.named.name)) return false;
          return (writable(field) === true && (shape.listDepth === 1
            || (relationDeclared(field) === true && field.embedded.known && field.embedded.value)))
            || (shape.listDepth === 1 && relationDeclared(field) === true && field.embedded.known
              && !field.embedded.value && field.resolve.known && !field.resolve.value);
        }));
      // A proven failed build does not reach its reservation phase or the next
      // straight-line statement. In particular, missing collection targets
      // must not fabricate a later foreign binding diagnostic.
      if (missingTarget) { state.failed = true; continue; }
      for (const type of state.registrations.values()) {
        for (const field of materialized.get(type)?.values() || []) {
          if (!field.resolve.known || field.resolve.value || relationDeclared(field) !== true
            || !field.embedded.known || field.embedded.value) continue;
          const shape = graph.shape(field.type);
          if (!shape || shape.named.kind !== 'object' || shape.listDepth > 1) continue;
          if (shape.listDepth && !state.registrations.has(shape.named.name)) continue;
          field.resolve = known(true);
          field.resolverOwner = runtime;
          field.extensionsOwner = runtime;
          bound.set(type, runtime);
        }
      }
      for (const type of types) {
        if (type.kind !== 'object') continue;
        if ([...(materialized.get(type)?.values() || [])].some(field => relationDeclared(field) === true
          && field.embedded.known && !field.embedded.value && field.resolve.known && !field.resolve.value)) bound.set(type, runtime);
      }
    }
  }
}

export function inspect(graph) {
  const errors = [];
  const warnings = [];
  if (graph.truncated) return { errors, warnings };
  inspectInputs(graph, errors, warnings);
  inspectOwnership(graph, errors);
  return { errors, warnings };
}
