/**
 * Declarations for `@simtlix/simfinity-core/validators`. The default export is the root
 * `validators` namespace, and every named export has the type of the same member, so the two
 * cannot drift. A root type used by these helpers belongs in the `export type` list below.
 */
import { validators } from './index.js';

export type { FieldValidations, FieldValidator, ItemValidators } from './index.js';
export const stringLength: typeof validators.stringLength;
export const maxLength: typeof validators.maxLength;
export const pattern: typeof validators.pattern;
export const email: typeof validators.email;
export const url: typeof validators.url;
export const numberRange: typeof validators.numberRange;
export const positive: typeof validators.positive;
export const arrayLength: typeof validators.arrayLength;
export const dateFormat: typeof validators.dateFormat;
export const futureDate: typeof validators.futureDate;

export default validators;
