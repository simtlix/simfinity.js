// Storage contracts are separate from input exposure: readOnly and own resolvers
// do not remove storage, while virtual fields do. No application code is run here.
export const messages = {
  storageMissingConnection: 'This storage backend requires a child connectionField for every stored object collection, including readOnly fields and fields with an own resolver. Declare the child link or use a virtual output field.',
  storageInverse: 'The child connectionField conflicts with its parent: use a singular ID, a reference to this parent, or an undeclared private child link.',
  storageInverseAlias: 'This child connectionField names one GraphQL field and another field\'s storage alias. Choose an unambiguous child link.',
  storageManyToMany: 'This storage backend cannot use a child collection as an inverse link. Declare an explicit linking entity with singular references.',
  storageCollision: 'Two stored fields use the same storage name. Give their stored values distinct names; a reference may use its connectionField alias.',
  storageCycle: 'This embedded storage path contains a cycle. Use an independent reference to break the storage cycle; readOnly does not remove storage.',
  storageInputCycle: 'These writable embedded fields form an input dependency cycle. Use an independent reference or a readOnly value supplied by the application.',
  storageEmbeddedCollection: 'This storage backend cannot store a referenced collection inside an embedded value. Declare the collection on its owning entity; embedded singular references are supported.',
  storageIndexFields: 'A declarative index needs a nonempty array of distinct field names.',
  storageIndexTarget: 'A SQL index must name a direct stored scalar or singular reference by GraphQL name or storage alias; lists, embedded objects and dotted paths are unsupported.',
  storageIdentity: 'A SQL entity id or _id must be a singular scalar ID or String. Embedded value IDs are ordinary fields.',
  storagePrivateColumn: 'SQL reserves physical column names beginning with __. Choose another stored name or child connectionField.',
  storageEmbeddedUnique: 'SQL cannot enforce unique on an entire embedded object. Declare uniqueness on a stored scalar or reference leaf instead.',
  storageMongoName: 'Mongo generated storage cannot represent this constructor path or embedded Object.prototype member. Choose another stored name; a reference can use a connectionField alias.',
  storageOverwrite: 'Generated Mongo storage maps two fields to the same path, so one definition overwrites the other. Confirm the intended mapping and any model hook.',
  storageIgnoredUnique: 'The Mongo model generator ignores unique on this mapping. Use an appropriate native index or a supported singular String, enum or numeric mapping; existing database constraints are not inspected.',
  storageUnlinkedCollection: 'This accepted collection has no child link. Generated nested writes through it are rejected; supply a connectionField or make an intentionally computed output readOnly with its own resolver.',
  storageEmbeddedIdentity: 'This type is both an entity and an embedded value. Its generated id resolver reads _id before id in both places; confirm that identity is intentional or use a distinct value type.',
};

const LIMIT = 200;
const isSQL = runtime => ['sql', 'postgres'].includes(runtime.engine);
const truthy = value => value?.known ? !!value.value : null;
const missing = value => value?.known && (value.value == null || value.value === '');
const plainLink = value => value?.known && typeof value.value === 'string' && value.value !== '' && !value.value.includes('.');
const at = (field, key) => field.relation?.get(key) || field.extensions?.get(key) || field.node;
const scalarRoot = type => {
  const visited = new Set();
  let root = type;
  while (root?.kind === 'scalar') {
    if (visited.has(root) || visited.size >= LIMIT || root.base === undefined) return null;
    visited.add(root);
    if (!root.base) return root;
    root = root.base;
  }
  return null;
};

const describe = (graph, field) => {
  if (field.virtual !== false) return null;
  const shape = graph.shape(field.type);
  if (!shape?.named || shape.listDepth > 1) return null;
  const { named } = shape;
  const value = { field, shape, named, name: field.name, storageName: field.name, list: shape.listDepth === 1 };
  if (['scalar', 'enum'].includes(named.kind)) {
    return { ...value, kind: 'scalar', scalar: named.kind === 'enum' ? 'Enum' : scalarRoot(named)?.name };
  }
  if (named.kind !== 'object' || !field.extensions?.has('relation') || !field.relation || !field.embedded.known) return null;
  if (field.embedded.value) return { ...value, kind: 'embedded' };
  if (value.list) return { ...value, kind: 'collection' };
  if (!field.connection.known) return null;
  if (field.connection.value != null && typeof field.connection.value !== 'string') return null;
  return { ...value, kind: 'reference', storageName: field.connection.value || field.name, target: named.name };
};

const scopes = graph => {
  const runtimes = new Map();
  for (const registration of graph.registrations) runtimes.set(registration.runtime.key, registration.runtime);
  return [...runtimes.values()].flatMap(runtime => {
    const builds = graph.builds.filter(build => build.runtime.key === runtime.key);
    const snapshots = builds.map(build => ({ runtime, build, registrations: graph.registrationsFor(runtime, build.node.range?.[0] ?? build.node.start) }));
    snapshots.push({ runtime, build: null, registrations: graph.registrationsFor(runtime) });
    return snapshots;
  });
};

// A positive local build/registration history does not need a fresh runtime:
// explicit registrations replace earlier entries by name. Every participating
// event must nevertheless have a complete, straight-line local ordering.
const ordered = (graph, build, registrations) => {
  const region = graph.block(build.node);
  return !graph.truncated && !!region
    && registrations.every(registration => registration.type?.name && graph.block(registration.node) === region)
    && graph.registrations.filter(registration => registration.runtime.key === build.runtime.key
      && registration.node.range[0] < build.node.range[0]).every(registration => graph.block(registration.node) === region);
};

// The existing connection-field rule owns these diagnostics and deduplicates
// syntax errors it already found on registered and embedded local types.
export const connectionDiagnostics = graph => {
  const result = [];
  for (const { runtime, registrations } of scopes(graph)) {
    if (!graph.metadata(runtime)) continue;
    const visited = new Set();
    const visit = type => {
      if (!type || visited.has(type) || visited.size >= LIMIT) return;
      visited.add(type);
      for (const field of type.fields?.values() || []) {
        const shape = graph.shape(field.type);
        if (shape?.named.kind === 'object' && shape.listDepth <= 1
          && field.virtual === false && field.extensions?.has('relation') && field.relation
          && field.embedded.known && !field.embedded.value && field.connection.known
          && field.connection.value != null && field.connection.value !== ''
          && (typeof field.connection.value !== 'string' || field.connection.value.includes('.'))) {
          result.push({ node: at(field, 'connectionField'), messageId: 'invalid' });
          continue;
        }
        const entry = describe(graph, field);
        if (entry?.kind === 'embedded') visit(entry.named);
        if (entry?.kind !== 'collection' || !missing(field.connection)) continue;
        const directlyRegistered = registrations.some(reg => reg.type === type);
        const covered = directlyRegistered && truthy(field.readOnly) === false
          && field.resolve.known && field.resolve.value == null;
        if (!covered) result.push({ node: at(field, 'connectionField'), messageId: 'storageMissingConnection' });
      }
    };
    for (const type of graph.entities(runtime, registrations)) visit(type);
  }
  return result;
};

export const inspect = graph => {
  const errors = [];
  const warnings = [];
  const seen = new Set();
  const report = (destination, node, messageId) => {
    if (!node) return;
    const key = `${destination === errors ? 'e' : 'w'}:${messageId}:${node.range?.[0] ?? node.start}:${node.range?.[1] ?? node.end}`;
    if (seen.has(key)) return;
    seen.add(key);
    destination.push({ node, messageId });
  };
  const error = (node, messageId) => report(errors, node, messageId);
  const warn = (node, messageId) => report(warnings, node, messageId);

  for (const { runtime, registrations, build } of scopes(graph)) {
    const metadata = graph.metadata(runtime);
    const entities = metadata ? graph.entities(runtime, registrations) : new Set();
    const stored = type => [...(type.fields?.values() || [])].map(field => describe(graph, field)).filter(Boolean);
    const complete = type => !!type.fields && !graph.truncated
      && [...type.fields.values()].every(field => field.virtual === true || describe(graph, field));
    const hasOwned = type => {
      const visited = new Set();
      const pending = [type];
      while (pending.length && visited.size < LIMIT) {
        const item = pending.pop();
        if (!item || visited.has(item)) continue;
        visited.add(item);
        for (const entry of stored(item)) {
          if (entry.kind === 'reference' || graph.property(entry.field.extensions, 'unique').value === true) return true;
          if (entry.kind === 'embedded') pending.push(entry.named);
        }
      }
      return false;
    };
    const cycleReported = new Set();
    const visitedStorage = new Map();
    const storageVisit = (type, mode, stack = [], embedded = false, physical = true) => {
      if (!type?.fields || stack.length >= LIMIT) return;
      const visitKey = `${mode}:${embedded}:${physical}`;
      if (visitedStorage.get(type)?.has(visitKey)) return;
      if (!visitedStorage.has(type)) visitedStorage.set(type, new Set());
      visitedStorage.get(type).add(visitKey);
      const path = [...stack, type];
      const storage = new Map();
      for (const entry of stored(type)) {
        const { field, named, kind, storageName } = entry;
        const unique = graph.property(field.extensions, 'unique');
        if (kind === 'collection') {
          if (mode === 'metadata' && embedded) error(field.node, 'storageEmbeddedCollection');
          if (mode === 'mongo' && unique.known && unique.value) warn(at(field, 'unique'), 'storageIgnoredUnique');
          continue;
        }
        // Mongo only defines mappings for its known builtins, enums/date scalars,
        // references and embedded values. Unknown scalar mappings store nothing
        // provable, and a relation-marked scalar list takes a different branch.
        const root = kind === 'scalar' && named.kind === 'scalar' ? scalarRoot(named) : null;
        const mongoMapped = kind !== 'scalar' || named.kind === 'enum'
          || (root && ((root.builtin && ['String', 'ID', 'Int', 'Float', 'Boolean'].includes(root.name))
            || ['DateTime', 'Date', 'Time'].includes(root.name)));
        if (mode === 'mongo' && (!mongoMapped || (entry.list && field.extensions?.has('relation')))) continue;
        if (storage.has(storageName)) {
          (mode === 'metadata' ? error : warn)(field.node, mode === 'metadata' ? 'storageCollision' : 'storageOverwrite');
        }
        storage.set(storageName, entry);
        if (mode === 'metadata' && isSQL(runtime)) {
          if (kind === 'embedded' && unique.known && unique.value === true) error(at(field, 'unique'), 'storageEmbeddedUnique');
          if (physical && !embedded && ['id', '_id'].includes(entry.name)) {
            if (kind !== 'scalar' || entry.list || (entry.scalar && !['ID', 'String'].includes(entry.scalar))) error(field.node, 'storageIdentity');
          } else if (physical && !embedded && storageName === 'id') error(field.node, 'storageCollision');
          else if (physical && storageName.startsWith('__')) error(field.node, 'storagePrivateColumn');
        }
        if (mode === 'mongo') {
          if (storageName === 'constructor' || (kind === 'embedded' && entry.name in Object.prototype)) error(field.node, 'storageMongoName');
          const honored = kind === 'scalar' && !entry.list && (named.kind === 'enum'
            || (root?.builtin && ['String', 'Int', 'Float'].includes(root.name)));
          if (unique.known && unique.value && !honored) warn(at(field, 'unique'), 'storageIgnoredUnique');
        }
        if (kind === 'embedded') {
          if (path.includes(named)) {
            const cycle = path.slice(path.indexOf(named));
            if (!cycle.some(member => cycleReported.has(member))) error(field.node, 'storageCycle');
            cycle.forEach(member => cycleReported.add(member));
          } else storageVisit(named, mode, path, true, physical && (mode !== 'metadata' || !isSQL(runtime) || hasOwned(named)));
        }
      }
    };

    if (metadata) {
      for (const type of entities) storageVisit(type, 'metadata');
      // Clone only the metadata records we infer. Never mutate shared graph fields.
      const fields = new Map([...entities].map(type => [type, stored(type).map(entry => ({ ...entry }))]));
      for (const parent of entities) {
        for (const entry of fields.get(parent) || []) {
          if (entry.kind !== 'collection' || !plainLink(entry.field.connection)) continue;
          const child = entry.named;
          const childFields = fields.get(child);
          if (!childFields) continue;
          const link = entry.field.connection.value;
          if (childFields.some(item => item.name === link && item.kind === 'collection')) {
            error(at(entry.field, 'connectionField'), 'storageManyToMany');
            continue;
          }
          const named = childFields.find(item => item.name === link && item.kind !== 'collection');
          const aliased = childFields.find(item => item.storageName === link && item.kind !== 'collection');
          if (named && aliased && named !== aliased) {
            error(at(entry.field, 'connectionField'), 'storageInverseAlias');
            continue;
          }
          const inverse = named || aliased;
          if (inverse) {
            if (inverse.kind === 'scalar' && !inverse.scalar && !inverse.list) continue;
            if (inverse.kind === 'scalar' && inverse.scalar === 'ID' && !inverse.list) {
              inverse.kind = 'reference';
              inverse.target = parent.name;
              if (isSQL(runtime) && ['id', '_id'].includes(inverse.name)) error(at(entry.field, 'connectionField'), 'storageIdentity');
            }
            if (inverse.kind !== 'reference' || (inverse.target && parent.name && inverse.target !== parent.name)) error(at(entry.field, 'connectionField'), 'storageInverse');
          } else if (complete(child)) {
            childFields.push({ name: link, storageName: link, kind: 'reference', target: parent.name });
            if (isSQL(runtime) && link.startsWith('__')) error(at(entry.field, 'connectionField'), 'storagePrivateColumn');
            if (isSQL(runtime) && ['id', '_id'].includes(link)) error(at(entry.field, 'connectionField'), 'storageIdentity');
          }
        }
      }
      for (const type of entities) {
        const indexes = graph.analysis.resolve(type.config?.get('extensions'));
        const extensions = graph.analysis.properties(indexes);
        const input = extensions?.get('indexes');
        if (!input) continue;
        const indexList = graph.analysis.resolve(input);
        if (indexList?.type !== 'ArrayExpression' || indexList.elements.some(item => !item || item.type === 'SpreadElement')) continue;
        for (const index of indexList.elements) {
          const options = graph.analysis.properties(index);
          if (!options) continue;
          const fieldNode = options.get('fields');
          const list = graph.analysis.resolve(fieldNode);
          const literal = graph.constant(fieldNode);
          if (list?.type !== 'ArrayExpression') {
            if (!fieldNode || literal.known) error(fieldNode || index, 'storageIndexFields');
            continue;
          }
          const values = list.elements.map(item => item && item.type !== 'SpreadElement' ? graph.constant(item) : { known: false });
          if (!values.length || (values.every(value => value.known) && new Set(values.map(value => value.value)).size !== values.length)) {
            error(fieldNode, 'storageIndexFields');
            continue;
          }
          if (!isSQL(runtime)) continue;
          for (let i = 0; i < values.length; i += 1) {
            if (!values[i].known) continue;
            const target = fields.get(type)?.find(item => item.name === values[i].value || item.storageName === values[i].value);
            if ((!target && complete(type)) || (target && (!['scalar', 'reference'].includes(target.kind) || target.list))) {
              error(list.elements[i], 'storageIndexTarget');
            }
          }
        }
      }
    }
    if (runtime.engine === 'mongo') {
      for (const registration of registrations) {
        if (graph.generated(registration, registrations) === true) storageVisit(registration.type, 'mongo');
      }
    }

    // Mongo's prepare performs this check for supplied models too, before the
    // generator runs. Only a complete child map can prove the link is private.
    if (runtime.engine === 'mongo') {
      for (const registration of registrations) {
        for (const entry of stored(registration.type || {})) {
          if (entry.kind !== 'collection' || entry.field.connection.value !== 'constructor' || !complete(entry.named)) continue;
          const linked = stored(entry.named).some(item => item.name === 'constructor' || item.storageName === 'constructor');
          if (!linked) error(at(entry.field, 'connectionField'), 'storageMongoName');
        }
      }
    }
    if (!metadata) {
      for (const registration of registrations) {
        for (const entry of stored(registration.type || {})) {
          if (entry.kind !== 'collection' || !missing(entry.field.connection)) continue;
          const readOnly = truthy(entry.field.readOnly);
          const resolver = truthy(entry.field.resolve);
          if (readOnly !== null && resolver !== null && readOnly !== resolver) warn(entry.field.node, 'storageUnlinkedCollection');
        }
      }
    }

    // Inputs are built only at a schema call. Require the graph's straight-line
    // prefix proof before a negative registration fact or order matters.
    if (!build || !ordered(graph, build, registrations)) continue;
    const registered = new Map(registrations.filter(reg => reg.type?.name).map(reg => [reg.type.name, reg]));
    const inputCycles = new Set();
    const visitedInputs = new Set();
    const inputVisit = (type, stack = []) => {
      if (!type?.fields || stack.length >= LIMIT || visitedInputs.has(type)) return;
      visitedInputs.add(type);
      const path = [...stack, type];
      for (const entry of stored(type)) {
        const { field, named } = entry;
        if (entry.kind !== 'embedded' || truthy(field.readOnly) !== false) continue;
        const registration = registered.get(type.name);
        if (field.name === 'state' && truthy(graph.constant(registration?.stateMachine)) !== false) continue;
        const target = registered.get(named.name)?.type;
        if (!target) continue;
        if (path.includes(target)) {
          const cycle = path.slice(path.indexOf(target));
          if (!cycle.some(member => inputCycles.has(member) || cycleReported.has(member))) error(field.node, 'storageInputCycle');
          cycle.forEach(member => inputCycles.add(member));
        } else inputVisit(target, path);
      }
    };
    for (const registration of registrations) inputVisit(registration.type);
  }
  // The id resolver belongs to the type object. A later entity build changes an
  // already-created schema that embeds that exact object too, across runtimes.
  const identities = new Set();
  const embeddedSites = new Map();
  for (const build of graph.builds) {
    const registrations = graph.registrationsFor(build.runtime, build.node.range[0]);
    if (!ordered(graph, build, registrations)) continue;
    const registered = new Map(registrations.filter(reg => reg.type?.name).map(reg => [reg.type.name, reg]));
    for (const registration of registrations) {
      if (registration.endpoint) identities.add(registration.type);
      for (const field of registration.type.fields?.values() || []) {
        const entry = describe(graph, field);
        if (!entry || !['reference', 'collection'].includes(entry.kind)) continue;
        const target = registered.get(entry.named.name)?.type;
        if (target) identities.add(target);
      }
    }
    const visited = new Set();
    const embeddedIdentity = type => {
      if (!type || visited.has(type) || visited.size >= LIMIT) return;
      visited.add(type);
      for (const field of type.fields?.values() || []) {
        const entry = describe(graph, field);
        if (entry?.kind !== 'embedded') continue;
        const id = entry.named.fields?.get('id');
        if (id && truthy(id.resolve) === false) {
          if (!embeddedSites.has(entry.named)) embeddedSites.set(entry.named, new Set());
          embeddedSites.get(entry.named).add(field.node);
        }
        embeddedIdentity(entry.named);
      }
    };
    for (const registration of registrations) embeddedIdentity(registration.type);
  }
  for (const [type, sites] of embeddedSites) {
    if (identities.has(type)) for (const node of sites) warn(node, 'storageEmbeddedIdentity');
  }
  return { errors, warnings };
};
