import { describe, expect, it } from 'vitest';
import { createQueryPlan } from '../packages/core/src/query-plan.js';
import { frameCollectionPaths, frameUnits, validateQuantifiedGroups } from '../packages/core/src/query-frames.js';
import { configureQueryLimits } from '../packages/core/src/query-limits.js';

const scalar = (name) => ({ name, kind: 'scalar', scalar: 'Int' });
const bundle = { name: 'bultos', kind: 'embedded', list: true, fields: [scalar('cantidad'), scalar('limite')] };
const lines = { name: 'lineas', kind: 'embedded', list: true, fields: [scalar('cantidad'), scalar('maxCantidad'), bundle,
  { name: 'proveedor', kind: 'reference', target: 'Proveedor' }] };
const models = { entities: [
  { name: 'Pedido', fields: [scalar('id'), scalar('maxCantidadPorLinea'), lines,
    { ...lines, name: 'otrasLineas' },
    { name: 'envio', kind: 'embedded', fields: [scalar('maxCantidadPorLinea'), scalar('cantidad'), lines] },
    { name: 'proveedor', kind: 'reference', target: 'Proveedor' }] },
  { name: 'Proveedor', fields: [scalar('maxCantidadPorLinea'), lines,
    { name: 'pedidos', kind: 'collection', target: 'Pedido', connectionField: 'proveedor' }] },
] };
const context = { models, entity: 'Pedido', quantifiers: true, referenceEmptiness: true, valuePath: true, elementFrames: true };
const plan = (args, options) => createQueryPlan(models, 'Pedido', args, options).where;
const condition = (field, valuePath, operator = 'LTE') => ({ field, valuePath, operator });
const quantified = (path, conditions, quantifier = 'ALL') => ({ AND: [{ [quantifier]: [{ path, conditions }] }] });
const fault = (args, code) => expect(() => plan(args)).toThrowError(expect.objectContaining({ extensions: expect.objectContaining({ code }) }));

describe('embedded query frames', () => {
  it('plans an embedded list body in its own field context', () => {
    expect(plan(quantified('lineas', [condition('cantidad', 'maxCantidad')]))).toEqual({
      kind: 'quantified', quantifier: 'ALL', path: ['lineas'], scope: null,
      where: { kind: 'predicate', path: ['cantidad'], operator: 'LTE', value: null, operand: { up: 0, path: ['maxCantidad'] } },
    });
  });

  it.each([
    ['lineas', '$parent.maxCantidadPorLinea', 1, []],
    ['envio.lineas', '$parent.maxCantidadPorLinea', 1, ['envio']],
    ['envio.lineas', '$parent.$parent.maxCantidadPorLinea', 1, []],
  ])('binds the structural container of %s with %s', (path, valuePath, up, containerPath) => {
    expect(plan(quantified(path, [condition('cantidad', valuePath)])).where.operand).toEqual({
      up: 0, path: ['maxCantidadPorLinea'], container: { up, path: containerPath },
    });
  });

  it('preserves the selected outer element through nested quantifiers', () => {
    const args = { AND: [{ ANY: [{ path: 'lineas', ALL: [{ path: 'bultos', conditions: [condition('cantidad', '$parent.maxCantidad')] }] }] }] };
    expect(plan(args).where.where.operand).toEqual({ up: 0, path: ['maxCantidad'], container: { up: 1, path: [] } });
    args.AND[0].ANY[0].ALL[0].conditions[0].valuePath = '$parent.$parent.maxCantidadPorLinea';
    expect(plan(args).where.where.operand).toEqual({ up: 0, path: ['maxCantidadPorLinea'], container: { up: 2, path: [] } });
  });

  it('uses a single embedded term carrier as the parent origin', () => {
    expect(plan({ envio: { terms: [{ path: 'cantidad', operator: 'LTE', valuePath: '$parent.maxCantidadPorLinea' }] } }))
      .toEqual({ kind: 'predicate', path: ['envio', 'cantidad'], operator: 'LTE', value: null, operand: { up: 0, path: ['maxCantidadPorLinea'] } });
    fault({ AND: [{ conditions: [condition('envio.cantidad', '$parent.maxCantidadPorLinea')] }] }, 'INVALID_FILTER_PATH');
  });

  it('does not cross a registered entity boundary while climbing', () => {
    const own = quantified('proveedor.lineas', [condition('cantidad', '$parent.maxCantidadPorLinea')]);
    expect(plan(own).where.operand.container).toEqual({ up: 1, path: ['proveedor'] });
    fault(quantified('proveedor.lineas', [condition('cantidad', '$parent.$parent.maxCantidadPorLinea')]), 'INVALID_FILTER_PATH');
    fault(quantified('proveedor', [condition('maxCantidadPorLinea', '$parent.maxCantidadPorLinea')]), 'INVALID_FILTER_PATH');
  });

  it.each(['$root.maxCantidadPorLinea', '$parent', '$parent.$parent.$parent.maxCantidadPorLinea', '$parent..maxCantidadPorLinea'])('rejects invalid upward paths: %s', (valuePath) => {
    fault(quantified('envio.lineas', [condition('cantidad', valuePath)]), 'INVALID_FILTER_PATH');
  });

  it('correlates dotted operands without correlating separate embedded conditions', () => {
    const args = { AND: [{ conditions: [condition('lineas.cantidad', 'lineas.maxCantidad'), condition('lineas.cantidad', 'maxCantidadPorLinea')] }] };
    const result = plan(args);
    expect(result.kind).toBe('and');
    expect(result.terms).toHaveLength(2);
    expect(result.terms[0].where.operand).toEqual({ up: 0, path: ['maxCantidad'] });
    expect(result.terms[1].where.operand).toEqual({ up: 1, path: ['maxCantidadPorLinea'] });
    const normalized = frameCollectionPaths(args, context);
    expect(() => validateQuantifiedGroups(normalized, context)).not.toThrow();
    expect(frameCollectionPaths(normalized, context)).toEqual(normalized);
  });

  it('complements existential equality for implicit embedded NE', () => {
    const result = plan({ AND: [{ conditions: [condition('lineas.cantidad', 'lineas.maxCantidad', 'NE')] }] });
    expect(result.quantifier).toBe('NONE');
    expect(result.where.operator).toBe('EQ');
    const explicit = plan(quantified('lineas', [condition('cantidad', 'maxCantidad', 'NE')], 'ANY'));
    expect(explicit.quantifier).toBe('ANY');
    expect(explicit.where.operator).toBe('NE');
  });

  it('rejects unbound lists and invalid quantifier endpoints', () => {
    fault({ AND: [{ conditions: [condition('lineas.cantidad', 'otrasLineas.maxCantidad')] }] }, 'INVALID_FILTER_PATH');
    fault(quantified('lineas.bultos', [condition('cantidad', 'limite')]), 'INVALID_FILTER_PATH');
    fault(quantified('envio', [condition('cantidad', 'maxCantidadPorLinea')]), 'INVALID_FILTER_PATH');
  });

  it('retains field-form quantifier semantics and capability gates', () => {
    const fieldForm = { lineas: { quantifier: 'ALL', terms: [{ path: 'cantidad', operator: 'LTE', valuePath: '$parent.maxCantidadPorLinea' }] } };
    expect(plan(fieldForm)).toEqual(plan(quantified('lineas', [condition('cantidad', '$parent.maxCantidadPorLinea')])));
    expect(() => plan(fieldForm, { operators: ['LTE'], quantifiers: true, referenceEmptiness: true, valuePath: true }))
      .toThrowError(expect.objectContaining({ extensions: expect.objectContaining({ code: 'UNSUPPORTED_QUERY' }) }));
  });

  it('budgets actual embedded witnesses and parent joins', () => {
    const args = quantified('envio.lineas', [condition('cantidad', '$parent.$parent.proveedor.maxCantidadPorLinea')]);
    expect(frameUnits(args, context).count).toBe(2);
    configureQueryLimits({ maxFrameNesting: 1 });
    try {
      fault({ AND: [{ conditions: [condition('lineas.bultos.cantidad', 'lineas.bultos.limite')] }] }, 'FILTER_DEPTH_EXCEEDED');
    } finally {
      configureQueryLimits({});
    }
  });

  it.each([
    { up: 0, path: ['maxCantidad'], container: { up: 0, path: [] } },
    { up: 0, path: ['maxCantidadPorLinea'], container: { up: 1, path: ['proveedor'] } },
    { up: 0, path: ['maxCantidadPorLinea'], container: { up: 2, path: [] } },
    { up: 1, path: ['maxCantidadPorLinea'], container: { up: 1, path: [] } },
  ])('rejects hand-built containers outside the structural chain: %j', (__operand) => {
    fault(quantified('lineas', [{ field: 'cantidad', operator: 'LTE', __operand }]), 'INVALID_FILTER_PATH');
  });

  it('validates normalized element witnesses below an aggregate collection anchor', () => {
    const args = { AND: [{ conditions: [condition('pedidos.lineas.cantidad', 'pedidos.maxCantidadPorLinea')] }],
      aggregation: { groupId: 'pedidos.id', facts: [{ operation: 'COUNT', factName: 'n', path: 'pedidos.id' }] } };
    const ctx = { ...context, entity: 'Proveedor', operation: 'aggregate', J: new Set(['pedidos']) };
    const normalized = frameCollectionPaths(args, ctx);
    expect(() => validateQuantifiedGroups(normalized, ctx)).not.toThrow();
    expect(frameCollectionPaths(normalized, ctx)).toEqual(normalized);
    expect(createQueryPlan(models, 'Proveedor', normalized, { mode: 'aggregate' }).where).toMatchObject({ path: ['lineas'], anchor: ['pedidos'] });
  });
});
