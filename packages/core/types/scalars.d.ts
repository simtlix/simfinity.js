/**
 * Declarations for `@simtlix/simfinity-core/scalars`. The default export is the root `scalars`
 * namespace, and every named export has the type of the same member, so the two cannot drift.
 */
import { scalars } from './index.js';

export const EmailScalar: typeof scalars.EmailScalar;
export const URLScalar: typeof scalars.URLScalar;
export const PositiveIntScalar: typeof scalars.PositiveIntScalar;
export const PositiveFloatScalar: typeof scalars.PositiveFloatScalar;
export const createBoundedStringScalar: typeof scalars.createBoundedStringScalar;
export const createBoundedIntScalar: typeof scalars.createBoundedIntScalar;
export const createBoundedFloatScalar: typeof scalars.createBoundedFloatScalar;
export const createPatternStringScalar: typeof scalars.createPatternStringScalar;

export default scalars;
