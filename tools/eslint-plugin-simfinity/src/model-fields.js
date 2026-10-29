export const messages = {
  fieldMissingRelation: 'Stored object field {{field}} requires extensions.relation on {{engine}}. Declare its embedded/reference storage, or make a computed output virtual with its own resolver.',
  fieldRelationAdvice: '{{field}} has no relation metadata: {{effect}}. Declare its intended relation or keep its application-owned output mapping explicitly.',
  fieldNestedStorage: '{{field}} has nested lists, which {{engine}} storage does not support. Model rows as embedded objects, or make a computed output virtual with its own resolver.',
  fieldNestedInput: 'Writable field {{field}} has nested lists with no generated input. Model rows as embedded objects, or mark an output-only field readOnly.',
  fieldAbstractStorage: '{{field}} has an interface or union type unsupported by {{engine}} storage. Use concrete stored fields, or a virtual field with its own resolver for computed output.',
  fieldAbstractInputAdvice: '{{field}} has an interface or union type, so generated inputs omit it. Mark an intentional output-only field readOnly and provide its output.',
  fieldScalarStorage: 'Stored scalar {{scalar}} on {{field}} has {{reason}}. Declare a supported, acyclic baseScalarType storage hint or use a virtual computed output.',
  fieldScalarMappingAdvice: 'The generated MongoDB model has no storage mapping for scalar {{scalar}} on {{field}}. Declare a supported baseScalarType or provide an application-owned model mapping.',
  fieldOutputMappingAdvice: 'The generated MongoDB model has no storage path for {{field}} because it contains {{shape}}. Keep this application-provided output intentional, or provide an application-owned model mapping.',
  fieldEnumCollision: 'Enum {{scalar}} used by {{field}} has distinct internal values with the same stored text {{value}}. Use unambiguous primitive values or intentional same-value aliases.',
  fieldMisplacedMetadata: '{{field}} declares {{key}} outside {{target}}; Simfinity ignores that placement. Put the intended setting at {{target}} without overwriting other metadata.',
  fieldNonBooleanFlag: '{{field}} declares a nonboolean {{key}}. {{effect}} Use an explicit boolean for the intended behavior.',
  fieldManualStateFlag: '{{field}} declares stateMachine metadata without a proven machine managing that field. The flag does not install a workflow or exclude input; register a machine for state, or mark a server-owned field readOnly.',
  fieldSQLStateType: '{{field}} belongs to a registered SQL state machine but is not an enum. Use a GraphQL enum for its state values.',
};

const storageNames = new Set(['String', 'ID', 'Int', 'Float', 'Boolean', 'DateTime', 'Date', 'Time']);
const dateNames = new Set(['DateTime', 'Date', 'Time']);
const abstract = type => type?.kind === 'interface' || type?.kind === 'union';
const display = (owner, field) => `${owner.name || 'LocalType'}.${field.name}`;
const primitive = value => value === null || !['object', 'function', 'symbol'].includes(typeof value);
const flagEffects = {
  readOnly: 'Generated inputs use its truthiness, while storage metadata records only true.',
  unique: 'Generated MongoDB unique metadata uses its truthiness, while SQL metadata requires true.',
  queryable: 'Only exact true or false changes the queryability default.',
  embedded: 'Relation ownership uses its truthiness.',
};

// No serialization or coercion of application objects is needed to follow a
// storage hint. A cycle is rejected by metadata; Mongo stops at the repeated
// scalar and still recognizes its builtin identity or date name.
const scalarRoot = (type, mongo = false) => {
  const visited = new Set();
  let current = type;
  while (current) {
    if (mongo && current.kind !== 'scalar') return { root: current };
    if (current.base === undefined) return { unknown: true };
    if (!current.base) return { root: current };
    if (visited.has(current)) return { root: current, cycle: true };
    if (visited.size >= 200) return { unknown: true };
    visited.add(current);
    current = current.base;
  }
  return { unknown: true };
};

export const inspect = graph => {
  const errors = [];
  const warnings = [];
  const emit = (list, node, messageId, data) => list.push({ node, messageId, data });
  const fieldNode = field => field.config?.get('type') || field.node;
  const relationValue = field => graph.property(field.extensions, 'relation');
  // Invalid/dynamic virtual declarations have their own startup validation.
  // They do not establish a stored-field proof for these diagnostics.
  const stored = field => field.virtual === false
    && graph.property(field.extensions, 'virtual').known
    && graph.property(field.extensions, 'virtual').value === undefined;
  const engineName = runtime => runtime.engine === 'mongo' ? 'transactional MongoDB' : 'SQL';
  const writable = (field, registration) => {
    if (!stored(field) || !field.readOnly.known) return false;
    if (field.readOnly.value) return false;
    if (field.name !== 'state') return true;
    const machine = graph.constant(registration?.stateMachine);
    return machine.known && !machine.value;
  };

  const enumCollision = type => {
    const values = graph.analysis.properties(type.config?.get('values'));
    if (!values) return null;
    const seen = new Map();
    for (const [name, node] of values) {
      const config = graph.analysis.properties(node);
      const result = graph.property(config, 'value');
      if (!result.known || !primitive(result.value)) continue;
      const value = result.value === undefined ? name : result.value;
      const text = String(value);
      if (seen.has(text) && !Object.is(seen.get(text), value)) return text;
      seen.set(text, value);
    }
    return null;
  };

  const inspectStorage = (owner, field, runtime) => {
    const shape = graph.shape(field.type);
    if (!shape || !stored(field)) return;
    const data = { field: display(owner, field), engine: engineName(runtime) };
    const node = fieldNode(field);
    if (shape.listDepth > 1) {
      emit(errors, node, 'fieldNestedStorage', data);
      return;
    }
    const named = shape.named;
    if (named.kind === 'object') {
      const relation = relationValue(field);
      if (relation.known && !relation.value) emit(errors, node, 'fieldMissingRelation', data);
    } else if (abstract(named)) {
      emit(errors, node, 'fieldAbstractStorage', data);
    } else if (named.kind === 'scalar') {
      const result = scalarRoot(named);
      if (!result.unknown && (result.cycle || (result.root.name && !storageNames.has(result.root.name)))) {
        emit(errors, node, 'fieldScalarStorage', {
          field: data.field, scalar: named.name || 'LocalScalar',
          reason: result.cycle ? 'a cyclic baseScalarType chain' : `unsupported storage root ${result.root.name}`,
        });
      }
    } else if (named.kind === 'enum') {
      const collision = enumCollision(named);
      if (collision !== null) emit(errors, node, 'fieldEnumCollision', {
        field: data.field, scalar: named.name || 'LocalEnum', value: JSON.stringify(collision),
      });
    }
  };

  const inspectMetadataAdvice = (owner, field, registration) => {
    const name = display(owner, field);
    for (const key of ['readOnly', 'relation', 'queryable', 'unique', 'validations']) {
      if (field.config?.has(key)) emit(warnings, field.config.get(key), 'fieldMisplacedMetadata', {
        field: name, key, target: `extensions.${key}`,
      });
    }
    if (field.extensions?.has('connectionField')) emit(warnings, field.extensions.get('connectionField'), 'fieldMisplacedMetadata', {
      field: name, key: 'extensions.connectionField', target: 'extensions.relation.connectionField',
    });
    for (const key of ['readOnly', 'unique', 'queryable', 'embedded']) {
      const map = key === 'embedded' ? field.relation : field.extensions;
      const value = graph.property(map, key);
      if (value.known && value.value != null && typeof value.value !== 'boolean') emit(warnings, map.get(key), 'fieldNonBooleanFlag', {
        field: name, key: key === 'embedded' ? 'relation.embedded' : key, effect: flagEffects[key],
      });
    }
    const flag = graph.property(field.extensions, 'stateMachine');
    const directFlag = graph.property(field.config, 'stateMachine');
    const flagNode = flag.known && flag.value === true ? field.extensions.get('stateMachine')
      : directFlag.known && directFlag.value === true ? field.config.get('stateMachine') : null;
    const machine = graph.constant(registration?.stateMachine);
    if (flagNode && machine.known && (field.name !== 'state' || !machine.value)) {
      emit(warnings, flagNode, 'fieldManualStateFlag', { field: name });
    }
  };

  const inspectInputs = (registration, storageFields) => {
    const owner = registration.type;
    for (const field of owner?.fields?.values() || []) {
      if (storageFields.has(field) || !writable(field, registration)) continue;
      const shape = graph.shape(field.type);
      if (!shape) continue;
      const data = { field: display(owner, field) };
      if (abstract(shape.named)) {
        emit(warnings, fieldNode(field), 'fieldAbstractInputAdvice', data);
      } else if (shape.listDepth > 1) {
        emit(errors, fieldNode(field), 'fieldNestedInput', data);
      } else if (shape.named.kind === 'object' && shape.listDepth === 0) {
        const relation = relationValue(field);
        if (relation.known && !relation.value) emit(warnings, fieldNode(field), 'fieldRelationAdvice', {
          ...data, effect: 'generated inputs omit this singular object field',
        });
      }
    }
  };

  const inspectMongoMapping = (owner, field, advisedInputs, registration) => {
    if (!stored(field)) return;
    const shape = graph.shape(field.type);
    if (!shape) return;
    const data = { field: display(owner, field) };
    const relation = relationValue(field);
    const machine = graph.constant(registration?.stateMachine);
    const outputOnly = (field.readOnly.known && field.readOnly.value)
      || (field.name === 'state' && machine.known && machine.value);
    if (outputOnly && relation.known && !relation.value && (shape.listDepth > 1 || abstract(shape.named))) {
      emit(warnings, fieldNode(field), 'fieldOutputMappingAdvice', {
        ...data, shape: shape.listDepth > 1 ? 'nested lists' : 'an interface or union',
      });
    } else if (shape.named.kind === 'object' && shape.listDepth < 2) {
      if (relation.known && !relation.value && !advisedInputs.has(field)) emit(warnings, fieldNode(field), 'fieldRelationAdvice', {
        ...data, effect: 'the generated MongoDB model has no storage path for it',
      });
    } else if (shape.named.kind === 'scalar' && shape.listDepth < 2) {
      if (shape.listDepth && (!relation.known || relation.value)) return;
      const result = scalarRoot(shape.named, true);
      if (!result.unknown && result.root.name && !result.root.builtin && !dateNames.has(result.root.name)) {
        emit(warnings, fieldNode(field), 'fieldScalarMappingAdvice', { ...data, scalar: shape.named.name || 'LocalScalar' });
      }
    }
  };

  // Embedded storage is generated/validated with its owner even if the embedded
  // type has no direct registration. Reference entity closure belongs to graph.
  const embeddedFields = (roots, visit) => {
    const seen = new Set();
    const queue = [...roots];
    while (queue.length && seen.size < 200) {
      const owner = queue.shift();
      if (!owner || seen.has(owner)) continue;
      seen.add(owner);
      for (const field of owner.fields?.values() || []) {
        visit(owner, field);
        if (!stored(field) || !field.embedded.known || !field.embedded.value) continue;
        const relation = relationValue(field);
        const shape = graph.shape(field.type);
        if (relation.known && relation.value && shape?.named.kind === 'object' && shape.listDepth <= 1) queue.push(shape.named);
      }
    }
  };

  if (graph.truncated) return { errors, warnings };
  const runtimes = new Set(graph.registrations.map(registration => registration.runtime));
  for (const runtime of runtimes) {
    const builds = graph.builds.filter(build => build.runtime === runtime);
    const snapshots = builds.length ? builds.map(build => graph.registrationsFor(runtime, build.node)) : [graph.registrationsFor(runtime)];
    for (const registrations of snapshots) {
      const byType = new Map(registrations.filter(reg => reg.type).map(reg => [reg.type, reg]));
      const storageFields = new Set();
      if (graph.metadata(runtime)) {
        const entities = graph.entities(runtime, registrations);
        embeddedFields(entities, (owner, field) => {
          storageFields.add(field);
          inspectStorage(owner, field, runtime);
        });
        if (runtime.engine === 'sql' || runtime.engine === 'postgres') {
          for (const registration of registrations) {
            const machine = graph.constant(registration.stateMachine);
            if (!machine.known || !machine.value || !entities.has(registration.type)) continue;
            const field = registration.type.fields?.get('state');
            const shape = graph.shape(field?.type);
            if (field && stored(field) && shape && shape.listDepth <= 1 && shape.named.kind !== 'enum') {
              emit(errors, fieldNode(field), 'fieldSQLStateType', { field: display(registration.type, field) });
            }
          }
        }
      }
      embeddedFields(byType.keys(), (owner, field) => inspectMetadataAdvice(owner, field, byType.get(owner)));
      for (const registration of registrations) inspectInputs(registration, storageFields);
      if (runtime.engine === 'mongo' && runtime.integrity === 'off') {
        const advisedInputs = new Set();
        for (const registration of registrations) {
          for (const field of registration.type?.fields?.values() || []) {
            const shape = graph.shape(field.type);
            const relation = relationValue(field);
            if (writable(field, registration) && shape?.named.kind === 'object' && !shape.listDepth
              && relation.known && !relation.value) advisedInputs.add(field);
          }
        }
        for (const registration of registrations) {
          const hook = graph.constant(registration.onModelCreated);
          if (graph.generated(registration, registrations) !== true || !hook.known || hook.value) continue;
          embeddedFields([registration.type], (owner, field) => inspectMongoMapping(owner, field, advisedInputs, byType.get(owner)));
        }
      }
    }
  }
  return graph.truncated ? { errors: [], warnings: [] } : { errors, warnings };
};
