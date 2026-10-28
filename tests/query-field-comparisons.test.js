import { describe, expect, it } from 'vitest';
import { GraphQLEnumType, GraphQLObjectType, GraphQLScalarType, GraphQLString } from 'graphql';
import * as operators from '../packages/core/src/query-operators.js';
import { describeModels } from '../packages/core/src/metadata.js';

const scalar = (name, extra = {}) => ({ scalar: name, ...extra });
const check = (left, right, op = 'EQ') => operators.validateComparisonTypes(left, right, op, 'left', 'right');
const error = (fn, code) => expect(fn).toThrow(expect.objectContaining({ extensions: expect.objectContaining({ code, status: 400 }) }));

describe('field comparison operands', () => {
  it('distinguishes nullable optional paths from supplied literals', () => {
    expect(operators.validateComparisonOperand({ value: 'x', valuePath: null })).toBeNull();
    expect(operators.validateComparisonOperand({ value: undefined, valuePath: 'stock' })).toBe('stock');
    error(() => operators.validateComparisonOperand({ value: null, valuePath: 'stock' }), 'INVALID_FILTER_VALUE');
    error(() => operators.validateComparisonOperand({ value: 0, valuePath: 'stock' }), 'INVALID_FILTER_VALUE');
  });
  it.each(['', 'a..b', '$root.a', 'a.$root', '.a', 'a.', 'a[0]', 'a b'])('rejects non-field syntax %j', (path) => {
    error(() => operators.validateComparisonOperand({ valuePath: path }), 'INVALID_FILTER_PATH');
  });
  it('accepts embedded parent syntax for subsequent context validation', () => {
    expect(operators.validateComparisonOperand({ valuePath: '$parent.$parent.amount' })).toBe('$parent.$parent.amount');
  });
  it.each([[false], [0], [[]], [{}]])('rejects non-string path %j', (path) => {
    error(() => operators.validateComparisonOperand({ valuePath: path }), 'INVALID_FILTER_VALUE');
  });
  it.each(['EQ', 'NE', 'LT', 'LTE', 'GT', 'GTE'])('accepts mixed numeric %s', (op) => {
    expect(() => check(scalar('Int'), scalar('Float'), op)).not.toThrow();
  });
  it.each(['LIKE', 'STARTS_WITH', 'ENDS_WITH', 'LT'])('accepts string %s', (op) => {
    expect(() => check(scalar('String'), scalar('String'), op)).not.toThrow();
  });
  it.each(['ILIKE', 'IEQ', 'IIN', 'IN', 'NIN', 'BTW', 'CONTAINS_ALL', 'IS_EMPTY', 'IS_NOT_EMPTY', 'ISTARTS_WITH', 'IENDS_WITH'])('rejects field operand operator %s', (op) => {
    error(() => check(scalar('String'), scalar('String'), op), 'INVALID_FILTER_OPERATOR');
  });
  it('permits scalar-list membership but rejects a right list and ordered left lists', () => {
    expect(() => check(scalar('String', { list: true }), scalar('String'))).not.toThrow();
    error(() => check(scalar('String'), scalar('String', { list: true })), 'INVALID_FILTER_PATH');
    error(() => check(scalar('String', { list: true }), scalar('String'), 'LT'), 'INVALID_FILTER_OPERATOR');
  });
  it('keeps identities, Boolean and enum comparisons equality-only', () => {
    expect(() => check(scalar('String', { identity: true }), scalar('ID'))).not.toThrow();
    error(() => check(scalar('String', { identity: true }), scalar('String')), 'INVALID_FILTER_VALUE');
    error(() => check(scalar('Boolean'), scalar('Boolean'), 'GT'), 'INVALID_FILTER_OPERATOR');
    expect(() => check(scalar('Enum', { enumName: 'State' }), scalar('Enum', { enumName: 'State' }))).not.toThrow();
    error(() => check(scalar('Enum', { enumName: 'State' }), scalar('Enum', { enumName: 'Other' })), 'INVALID_FILTER_VALUE');
    error(() => check(scalar('Enum'), scalar('Enum')), 'UNSUPPORTED_QUERY');
  });
  it('preserves effective temporal types and excludes record versions', () => {
    expect(() => check(scalar('DateTime', { temporalName: 'Date' }), scalar('DateTime', { temporalName: 'Date' }), 'LTE')).not.toThrow();
    error(() => check(scalar('DateTime', { temporalName: 'Date' }), scalar('DateTime', { temporalName: 'Time' })), 'INVALID_FILTER_VALUE');
    error(() => check(scalar('DateTime'), scalar('DateTime')), 'UNSUPPORTED_QUERY');
    error(() => check(scalar('Version'), scalar('Version')), 'INVALID_FILTER_VALUE');
  });
  it('preserves logical enum and temporal names in model descriptions', () => {
    const state = new GraphQLEnumType({ name: 'ComparisonState', values: { OPEN: { value: 7 } } });
    const date = new GraphQLScalarType({ name: 'Date', serialize: (value) => value });
    const gqltype = new GraphQLObjectType({ name: 'ComparisonMetadata', fields: { id: { type: GraphQLString }, state: { type: state }, date: { type: date } } });
    const fields = describeModels([{ gqltype }]).entities[0].fields;
    expect(fields.find((field) => field.name === 'state')).toMatchObject({ scalar: 'Enum', enumName: 'ComparisonState' });
    expect(fields.find((field) => field.name === 'date')).toMatchObject({ scalar: 'DateTime', temporalName: 'Date' });
  });
  it('requires explicit capability and reference support', () => {
    expect(operators.resolveQueryFeatures().valuePath).toBe(false);
    expect(operators.resolveQueryFeatures({ operators: ['EQ'], referenceEmptiness: true, valuePath: true }).valuePath).toBe(true);
    expect(() => operators.resolveQueryFeatures({ operators: ['EQ'], valuePath: true })).toThrow(expect.objectContaining({ extensions: expect.objectContaining({ code: 'INVALID_QUERY_FEATURES' }) }));
    expect(() => operators.resolveQueryFeatures({ operators: ['EQ'], valuePath: 'yes' })).toThrow(expect.objectContaining({ extensions: expect.objectContaining({ code: 'INVALID_QUERY_FEATURES' }) }));
  });
});
