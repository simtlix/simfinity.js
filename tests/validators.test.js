import {
  describe, test, expect, beforeAll, afterEach, vi,
} from 'vitest';
import {
  GraphQLObjectType, GraphQLString, GraphQLID,
} from 'graphql';
import { validators } from '../packages/mongodb/src/index.js';
import * as simfinity from '../packages/mongodb/src/index.js';
import SimfinityError from '../packages/mongodb/src/errors/simfinity.error.js';

describe('Declarative Validation Helpers', () => {
  beforeAll(() => {
    simfinity.preventCreatingCollection(true);
  });

  describe('validators object', () => {
    test('should export validators object with all expected validators', () => {
      expect(validators).toBeDefined();
      expect(validators.stringLength).toBeDefined();
      expect(validators.maxLength).toBeDefined();
      expect(validators.pattern).toBeDefined();
      expect(validators.email).toBeDefined();
      expect(validators.url).toBeDefined();
      expect(validators.numberRange).toBeDefined();
      expect(validators.positive).toBeDefined();
      expect(validators.arrayLength).toBeDefined();
      expect(validators.dateFormat).toBeDefined();
      expect(validators.futureDate).toBeDefined();
    });
  });

  describe('stringLength validator', () => {
    test('should return validation object with CREATE and UPDATE keys', () => {
      const validation = validators.stringLength('Name', 2, 100);
      expect(validation).toBeDefined();
      expect(validation.CREATE).toBeDefined();
      expect(validation.UPDATE).toBeDefined();
      expect(Array.isArray(validation.CREATE)).toBe(true);
      expect(Array.isArray(validation.UPDATE)).toBe(true);
    });

    test('should validate string length correctly for CREATE', async () => {
      const validation = validators.stringLength('Name', 2, 100);
      const validator = validation.CREATE[0];

      // Valid value
      await expect(validator.validate('User', 'name', 'John Doe', null)).resolves.not.toThrow();

      // Too short
      await expect(validator.validate('User', 'name', 'A', null))
        .rejects.toThrow(SimfinityError);

      // Too long
      await expect(validator.validate('User', 'name', 'A'.repeat(101), null))
        .rejects.toThrow(SimfinityError);

      // Missing value (required)
      await expect(validator.validate('User', 'name', null, null))
        .rejects.toThrow(SimfinityError);
    });

    test('should allow undefined/null for UPDATE operations', async () => {
      const validation = validators.stringLength('Name', 2, 100);
      const validator = validation.UPDATE[0];

      // Undefined should be allowed in UPDATE
      await expect(validator.validate('User', 'name', undefined, null)).resolves.not.toThrow();

      // Null should be allowed in UPDATE
      await expect(validator.validate('User', 'name', null, null)).resolves.not.toThrow();

      // Valid value should still be validated
      await expect(validator.validate('User', 'name', 'John', null)).resolves.not.toThrow();

      // Invalid value should still throw
      await expect(validator.validate('User', 'name', 'A', null))
        .rejects.toThrow(SimfinityError);
    });
  });

  describe('email validator', () => {
    test('should validate email format', async () => {
      const validation = validators.email();
      const validator = validation.CREATE[0];

      // Valid email
      await expect(validator.validate('User', 'email', 'test@example.com', null))
        .resolves.not.toThrow();

      // Invalid email
      await expect(validator.validate('User', 'email', 'invalid-email', null))
        .rejects.toThrow(SimfinityError);

      // Invalid email format
      await expect(validator.validate('User', 'email', 'notanemail', null))
        .rejects.toThrow(SimfinityError);
    });

    test('accepts exactly the strings matched by the original email pattern', async () => {
      // The original pattern; only ever run on short strings here.
      const reference = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
      const validator = validators.email().CREATE[0];
      const alphabet = ['a', '.', '@', ' ', ' ', '\n'];
      const values = [''];
      for (let index = 0; values[index].length < 6; index += 1) {
        for (const character of alphabet) values.push(values[index] + character);
      }
      const mismatches = [];
      for (const value of values) {
        const accepted = await validator.validate('User', 'email', value, null).then(() => true, () => false);
        if (accepted !== reference.test(value)) mismatches.push(value);
      }
      expect(mismatches).toEqual([]);
    });

    test('rejects hostile dot-filled domains in linear time', async () => {
      const validation = validators.email();
      // The first size already takes about a second with a backtracking pattern.
      for (const size of [32 * 1024, 1024 * 1024]) {
        for (const value of [`a@${'.'.repeat(size)} `, `a@${'.'.repeat(size)}@`]) {
          for (const validator of [validation.CREATE[0], validation.UPDATE[0]]) {
            const started = performance.now();
            await expect(validator.validate('User', 'email', value, null))
              .rejects.toMatchObject({ message: 'Invalid email format', extensions: { code: 'VALIDATION_ERROR', status: 400 } });
            expect(performance.now() - started).toBeLessThan(200);
          }
        }
      }
    });
  });

  describe('pattern validator', () => {
    const accepts = (validation, value) => validation.CREATE[0].validate('Serie', 'slug', value, null).then(() => true, () => false);

    test('a global regex accepts every valid value in sequence', async () => {
      const validation = validators.pattern('Slug', /^[a-z]+$/g);
      const results = [];
      for (const value of ['alpha', 'beta', 'gamma', 'delta']) results.push(await accepts(validation, value));
      expect(results).toEqual([true, true, true, true]);
    });

    test('a global unanchored regex is not affected by the previous match position', async () => {
      const validation = validators.pattern('Code', /[0-9]{3}/g);
      expect(await accepts(validation, 'x123')).toBe(true);
      expect(await accepts(validation, '123')).toBe(true);
    });

    test('a sticky regex always matches from the start of each value', async () => {
      const validation = validators.pattern('Code', /[0-9]{3}/y);
      expect(await accepts(validation, '123')).toBe(true);
      expect(await accepts(validation, 'abc123')).toBe(false);
      expect(await accepts(validation, 'abc123')).toBe(false);
    });

    test('the caller regex is neither read nor mutated', async () => {
      const regex = /[0-9]{3}/y;
      const validation = validators.pattern('Code', regex);
      regex.lastIndex = 3;
      expect(await accepts(validation, 'abc123')).toBe(false);
      expect(await accepts(validation, '123')).toBe(true);
      expect(regex.lastIndex).toBe(3);
    });

    test('string patterns are compiled', async () => {
      const validation = validators.pattern('Code', '^[0-9]+$');
      expect(await accepts(validation, '12')).toBe(true);
      await expect(validation.UPDATE[0].validate('Serie', 'code', 'x', null))
        .rejects.toMatchObject({ message: 'Code format is invalid', extensions: { code: 'VALIDATION_ERROR', status: 400 } });
    });

    test.each([[{ test: () => true }], [123], [null]])('rejects the unsupported pattern %j at creation', (unsupported) => {
      expect(() => validators.pattern('Code', unsupported)).toThrow(TypeError);
    });
  });

  describe('url validator', () => {
    afterEach(() => {
      vi.restoreAllMocks();
    });

    test('accepts an absolute URL', async () => {
      await expect(validators.url().CREATE[0].validate('User', 'website', 'https://example.com', null))
        .resolves.not.toThrow();
    });

    test('rejects invalid input without writing it to the console', async () => {
      const log = vi.spyOn(console, 'log').mockImplementation(() => {});
      const validation = validators.url();
      await expect(validation.CREATE[0].validate('User', 'website', 'not a url token=secret', null))
        .rejects.toMatchObject({ message: 'Invalid URL format', extensions: { code: 'VALIDATION_ERROR', status: 400 } });
      expect(log).not.toHaveBeenCalled();
    });
  });

  describe('numberRange validator', () => {
    test('should validate number range', async () => {
      const validation = validators.numberRange('Age', 0, 120);
      const validator = validation.CREATE[0];

      // Valid number
      await expect(validator.validate('User', 'age', 25, null)).resolves.not.toThrow();

      // Below minimum
      await expect(validator.validate('User', 'age', -1, null))
        .rejects.toThrow(SimfinityError);

      // Above maximum
      await expect(validator.validate('User', 'age', 121, null))
        .rejects.toThrow(SimfinityError);

      // Not a number
      await expect(validator.validate('User', 'age', 'not a number', null))
        .rejects.toThrow(SimfinityError);
    });
  });

  describe('positive validator', () => {
    test('should validate positive numbers', async () => {
      const validation = validators.positive('Price');
      const validator = validation.CREATE[0];

      // Valid positive number
      await expect(validator.validate('Product', 'price', 10, null)).resolves.not.toThrow();

      // Zero should fail
      await expect(validator.validate('Product', 'price', 0, null))
        .rejects.toThrow(SimfinityError);

      // Negative should fail
      await expect(validator.validate('Product', 'price', -5, null))
        .rejects.toThrow(SimfinityError);
    });
  });

  describe('arrayLength validator', () => {
    test('should validate array length', async () => {
      const validation = validators.arrayLength('Items', 10);
      const validator = validation.CREATE[0];

      // Valid array
      await expect(validator.validate('Order', 'items', [1, 2, 3], null))
        .resolves.not.toThrow();

      // Too many items
      await expect(validator.validate('Order', 'items', Array(11).fill(1), null))
        .rejects.toThrow(SimfinityError);

      // Not an array
      await expect(validator.validate('Order', 'items', 'not an array', null))
        .rejects.toThrow(SimfinityError);
    });
  });

  describe('futureDate validator', () => {
    test('should validate future dates', async () => {
      const validation = validators.futureDate('EventDate');
      const validator = validation.CREATE[0];

      // Future date
      const futureDate = new Date();
      futureDate.setFullYear(futureDate.getFullYear() + 1);
      await expect(validator.validate('Event', 'eventDate', futureDate, null))
        .resolves.not.toThrow();

      // Past date should fail
      const pastDate = new Date('2020-01-01');
      await expect(validator.validate('Event', 'eventDate', pastDate, null))
        .rejects.toThrow(SimfinityError);

      // Current date should fail (not future)
      const now = new Date();
      await expect(validator.validate('Event', 'eventDate', now, null))
        .rejects.toThrow(SimfinityError);
    });
  });

  describe('Integration: Using validators in GraphQL type', () => {
    test('should work with GraphQL type extensions', () => {
      const PersonType = new GraphQLObjectType({
        name: 'Person',
        fields: () => ({
          id: { type: GraphQLID },
          name: {
            type: GraphQLString,
            extensions: {
              validations: validators.stringLength('Name', 2, 100),
            },
          },
          email: {
            type: GraphQLString,
            extensions: {
              validations: validators.email(),
            },
          },
        }),
      });

      expect(PersonType).toBeDefined();
      const nameField = PersonType.getFields().name;
      expect(nameField.extensions.validations).toBeDefined();
      expect(nameField.extensions.validations.CREATE).toBeDefined();
      expect(nameField.extensions.validations.UPDATE).toBeDefined();
    });
  });
});


