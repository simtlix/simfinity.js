// This module reads wire metadata only; it deliberately imports no server code.
const kinds = { entity: 'OBJECT', object: 'OBJECT', input: 'INPUT_OBJECT', enum: 'ENUM', scalar: 'SCALAR', interface: 'INTERFACE', union: 'UNION' };
const namePattern = /^[_A-Za-z][_0-9A-Za-z]*$/;
const record = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const invalid = (detail) => { throw new Error(`Invalid client descriptor: ${detail}`); };

export const parseTypeReference = (text, types) => {
  if (typeof text !== 'string' || text.length > 1024) invalid('invalid type reference');
  let position = 0;
  const read = (depth = 0) => {
    if (depth > 64) invalid('type reference nesting exceeds 64');
    let ref;
    if (text[position] === '[') {
      position++;
      ref = { kind: 'LIST', ofType: read(depth + 1) };
      if (text[position++] !== ']') invalid(`invalid type reference ${text}`);
    } else {
      const name = text.slice(position).match(/^[_A-Za-z][_0-9A-Za-z]*/)?.[0];
      if (!name || !Object.hasOwn(types, name)) invalid(`unknown type ${name || text}`);
      position += name.length;
      ref = { kind: kinds[types[name].kind], name };
    }
    if (text[position] === '!') { position++; ref = { kind: 'NON_NULL', ofType: ref }; }
    return ref;
  };
  const result = read();
  if (position !== text.length) invalid(`invalid type reference ${text}`);
  return result;
};

export const normalizeDescriptor = (document) => {
  if (!record(document) || document.formatVersion !== 1) invalid('unsupported format version (expected 1)');
  if (!record(document.types) || !record(document.operations) || !record(document.roots)) invalid('types, roots and operations are required');
  const descriptor = JSON.parse(JSON.stringify(document));
  const types = descriptor.types;
  for (const [name, type] of Object.entries(types)) {
    if (!namePattern.test(name) || !record(type) || !Object.hasOwn(kinds, type.kind)) invalid(`invalid type ${name}`);
  }
  const reference = (text) => parseTypeReference(text, types);
  const input = (arg) => {
    if (!record(arg) || !namePattern.test(arg.name)) invalid('invalid argument or input field');
    return { ...arg, type: reference(arg.type) };
  };
  const normalized = Object.entries(types).map(([name, type]) => ({
    name, kind: kinds[type.kind], description: type.description, isOneOf: type.isOneOf,
    baseScalar: type.baseScalar, possibleTypes: type.possibleTypes, interfaces: type.interfaces,
    enumValues: type.values || [],
    ...(type.kind === 'input' ? { inputFields: (type.fields || []).map(input) } : { fields: (type.fields || []).map((field) => ({
      ...input(field), args: (field.args || []).map(input),
      extensions: { relation: field.relation || null, readOnly: field.readOnly, stateMachine: field.stateMachine,
        ...(field.virtual ? { virtual: field.virtual } : {}), ...(field.queryable !== undefined ? { queryable: field.queryable } : {}),
        ...(field.rootInputUsage ? { rootInputUsage: field.rootInputUsage } : {}) },
    })) }),
  }));
  for (const root of ['query', 'mutation']) {
    if (!record(descriptor.operations[root])) invalid(`invalid ${root} operations`);
    const entries = Object.entries(descriptor.operations[root]);
    const rootName = descriptor.roots[root];
    if (rootName !== null && (typeof rootName !== 'string' || !namePattern.test(rootName))) invalid(`invalid ${root} root`);
    if (entries.length && !rootName) invalid(`missing ${root} root`);
    const fields = entries.map(([name, operation]) => {
      if (!namePattern.test(name) || !record(operation) || !Array.isArray(operation.args)) invalid(`invalid operation ${name}`);
      if (operation.type !== null && (!Object.hasOwn(types, operation.type))) invalid(`unknown operation type ${operation.type}`);
      return { name, description: operation.description, type: reference(operation.returns), args: operation.args.map(input) };
    });
    if (rootName) {
      const existing = normalized.find((type) => type.name === rootName);
      if (existing) existing.fields = fields;
      else normalized.push({ name: rootName, kind: 'OBJECT', fields });
    }
  }
  for (const [name, type] of Object.entries(types)) {
    for (const [kind, endpoint] of Object.entries(type.endpoints || {})) {
      const root = ['get', 'list', 'aggregate'].includes(kind) ? 'query' : 'mutation';
      if (!Object.hasOwn(descriptor.operations[root], endpoint) || descriptor.operations[root][endpoint].type !== name) invalid(`invalid endpoint ${name}.${kind}`);
    }
  }
  return { descriptor, schema: { types: normalized, queryType: descriptor.roots.query ? { name: descriptor.roots.query } : null,
    mutationType: descriptor.roots.mutation ? { name: descriptor.roots.mutation } : null } };
};

const typeRefSelection = (depth) => depth ? `kind name ofType { ${typeRefSelection(depth - 1)} }` : 'kind name';
export const introspectionQuery = (extended = true) => {
  const ref = typeRefSelection(16);
  const argument = `name description defaultValue type { ${ref} }`;
  return `query IntrospectionQuery { __schema { queryType { name } mutationType { name } types {
    name kind description fields(includeDeprecated: true) { name description type { ${ref} } args { ${argument} }
      ${extended ? 'extensions { relation { displayField embedded connectionField } stateMachine readOnly }' : ''}
    } inputFields { ${argument} } enumValues(includeDeprecated: true) { name } possibleTypes { name } interfaces { name }
  } } }`;
};
