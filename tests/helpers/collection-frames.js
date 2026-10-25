import { graphql, GraphQLSchema } from 'graphql';
import { createQueryPlan, describeModels } from '../../packages/core/src/index.js';
import { REFERENCE_DATA, REFERENCE_DANGLING_KEY, REFERENCE_SHAPES, referenceCaseArgs, seedReferenceEmptiness } from './query-emptiness.js';

const LEGACY = ['EQ', 'NE', 'LT', 'LTE', 'GT', 'GTE', 'BTW', 'IN', 'NIN', 'LIKE'];

const safeClone = (value) => {
  try {
    return structuredClone(value);
  } catch {
    return value;
  }
};

// The records of REFERENCE_DATA as the backends store them: each identity is the record's key, and each reference
// holds the target's key under its storage name (Review.product as productId). `dangling` adds MongoDB's dangling
// product Dg, whose references point to no record.
const storedRecord = (fields, value) => Object.fromEntries(fields.filter((field) => Object.hasOwn(value, field.name)).map((field) => {
  const item = value[field.name];
  if (field.kind !== 'embedded' || item == null) return [field.storageName, item];
  return [field.storageName, field.list ? item.map((entry) => storedRecord(field.fields, entry)) : storedRecord(field.fields, item)];
}));
export const referenceStore = (prefix, { dangling = false, records = REFERENCE_DATA } = {}) => (models) => {
  const store = {};
  for (const [typeKey, entries] of Object.entries(records)) {
    const entity = models.entities.find((item) => item.name === `${prefix}${typeKey.charAt(0).toUpperCase()}${typeKey.slice(1)}`);
    store[entity.name] = entries.map((record) => ({ ...storedRecord(entity.fields, record), _id: record.key }));
  }
  if (dangling) {
    store[`${prefix}Product`].push({
      _id: 'Dg', key: 'Dg', name: 'Dg', stock: 1, shop: 'ghost', pro: 'ghost', odim: { shop: 'ghost' }, olines: [{ qty: 1, shop: 'ghost' }],
    });
  }
  return store;
};

// An evaluator of query plans over a store, written from the definitions. A predicate without `scopes` is trusted and
// reads stored records through plain joins; an emptiness predicate with `scopes` admits a target only when its scope
// (a plan of the target type) holds for it, so a hidden record reads as missing. Plain joins give one value per list
// item or child, and undefined where a hop is missing; a condition holds when one of its values matches.
export const createEvaluator = (models, store) => {
  const fieldsOf = (name) => models.entities.find((item) => item.name === name).fields;
  const fieldOf = (fields, name) => {
    const field = fields.find((item) => item.name === name);
    if (!field) throw new Error(`The evaluator has no field ${name}`);
    return field;
  };
  const deref = (target, key) => (key == null ? undefined : store[target]?.find((record) => record._id === key));
  const children = (field, holder) => (store[field.target] ?? []).filter((child) => child[field.connectionField] === holder._id);
  const isIdentity = (entityLevel, name) => entityLevel && (name === 'id' || name === '_id');
  const values = (fields, record, segments, entityLevel, joins, base = []) => {
    if (record == null) return [undefined];
    const [name, ...rest] = segments;
    if (isIdentity(entityLevel, name) && !rest.length) return [record._id];
    const field = fieldOf(fields, name);
    const value = record[field.storageName];
    if (!rest.length) return [value];
    if (field.kind === 'reference') {
      const target = deref(field.target, value);
      const path = [...base, name];
      const scope = joins?.[path.join('.')];
      const admitted = target && (!scope || holds(field.target, target, scope));
      return values(fieldsOf(field.target), admitted ? target : undefined, rest, true, joins, path);
    }
    if (field.kind === 'collection') {
      const found = children(field, record);
      return found.length ? found.flatMap((child) => values(fieldsOf(field.target), child, rest, true, joins, [...base, name])) : [undefined];
    }
    if (field.list) return value?.length ? value.flatMap((item) => values(field.fields, item, rest, false, joins, [...base, name])) : [undefined];
    return values(field.fields, value, rest, false, joins, [...base, name]);
  };
  const compare = (actual, operator, expected) => {
    switch (operator) {
      case 'EQ': return expected === null ? actual == null : actual === expected;
      case 'NE': return expected === null ? actual != null : actual !== expected;
      case 'IN': return expected.includes(actual);
      case 'NIN': return !expected.includes(actual);
      case 'GT': return actual != null && actual > expected;
      case 'GTE': return actual != null && actual >= expected;
      case 'LT': return actual != null && actual < expected;
      case 'LTE': return actual != null && actual <= expected;
      case 'BTW': return actual != null && actual >= expected[0] && actual <= expected[1];
      default: throw new Error(`The evaluator has no operator ${operator}`);
    }
  };
  // `holds`, defined below, is only called once both exist.
  const empty = (fields, record, segments, entityLevel, base, scopes) => {
    const [name, ...rest] = segments;
    if (isIdentity(entityLevel, name) && !rest.length) return false;
    const field = fieldOf(fields, name);
    const path = [...base, name];
    const value = record[field.storageName];
    const admits = (target, candidate) => {
      if (scopes == null) return true;
      const key = path.join('.');
      if (!Object.hasOwn(scopes, key)) throw new Error(`The plan has no scope for ${key}`);
      return scopes[key] === null || holds(target, candidate, scopes[key]);
    };
    if (field.kind === 'reference') {
      const target = deref(field.target, value);
      const seen = target && admits(field.target, target) ? target : undefined;
      if (!rest.length || !seen) return !seen;
      return empty(fieldsOf(field.target), seen, rest, true, path, scopes);
    }
    if (field.kind === 'collection') return !children(field, record).some((child) => admits(field.target, child));
    if (field.kind === 'embedded' && !field.list) {
      if (value == null) return true;
      if (rest.length) return empty(field.fields, value, rest, false, path, scopes);
      return field.fields.every((member) => empty(field.fields, value, [member.name], false, path, scopes));
    }
    if (field.list) return value == null || value.length === 0;
    return value == null || (field.scalar === 'String' && value === '');
  };
  // Enumerate actual elements of a frame; a missing reference contributes no element. Joins on
  // crossings still expose a missing scalar to NE, as the adapters' scoped LEFT JOIN does.
  const elements = (fields, record, path, joins, base = []) => {
    if (record == null) return [];
    const [name, ...rest] = path;
    const field = fieldOf(fields, name);
    const prefix = [...base, name];
    let found;
    if (field.kind === 'collection') found = children(field, record);
    else if (field.kind === 'reference') {
      const target = deref(field.target, record[field.storageName]);
      const scope = joins?.[prefix.join('.')];
      found = target && (!scope || holds(field.target, target, scope)) ? [target] : [];
    } else {
      const value = record[field.storageName];
      found = value == null ? [] : field.list ? value : [value];
    }
    const next = field.target ? fieldsOf(field.target) : field.fields;
    return rest.length ? found.flatMap((value) => elements(next, value, rest, joins, prefix))
      : found.map((value) => ({ entity: field.target, record: value }));
  };
  const holds = (entity, record, node) => {
    if (!node) return true;
    if (node.kind === 'and') return node.terms.every((term) => holds(entity, record, term));
    if (node.kind === 'or') return node.terms.some((term) => holds(entity, record, term));
    if (node.kind === 'quantified') {
      const path = [...(node.anchor ?? []), ...node.path];
      const candidates = elements(fieldsOf(entity), record, path, node.joins)
        .filter((target) => holds(target.entity, target.record, node.scope));
      const matches = (target) => holds(target.entity, target.record, node.where);
      if (node.quantifier === 'ALL') return candidates.every(matches);
      return candidates.some(matches) === (node.quantifier === 'ANY');
    }
    if (node.operator === 'IS_EMPTY' || node.operator === 'IS_NOT_EMPTY') {
      return empty(fieldsOf(entity), record, node.path, true, [], node.scopes) === (node.operator === 'IS_EMPTY');
    }
    return values(fieldsOf(entity), record, node.path, true, node.joins).some((value) => compare(value, node.operator, node.value));
  };
  return holds;
};

// A database-free adapter that plans every read with createQueryPlan, with its declared operators and reference
// emptiness, and answers it from the store. Each call keeps a copy of its arguments, its plan and the keys it matched.
// `batch` adds findChildrenBatch.
export const createMemoryAdapter = ({
  queryFeatures, calls, batch = false, data = () => ({}),
}) => {
  let models;
  let store;
  let holds;
  const copy = (record) => ({ ...structuredClone(record), id: record._id });
  const all = (Model) => store[Model.name] ?? [];
  const read = (method, Model, args, mode, records) => {
    const call = { method, type: Model.name, args: safeClone(args) };
    calls.push(call);
    call.plan = createQueryPlan(models, Model.name, args, {
      mode, operators: queryFeatures?.operators ?? LEGACY, referenceEmptiness: queryFeatures?.referenceEmptiness === true,
      quantifiers: queryFeatures?.quantifiers === true,
    });
    const found = records.filter((record) => holds(Model.name, record, call.plan.where));
    call.rows = found.map((record) => record._id).sort();
    return found.map(copy);
  };
  return {
    ...(queryFeatures === undefined ? {} : { queryFeatures }),
    bind() {},
    prepare(registrations) {
      models = describeModels(registrations);
      store = data(models);
      holds = createEvaluator(models, store);
    },
    createModel: (gqltype) => ({ name: gqltype.name }),
    castId: String,
    withTransaction: async (session, body) => body(session || {}),
    async getById(Model, id) {
      const record = all(Model).find((item) => item._id === String(id));
      return record ? copy(record) : null;
    },
    async find(Model, gqltype, args) { return read('find', Model, args, 'find', all(Model)); },
    async count(Model, gqltype, args) { return read('count', Model, args, 'count', all(Model)).length; },
    async aggregate(Model, gqltype, args) {
      read('aggregate', Model, args, 'aggregate', all(Model));
      return [];
    },
    async findChildren(Model, gqltype, connectionField, parentId, args) {
      return read('findChildren', Model, args, 'find', all(Model).filter((record) => record[connectionField] === String(parentId)));
    },
    ...(batch ? {
      async findChildrenBatch(Model, gqltype, connectionField, parentIds, args) {
        const keys = parentIds.map(String);
        const found = read('findChildrenBatch', Model, args, 'find', all(Model).filter((record) => keys.includes(record[connectionField])));
        calls.at(-1).parents = keys;
        return keys.map((key) => found.filter((record) => record[connectionField] === key));
      },
    } : {}),
  };
};


// Public helper for focused hand-built-plan probes; adapter reads share the same evaluator.
export const holds = (predicate, record, { models, store, entity }) => createEvaluator(models, store)(entity, record, predicate);

export const COLLECTION_DATA = Object.freeze({
  ...REFERENCE_DATA,
  product: Object.freeze([...REFERENCE_DATA.product, Object.freeze({ key: 'F', name: 'F', stock: 0, shop: 'S1', pro: 'P2' })]),
  review: Object.freeze([...REFERENCE_DATA.review, Object.freeze({ key: 'Ka:null:x', rating: null, author: 'x', product: 'Ka' })]),
});

export const seedCollectionFrames = async (runtime, types) => {
  const ids = await seedReferenceEmptiness(runtime, types);
  const schema = runtime instanceof GraphQLSchema ? runtime : runtime?.schema;
  const execute = typeof runtime === 'function' ? runtime : (source, variableValues) => graphql({ schema, source, variableValues });
  for (const [typeKey, input] of [
    ['product', { key: 'F', name: 'F', stock: 0, shop: { id: ids.S1 }, pro: { id: ids.P2 } }],
    ['review', { key: 'Ka:null:x', rating: null, author: 'x', product: { id: ids.Ka } }],
  ]) {
    const root = types.roots[typeKey];
    const result = await execute(`mutation($input: ${root.type.name}Input!){ add${root.single}(input:$input){ id } }`, { input });
    if (result.errors) throw new Error(JSON.stringify(result.errors));
    ids[input.key] = Object.values(result.data)[0].id;
  }
  return ids;
};

const ORACLE_SCHEMA = {
  shop: {
    id: 'identity', key: 'string', name: 'string', state: 'string', minStock: 'scalar', products: { collection: 'product', via: 'shop' },
  },
  pro: {
    id: 'identity', key: 'string', name: 'string', shop: { reference: 'shop' },
  },
  product: {
    id: 'identity',
    key: 'string',
    name: 'string',
    stock: 'scalar',
    shop: { reference: 'shop' },
    pro: { reference: 'pro' },
    odim: { embedded: { w: 'scalar', shop: { reference: 'shop' } } },
    olines: 'list',
    reviews: { collection: 'review', via: 'product' },
  },
  review: {
    id: 'identity', key: 'string', rating: 'scalar', author: 'string', product: { reference: 'product' },
  },
};
// The scopes as the spec states them, written apart from REFERENCE_SCOPES.
const ORACLE_SCOPES = {
  admin: {},
  NE: { shop: (record) => record.name !== 'S2', review: (record) => record.author !== 'hidden', pro: (record) => record.name !== 'P2' },
  EQ: { shop: (record) => record.state === 'OPEN', review: (record) => record.author === 'x', pro: (record) => record.name === 'P1' },
  proOnly: { pro: (record) => record.name !== 'P2' },
  shopNE: { shop: (record) => record.name !== 'S2' },
  shopEQ: { shop: (record) => record.state === 'OPEN' },
};
// The legacy form of the same scopes, a prefixed condition read through plain joins.
const ORACLE_JOINED = {
  NE: { shop: ['name', 'NE', 'S2'], review: ['author', 'NE', 'hidden'], pro: ['name', 'NE', 'P2'] },
  EQ: { shop: ['state', 'EQ', 'OPEN'], review: ['author', 'EQ', 'x'], pro: ['name', 'EQ', 'P1'] },
  proOnly: { pro: ['name', 'NE', 'P2'] },
  shopNE: { shop: ['name', 'NE', 'S2'] },
  shopEQ: { shop: ['state', 'EQ', 'OPEN'] },
  admin: {},
};

export const referenceOracle = (shape, { dangling = false, data = REFERENCE_DATA } = {}) => {
  const records = {
    ...data,
    product: [
      ...data.product,
      ...(dangling ? [{
        key: REFERENCE_DANGLING_KEY, name: REFERENCE_DANGLING_KEY, stock: 1, shop: 'ghost', pro: 'ghost', odim: { shop: 'ghost' }, olines: [{ qty: 1, shop: 'ghost' }],
      }] : []),
    ],
  };
  const visible = (client, typeKey, record) => !client || (ORACLE_SCOPES[shape][typeKey]?.(record) ?? true);
  const deref = (client, typeKey, key) => {
    const record = key == null ? undefined : records[typeKey].find((item) => item.key === key);
    return record && visible(client, typeKey, record) ? record : undefined;
  };
  const endEmpty = (client, field, stored, holder) => {
    if (field === 'identity') return false;
    if (field === 'string') return stored == null || stored === '';
    if (field === 'scalar') return stored == null;
    if (field === 'list') return stored == null || stored.length === 0;
    if (field.reference) return !deref(client, field.reference, stored);
    if (field.collection) return !records[field.collection].some((child) => child[field.via] === holder.key && visible(client, field.collection, child));
    return stored == null || Object.entries(field.embedded).every(([name, member]) => endEmpty(client, member, stored[name], stored));
  };
  const empty = (client, fields, value, segments) => {
    const [head, ...rest] = segments;
    const field = fields[head];
    if (!rest.length) return endEmpty(client, field, value[head], value);
    if (field.reference) {
      const target = deref(client, field.reference, value[head]);
      return target ? empty(client, ORACLE_SCHEMA[field.reference], target, rest) : true;
    }
    return value[head] == null ? true : empty(client, field.embedded, value[head], rest);
  };
  // A legacy condition: the stored value through plain joins, missing when a hop is; NE accepts a missing value.
  const stored = (fields, value, segments) => {
    const [head, ...rest] = segments;
    const field = fields[head];
    if (!rest.length) return field === 'identity' ? value.key : value[head];
    const next = field.reference ? deref(false, field.reference, value[head]) : value[head];
    return next == null ? undefined : stored(field.reference ? ORACLE_SCHEMA[field.reference] : field.embedded, next, rest);
  };
  const compare = (actual, operator, expected) => (operator === 'EQ' ? actual === expected : actual !== expected);
  const legacy = (root, record, path, operator, value) => compare(stored(ORACLE_SCHEMA[root], record, path.split('.')), operator, value);
  // The joined scopes of a legacy path: one prefixed condition per reference on it whose target the shape scopes.
  const joinedScopes = (root, path) => {
    const conditions = [];
    let fields = ORACLE_SCHEMA[root];
    const segments = path.split('.');
    for (const [index, name] of segments.slice(0, -1).entries()) {
      const field = fields[name];
      if (!field.reference) {
        fields = field.embedded;
        continue;
      }
      const scope = ORACLE_JOINED[shape][field.reference];
      if (scope) conditions.push([`${segments.slice(0, index + 1).join('.')}.${scope[0]}`, scope[1], scope[2]]);
      fields = ORACLE_SCHEMA[field.reference];
    }
    return conditions;
  };
  const construct = (root, record, path, operator, value, client) => (operator === 'IS_EMPTY' || operator === 'IS_NOT_EMPTY'
    ? empty(client, ORACLE_SCHEMA[root], record, path.split('.')) === (operator === 'IS_EMPTY')
    : legacy(root, record, path, operator, value));
  const pathOf = (field, path) => (path ? `${field}.${path}` : field);
  const group = (root, record, value, client) => {
    const results = [];
    for (const { field, path, operator, value: expected } of value.conditions ?? []) {
      results.push(construct(root, record, pathOf(field, path), operator, expected, client));
      if (client && !['IS_EMPTY', 'IS_NOT_EMPTY'].includes(operator)) {
        for (const [scoped, scopeOperator, scopeValue] of joinedScopes(root, pathOf(field, path))) {
          results.push(legacy(root, record, scoped, scopeOperator, scopeValue));
        }
      }
    }
    for (const item of value.AND ?? []) results.push(group(root, record, item, client));
    if (value.OR?.length) results.push(value.OR.some((item) => group(root, record, item, client)));
    return results.every(Boolean);
  };
  const query = (root, record, args, client) => {
    const results = [];
    for (const [name, value] of Object.entries(args)) {
      if (['AND', 'OR', 'sort'].includes(name)) continue;
      for (const term of value.terms) {
        results.push(construct(root, record, pathOf(name, term.path), term.operator, term.value, client));
        if (client && !['IS_EMPTY', 'IS_NOT_EMPTY'].includes(term.operator)) {
          for (const [scoped, scopeOperator, scopeValue] of joinedScopes(root, pathOf(name, term.path))) results.push(legacy(root, record, scoped, scopeOperator, scopeValue));
        }
      }
    }
    results.push(group(root, record, { AND: args.AND, OR: args.OR }, client));
    for (const term of args.sort?.terms ?? []) {
      for (const [scoped, scopeOperator, scopeValue] of joinedScopes(root, term.field)) results.push(legacy(root, record, scoped, scopeOperator, scopeValue));
    }
    return results.every(Boolean);
  };
  return (item, { trusted = false } = {}) => {
    const ids = Object.fromEntries(Object.values(data).flat().map((record) => [record.key, record.key]));
    const args = referenceCaseArgs(item, ids);
    return records[item.root]
      .filter((record) => visible(true, item.root, record))
      .filter((record) => query(item.root, record, args, !trusted))
      .filter((record) => !item.scopeArgs || query(item.root, record, item.scopeArgs, false))
      .map((record) => record.key)
      .sort();
  };
};

// Direct interpretation of the language over key-based records, independent of the planner and
// its rewrite. Conditions sharing the first collection must hold on the same actual element.
export const collectionOracle = (shape = 'admin', records = COLLECTION_DATA) => {
  const schema = { ...ORACLE_SCHEMA, product: { ...ORACLE_SCHEMA.product, olines: { embeddedList: { qty: 'scalar', shop: { reference: 'shop' } } } } };
  const fieldsOf = (type) => (typeof type === 'string' ? schema[type] : type);
  const visible = (type, record) => record != null && (ORACLE_SCOPES[shape][type]?.(record) ?? true);
  const compare = (actual, operator = 'EQ', expected) => {
    switch (operator) {
      case 'EQ': return expected == null ? actual == null : actual === expected;
      case 'NE': return expected == null ? actual != null : actual !== expected;
      case 'GTE': return actual != null && actual >= expected;
      case 'GT': return actual != null && actual > expected;
      case 'LTE': return actual != null && actual <= expected;
      case 'LT': return actual != null && actual < expected;
      case 'IN': return expected.includes(actual);
      case 'NIN': return !expected.includes(actual);
      default: throw new Error(`Unknown oracle operator ${operator}`);
    }
  };
  const targets = (type, record, path, client) => {
    if (record == null) return [];
    const [name, ...rest] = path;
    const field = fieldsOf(type)[name];
    let rows;
    let target;
    if (field.reference) {
      target = field.reference;
      rows = records[target].filter((item) => item.key === record[name]);
    } else if (field.collection) {
      target = field.collection;
      rows = records[target].filter((item) => item[field.via] === record.key);
    } else if (field.embeddedList || field.embedded) {
      target = field.embeddedList ?? field.embedded;
      const value = record[name];
      rows = value == null ? [] : field.embeddedList ? value : [value];
    } else throw new Error(`Not an oracle relation ${type}.${name}`);
    if (client && typeof target === 'string') rows = rows.filter((item) => visible(target, item));
    return rest.length ? rows.flatMap((item) => targets(target, item, rest, client)) : rows.map((item) => ({ type: target, record: item }));
  };
  const scalar = (type, record, path, client) => {
    if (record == null) return undefined;
    const [name, ...rest] = path;
    const field = fieldsOf(type)[name];
    if (!rest.length) return field === 'identity' ? record.key : record[name];
    if (field.reference) {
      const target = records[field.reference].find((item) => item.key === record[name]);
      return scalar(field.reference, !client || visible(field.reference, target) ? target : undefined, rest, client);
    }
    if (field.embedded) return scalar(field.embedded, record[name], rest, client);
    if (field.embeddedList) return (record[name] ?? []).map((item) => scalar(field.embeddedList, item, rest, client));
    throw new Error(`Unsupported oracle scalar traversal ${type}.${path.join('.')}`);
  };
  const firstCollection = (type, parts) => {
    let current = type;
    for (const [index, name] of parts.entries()) {
      const field = fieldsOf(current)[name];
      if (field.collection) return { prefix: parts.slice(0, index + 1), rest: parts.slice(index + 1) };
      if (field.reference) current = field.reference;
      else if (field.embedded || field.embeddedList) current = field.embedded ?? field.embeddedList;
    }
    return null;
  };
  const empty = (type, record, path, client) => {
    const [name, ...rest] = path;
    const field = fieldsOf(type)[name];
    if (field.reference || field.collection) {
      const rows = targets(type, record, [name], client);
      return !rows.length || (rest.length > 0 && rows.every((item) => empty(item.type, item.record, rest, client)));
    }
    const value = scalar(type, record, path, client);
    return value == null || (field === 'string' && value === '');
  };
  const conditions = (type, record, items, client, framed = false) => {
    const buckets = new Map();
    for (const item of items) {
      const parts = (item.path ? `${item.field}.${item.path}` : item.field).split('.');
      if (['IS_EMPTY', 'IS_NOT_EMPTY'].includes(item.operator)) {
        if (empty(type, record, parts, client) !== (item.operator === 'IS_EMPTY')) return false;
        continue;
      }
      const cut = firstCollection(type, parts);
      if (!cut) {
        if (!compare(scalar(type, record, parts, client && framed), item.operator, item.value)) return false;
        if (client && !framed) {
          let holder = record;
          let targetType = type;
          for (const name of parts.slice(0, -1)) {
            const member = fieldsOf(targetType)[name];
            if (!member.reference) break;
            holder = records[member.reference].find((candidate) => candidate.key === holder?.[name]);
            targetType = member.reference;
            const scope = ORACLE_JOINED[shape][targetType];
            if (scope && !compare(holder?.[scope[0]], scope[1], scope[2])) return false;
          }
        }
      } else {
        const key = cut.prefix.join('.');
        if (!buckets.has(key)) buckets.set(key, { path: cut.prefix, conditions: [] });
        buckets.get(key).conditions.push({ ...item, field: cut.rest.join('.'), path: undefined });
      }
    }
    return [...buckets.values()].every((bucket) => targets(type, record, bucket.path, client)
      .some((item) => conditions(item.type, item.record, bucket.conditions, client, true)));
  };
  const group = (type, record, value, client, framed = false) => {
    if (!conditions(type, record, value.conditions ?? [], client, framed)) return false;
    for (const quantifier of ['ANY', 'ALL', 'NONE']) for (const frame of value[quantifier] ?? []) {
      const candidates = targets(type, record, frame.path.split('.'), client);
      const matches = (item) => group(item.type, item.record, frame, client, true);
      if (quantifier === 'ALL' ? !candidates.every(matches) : candidates.some(matches) !== (quantifier === 'ANY')) return false;
    }
    return (value.AND ?? []).every((item) => group(type, record, item, client, framed))
      && (!value.OR?.length || value.OR.some((item) => group(type, record, item, client, framed)));
  };
  const query = (type, record, args, client) => {
    for (const [name, value] of Object.entries(args)) {
      if (['AND', 'OR', 'sort', 'pagination', 'aggregation'].includes(name)) continue;
      if (value.quantifier != null) {
        const frame = { path: name, conditions: (value.terms ?? []).map(({ path, ...term }) => ({ field: path, ...term })) };
        if (!group(type, record, { [value.quantifier]: [frame] }, client)) return false;
      } else if (value.terms) {
        if (!conditions(type, record, value.terms.map(({ path, ...term }) => ({ field: path ? `${name}.${path}` : name, ...term })), client)) return false;
      } else if (!conditions(type, record, [{ field: name, ...value }], client)) return false;
    }
    return group(type, record, args, client);
  };
  return (item, { trusted = false } = {}) => records[item.root].filter((record) => visible(item.root, record))
    .filter((record) => query(item.root, record, item.args, !trusted)).map((record) => record.key).sort();
};

const conditionArgs = (...conditions) => ({ AND: [{ conditions }] });
const collectionCase = (name, root, args, admin, restricted = admin, overrides = {}) => ({
  name, root, args,
  rows: Object.fromEntries(REFERENCE_SHAPES.map((shape) => [shape, (overrides[shape] ?? (['NE', 'EQ'].includes(shape) ? restricted : admin)).split(' ').filter(Boolean).sort()])),
});
const reviewCondition = (field, operator, value) => ({ field: `reviews.${field}`, operator, value });
const ratingFour = { field: 'rating', operator: 'GTE', value: 4 };
const allProducts = 'C D E F Ka c';
export const COLLECTION_CASES = [
  collectionCase('duplication: rating', 'product', conditionArgs(reviewCondition('rating', 'GTE', 1)), 'D E Ka c', 'D E Ka'),
  collectionCase('author EQ x', 'product', conditionArgs(reviewCondition('author', 'EQ', 'x')), 'D E Ka'),
  collectionCase('author NE x', 'product', conditionArgs(reviewCondition('author', 'NE', 'x')), 'D E c', ''),
  collectionCase('author EQ null', 'product', conditionArgs(reviewCondition('author', 'EQ', null)), ''),
  collectionCase('OR reference and collection', 'product', { OR: [{ conditions: [{ field: 'shop.key', value: 'S1' }] }, { conditions: [reviewCondition('author', 'EQ', 'x')] }] }, 'D E F Ka'),
  collectionCase('OR hidden author', 'product', { OR: [{ conditions: [{ field: 'shop.key', value: 'S1' }] }, { conditions: [reviewCondition('author', 'EQ', 'hidden')] }] }, 'D E F Ka c', 'E F Ka'),
  collectionCase('correlation: separate groups', 'product', { AND: [{ conditions: [reviewCondition('rating', 'GTE', 4)] }, { conditions: [reviewCondition('author', 'EQ', 'x')] }] }, 'D E Ka', 'E Ka'),
  collectionCase('correlation: same group', 'product', conditionArgs(reviewCondition('rating', 'GTE', 4), reviewCondition('author', 'EQ', 'x')), 'E Ka'),
  collectionCase('correlation: hidden separate', 'product', { AND: [{ conditions: [reviewCondition('rating', 'GTE', 4)] }, { conditions: [reviewCondition('author', 'EQ', 'hidden')] }] }, 'D E', ''),
  collectionCase('correlation: hidden same', 'product', conditionArgs(reviewCondition('rating', 'GTE', 4), reviewCondition('author', 'EQ', 'hidden')), 'D', ''),
  collectionCase('term beside group', 'product', { reviews: { terms: [{ path: 'rating', operator: 'GTE', value: 4 }] }, AND: [{ conditions: [reviewCondition('author', 'EQ', 'x')] }] }, 'D E Ka', 'E Ka'),
  ...['ANY', 'NONE', 'ALL'].map((quantifier, index) => collectionCase(`${quantifier} rating GTE 4`, 'product', { AND: [{ [quantifier]: [{ path: 'reviews', conditions: [ratingFour] }] }] }, ['D E Ka', 'C F c', 'C F'][index], ['E Ka', 'C D F c', 'C E F c'][index])),
  collectionCase('has a child', 'product', { AND: [{ ANY: [{ path: 'reviews' }] }] }, 'D E Ka c', 'D E Ka'),
  collectionCase('ALL author NE x', 'product', { AND: [{ ALL: [{ path: 'reviews', conditions: [{ field: 'author', operator: 'NE', value: 'x' }] }] }] }, 'C F c', 'C F c'),
  collectionCase('ALL alone', 'product', { AND: [{ ALL: [{ path: 'reviews' }] }] }, allProducts),
  collectionCase('ALL alone OR', 'product', { OR: [{ ALL: [{ path: 'reviews' }] }, { conditions: [{ field: 'name', value: 'x' }] }] }, allProducts),
  collectionCase('ALL alone AND neutral', 'product', { AND: [{ ALL: [{ path: 'reviews' }] }, { conditions: [{ field: 'name', value: 'Ka' }] }] }, 'Ka'),
  collectionCase('nested rating 5', 'shop', conditionArgs({ field: 'products.reviews.rating', operator: 'GTE', value: 5 }), 'S1 S3', 'S1', { shopNE: 'S1 S3', shopEQ: 'S1' }),
  collectionCase('nested rating 1', 'shop', conditionArgs({ field: 'products.reviews.rating', operator: 'GTE', value: 1 }), 'S1 S2 S3', 'S1 S3', { EQ: 'S1', shopNE: 'S1 S3', shopEQ: 'S1' }),
  collectionCase('NONE shop with stock 5', 'product', { shop: { quantifier: 'NONE', terms: [{ path: 'products.stock', value: 5 }] } }, 'C D', 'C D c', { shopNE: 'C D c', shopEQ: 'C D c' }),
  collectionCase('reference inside frame EQ', 'shop', { products: { terms: [{ path: 'pro.name', value: 'P2' }] } }, 'S1 S2', '', { proOnly: '', shopNE: 'S1', shopEQ: 'S1' }),
  collectionCase('reference inside frame NE', 'shop', { products: { terms: [{ path: 'pro.name', operator: 'NE', value: 'P2' }] } }, 'S1 S3', 'S1 S3', { EQ: 'S1', proOnly: 'S1 S2 S3', shopEQ: 'S1' }),
  collectionCase('back reference', 'product', { AND: [{ ANY: [{ path: 'reviews', conditions: [{ field: 'product.shop.state', value: 'CLOSED' }] }] }] }, 'c', '', { shopNE: '', shopEQ: '' }),
  collectionCase('rule 4 reference before collection', 'product', { shop: { terms: [{ path: 'products.stock', value: 5 }] } }, 'E F Ka c', 'E F Ka', { shopNE: 'E F Ka', shopEQ: 'E F Ka' }),
  collectionCase('2b inside frame: empty author', 'product', { AND: [{ ANY: [{ path: 'reviews', conditions: [{ field: 'author', operator: 'IS_EMPTY' }] }] }] }, ''),
  collectionCase('2b inside frame: empty reviews', 'shop', { AND: [{ ANY: [{ path: 'products', conditions: [{ field: 'reviews', operator: 'IS_EMPTY' }] }] }] }, 'S1', 'S1', { proOnly: 'S1', shopNE: 'S1', shopEQ: 'S1' }),
];

const referenceRows = {
  shop: {
    ANY: { admin: 'D E F Ka c', NE: 'D E F Ka', EQ: 'E F Ka', proOnly: 'D E F Ka c', shopNE: 'D E F Ka', shopEQ: 'E F Ka' },
    NONE: { admin: 'C', NE: 'C c', EQ: 'C D c', proOnly: 'C', shopNE: 'C c', shopEQ: 'C D c' },
  },
  pro: {
    ANY: { admin: 'C D F Ka c', NE: 'C D Ka', EQ: 'Ka', proOnly: 'C D Ka', shopNE: 'C D F Ka c', shopEQ: 'C D F Ka c' },
    NONE: { admin: 'E', NE: 'E F c', EQ: 'C D E F c', proOnly: 'E F c', shopNE: 'E', shopEQ: 'E' },
  },
};
for (const path of ['shop', 'pro']) for (const quantifier of ['ANY', 'ALL', 'NONE']) {
  const rows = quantifier === 'ALL' ? Object.fromEntries(REFERENCE_SHAPES.map((shape) => [shape, allProducts])) : referenceRows[path][quantifier];
  COLLECTION_CASES.push(collectionCase(`${quantifier} reference ${path} alone`, 'product', { AND: [{ [quantifier]: [{ path }] }] }, rows.admin, rows.NE, rows));
  const shopRows = {
    ANY: { admin: 'E F Ka', NE: 'E F Ka', EQ: 'E F Ka' },
    NONE: { admin: 'C D c', NE: 'C D c', EQ: 'C D c' },
    ALL: { admin: 'C E F Ka', NE: 'C E F Ka c', EQ: allProducts, shopNE: 'C E F Ka c', shopEQ: allProducts },
  };
  const proRows = {
    ANY: { admin: 'F c', NE: '', EQ: '', proOnly: '' },
    NONE: { admin: 'C D E Ka', NE: allProducts, EQ: allProducts, proOnly: allProducts },
    ALL: { admin: 'E F c', NE: 'E F c', EQ: 'C D E F c', proOnly: 'E F c' },
  };
  const conditioned = (path === 'shop' ? shopRows : proRows)[quantifier];
  COLLECTION_CASES.push(collectionCase(`${quantifier} reference ${path} with condition`, 'product', { AND: [{ [quantifier]: [{ path, conditions: [{ field: 'name', value: path === 'shop' ? 'S1' : 'P2' }] }] }] }, conditioned.admin, conditioned.NE, conditioned));
}

// Aggregate expectations use the extended seed. Scoped collection grouping is forbidden by the
// runtime and is listed separately from rows that can be read under a scope shape.
export const COLLECTION_AGGREGATES = [
  { name: 'shop counts', groupId: 'shop.key', filter: null, facts: [{ operation: 'COUNT', factName: 'n', path: 'id' }], rows: [[null, 1], ['S1', 3], ['S2', 1], ['S3', 1]] },
  { name: 'shop counts with rating frame', groupId: 'shop.key', filter: 'rating1', facts: [{ operation: 'COUNT', factName: 'n', path: 'id' }, { operation: 'SUM', factName: 'stock', path: 'stock' }], rows: [['S1', 2, 8], ['S2', 1, 5], ['S3', 1, 0]] },
  { name: 'author counts', groupId: 'reviews.author', filter: null, facts: [{ operation: 'COUNT', factName: 'n', path: 'id' }], rows: [[null, 2], ['hidden', 3], ['x', 4]], forbidden: ['NE', 'EQ'] },
  { name: 'author counts with joined rating', groupId: 'reviews.author', filter: 'rating5', facts: [{ operation: 'COUNT', factName: 'n', path: 'id' }], rows: [['hidden', 1], ['x', 2]], forbidden: ['NE', 'EQ'] },
  { name: 'author counts with two groups', groupId: 'reviews.author', filter: 'twoGroups', facts: [{ operation: 'COUNT', factName: 'n', path: 'id' }], rows: [['x', 2]], forbidden: ['NE', 'EQ'] },
  { name: 'shop review sums', groupId: 'shop.key', filter: 'rating5', facts: [{ operation: 'COUNT', factName: 'n', path: 'id' }, { operation: 'SUM', factName: 'r', path: 'reviews.rating' }], rows: [['S1', 2, 10], ['S3', 1, 5]] },
];

// A relational reading of the six stated aggregate probes, without planning or rewriting their
// arguments. Joining reviews produces a null row only for a product with no review at all.
export const collectionAggregateOracle = (item, records = COLLECTION_DATA, shape = 'admin') => {
  const joined = item.groupId.startsWith('reviews.') || item.facts.some((fact) => fact.path.startsWith('reviews.'));
  const pairs = records.product.flatMap((product) => {
    const reviews = records.review.filter((review) => review.product === product.key);
    if (!joined) return [{ product, reviews }];
    return (reviews.length ? reviews : [null]).map((review) => ({ product, review, reviews }));
  }).filter(({ product, review, reviews }) => {
    if (item.groupId === 'shop.key') {
      const shop = records.shop.find((entry) => entry.key === product.shop);
      if (['NE', 'shopNE'].includes(shape) && shop?.name === 'S2') return false;
      if (['EQ', 'shopEQ'].includes(shape) && shop?.state !== 'OPEN') return false;
    }
    if (!item.filter) return true;
    if (item.filter === 'twoGroups') return review?.rating >= 4 && review?.author === 'x';
    const threshold = item.filter === 'rating1' ? 1 : 5;
    return joined ? review?.rating != null && review.rating >= threshold : reviews.some((entry) => (ORACLE_SCOPES[shape].review?.(entry) ?? true) && entry.rating != null && entry.rating >= threshold);
  });
  const groups = new Map();
  for (const { product, review } of pairs) {
    const key = item.groupId === 'shop.key' ? product.shop ?? null : review?.author ?? null;
    if (!groups.has(key)) groups.set(key, [key, ...item.facts.map(() => 0)]);
    item.facts.forEach((fact, index) => {
      groups.get(key)[index + 1] += fact.operation === 'COUNT' ? 1 : fact.path === 'stock' ? product.stock : review?.rating ?? 0;
    });
  }
  return [...groups.values()].sort((a, b) => String(a[0] ?? '').localeCompare(String(b[0] ?? '')));
};

for (const item of COLLECTION_AGGREGATES) {
  const rows = Object.fromEntries(REFERENCE_SHAPES.map((shape) => [shape, item.rows]));
  if (item.name === 'shop counts') {
    rows.NE = rows.shopNE = [[null, 1], ['S1', 3], ['S3', 1]];
    rows.EQ = rows.shopEQ = [['S1', 3]];
  } else if (item.name === 'shop counts with rating frame') {
    rows.NE = rows.shopNE = [['S1', 2, 8], ['S3', 1, 0]];
    rows.EQ = rows.shopEQ = [['S1', 2, 8]];
  } else if (item.name === 'shop review sums') {
    item.forbidden = ['NE', 'EQ'];
    rows.shopEQ = [['S1', 2, 10]];
  }
  item.rowsByShape = rows;
}

export const COLLECTION_ANCHOR_ROWS = {
  reviewsPerProduct: {
    admin: [['D', 1], ['E', 1], ['Ka', 1], ['c', 1]], NE: [['D', 1], ['E', 1], ['Ka', 1]], EQ: [['E', 1], ['Ka', 1]],
    proOnly: [['D', 1], ['E', 1], ['Ka', 1], ['c', 1]], shopNE: [['D', 1], ['E', 1], ['Ka', 1]], shopEQ: [['E', 1], ['Ka', 1]],
  },
  referenceChain: {
    // R17: F has the same P2 -> S1 -> products(Ka) path as c on the extended seed.
    admin: [['F', 1], ['Ka', 1], ['c', 1]], NE: [['Ka', 1]], EQ: [['Ka', 1]], proOnly: [['Ka', 1]],
    shopNE: [['F', 1], ['Ka', 1]], shopEQ: [['F', 1], ['Ka', 1]],
  },
  universalProducts: { admin: ['S3'], proOnly: ['S3'], shopNE: ['S3'], shopEQ: [], forbidden: ['NE', 'EQ'] },
};

COLLECTION_CASES.push({
  ...collectionCase('collection through an embedded list reference', 'product', conditionArgs({ field: 'olines.shop.products.name', value: 'Ka' }), 'Ka'),
  forbidden: ['NE', 'EQ', 'shopNE', 'shopEQ'],
});
