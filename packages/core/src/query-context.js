import { getNamedType, isEnumType, isObjectType } from 'graphql';
import SimfinityError from './errors/simfinity.error.js';
import { effectiveScalarName } from './metadata.js';
import { isVirtualField } from './relation-storage.js';
import { graphqlStep, modelStep } from './query-emptiness.js';

const fail = (message, code = 'INVALID_FILTER_PATH') => { throw new SimfinityError(message, code, 400); };
const relation = (step) => ['reference', 'collection'].includes(step.kind);
const partsOf = (path) => (Array.isArray(path) ? path : typeof path === 'string' ? path.split('.') : []);
const bindingOf = (ctx) => ctx.binding ?? { depth: 0, path: [] };

const childContext = (ctx, step) => ({
  ...ctx,
  ...(ctx.gqltype ? { gqltype: step.node } : { entity: step.target ?? ctx.entity, fields: step.node }),
  parent: ['embedded', 'embeddedList'].includes(step.kind) ? ctx : undefined,
  absolute: [...(ctx.absolute ?? []), step.name],
  binding: { depth: bindingOf(ctx).depth, path: [...bindingOf(ctx).path, step.name] },
});

// One schema-path resolver for these operations, using the same step classifications as emptiness.
// Model contexts retain embedded fields locally; relation steps switch to the target entity.
export const resolveQueryContext = (path, ctx, { onStep, virtualLabel, ordinaryCondition = false } = {}) => {
  const parts = partsOf(path);
  const invalid = parts.findIndex((part) => typeof part !== 'string' || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(part));
  if (!parts.length || invalid !== -1) {
    if (ordinaryCondition && invalid > 0) fail(`Invalid filter path segment: "${parts[invalid]}"`, 'INVALID_FILTER_PATH');
    fail('Invalid filter path', 'INVALID_FILTER_PATH');
  }
  let current = ctx;
  const steps = [];
  const raw = [];
  for (const [index, name] of parts.entries()) {
    let step;
    if (ctx.gqltype) {
      const fields = isObjectType(current.gqltype) ? current.gqltype.getFields() : null;
      const field = fields && Object.hasOwn(fields, name) ? fields[name] : null;
      if (!field) fail(ordinaryCondition && index === 0 ? `Unknown filter field: ${name}`
        : `Unknown field ${parts.slice(0, index + 1).join('.')}`, 'INVALID_FILTER_FIELD');
      if (isVirtualField(field)) {
        const label = virtualLabel?.(field) ?? parts.join('.');
        fail(`Query path ${label} uses the virtual field ${current.gqltype.name}.${name}, which is not stored`, 'INVALID_FILTER_FIELD');
      }
      step = graphqlStep(name, field);
      const type = getNamedType(field.type);
      step.scalar = isEnumType(type) ? 'Enum' : effectiveScalarName(type);
      step.enumName = isEnumType(type) ? type.name : undefined;
      step.temporalName = ['Date', 'Time', 'DateTime'].includes(step.scalar) ? step.scalar : undefined;
      step.version = step.scalar === 'RecordVersion' || step.scalar === 'Version';
      raw.push(field);
    } else {
      const fields = current.fields ?? current.models?.entities.find((entity) => entity.name === current.entity)?.fields;
      const field = fields?.find((item) => item.name === name && !item.private);
      if (!field) fail(`Unknown field ${parts.slice(0, index + 1).join('.')}`, 'INVALID_FILTER_FIELD');
      step = { ...field, ...modelStep(field) };
      if (relation(step)) step.node = ctx.models?.entities.find((entity) => entity.name === step.target)?.fields;
      raw.push(field);
    }
    onStep?.(step, current);
    steps.push(step);
    if (index < parts.length - 1 && !step.node) fail(`Field ${name} cannot be traversed`, 'INVALID_FILTER_PATH');
    current = childContext(current, step);
  }
  return { steps, raw, end: current };
};

/** Bind the endpoint while retaining its actual structural containers. */
export const enterQueryFrame = (context, path) => {
  const { end } = resolveQueryContext(path, context);
  return { ...end, frameParent: context, binding: { depth: bindingOf(context).depth + 1, path: [] } };
};

/** Resolve public comparison paths from their filter carrier, before normalization. */
export const resolveComparisonContext = (valuePath, context, prefix = '') => {
  const parts = partsOf(valuePath);
  if (parts[0] !== '$parent') {
    return { resolved: resolveQueryContext([...(prefix ? partsOf(prefix) : []), ...parts], context), context };
  }
  let current = prefix ? resolveQueryContext(prefix, context).end : context;
  while (parts[0] === '$parent') {
    if (!current.parent) fail('$parent requires an embedded containing object');
    current = current.parent;
    parts.shift();
  }
  const resolved = resolveQueryContext(parts, current);
  const binding = bindingOf(current);
  return { resolved, context: current, path: parts,
    container: { up: bindingOf(context).depth - binding.depth, path: binding.path } };
};

/** A structural operand may address only one of this context's bound containers. */
export const resolveContainerContext = (container, context) => {
  if (!container || typeof container !== 'object' || Array.isArray(container)
    || Object.keys(container).some((key) => !['up', 'path'].includes(key))
    || !Number.isSafeInteger(container.up) || container.up < 0 || !Array.isArray(container.path)
    || container.path.some((part) => typeof part !== 'string' || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(part))) {
    fail('Invalid embedded comparison container');
  }
  for (let parent = context.parent; parent; parent = parent.parent) {
    const binding = bindingOf(parent);
    if (bindingOf(context).depth - binding.depth === container.up
      && binding.path.length === container.path.length && binding.path.every((part, index) => part === container.path[index])) return parent;
  }
  fail('Comparison container is not an embedded ancestor');
};
