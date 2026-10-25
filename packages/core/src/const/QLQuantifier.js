import { GraphQLEnumType } from 'graphql';

const QLQuantifier = new GraphQLEnumType({
  name: 'QLQuantifier',
  values: {
    ANY: { value: 'ANY' },
    ALL: { value: 'ALL' },
    NONE: { value: 'NONE' },
  },
});

export const QUANTIFIED_LISTS = Object.freeze(QLQuantifier.getValues().map(({ value }) => value));
export const QUANTIFIERS = new Set(QUANTIFIED_LISTS);

// Shared by the collector and the quantified-group validator. `path` is allowed only on a
// quantified member; reserved metadata is interpreted by its owning phase.
export const GROUP_KEYS = new Set([
  'conditions', 'AND', 'OR', ...QUANTIFIED_LISTS, 'path', '__scope', '__implicit', '__anchor',
]);

export default QLQuantifier;
