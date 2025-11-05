import SimfinityError from './errors/simfinity.error.js';

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

/**
 * String validators
 */
export const stringLength = (name, min, max) => {
  return createValidator(async (typeName, fieldName, value) => {
    if (typeof value !== 'string') {
      throw new SimfinityError(`${name} must be a string`, 'VALIDATION_ERROR', 400);
    }
    
    if (min !== undefined && value.length < min) {
      throw new SimfinityError(`${name} must be at least ${min} characters`, 'VALIDATION_ERROR', 400);
    }
    
    if (max !== undefined && value.length > max) {
      throw new SimfinityError(`${name} must be at most ${max} characters`, 'VALIDATION_ERROR', 400);
    }
  }, true); // Required for CREATE operations
};

export const maxLength = (name, max) => {
  return createValidator(async (typeName, fieldName, value) => {
    if (typeof value !== 'string') {
      throw new SimfinityError(`${name} must be a string`, 'VALIDATION_ERROR', 400);
    }
    
    if (value.length > max) {
      throw new SimfinityError(`${name} must be at most ${max} characters`, 'VALIDATION_ERROR', 400);
    }
  }, false); // Optional
};

export const pattern = (name, regex, message) => {
  const regexObj = typeof regex === 'string' ? new RegExp(regex) : regex;
  const errorMessage = message || `${name} format is invalid`;
  
  return createValidator(async (typeName, fieldName, value) => {
    if (typeof value !== 'string') {
      throw new SimfinityError(`${name} must be a string`, 'VALIDATION_ERROR', 400);
    }
    
    if (!regexObj.test(value)) {
      throw new SimfinityError(errorMessage, 'VALIDATION_ERROR', 400);
    }
  }, false); // Optional
};

export const email = () => {
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  
  return createValidator(async (typeName, fieldName, value) => {
    if (typeof value !== 'string') {
      throw new SimfinityError('Email must be a string', 'VALIDATION_ERROR', 400);
    }
    
    if (!emailRegex.test(value)) {
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
    } catch (e) {
        console.log('Invalid URL format', e);
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
    
    if (min !== undefined && value < min) {
      throw new SimfinityError(`${name} must be at least ${min}`, 'VALIDATION_ERROR', 400);
    }
    
    if (max !== undefined && value > max) {
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
export const arrayLength = (name, maxItems, itemValidator) => {
  return createValidator(async (typeName, fieldName, value, session) => {
    if (!Array.isArray(value)) {
      throw new SimfinityError(`${name} must be an array`, 'VALIDATION_ERROR', 400);
    }
    
    if (maxItems !== undefined && value.length > maxItems) {
      throw new SimfinityError(`${name} must have at most ${maxItems} items`, 'VALIDATION_ERROR', 400);
    }
    
    // If itemValidator is provided, validate each item
    if (itemValidator && Array.isArray(itemValidator)) {
      for (let i = 0; i < value.length; i++) {
        for (const validator of itemValidator) {
          await validator.validate(typeName, fieldName, value[i], session);
        }
      }
    }
  }, false); // Optional
};

/**
 * Date validators
 */
export const dateFormat = (name, format) => {
  return createValidator(async (typeName, fieldName, value) => {
    // Handle Date objects, ISO strings, and timestamps
    let date;
    if (value instanceof Date) {
      date = value;
    } else if (typeof value === 'string') {
      date = new Date(value);
    } else if (typeof value === 'number') {
      date = new Date(value);
    } else {
      throw new SimfinityError(`${name} must be a valid date`, 'VALIDATION_ERROR', 400);
    }
    
    if (isNaN(date.getTime())) {
      throw new SimfinityError(`${name} must be a valid date`, 'VALIDATION_ERROR', 400);
    }
    
    // If format is provided, validate format
    if (format && typeof value === 'string') {
      // Simple format validation - can be enhanced
      const formatRegex = /^\d{4}-\d{2}-\d{2}$/; // YYYY-MM-DD
      if (format === 'YYYY-MM-DD' && !formatRegex.test(value)) {
        throw new SimfinityError(`${name} must be in format ${format}`, 'VALIDATION_ERROR', 400);
      }
      // Add more format patterns as needed
    }
  }, false); // Optional
};

export const futureDate = (name) => {
  return createValidator(async (typeName, fieldName, value) => {
    let date;
    if (value instanceof Date) {
      date = value;
    } else if (typeof value === 'string') {
      date = new Date(value);
    } else if (typeof value === 'number') {
      date = new Date(value);
    } else {
      throw new SimfinityError(`${name} must be a valid date`, 'VALIDATION_ERROR', 400);
    }
    
    if (isNaN(date.getTime())) {
      throw new SimfinityError(`${name} must be a valid date`, 'VALIDATION_ERROR', 400);
    }
    
    if (date <= new Date()) {
      throw new SimfinityError(`${name} must be a future date`, 'VALIDATION_ERROR', 400);
    }
  }, false); // Optional
};

// Export all validators as an object
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

