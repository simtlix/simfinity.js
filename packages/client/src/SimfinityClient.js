import { normalizeDescriptor, introspectionQuery } from './metadata.js';
import { SelectionTree } from './selection.js';
import { transformRootInput, transformDelta } from './inputs.js';

function unwrapType(typeRef) {
  let isList = false;
  let isNonNull = false;
  let current = typeRef;
  while (current && (current.kind === 'NON_NULL' || current.kind === 'LIST')) {
    if (current.kind === 'NON_NULL') isNonNull = true;
    if (current.kind === 'LIST') isList = true;
    current = current.ofType;
  }
  return { name: current?.name, kind: current?.kind, isList, isNonNull };
}

function getActualScalarType(name) {
  if (!name) return null;
  return name.includes('_') ? name.split('_').pop() || name : name;
}

function isNumericScalar(name) {
  if (!name) return false;
  const actual = getActualScalarType(name);
  if (!actual) return false;
  const n = actual.toLowerCase();
  return n === 'int' || n === 'float' || n === 'idnumber';
}

function isBooleanScalar(name) {
  if (!name) return false;
  const actual = getActualScalarType(name);
  if (!actual) return false;
  return actual.toLowerCase() === 'boolean';
}

function isDateTimeScalar(name) {
  if (!name) return false;
  const actual = getActualScalarType(name);
  if (!actual) return false;
  const n = actual.toLowerCase();
  return n === 'date' || n === 'datetime' || n === 'timestamp'
    || n === 'isodate' || n === 'graphqldate' || n === 'graphqldatetime';
}

const canAutoSelect = (field) => !field.args?.some((arg) => arg.type.kind === 'NON_NULL' && !arg.hasDefault);

function isScalarOrEnum(kind) {
  return kind === 'SCALAR' || kind === 'ENUM';
}

function isListType(rawType) {
  let current = rawType;
  while (current) {
    if (current.kind === 'LIST') return true;
    current = current.ofType || null;
  }
  return false;
}

function typeRefToString(typeRef) {
  if (!typeRef) return '';
  if (typeRef.kind === 'NON_NULL') return typeRefToString(typeRef.ofType) + '!';
  if (typeRef.kind === 'LIST') return '[' + typeRefToString(typeRef.ofType) + ']';
  return typeRef.name || '';
}

// ---------------------------------------------------------------------------
// SelectionTree -- accumulates nested field selections and serializes them
// into a GraphQL selection set string.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// QueryBuilder -- chainable builder returned by SimfinityClient.find()
// ---------------------------------------------------------------------------

class QueryBuilder {
  constructor(client, typeName, queryInfo = null) {
    this._queryInfo = queryInfo;
    this._collectionArguments = new Map();
    this._client = client;
    this._typeName = typeName;
    this._variables = {};
    this._selectionTree = new SelectionTree();
    this._sortTerms = [];
    this._hasExplicitFields = false;
  }

  // -- Filtering -----------------------------------------------------------

  where(field, operatorOrTerms, value, value2) {
    if (operatorOrTerms && typeof operatorOrTerms === 'object' && !Array.isArray(operatorOrTerms)) {
      this._variables[field] = { ...operatorOrTerms };
    } else if (Array.isArray(operatorOrTerms)) {
      if (this._variables[field]?.terms) {
        this._variables[field].terms.push(...operatorOrTerms);
      } else {
        this._variables[field] = { terms: operatorOrTerms };
      }
    } else {
      const filter = { operator: operatorOrTerms, value };
      if (value2 !== undefined) filter.value2 = value2;
      this._variables[field] = filter;
    }
    return this;
  }

  filter(group) {
    if (!group || typeof group !== 'object' || Array.isArray(group)) throw new Error('filter() expects a QLFilterGroup');
    return this.and([group]);
  }

  or(groups) {
    if (!Array.isArray(groups)) {
      throw new Error('or() expects an array of QLFilterGroup objects');
    }
    if (this._variables.OR) {
      this._variables.OR.push(...groups);
    } else {
      this._variables.OR = [...groups];
    }
    return this;
  }

  and(groups) {
    if (!Array.isArray(groups)) {
      throw new Error('and() expects an array of QLFilterGroup objects');
    }
    if (this._variables.AND) {
      this._variables.AND.push(...groups);
    } else {
      this._variables.AND = [...groups];
    }
    return this;
  }

  // -- Relation Field Selection --------------------------------------------

  joinCollection(path, fields, filter) {
    this._selectionTree.addNested(path, fields);
    if (filter) {
      const rootField = path.split('.')[0];
      if (this._variables[rootField]?.terms) {
        this._variables[rootField].terms.push(...filter);
      } else {
        this._variables[rootField] = { terms: filter };
      }
    }
    return this;
  }

  joinObject(path, fields) {
    this._selectionTree.addNested(path, fields);
    return this;
  }

  // -- Result Shaping ------------------------------------------------------

  fields(selectionString) {
    this._selectionTree.addSelection(selectionString);
    this._hasExplicitFields = true;
    return this;
  }

  page(page, size, count) {
    const pagination = { page, size };
    if (count !== undefined) pagination.count = count;
    this._variables.pagination = pagination;
    return this;
  }

  sort(field, order) {
    this._sortTerms.push({ field, order });
    this._variables.sort = { terms: this._sortTerms };
    return this;
  }

  clearSort() {
    this._sortTerms = [];
    delete this._variables.sort;
    return this;
  }

  autoSelect() {
    const result = this._client.buildSelectionSet(this._typeName);
    this._hasExplicitFields = true;
    this._autoSelection = result.selection;
    this._selectionMeta = result;
    return this;
  }

  // -- Execution -----------------------------------------------------------

  collectionArgs(path, args) {
    if (!args || typeof args !== 'object' || Array.isArray(args)) throw new Error('collectionArgs expects an argument object');
    this._collectionArguments.set(path, { ...args }); return this;
  }

  async exec() {
    const { data, extensions } = await this.execWithMeta();
    if (data !== null && typeof data === 'object' && extensions) data.__extensions = extensions;
    return data;
  }

  async execWithMeta() {
    const queryInfo = this._queryInfo || this._client._findPluralQuery(this._typeName);
    if (!queryInfo) throw new Error(`No plural query found for type '${this._typeName}'`);
    if (!this._hasExplicitFields) this._selectionTree.addScalars(this._client._getScalarFields(this._typeName));
    const tree = this._autoSelection ? new SelectionTree() : this._selectionTree;
    if (this._autoSelection) tree.addSelection(this._autoSelection);
    const response = await this._client._requestOperation('query', queryInfo, this._variables, tree, this._collectionArguments);
    this._client._checkErrors(response, queryInfo.name, true);
    return { data: response.data?.[queryInfo.name], extensions: response.extensions || null };
  }

}

// ---------------------------------------------------------------------------
// AggregateBuilder -- chainable builder returned by SimfinityClient.aggregate()
// ---------------------------------------------------------------------------

class AggregateBuilder {
  constructor(client, typeName) {
    this._client = client;
    this._typeName = typeName;
    this._groupId = null;
    this._facts = [];
    this._variables = {};
    this._sortTerms = [];
  }

  groupBy(field) {
    this._groupId = field;
    return this;
  }

  fact(operation, factName, path) {
    this._facts.push({ operation, factName, path });
    return this;
  }

  where(field, operatorOrTerms, value, value2) {
    if (operatorOrTerms && typeof operatorOrTerms === 'object' && !Array.isArray(operatorOrTerms)) {
      this._variables[field] = { ...operatorOrTerms };
    } else if (Array.isArray(operatorOrTerms)) {
      if (this._variables[field]?.terms) {
        this._variables[field].terms.push(...operatorOrTerms);
      } else {
        this._variables[field] = { terms: operatorOrTerms };
      }
    } else {
      const filter = { operator: operatorOrTerms, value };
      if (value2 !== undefined) filter.value2 = value2;
      this._variables[field] = filter;
    }
    return this;
  }

  filter(group) {
    if (!group || typeof group !== 'object' || Array.isArray(group)) throw new Error('filter() expects a QLFilterGroup');
    return this.and([group]);
  }

  or(groups) {
    if (!Array.isArray(groups)) {
      throw new Error('or() expects an array of QLFilterGroup objects');
    }
    if (this._variables.OR) {
      this._variables.OR.push(...groups);
    } else {
      this._variables.OR = [...groups];
    }
    return this;
  }

  and(groups) {
    if (!Array.isArray(groups)) {
      throw new Error('and() expects an array of QLFilterGroup objects');
    }
    if (this._variables.AND) {
      this._variables.AND.push(...groups);
    } else {
      this._variables.AND = [...groups];
    }
    return this;
  }

  page(page, size, count) {
    const pagination = { page, size };
    if (count !== undefined) pagination.count = count;
    this._variables.pagination = pagination;
    return this;
  }

  sort(field, order) {
    this._sortTerms.push({ field, order });
    this._variables.sort = { terms: this._sortTerms };
    return this;
  }

  async exec() {
    if (!this._groupId) {
      throw new Error('groupBy() is required for aggregate queries');
    }
    if (this._facts.length === 0) {
      throw new Error('At least one fact() is required for aggregate queries');
    }

    const queryInfo = this._client._findAggregateQuery(this._typeName);
    if (!queryInfo) {
      throw new Error(`No aggregate query found for type '${this._typeName}'`);
    }

    this._variables.aggregation = {
      groupId: this._groupId,
      facts: this._facts,
    };

    const response = await this._client._requestOperation('query', queryInfo, this._variables, 'groupId facts');
    this._client._checkErrors(response, queryInfo.name);

    return response.data[queryInfo.name];
  }
}

// ---------------------------------------------------------------------------
// SimfinityClient -- introspection-driven GraphQL client
// ---------------------------------------------------------------------------

export default class SimfinityClient {
  /**
   * @param {string} endpoint GraphQL HTTP endpoint URL
   * @param {{ prepareHeaders?: (headers: Record<string, string>) => void }} [options]
   *        Optional `prepareHeaders` runs before each request; mutate `headers` to add auth
   *        (e.g. `headers['Authorization'] = 'Bearer …'`). Login is not part of this client —
   *        perform auth in your app and set tokens inside this callback or a closure it sees.
   */
  constructor(endpoint, options = {}) {
    if (options.descriptor !== undefined && options.descriptorEndpoint !== undefined) throw new Error('descriptor and descriptorEndpoint are mutually exclusive');
    if (options.introspection !== undefined && !['extended', 'standard'].includes(options.introspection)) throw new Error('Invalid introspection mode');
    this._options = options;
    this._descriptor = null;
    this._fetch = options.fetch || ((...args) => {
      if (typeof globalThis.fetch !== 'function') throw new Error('SimfinityClient requires fetch or options.fetch');
      return globalThis.fetch(...args);
    });
    this._endpoint = endpoint;
    this._types = new Map();
    this._queries = new Map();
    this._mutations = new Map();
    this._typeNameToPlural = new Map();
    this._typeNameToSingular = new Map();
    this._typeNameToAggregate = new Map();
    this._queryNameToType = new Map();
    this._initialized = false;
    this._prepareHeaders =
      typeof options.prepareHeaders === 'function' ? options.prepareHeaders : null;
  }

  // -- Initialization ------------------------------------------------------

  async init() {
    let descriptor = this._options.descriptor;
    if (this._options.descriptorEndpoint !== undefined) {
      const headers = {};
      if (this._prepareHeaders) await this._prepareHeaders(headers);
      const response = await this._fetch(this._options.descriptorEndpoint, { method: 'GET', headers });
      if (!response.ok) throw new Error(`Descriptor HTTP request failed (${response.status})`);
      descriptor = await response.json();
    }
    let schema;
    if (descriptor !== undefined) {
      const normalized = normalizeDescriptor(descriptor);
      schema = normalized.schema; descriptor = normalized.descriptor;
    } else {
      const response = await this._sendRequest(introspectionQuery(this._options.introspection !== 'standard'));
      if (response.errors) { const error = new Error(`Introspection failed: ${JSON.stringify(response.errors)}`); error.graphQLErrors = response.errors; throw error; }
      schema = response.data?.__schema;
      if (!schema || !Array.isArray(schema.types)) throw new Error('Invalid introspection response');
    }
    const draft = new SimfinityClient(this._endpoint);
    draft._parseIntrospection(schema);
    draft._descriptor = descriptor || null;
    if (descriptor) draft._applyDescriptor(descriptor);
    for (const key of ['_types', '_queries', '_mutations', '_typeNameToPlural', '_typeNameToSingular', '_typeNameToAggregate', '_queryNameToType', '_descriptor']) this[key] = draft[key];
    this._initialized = true;
  }

  getDescriptor() { return this._descriptor; }

  _applyDescriptor(descriptor) {
    this._typeNameToPlural.clear(); this._typeNameToSingular.clear(); this._typeNameToAggregate.clear();
    for (const [typeName, type] of Object.entries(descriptor.types)) {
      for (const [kind, map] of [['list', this._typeNameToPlural], ['get', this._typeNameToSingular], ['aggregate', this._typeNameToAggregate]]) {
        if (type.endpoints?.[kind]) map.set(typeName, type.endpoints[kind]);
      }
    }
    for (const [root, registry] of [['query', this._queries], ['mutation', this._mutations]]) {
      for (const [name, operation] of Object.entries(descriptor.operations[root])) {
        Object.assign(registry.get(name), operation, { returnType: registry.get(name).returnType, args: registry.get(name).args,
          category: operation.operation === 'transition' ? 'stateTransition' : operation.operation, typeName: operation.type });
      }
    }
  }

  _parseIntrospection(schema) {
    const queryTypeName = schema.queryType?.name;
    const mutationTypeName = schema.mutationType?.name;

    this._buildTypesRegistry(schema.types);
    this._buildQueriesRegistry(schema.types, queryTypeName);
    this._buildMutationsRegistry(schema.types, mutationTypeName);
  }

  _buildTypesRegistry(types) {
    for (const type of types) {
      if (type.name.startsWith('__')) continue;
      const validKinds = ['OBJECT', 'ENUM', 'SCALAR', 'INPUT_OBJECT', 'INTERFACE', 'UNION'];
      if (!validKinds.includes(type.kind)) continue;

      const typeInfo = {
        name: type.name,
        kind: type.kind,
        fields: (type.fields || type.inputFields || []).map(f => ({
          name: f.name,
          type: unwrapType(f.type),
          rawType: f.type,
          args: (f.args || []).map(a => ({ ...a, hasDefault: a.hasDefault ?? (a.defaultValue != null) })),
          extensions: f.extensions || null,
          hasDefault: f.hasDefault ?? (f.defaultValue != null), defaultValue: f.defaultValue,
        })),
        enumValues: (type.enumValues || []).map(v => v.name),
        baseScalar: type.baseScalar, possibleTypes: type.possibleTypes?.map((value) => typeof value === 'string' ? value : value.name), interfaces: type.interfaces?.map((value) => typeof value === 'string' ? value : value.name), isOneOf: type.isOneOf,
      };
      this._types.set(type.name, typeInfo);
    }
  }

  _buildQueriesRegistry(types, queryTypeName) {
    const queryType = types.find(t => t.name === queryTypeName);
    if (!queryType?.fields) return;

    for (const field of queryType.fields) {
      const returnType = unwrapType(field.type);
      const queryInfo = {
        name: field.name,
        description: field.description,
        args: (field.args || []).map(a => ({ ...a, hasDefault: a.hasDefault ?? (a.defaultValue != null) })),
        returnType,
        rawReturnType: field.type,
      };
      this._queries.set(field.name, queryInfo);

      if (!returnType.name) continue;
      if (returnType.isList) {
        this._typeNameToPlural.set(returnType.name, field.name);
      } else if (queryInfo.args.some(a => a.name === 'id')) {
        this._typeNameToSingular.set(returnType.name, field.name);
      }
    }

    for (const typeName of this._typeNameToPlural.keys()) {
      const candidates = [...this._queries.values()].filter((query) => query.returnType.name === typeName && query.returnType.isList && !query.args.some((arg) => arg.name === 'aggregation'));
      const canonical = candidates.filter((query) => this._queries.has(`${query.name}_aggregate`));
      const selected = canonical.length === 1 ? canonical[0] : canonical.length === 0 && candidates.length === 1 ? candidates[0] : null;
      if (selected) {
        this._typeNameToPlural.set(typeName, selected.name);
        if (canonical.length === 1) this._typeNameToAggregate.set(typeName, `${selected.name}_aggregate`);
      } else this._typeNameToPlural.delete(typeName);
    }
    for (const typeName of this._typeNameToSingular.keys()) {
      const candidates = [...this._queries.values()].filter((query) => query.returnType.name === typeName && !query.returnType.isList && query.args.some((arg) => arg.name === 'id'));
      if (candidates.length !== 1) this._typeNameToSingular.delete(typeName);
    }
    this._queryNameToType = new Map();
    for (const [typeName, queryName] of this._typeNameToPlural) {
      this._queryNameToType.set(queryName, typeName);
    }
    for (const [typeName, queryName] of this._typeNameToSingular) {
      this._queryNameToType.set(queryName, typeName);
    }
  }

  _buildMutationsRegistry(types, mutationTypeName) {
    const mutationType = types.find(t => t.name === mutationTypeName);
    if (!mutationType?.fields) return;

    const knownTypeNames = [...this._typeNameToSingular.keys()];

    for (const field of mutationType.fields) {
      const returnType = unwrapType(field.type);
      const mutationInfo = {
        name: field.name,
        description: field.description,
        args: (field.args || []).map(a => ({ ...a, hasDefault: a.hasDefault ?? (a.defaultValue != null) })),
        returnType,
        rawReturnType: field.type,
        category: 'custom',
        typeName: returnType.name,
      };

      this._classifyMutation(mutationInfo, knownTypeNames);
      this._mutations.set(field.name, mutationInfo);
    }
  }

  _classifyMutation(mutationInfo, knownTypeNames) {
    const name = mutationInfo.name;
    for (const kind of ['add', 'update', 'delete']) {
      if (mutationInfo.description === kind && name.startsWith(kind) && knownTypeNames.includes(mutationInfo.returnType.name)) {
        Object.assign(mutationInfo, { category: kind, typeName: mutationInfo.returnType.name }); return;
      }
    }
    for (const typeName of knownTypeNames) {
      const singular = this._typeNameToSingular.get(typeName);
      const suffix = `_${singular}`;
      if (mutationInfo.returnType.name === typeName && singular && name.endsWith(suffix)
        && this._types.get(typeName)?.fields.some((field) => field.extensions?.stateMachine)) {
        Object.assign(mutationInfo, { category: 'stateTransition', typeName, action: name.slice(0, -suffix.length) }); return;
      }
      if (name === `add${typeName}`) {
        Object.assign(mutationInfo, { category: 'add', typeName });
        return;
      }
      if (name === `update${typeName}`) {
        Object.assign(mutationInfo, { category: 'update', typeName });
        return;
      }
      if (name === `delete${typeName}`) {
        Object.assign(mutationInfo, { category: 'delete', typeName });
        return;
      }
      if (name.endsWith(typeName)) {
        let prefix = name.slice(0, -typeName.length);
        if (prefix.endsWith('_')) prefix = prefix.slice(0, -1);
        if (prefix) {
          Object.assign(mutationInfo, {
            category: 'stateTransition',
            typeName,
            action: prefix,
          });
          return;
        }
      }
    }
  }

  // -- Field Auto-Selection ------------------------------------------------

  _getScalarFields(typeName) {
    const typeInfo = this._types.get(typeName);
    if (!typeInfo) return 'id';
    const scalars = typeInfo.fields
      .filter(f => (f.type.kind === 'SCALAR' || f.type.kind === 'ENUM') && canAutoSelect(f))
      .map(f => f.name);
    return scalars.length > 0 ? scalars.join(' ') : 'id';
  }

  _resolveFields(typeName, fields) {
    return fields || this._getScalarFields(typeName);
  }

  // -- Query Lookup --------------------------------------------------------

  _findPluralQuery(typeName) {
    const queryName = this._typeNameToPlural.get(typeName);
    return queryName ? this._queries.get(queryName) : null;
  }

  _findSingularQuery(typeName) {
    const queryName = this._typeNameToSingular.get(typeName);
    return queryName ? this._queries.get(queryName) : null;
  }

  _findAggregateQuery(typeName) {
    const queryName = this._typeNameToAggregate.get(typeName);
    return queryName ? this._queries.get(queryName) : null;
  }

  // -- HTTP ----------------------------------------------------------------

  async _sendRequest(query, variables) {
    const body = { query };
    if (variables && Object.keys(variables).length > 0) {
      body.variables = variables;
    }
    const headers = { 'Content-Type': 'application/json' };
    if (this._prepareHeaders) {
      await this._prepareHeaders(headers);
    }
    const response = await this._fetch(this._endpoint, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    });
    let envelope;
    try { envelope = await response.json(); } catch { throw new Error(`Invalid JSON response (HTTP ${response.status})`); }
    if (!envelope || typeof envelope !== 'object' || Array.isArray(envelope)
      || (envelope.errors !== undefined && (!Array.isArray(envelope.errors) || envelope.errors.length === 0 || envelope.errors.some((error) => !error || typeof error.message !== 'string')))
      || (!Object.hasOwn(envelope, 'data') && !envelope.errors)
      || (envelope.data !== undefined && envelope.data !== null && (typeof envelope.data !== 'object' || Array.isArray(envelope.data)))) throw new Error('Invalid GraphQL response');
    if (!response.ok && !envelope.errors) throw new Error(`HTTP request failed (${response.status})`);
    return envelope;
  }

  _checkErrors(response, name, partial = false) {
    if (response.errors && (!partial || !response.data?.[name])) {
      const error = new Error(`GraphQL errors: ${JSON.stringify(response.errors)}`);
      error.graphQLErrors = response.errors; throw error;
    }
  }

  async _requestOperation(kind, info, provided = {}, selection, collectionArguments = new Map()) {
    const definitions = []; const variables = {}; const mappings = [];
    for (const [name, value] of Object.entries(provided)) {
      if (value === undefined) continue;
      const arg = info.args.find((item) => item.name === name);
      if (!arg) throw new Error(`Unknown ${kind} argument ${info.name}.${name}`);
      definitions.push(`$${name}: ${typeRefToString(arg.type)}`); variables[name] = value; mappings.push(`${name}: $${name}`);
    }
    const context = { types: this._types, arguments: collectionArguments, used: new Set(), variable: (ref, value) => {
      let name = `c${definitions.length}`; while (Object.hasOwn(variables, name)) name += '_';
      variables[name] = value; definitions.push(`$${name}: ${typeRefToString(ref)}`); return name;
    } };
    const composite = ['OBJECT', 'INTERFACE', 'UNION'].includes(info.returnType.kind);
    let fields = '';
    if (composite) {
      const tree = selection instanceof SelectionTree ? selection : new SelectionTree();
      if (!(selection instanceof SelectionTree)) tree.addSelection(selection || this._getScalarFields(info.returnType.name));
      fields = tree.serialize(context, info.returnType.name);
      if (!fields) throw new Error(`No fields to select for ${info.name}`);
    }
    for (const path of collectionArguments.keys()) if (!context.used.has(path)) throw new Error(`Collection path is not selected: ${path}`);
    const document = `${kind}${definitions.length ? `(${definitions.join(', ')})` : ''} { ${info.name}${mappings.length ? `(${mappings.join(', ')})` : ''}${fields ? ` { ${fields} }` : ''} }`;
    return this._sendRequest(document, variables);
  }

  async query(name, args = {}, fields) {
    this._ensureInitialized(); const info = this._queries.get(name);
    if (!info) throw new Error(`Query '${name}' not found`);
    const response = await this._requestOperation('query', info, args, fields);
    this._checkErrors(response, name); return response.data?.[name];
  }

  getViews(typeName) {
    this._ensureInitialized();
    return [...this._queries.values()].filter((info) => info.view && (!typeName || info.typeName === typeName));
  }

  findView(name, params = {}) {
    this._ensureInitialized(); const info = this._queries.get(name);
    if (!info?.returnType.isList || (this._descriptor && !info.view)) throw new Error(`View '${name}' not found`);
    const builder = new QueryBuilder(this, info.returnType.name, info); builder._variables = { ...params }; return builder;
  }

  // -- Query Methods -------------------------------------------------------

  find(typeName) {
    this._ensureInitialized();
    return new QueryBuilder(this, typeName);
  }

  aggregate(typeName) {
    this._ensureInitialized();
    return new AggregateBuilder(this, typeName);
  }

  findByParent(typeName, connectionField, parentId) {
    this._ensureInitialized();
    const builder = new QueryBuilder(this, typeName);
    builder.where(connectionField, [{ path: 'id', operator: 'EQ', value: parentId }]);
    builder.sort('id', 'ASC');
    return builder;
  }

  async search(typeName, searchTerm, options = {}) {
    this._ensureInitialized();
    const { page = 1, size = 10, displayField = null } = options;

    let searchField = displayField;
    if (!searchField) {
      const typeInfo = this._types.get(typeName);
      if (typeInfo?.fields) {
        const nameField = typeInfo.fields.find(f => f.name === 'name');
        if (nameField) {
          searchField = 'name';
        } else {
          const firstScalar = typeInfo.fields.find(f =>
            isScalarOrEnum(f.type.kind) && f.name !== 'id',
          );
          searchField = firstScalar?.name || 'id';
        }
      }
    }

    const typeInfo = this._types.get(typeName);
    const fieldInfo = typeInfo?.fields.find(f => f.name === searchField);
    const fieldTypeName = fieldInfo?.type?.name || 'String';

    const isString = !isNumericScalar(fieldTypeName) && !isBooleanScalar(fieldTypeName);
    const operator = isString ? 'LIKE' : 'EQ';

    let castedTerm = searchTerm;
    if (isNumericScalar(fieldTypeName)) {
      const actualType = getActualScalarType(fieldTypeName);
      if (actualType?.toLowerCase() === 'int') {
        const parsed = parseInt(searchTerm, 10);
        if (!isNaN(parsed)) castedTerm = parsed;
      } else {
        const parsed = parseFloat(searchTerm);
        if (!isNaN(parsed)) castedTerm = parsed;
      }
    } else if (isBooleanScalar(fieldTypeName)) {
      if (searchTerm.toLowerCase() === 'true') castedTerm = true;
      else if (searchTerm.toLowerCase() === 'false') castedTerm = false;
    }

    const builder = this.find(typeName)
      .fields(`id ${searchField}`)
      .page(page, size, false)
      .where(searchField, operator, castedTerm);

    return builder.exec();
  }

  async getById(typeName, id, fields) {
    this._ensureInitialized();
    const queryInfo = this._findSingularQuery(typeName);
    if (!queryInfo) {
      throw new Error(`No singular query found for type '${typeName}'`);
    }

    const selectionSet = this._resolveFields(typeName, fields);
    const idArg = queryInfo.args.find(a => a.name === 'id');
    const idType = idArg ? typeRefToString(idArg.type) : 'ID!';

    const query = `query($id: ${idType}) { ${queryInfo.name}(id: $id) { ${selectionSet} } }`;
    const response = await this._sendRequest(query, { id });

    if (response.errors && !response.data?.[queryInfo.name]) {
      const error = new Error(`GraphQL errors: ${JSON.stringify(response.errors)}`);
      error.graphQLErrors = response.errors;
      throw error;
    }
    return response.data[queryInfo.name];
  }

  // -- CRUD Mutation Methods -----------------------------------------------

  async add(typeName, input, fields, options = {}) {
    this._ensureInitialized();
    const transformedInput = options.transform
      ? this.transformInput(typeName, input, { mode: 'create', ...options })
      : input;
    return this._executeMutation(this._mutationName(typeName, 'add'), typeName, { input: transformedInput }, fields);
  }

  async update(typeName, id, input, fields, options = {}) {
    this._ensureInitialized();
    const transformedInput = options.transform
      ? this.transformInput(typeName, input, { mode: 'update', ...options })
      : input;
    return this._executeMutation(
      this._mutationName(typeName, 'update'), typeName,
      { input: { id, ...transformedInput } },
      fields,
    );
  }

  async delete(typeName, id, fields, options = {}) {
    this._ensureInitialized();
    return this._executeMutation(this._mutationName(typeName, 'delete'), typeName, { id, ...(options.version !== undefined ? { version: options.version } : {}) }, fields);
  }

  _mutationName(typeName, kind) {
    if (this._descriptor) {
      const name = this._descriptor.types[typeName]?.endpoints?.[kind];
      if (!name) throw new Error(`No ${kind} mutation for '${typeName}'`);
      return name;
    }
    return [...this._mutations.values()].find((info) => info.category === kind && info.typeName === typeName)?.name || `${kind}${typeName}`;
  }

  _inputTypeName(typeName, kind) {
    const descriptor = this._descriptor?.types[typeName]?.inputs?.[kind];
    if (descriptor) return descriptor;
    const info = this._mutations.get(this._mutationName(typeName, kind));
    const input = info?.args.find((arg) => arg.name === 'input');
    return input ? unwrapType(input.type).name : null;
  }

  async transaction(operations, fields = 'id', options = {}) {
    this._ensureInitialized();
    const info = options.name ? this._mutations.get(options.name) : [...this._mutations.values()].find((item) => item.category === 'transaction');
    if (!info || (this._descriptor && info.category !== 'transaction') || (!this._descriptor && !options.name)) throw new Error('Generated transaction not found; introspection requires an explicit transaction name');
    return this._executeMutation(info.name, info.returnType.name, { operations }, fields);
  }

  // -- State Machine -------------------------------------------------------

  async transition(typeName, action, id, inputOrFields, fields) {
    this._ensureInitialized();
    const mutationInfo = this._findTransitionMutation(typeName, action);
    if (!mutationInfo) {
      throw new Error(`No state machine transition '${action}' found for type '${typeName}'`);
    }

    let input, resolvedFields;
    if (typeof inputOrFields === 'object' && inputOrFields !== null) {
      input = inputOrFields;
      resolvedFields = fields;
    } else {
      input = {};
      resolvedFields = inputOrFields;
    }

    return this._executeMutation(
      mutationInfo.name, typeName, { input: { id, ...input } }, resolvedFields,
    );
  }

  _findTransitionMutation(typeName, action) {
    for (const info of this._mutations.values()) {
      if (info.category === 'stateTransition' && info.typeName === typeName && info.action === action) {
        return info;
      }
    }
    return null;
  }

  getStateMachineFields(typeName) {
    this._ensureInitialized();
    const typeInfo = this._types.get(typeName);
    if (!typeInfo?.fields) return [];
    return typeInfo.fields
      .filter(f => f.extensions?.stateMachine === true)
      .map(f => f.name);
  }

  getAvailableTransitions(typeName) {
    this._ensureInitialized();
    const transitions = [];
    for (const info of this._mutations.values()) {
      if (info.category === 'stateTransition' && info.typeName === typeName) {
        transitions.push({
          action: info.action,
          mutationName: info.name,
        });
      }
    }
    return transitions;
  }

  // -- Custom Mutations ----------------------------------------------------

  async customMutation(mutationName, args, fields) {
    this._ensureInitialized();
    const mutationInfo = this._mutations.get(mutationName);
    if (!mutationInfo) {
      throw new Error(`Mutation '${mutationName}' not found`);
    }
    return this._executeMutation(
      mutationName,
      mutationInfo.returnType.name,
      args || {},
      fields,
    );
  }

  // -- Raw Execution -------------------------------------------------------

  async execute(query, variables) {
    return this._sendRequest(query, variables);
  }

  // -- Shared Mutation Executor --------------------------------------------

  async _executeMutation(mutationName, typeName, providedArgs, fields) {
    const info = this._mutations.get(mutationName);
    if (!info) throw new Error(`Mutation '${mutationName}' not found`);
    const response = await this._requestOperation('mutation', info, providedArgs, fields);
    this._checkErrors(response, mutationName); return response.data?.[mutationName];
  }

  // -- Schema Getters ------------------------------------------------------

  getTypes() {
    return Object.fromEntries(this._types);
  }

  getQueries() {
    return Object.fromEntries(this._queries);
  }

  getMutations() {
    return Object.fromEntries(this._mutations);
  }

  // -- Selection Set Building ------------------------------------------------

  buildSelectionSet(typeName) {
    this._ensureInitialized();
    const typeInfo = this._types.get(typeName);
    if (!typeInfo?.fields) {
      return { selection: 'id', columns: ['id'], sortFieldByColumn: {}, fieldTypeByColumn: {} };
    }

    const columns = [];
    const sortFieldByColumn = {};
    const fieldTypeByColumn = {};
    const fieldSelections = [];

    for (const field of typeInfo.fields) {
      const { name, type: unwrapped, rawType, extensions } = field;

      if (isListType(rawType) || !canAutoSelect(field)) continue;

      if (isScalarOrEnum(unwrapped.kind)) {
        fieldSelections.push(name);
        if (name !== 'id') columns.push(name);
        sortFieldByColumn[name] = name;
        fieldTypeByColumn[name] = unwrapped.name || unwrapped.kind || 'SCALAR';
      } else if (unwrapped.kind === 'OBJECT' && unwrapped.name) {
        const objType = this._types.get(unwrapped.name);
        const objFields = (objType?.fields || []).filter((candidate) => isScalarOrEnum(candidate.type.kind) && !candidate.type.isList && canAutoSelect(candidate));
        const objFieldNames = new Set(objFields.map(f => f.name));
        const isEmbedded = extensions?.relation?.embedded === true;

        let chosenDisplay = null;
        const extDisplay = extensions?.relation?.displayField;
        if (extDisplay && objFieldNames.has(extDisplay)) {
          chosenDisplay = extDisplay;
        } else if (objFieldNames.has('name')) {
          chosenDisplay = 'name';
        } else {
          const firstScalar = objFields.find(f =>
            isScalarOrEnum(f.type.kind) && !f.type.isList,
          );
          chosenDisplay = firstScalar?.name || null;
        }

        const subFields = new Set();
        if (chosenDisplay) subFields.add(chosenDisplay);
        if (!isEmbedded && objFieldNames.has('id')) subFields.add('id');
        if (subFields.size === 0) {
          if (objFieldNames.has('id') && !isEmbedded) subFields.add('id');
          else if (objFieldNames.has('name')) subFields.add('name');
          else if (objFields[0]) subFields.add(objFields[0].name);
        }

        if (subFields.size === 0) continue;
        const subSelection = [...subFields].join(' ');
        fieldSelections.push(`${name} { ${subSelection} }`);
        columns.push(name);

        if (chosenDisplay) {
          sortFieldByColumn[name] = `${name}.${chosenDisplay}`;
          const displayFieldInfo = objFields.find(f => f.name === chosenDisplay);
          fieldTypeByColumn[name] = displayFieldInfo?.type?.name || 'OBJECT';
        } else {
          sortFieldByColumn[name] = name;
          fieldTypeByColumn[name] = 'OBJECT';
        }
      }
    }

    const hasId = typeInfo.fields.some(f => f.name === 'id' && canAutoSelect(f));
    if (hasId && !fieldSelections.includes('id')) {
      fieldSelections.unshift('id');
    }

    return {
      selection: fieldSelections.join('\n') || '__typename',
      columns,
      sortFieldByColumn,
      fieldTypeByColumn,
    };
  }

  // -- Schema Metadata Access -----------------------------------------------

  getFieldExtensions(typeName, fieldName) {
    this._ensureInitialized();
    const typeInfo = this._types.get(typeName);
    if (!typeInfo) return null;
    const field = typeInfo.fields.find(f => f.name === fieldName);
    return field?.extensions || null;
  }

  getDisplayField(typeName, fieldName) {
    this._ensureInitialized();
    const ext = this.getFieldExtensions(typeName, fieldName);
    const displayField = ext?.relation?.displayField;
    if (displayField) return displayField;

    const typeInfo = this._types.get(typeName);
    const field = typeInfo?.fields.find(f => f.name === fieldName);
    if (!field || field.type.kind !== 'OBJECT') return null;

    const objectType = this._types.get(field.type.name);
    if (!objectType?.fields) return null;

    const objFieldNames = objectType.fields.map(f => f.name);
    if (objFieldNames.includes('name')) return 'name';

    const firstScalar = objectType.fields.find(f =>
      isScalarOrEnum(f.type.kind) && !f.type.isList,
    );
    return firstScalar?.name || null;
  }

  isEmbeddedField(typeName, fieldName) {
    this._ensureInitialized();
    const ext = this.getFieldExtensions(typeName, fieldName);
    return ext?.relation?.embedded === true;
  }

  getConnectionField(typeName, fieldName) {
    this._ensureInitialized();
    const ext = this.getFieldExtensions(typeName, fieldName);
    return ext?.relation?.connectionField || null;
  }

  isStateMachineField(typeName, fieldName) {
    this._ensureInitialized();
    const ext = this.getFieldExtensions(typeName, fieldName);
    return ext?.stateMachine === true;
  }

  isReadOnlyField(typeName, fieldName) {
    this._ensureInitialized();
    const ext = this.getFieldExtensions(typeName, fieldName);
    return ext?.readOnly === true;
  }

  getEnumValues(typeName) {
    this._ensureInitialized();
    const typeInfo = this._types.get(typeName);
    if (!typeInfo || typeInfo.kind !== 'ENUM') return [];
    return typeInfo.enumValues || [];
  }

  getFieldsOfType(typeName) {
    this._ensureInitialized();
    const typeInfo = this._types.get(typeName);
    if (!typeInfo) return [];
    return typeInfo.fields;
  }

  getDescriptionFieldType(typeName, descriptionField) {
    this._ensureInitialized();
    const typeInfo = this._types.get(typeName);
    if (!typeInfo?.fields) return 'String';
    const field = typeInfo.fields.find(f => f.name === descriptionField);
    if (!field) return 'String';
    return field.type.name || 'String';
  }

  // -- Entity & Query Name Resolution ----------------------------------------

  getTypeNameForQuery(queryName) {
    this._ensureInitialized();
    const queryInfo = this._queries.get(queryName);
    return queryInfo?.returnType?.name || null;
  }

  getPluralQueryName(typeName) {
    this._ensureInitialized();
    return this._typeNameToPlural.get(typeName) || null;
  }

  getSingularQueryName(typeName) {
    this._ensureInitialized();
    return this._typeNameToSingular.get(typeName) || null;
  }

  getListEntityNames() {
    this._ensureInitialized();
    const names = [];
    for (const [queryName, queryInfo] of this._queries) {
      if (queryInfo.returnType.isList && !queryName.endsWith('_aggregate')) {
        names.push(queryName);
      }
    }
    return names.sort();
  }

  getListEntityNamesOfType(typeName) {
    this._ensureInitialized();
    const names = [];
    for (const [queryName, queryInfo] of this._queries) {
      if (queryInfo.returnType.isList
        && queryInfo.returnType.name === typeName
        && !queryName.endsWith('_aggregate')) {
        names.push(queryName);
      }
    }
    return names.sort();
  }

  getQueryNamesForType(typeName) {
    this._ensureInitialized();
    return {
      pluralQueryName: this._typeNameToPlural.get(typeName) || null,
      singularQueryName: this._typeNameToSingular.get(typeName) || null,
      aggregateQueryName: this._typeNameToAggregate.get(typeName) || null,
    };
  }

  // -- Scalar Type Utilities -----------------------------------------------

  getActualScalarType(scalarName) { return getActualScalarType(scalarName); }
  isNumericScalar(scalarName) { return isNumericScalar(scalarName); }
  isBooleanScalar(scalarName) { return isBooleanScalar(scalarName); }
  isDateTimeScalar(scalarName) { return isDateTimeScalar(scalarName); }

  // -- Mutation Input Transformation -----------------------------------------

  transformInput(typeName, rawInput, options = {}) {
    this._ensureInitialized(); return transformRootInput(this, typeName, rawInput, options);
  }

  _legacyTransformInput(typeName, rawInput, options = {}) {
    this._ensureInitialized();
    const { skipFields = [], transientFields = [] } = options;
    const typeInfo = this._types.get(typeName);
    if (!typeInfo) return { ...rawInput };

    const transformed = {};

    for (const field of typeInfo.fields) {
      const { name, type: unwrapped, rawType, extensions } = field;

      if (rawInput[name] === undefined) continue;
      if (name === 'id') continue;
      if (skipFields.includes(name) || transientFields.includes(name)) continue;
      if (extensions?.stateMachine === true) continue;
      if (extensions?.readOnly === true) continue;
      if (isListType(rawType) && unwrapped.kind === 'OBJECT') continue;

      let value = rawInput[name];

      if (unwrapped.kind === 'OBJECT' && extensions?.relation?.embedded === true) {
        value = this._transformEmbeddedInput(unwrapped.name, value, options);
      } else if (unwrapped.kind === 'OBJECT' && !extensions?.relation?.embedded) {
        value = this._cleanObjectFieldForMutation(value);
      } else {
        value = this._coerceScalarValue(value, unwrapped.name);
      }

      if (value !== undefined && value !== null && value !== '') {
        transformed[name] = value;
      }
    }

    return this._deepRemoveTypename(transformed);
  }

  _transformEmbeddedInput(objectTypeName, value) {
    if (!value || typeof value !== 'object') return value;
    const typeInfo = this._types.get(objectTypeName);
    if (!typeInfo?.fields) return value;

    const cleaned = {};
    for (const field of typeInfo.fields) {
      const { name, type: unwrapped, extensions } = field;
      if (value[name] === undefined) continue;
      if (extensions?.readOnly === true) continue;

      let fieldValue = value[name];
      fieldValue = this._coerceScalarValue(fieldValue, unwrapped.name);

      if (fieldValue !== undefined && fieldValue !== null && fieldValue !== '') {
        cleaned[name] = fieldValue;
      }
    }
    return Object.keys(cleaned).length > 0 ? cleaned : undefined;
  }

  _cleanObjectFieldForMutation(value) {
    if (!value) return value;
    if (typeof value === 'string') return { id: value };
    if (typeof value === 'object' && value.id) return { id: value.id };
    return value;
  }

  _coerceScalarValue(value, scalarTypeName) {
    if (value === null || value === undefined) return value;

    if (isNumericScalar(scalarTypeName) && typeof value === 'string') {
      return Number(value);
    }

    if (isDateTimeScalar(scalarTypeName) && typeof value === 'string') {
      if (/^\d{4}-\d{2}-\d{2}$/.test(value)) {
        return `${value}T00:00:00.000Z`;
      }
    }

    return value;
  }

  _deepRemoveTypename(obj) {
    if (typeof obj !== 'object' || obj === null) return obj;
    if (Array.isArray(obj)) return obj.map(item => this._deepRemoveTypename(item));

    const cleaned = {};
    for (const [key, value] of Object.entries(obj)) {
      if (key === '__typename') continue;
      cleaned[key] = this._deepRemoveTypename(value);
    }
    return cleaned;
  }

  // -- Collection Delta Mutations --------------------------------------------

  transformCollectionDelta(collectionTypeName, delta, options = {}) {
    this._ensureInitialized(); return transformDelta(this, collectionTypeName, delta, options);
  }

  // -- Guard ---------------------------------------------------------------

  _ensureInitialized() {
    if (!this._initialized) {
      throw new Error('Client not initialized. Call init() first.');
    }
  }

  // -- Static Helpers -------------------------------------------------------

  static condition(field, operator, value, path) {
    const cond = { field, operator, value };
    if (path !== undefined) cond.path = path;
    return { conditions: [cond] };
  }
}
