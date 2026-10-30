const leaf = (ref) => { let current = ref; while (current?.ofType) current = current.ofType; return current; };
const present = (value, options) => value !== undefined && (options.preserveEmpty || (value !== null && value !== ''));
const versionValue = (value) => {
  if (!Number.isSafeInteger(value) || value < 1) throw new Error('Record version must be a JSON integer from 1 to 9007199254740991');
  return value;
};
const deltaType = (type) => type?.kind === 'INPUT_OBJECT' && type.fields.some((f) => f.name === 'added') && type.fields.some((f) => f.name === 'deleted');

export const cleanInputValue = (client, ref, value, options = {}, root = false) => {
  if (ref.kind === 'NON_NULL') return cleanInputValue(client, ref.ofType, value, options, root);
  if (value === undefined || value === null) return value;
  if (ref.kind === 'LIST') return Array.isArray(value) ? value.map((item) => cleanInputValue(client, ref.ofType, item, options)) : cleanInputValue(client, ref.ofType, value, options);
  if (ref.kind !== 'INPUT_OBJECT') {
    if (ref.name === 'RecordVersion') return versionValue(value);
    return client._coerceScalarValue(value, client._types.get(ref.name)?.baseScalar || ref.name);
  }
  const type = client._types.get(ref.name);
  if (!type) throw new Error(`Unknown input type ${ref.name}`);
  if (typeof value === 'string' && type.fields.some((f) => f.name === 'id')) value = { id: value };
  if (typeof value !== 'object' || Array.isArray(value)) throw new Error(`Expected input object ${ref.name}`);
  const protectedVersion = type.fields.find((f) => f.name === 'version' && leaf(f.rawType)?.name === 'RecordVersion');
  if (protectedVersion) versionValue(value.version);
  const output = {};
  for (const field of type.fields) {
    const name = field.name;
    if (value[name] === undefined || options.skipFields?.includes(name) || options.transientFields?.includes(name)) continue;
    if (root && name === 'id' && options.mode !== 'update') continue;
    if (name === '__typename' || name === '__status' || name === '__originalData') continue;
    const target = client._types.get(leaf(field.rawType)?.name);
    if (deltaType(target) && !options.includeCollections) continue;
    if (field.type.isList && field.type.kind === 'INPUT_OBJECT' && !deltaType(type) && !options.includeCollections) continue;
    const cleaned = cleanInputValue(client, field.rawType, value[name], options);
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
    return transformRootInput(client, typeName, raw, { ...options, mode, includeCollections: true });
  };
  if (delta.added?.length) result.added = delta.added.map((item) => clean(item, 'create'));
  if (delta.updated?.length) result.updated = delta.updated.map((item) => clean(item, 'update'));
  if (delta.deleted?.length) {
    const name = client._mutationName(typeName, 'delete');
    const protectedDelete = client._mutations.get(name)?.args.some((arg) => arg.name === 'version' && leaf(arg.type)?.name === 'RecordVersion');
    result.deleted = delta.deleted.map((item) => {
      if (item === null) return null;
      if (!protectedDelete) return typeof item === 'object' ? item.id : item;
      if (typeof item !== 'object') throw new Error('Protected collection deletion requires id and version');
      return { id: item.id, version: versionValue(item.version) };
    });
  }
  return result;
};
