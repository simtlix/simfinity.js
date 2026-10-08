import SimfinityError from './errors/simfinity.error.js';
import { isEmailFormat } from './scalars/email.js';
import { compilePattern, matchesPattern } from './scalars/pattern.js';

/**
 * Creates a validation object that works for both 'save' (CREATE) and 'update' (UPDATE) operations.
 * The validators will be applied to both operations.
 * For CREATE operations, the value must be provided and valid.
 * For UPDATE operations, undefined/null values are allowed (field might not be updated),
 * but if a value is provided, it must be valid.
 */
const createValidator = (validatorFn, required = false) => {
  // Validator for CREATE operations - value is required if required=true
  const validateCreate = async (typeName, fieldName, value, session) => {
    if (required && (value === null || value === undefined)) {
      throw new SimfinityError(`${fieldName} is required`, 'VALIDATION_ERROR', 400);
    }
    if (value !== null && value !== undefined) {
      await validatorFn(typeName, fieldName, value, session);
    }
  };

  // Validator for UPDATE operations - value is optional
  const validateUpdate = async (typeName, fieldName, value, session) => {
    // Skip validation if value is not provided (field is not being updated)
    if (value === null || value === undefined) {
      return;
    }
    // If value is provided, validate it
    await validatorFn(typeName, fieldName, value, session);
  };

  const validatorCreate = { validate: validateCreate };
  const validatorUpdate = { validate: validateUpdate };

  // Return validations for both CREATE and UPDATE operations
  // Also support 'save'/'update' for backward compatibility (though code uses CREATE/UPDATE)
  return {
    CREATE: [validatorCreate],
    UPDATE: [validatorUpdate],
    save: [validatorCreate], // For backward compatibility
    update: [validatorUpdate], // For backward compatibility
  };
};

// A null or omitted bound means no bound (#97). Other values keep JavaScript's comparison, so numeric strings work.
const hasBound = (bound) => bound !== undefined && bound !== null;

/**
 * String validators
 */
export const stringLength = (name, min, max) => {
  return createValidator(async (typeName, fieldName, value) => {
    if (typeof value !== 'string') {
      throw new SimfinityError(`${name} must be a string`, 'VALIDATION_ERROR', 400);
    }

    if (hasBound(min) && value.length < min) {
      throw new SimfinityError(`${name} must be at least ${min} characters`, 'VALIDATION_ERROR', 400);
    }

    if (hasBound(max) && value.length > max) {
      throw new SimfinityError(`${name} must be at most ${max} characters`, 'VALIDATION_ERROR', 400);
    }
  }, true); // Required for CREATE operations
};

export const maxLength = (name, max) => {
  return createValidator(async (typeName, fieldName, value) => {
    if (typeof value !== 'string') {
      throw new SimfinityError(`${name} must be a string`, 'VALIDATION_ERROR', 400);
    }

    if (hasBound(max) && value.length > max) {
      throw new SimfinityError(`${name} must be at most ${max} characters`, 'VALIDATION_ERROR', 400);
    }
  }, false); // Optional
};

export const pattern = (name, regex, message) => {
  const regexObj = compilePattern(regex);
  const errorMessage = message || `${name} format is invalid`;

  return createValidator(async (typeName, fieldName, value) => {
    if (typeof value !== 'string') {
      throw new SimfinityError(`${name} must be a string`, 'VALIDATION_ERROR', 400);
    }

    if (!matchesPattern(regexObj, value)) {
      throw new SimfinityError(errorMessage, 'VALIDATION_ERROR', 400);
    }
  }, false); // Optional
};

export const email = () => {
  return createValidator(async (typeName, fieldName, value) => {
    if (typeof value !== 'string') {
      throw new SimfinityError('Email must be a string', 'VALIDATION_ERROR', 400);
    }

    if (!isEmailFormat(value)) {
      throw new SimfinityError('Invalid email format', 'VALIDATION_ERROR', 400);
    }
  }, false); // Optional
};

export const url = () => {
  return createValidator(async (typeName, fieldName, value) => {
    if (typeof value !== 'string') {
      throw new SimfinityError('URL must be a string', 'VALIDATION_ERROR', 400);
    }

    try {
      // Use URL constructor for better validation
      new URL(value);
    } catch {
      throw new SimfinityError('Invalid URL format', 'VALIDATION_ERROR', 400);
    }
  }, false); // Optional
};

/**
 * Number validators
 */
export const numberRange = (name, min, max) => {
  return createValidator(async (typeName, fieldName, value) => {
    if (typeof value !== 'number' || isNaN(value)) {
      throw new SimfinityError(`${name} must be a number`, 'VALIDATION_ERROR', 400);
    }

    if (hasBound(min) && value < min) {
      throw new SimfinityError(`${name} must be at least ${min}`, 'VALIDATION_ERROR', 400);
    }

    if (hasBound(max) && value > max) {
      throw new SimfinityError(`${name} must be at most ${max}`, 'VALIDATION_ERROR', 400);
    }
  }, false); // Optional
};

export const positive = (name) => {
  return createValidator(async (typeName, fieldName, value) => {
    if (typeof value !== 'number' || isNaN(value)) {
      throw new SimfinityError(`${name} must be a number`, 'VALIDATION_ERROR', 400);
    }

    if (value <= 0) {
      throw new SimfinityError(`${name} must be positive`, 'VALIDATION_ERROR', 400);
    }
  }, false); // Optional
};

/**
 * Array validators
 */

// What arrayLength() runs on each item (#92). A validator is anything with a validate() function.
const isFieldValidator = (candidate) => candidate !== null
  && (typeof candidate === 'object' || typeof candidate === 'function')
  && typeof candidate.validate === 'function';

// A helper result such as validators.maxLength('Tag', 3). Items of a supplied list are always present, so they get
// the helper's CREATE rules on create and update, like the documented validators.maxLength('Tag', 3).CREATE.
const isFieldValidations = (candidate) => candidate !== null && typeof candidate === 'object'
  && !Array.isArray(candidate) && Array.isArray(candidate.CREATE) && candidate.CREATE.every(isFieldValidator);

// Array entries: every validator runs, as before, and a helper result runs its CREATE rules.
const itemRulesOf = (entry) => {
  if (isFieldValidator(entry)) return [entry];
  if (isFieldValidations(entry)) return entry.CREATE;
  return null;
};

// A single itemValidator was ignored before, so only shapes written for Simfinity run now: helper results, and plain
// objects or functions with validate(). A class instance with its own validate(), such as a Joi or yup schema, takes
// other arguments, so it stays ignored.
const isPlainValidator = (candidate) => isFieldValidator(candidate)
  && (typeof candidate === 'function' || [Object.prototype, null].includes(Object.getPrototypeOf(candidate)));

const ITEM_VALIDATOR_SHAPES = 'a validator object with validate(), a helper result such as validators.maxLength(\'Item\', 20), or an array of them';

// Resolves itemValidator once, when arrayLength() runs. No shape throws here, so every application that starts keeps
// starting; unusable shapes log one 'Configuration issue' warning instead.
const itemValidationOf = (name, itemValidator) => {
  // undefined, null, false, '' and 0 add no item checks, so `flag && rules` works.
  if (!itemValidator) return null;

  if (Array.isArray(itemValidator)) {
    // Falsy entries are skipped. Any other unusable entry keeps failing lists with items, as before.
    const unusable = itemValidator.flatMap((entry, index) => (!entry || itemRulesOf(entry) ? [] : [`itemValidator[${index}]`]));
    if (unusable.length > 0) {
      console.warn(`Configuration issue: validators.arrayLength('${name}') has an unusable ${unusable.join(', ')}; `
        + `lists with items fail with a TypeError. Pass ${ITEM_VALIDATOR_SHAPES}.`);
    }
    // The array is read on every validation, as before, so entries added after creation run too.
    return async (typeName, fieldName, item, session) => {
      for (let index = 0; index < itemValidator.length; index++) {
        const entry = itemValidator[index];
        if (!entry) continue;
        const rules = itemRulesOf(entry);
        if (!rules) {
          throw new TypeError(`validators.arrayLength('${name}'): itemValidator[${index}] is not a validator with a validate() function`);
        }
        for (const rule of rules) {
          await rule.validate(typeName, fieldName, item, session);
        }
      }
    };
  }

  let rules = null;
  if (isPlainValidator(itemValidator)) {
    rules = [itemValidator];
  } else if (isFieldValidations(itemValidator)) {
    rules = itemValidator.CREATE;
  }
  if (!rules) {
    const shape = isFieldValidator(itemValidator)
      ? 'a class instance whose validate() is not a Simfinity validator (such as a Joi or yup schema)'
      : `not ${ITEM_VALIDATOR_SHAPES}`;
    console.warn(`Configuration issue: validators.arrayLength('${name}') ignores its itemValidator, which is ${shape}; `
      + 'items are not validated.');
    return null;
  }
  return async (typeName, fieldName, item, session) => {
    for (const rule of rules) {
      await rule.validate(typeName, fieldName, item, session);
    }
  };
};

export const arrayLength = (name, maxItems, itemValidator) => {
  const validateItem = itemValidationOf(name, itemValidator);
  return createValidator(async (typeName, fieldName, value, session) => {
    if (!Array.isArray(value)) {
      throw new SimfinityError(`${name} must be an array`, 'VALIDATION_ERROR', 400);
    }

    if (hasBound(maxItems) && value.length > maxItems) {
      throw new SimfinityError(`${name} must have at most ${maxItems} items`, 'VALIDATION_ERROR', 400);
    }

    if (validateItem) {
      for (let i = 0; i < value.length; i++) {
        await validateItem(typeName, fieldName, value[i], session);
      }
    }
  }, false); // Optional
};

/**
 * Date validators
 */

// Calendar arithmetic (#94), independent of the process time zone.
const isLeapYear = (year) => (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
const DAYS_IN_MONTH = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
const isCalendarDate = (year, month, day) => month >= 1 && month <= 12 && day >= 1
  && day <= (month === 2 && isLeapYear(year) ? 29 : DAYS_IN_MONTH[month - 1]);

// The only format dateFormat() checks.
const ISO_DATE_FORMAT = 'YYYY-MM-DD';
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
// A leading ISO date, alone or followed by a time or a zone.
const ISO_DATE_PREFIX = /^(\d{4})-(\d{2})-(\d{2})(?!\d)/;
// JavaScript reads slashed dates month first.
const SLASHED_DATE = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/;

// Strings that JavaScript parses by rolling an impossible day into the next month, such as 2024-02-31 or 02/31/2024.
// Only values whose stored date never matched what was sent qualify, so no correctly stored value is rejected.
const isRolledOverDate = (value) => {
  const iso = ISO_DATE_PREFIX.exec(value);
  if (iso) return !isCalendarDate(Number(iso[1]), Number(iso[2]), Number(iso[3]));
  const slashed = SLASHED_DATE.exec(value);
  if (slashed) return !isCalendarDate(Number(slashed[3]), Number(slashed[1]), Number(slashed[2]));
  return false;
};

// Date objects, and strings or timestamps that JavaScript can parse, as before.
const parseDate = (name, value) => {
  let date;
  if (value instanceof Date) {
    date = value;
  } else if (typeof value === 'string' || typeof value === 'number') {
    date = new Date(value);
  } else {
    throw new SimfinityError(`${name} must be a valid date`, 'VALIDATION_ERROR', 400);
  }

  if (isNaN(date.getTime())) {
    throw new SimfinityError(`${name} must be a valid date`, 'VALIDATION_ERROR', 400);
  }
  return date;
};

// parseDate, plus the calendar check for strings that JavaScript would roll into the next month.
const toDate = (name, value) => {
  const date = parseDate(name, value);
  if (typeof value === 'string' && isRolledOverDate(value)) {
    throw new SimfinityError(`${name} must be a valid date`, 'VALIDATION_ERROR', 400);
  }
  return date;
};

export const dateFormat = (name, format) => {
  const checksFormat = format === ISO_DATE_FORMAT;
  // Other formats were never checked. They keep that behavior, and the warning says so once, here.
  if (format && !checksFormat) {
    const label = typeof format === 'string' ? `'${format}'` : `of type ${typeof format}`;
    console.warn(`Configuration issue: validators.dateFormat('${name}') does not check the format ${label}; `
      + `only '${ISO_DATE_FORMAT}' is checked, so other values pass when JavaScript can parse them as a valid date.`);
  }

  return createValidator(async (typeName, fieldName, value) => {
    if (checksFormat && typeof value === 'string') {
      // As before: an unparseable value is not a valid date, and any other shape gets the format message.
      parseDate(name, value);
      if (!ISO_DATE.test(value)) {
        throw new SimfinityError(`${name} must be in format ${format}`, 'VALIDATION_ERROR', 400);
      }
      // A value in the format must be a calendar date.
      if (isRolledOverDate(value)) {
        throw new SimfinityError(`${name} must be a valid date`, 'VALIDATION_ERROR', 400);
      }
      return;
    }
    // Date objects, timestamps, and strings when no format is checked.
    toDate(name, value);
  }, false); // Optional
};

export const futureDate = (name) => {
  return createValidator(async (typeName, fieldName, value) => {
    const date = toDate(name, value);

    if (date <= new Date()) {
      throw new SimfinityError(`${name} must be a future date`, 'VALIDATION_ERROR', 400);
    }
  }, false); // Optional
};

// Export validators as an object
const validators = {
  // String validators
  stringLength,
  maxLength,
  pattern,
  email,
  url,
  // Number validators
  numberRange,
  positive,
  // Array validators
  arrayLength,
  // Date validators
  dateFormat,
  futureDate,
};

export default validators;
