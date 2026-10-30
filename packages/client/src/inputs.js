const leaf = (ref) => { let current = ref; while (current?.ofType) current = current.ofType; return current; };
const present = (value, options) => value !== undefined && (options.preserveEmpty || (value !== null && value !== ''));
const versionValue = (value) => {
  if (!Number.isSafeInteger(value) || value < 1) throw new Error('Record version must be a JSON integer from 1 to 9007199254740991');
  return value;
};
const deltaType = (type) => type?.kind === 'INPUT_OBJECT' && type.fields.length > 0 && type.fields.every((field) => ['added', 'updated', 'deleted'].includes(field.name) && field.type.isList);

export const cleanInputValue = (client, ref, value, options = {}, root = false) => {
  if (ref.kind === 'NON_NULL') return cleanInputValue(client, ref.ofType, value, options, root);
  if (value === undefined || value === null) return value;
  if (ref.kind === 'LIST') return Array.isArray(value) ? value.map((item) => cleanInputValue(client, ref.ofType, item, options)) : cleanInputValue(client, ref.ofType, value, options);
  if (ref.kind !== 'INPUT_OBJECT') {
    if (ref.name === 'RecordVersion') return versionValue(value);
    if (ref.kind === 'ENUM' || (options.preserveEmpty && value === '')) return value;
    return client._coerceScalarValue(value, client._types.get(ref.name)?.baseScalar || ref.name);
  }
  const type = client._types.get(ref.name);
  if (!type) throw new Error(`Unknown input type ${ref.name}`);
  const input = typeof value === 'string' && type.fields.some((f) => f.name === 'id') ? { id: value } : value;
  if (typeof input !== 'object' || Array.isArray(input)) throw new Error(`Expected input object ${ref.name}`);
  const protectedVersion = type.fields.find((f) => f.name === 'version' && leaf(f.rawType)?.name === 'RecordVersion');
  if (protectedVersion) versionValue(input.version);
  const output = {};
  for (const field of type.fields) {
    const name = field.name;
    if (input[name] === undefined || options.skipFields?.includes(name) || options.transientFields?.includes(name)) continue;
    if (root && name === 'id' && options.mode !== 'update') continue;
    if (name === '__typename' || name === '__status' || name === '__originalData') continue;
    const target = client._types.get(leaf(field.rawType)?.name);
    if (deltaType(target) && !options.includeCollections) continue;
    if (field.type.isList && field.type.kind === 'INPUT_OBJECT' && !deltaType(type) && !options.includeCollections) continue;
    let fieldValue = input[name];
    if (deltaType(type) && name === 'deleted' && leaf(field.rawType)?.name === 'ID' && Array.isArray(fieldValue)) {
      fieldValue = fieldValue.map((item) => item !== null && typeof item === 'object' ? item.id : item);
    }
    const cleaned = cleanInputValue(client, field.rawType, fieldValue, options);
    if (present(cleaned, options)) output[name] = cleaned;
  }
  return output;
};

export const transformRootInput = (client, typeName, raw, options = {}) => {
  const mode = options.mode || 'create';
  const inputName = options.inputType || client._inputTypeName(typeName, mode === 'create' ? 'add' : 'update');
  if (!inputName) return client._legacyTransformInput(typeName, raw, options);
  const type = client._types.get(inputName);
  if (!type || type.kind !== 'INPUT_OBJECT') throw new Error(`Unknown input type ${inputName}`);
  if (mode === 'update' && raw.version !== undefined && !type.fields.some((f) => f.name === 'version')) throw new Error(`Input ${inputName} does not accept a version`);
  return cleanInputValue(client, { name: inputName, kind: 'INPUT_OBJECT' }, raw, { ...options, mode }, true);
};

const collectionItemInput = (client, targetName, mode) => {
  const kind = mode === 'create' ? 'add' : 'update';
  const roots = [...client._mutations.values()].filter((operation) => ['add', 'update', 'stateTransition'].includes(operation.category));
  const direct = roots.find((operation) => operation.typeName === targetName && operation.category === kind);
  if (direct) return leaf(direct.args.find((arg) => arg.name === 'input')?.type)?.name;
  const candidates = new Set(); const seen = new Set();
  const visit = (entityName, inputName) => {
    const key = `${entityName}:${inputName}`; if (seen.has(key)) return; seen.add(key);
    const entity = client._types.get(entityName); const input = client._types.get(inputName);
    if (!entity || input?.kind !== 'INPUT_OBJECT') return;
    for (const field of input.fields) {
      const output = entity.fields.find((item) => item.name === field.name);
      if (output?.type.kind !== 'OBJECT') continue;
      const nested = client._types.get(field.type.name);
      if (output.type.isList && deltaType(nested)) {
        for (const entry of nested.fields.filter((item) => ['added', 'updated'].includes(item.name))) {
          if (output.type.name === targetName && entry.name === (mode === 'create' ? 'added' : 'updated')) candidates.add(entry.type.name);
          visit(output.type.name, entry.type.name);
        }
      } else visit(output.type.name, field.type.name);
    }
  };
  for (const root of roots) visit(root.typeName, leaf(root.args.find((arg) => arg.name === 'input')?.type)?.name);
  if (candidates.size !== 1) throw new Error('Cannot choose a collection input unambiguously; supply inputType');
  return [...candidates][0];
};

export const transformDelta = (client, typeName, delta, options = {}) => {
  if (options.inputType) {
    const input = client._types.get(options.inputType);
    if (!deltaType(input)) throw new Error(`Not a collection delta input: ${options.inputType}`);
    return cleanInputValue(client, { kind: 'INPUT_OBJECT', name: options.inputType }, delta, { ...options, includeCollections: true });
  }
  const result = {};
  const clean = (item, mode) => {
    const raw = { ...item };
    delete raw.__status; delete raw.__originalData; delete raw.__typename;
    if (options.connectionField) delete raw[options.connectionField];
    if (mode === 'create' && typeof raw.id === 'string' && raw.id.startsWith('temp_')) delete raw.id;
    return transformRootInput(client, typeName, raw, { ...options, mode, inputType: collectionItemInput(client, typeName, mode), includeCollections: true });
  };
  if (delta.added?.length) result.added = delta.added.map((item) => clean(item, 'create'));
  if (delta.updated?.length) result.updated = delta.updated.map((item) => clean(item, 'update'));
  if (delta.deleted?.length) {
    const protectedDelete = client._types.get(typeName)?.fields.some((field) => field.name === 'version' && field.type.name === 'RecordVersion');
    result.deleted = delta.deleted.map((item) => {
      if (item === null) return null;
      if (!protectedDelete) return typeof item === 'object' ? item.id : item;
      if (typeof item !== 'object') throw new Error('Protected collection deletion requires id and version');
      return { id: item.id, version: versionValue(item.version) };
    });
  }
  return result;
};
