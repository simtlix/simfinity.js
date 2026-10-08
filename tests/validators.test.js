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

    // #92: item rules
    const accepts = (validator, value) => validator.validate('Post', 'tags', value, null).then(() => true, () => false);
    const tagTooLong = { message: 'Tag must be at most 3 characters', extensions: { code: 'VALIDATION_ERROR', status: 400 } };

    afterEach(() => {
      vi.restoreAllMocks();
    });

    test.each([
      ['a helper result', () => validators.maxLength('Tag', 3)],
      ['a single validator', () => validators.maxLength('Tag', 3).CREATE[0]],
      ['a plain validator object', () => ({ validate: (...args) => validators.maxLength('Tag', 3).CREATE[0].validate(...args) })],
      ['a function with validate()', () => Object.assign(() => {}, { validate: (...args) => validators.maxLength('Tag', 3).CREATE[0].validate(...args) })],
      ['an array of helper results', () => [validators.maxLength('Tag', 3)]],
      ['the documented CREATE array', () => validators.maxLength('Tag', 3).CREATE],
    ])('validates every item with %s on create and update', async (label, itemValidator) => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const rule = validators.arrayLength('Tags', 10, itemValidator());
      for (const validator of [rule.CREATE[0], rule.UPDATE[0]]) {
        await expect(validator.validate('Post', 'tags', ['waytoolong'], null)).rejects.toMatchObject(tagTooLong);
        expect(await accepts(validator, ['ok', 'abc'])).toBe(true);
      }
      expect(warn).not.toHaveBeenCalled();
    });

    test('a helper result applies its CREATE rules to items on update, like the documented form', async () => {
      const rule = validators.arrayLength('Tags', 10, validators.stringLength('Tag', 1, 3));
      await expect(rule.UPDATE[0].validate('Post', 'tags', ['ok', null], null))
        .rejects.toMatchObject({ message: 'tags is required', extensions: { code: 'VALIDATION_ERROR', status: 400 } });
    });

    test.each([[undefined], [null], [false], [''], [0]])('%j adds no item checks and no warning', async (itemValidator) => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const rule = validators.arrayLength('Tags', 10, itemValidator);
      expect(await accepts(rule.CREATE[0], ['waytoolong', 42])).toBe(true);
      expect(warn).not.toHaveBeenCalled();
    });

    test.each([
      ['a string', 'maxLength'],
      ['a number', 3],
      ['an empty object', {}],
      ['an object whose CREATE is not a list of validators', { CREATE: 'x' }],
      ['a function without validate()', () => {}],
    ])('warns once at creation and keeps ignoring %s', async (label, itemValidator) => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const rule = validators.arrayLength('Tags', 10, itemValidator);
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn.mock.calls[0][0]).toContain('Configuration issue: validators.arrayLength(\'Tags\') ignores its itemValidator');
      expect(await accepts(rule.CREATE[0], ['waytoolong'])).toBe(true);
      expect(await accepts(rule.UPDATE[0], ['waytoolong'])).toBe(true);
      expect(warn).toHaveBeenCalledTimes(1);
    });

    test('a single class instance with its own validate(), such as a schema library object, is warned about and ignored', async () => {
      class SchemaLike {
        validate(value, options) {
          this.calls.push([value, options]);
          throw new TypeError('Options must be of type object');
        }
      }
      SchemaLike.prototype.calls = [];
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const schema = new SchemaLike();
      const rule = validators.arrayLength('Tags', 10, schema);
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn.mock.calls[0][0]).toContain('validators.arrayLength(\'Tags\') ignores its itemValidator, which is a class instance');
      expect(await accepts(rule.CREATE[0], ['waytoolong'])).toBe(true);
      expect(schema.calls).toEqual([]);
    });

    test('a class instance inside an itemValidator array still runs, as before', async () => {
      class Short {
        async validate(typeName, fieldName, value) {
          if (value.length > 3) throw new SimfinityError('Too long', 'VALIDATION_ERROR', 400);
        }
      }
      const rule = validators.arrayLength('Tags', 10, [new Short()]);
      expect(await accepts(rule.CREATE[0], ['ok'])).toBe(true);
      await expect(rule.CREATE[0].validate('Post', 'tags', ['waytoolong'], null)).rejects.toMatchObject({ message: 'Too long' });
    });

    test('an itemValidator array is read when each list is validated, as before', async () => {
      const itemRules = [];
      const rule = validators.arrayLength('Tags', 10, itemRules);
      itemRules.push(...validators.maxLength('Tag', 3).CREATE);
      expect(await accepts(rule.CREATE[0], ['waytoolong'])).toBe(false);
    });

    test('falsy entries in an itemValidator array are skipped without a warning', async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const flag = false;
      for (const itemRules of [
        [false, validators.maxLength('Tag', 3).CREATE[0]],
        [null, undefined, '', 0, flag && validators.stringLength('Tag', 1, 2), validators.maxLength('Tag', 3)],
      ]) {
        const rule = validators.arrayLength('Tags', 10, itemRules);
        for (const validator of [rule.CREATE[0], rule.UPDATE[0]]) {
          expect(await accepts(validator, ['ok', 'abc'])).toBe(true);
          await expect(validator.validate('Post', 'tags', ['waytoolong'], null)).rejects.toMatchObject(tagTooLong);
        }
      }
      expect(warn).not.toHaveBeenCalled();
    });

    test('an array with an unusable entry warns at creation and names the helper when a list has items', async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const rule = validators.arrayLength('Codes', 10, [validators.maxLength('Code', 3).CREATE[0], 'nope']);
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn.mock.calls[0][0]).toContain('Configuration issue: validators.arrayLength(\'Codes\') has an unusable itemValidator[1]');
      expect(await accepts(rule.CREATE[0], [])).toBe(true);
      await expect(rule.CREATE[0].validate('Post', 'codes', ['abcd'], null))
        .rejects.toMatchObject({ message: 'Code must be at most 3 characters' });
      await expect(rule.CREATE[0].validate('Post', 'codes', ['ok'], null))
        .rejects.toThrow(new TypeError('validators.arrayLength(\'Codes\'): itemValidator[1] is not a validator with a validate() function'));
      expect(warn).toHaveBeenCalledTimes(1);
    });
  });

  describe('dateFormat validator', () => {
    const run = (format, value, factory = validators.dateFormat) => factory('Birth', format).CREATE[0]
      .validate('Person', 'birth', value, null).then(() => 'ok', (error) => error.message);

    afterEach(() => {
      vi.restoreAllMocks();
    });

    test.each(['2024-02-29', '2000-02-29', '0000-02-29', '0000-01-01', '2023-12-31', '9999-12-31'])('YYYY-MM-DD accepts the real date %s', async (value) => {
      expect(await run('YYYY-MM-DD', value)).toBe('ok');
    });

    test.each([
      '2024-02-30', '2024-02-31', '2023-02-29', '1900-02-29', '2024-04-31', '2024-06-31',
      '2024-02-32', '2024-13-01', '2024-00-10', '2024-01-00',
    ])('YYYY-MM-DD rejects the impossible date %s', async (value) => {
      expect(await run('YYYY-MM-DD', value)).toBe('Birth must be a valid date');
    });

    test('YYYY-MM-DD keeps the earlier messages for values in other shapes', async () => {
      expect(await run('YYYY-MM-DD', '2024/02/29')).toBe('Birth must be in format YYYY-MM-DD');
      expect(await run('YYYY-MM-DD', '2024-02-29T00:00:00Z')).toBe('Birth must be in format YYYY-MM-DD');
      expect(await run('YYYY-MM-DD', '2024-02-31T00:00:00Z')).toBe('Birth must be in format YYYY-MM-DD');
      expect(await run('YYYY-MM-DD', '2024-02-31 10:00')).toBe('Birth must be in format YYYY-MM-DD');
      expect(await run('YYYY-MM-DD', '02/31/2024')).toBe('Birth must be in format YYYY-MM-DD');
      expect(await run('YYYY-MM-DD', 'abc')).toBe('Birth must be a valid date');
    });

    test('Date objects and timestamps are still accepted whatever the format', async () => {
      for (const format of ['YYYY-MM-DD', undefined]) {
        expect(await run(format, new Date('2024-02-29T10:00:00Z'))).toBe('ok');
        expect(await run(format, 0)).toBe('ok');
        expect(await run(format, new Date('invalid'))).toBe('Birth must be a valid date');
      }
    });

    test('without a format, strings that JavaScript rolls into the next month are rejected', async () => {
      for (const value of ['2024-02-31', '2023-02-29', '2024-02-31T10:00:00Z', '2024-02-31Z', '02/31/2024', '2/30/2024', '04/31/2024', '02/29/2023']) {
        expect(await run(undefined, value), value).toBe('Birth must be a valid date');
      }
      for (const value of ['2024-02-29', '2024-02-29T10:00:00Z', 'March 7, 2024', '12/25/2024', '02/29/2024', '1/1/2024']) {
        expect(await run(undefined, value), value).toBe('ok');
      }
    });

    test('a DD/MM/YYYY format keeps accepting the dates JavaScript reads, and warns once when created', async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const rule = validators.dateFormat('Visit', 'DD/MM/YYYY').CREATE[0];
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn.mock.calls[0][0]).toContain('Configuration issue: validators.dateFormat(\'Visit\') does not check the format \'DD/MM/YYYY\'');
      const visit = (value) => rule.validate('Person', 'visit', value, null).then(() => 'ok', (error) => error.message);
      for (const value of ['12/25/2024', '01/13/2024', '05/01/2024', '2024-01-05T10:00:00Z']) {
        expect(await visit(value), value).toBe('ok');
      }
      for (const value of ['31/01/2024', '02/31/2024', '2024-02-31', 'abc']) {
        expect(await visit(value), value).toBe('Visit must be a valid date');
      }
      expect(warn).toHaveBeenCalledTimes(1);
    });

    test.each(['yyyy-mm-dd', 'MM/DD/YYYY', 'YYYYMMDD', 'YYYY-MM-DDTHH:mm'])('the format %j warns once, naming it, and only checks dates', async (format) => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const rule = validators.dateFormat('Visit', format).CREATE[0];
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn.mock.calls[0][0]).toContain(`does not check the format '${format}'`);
      await expect(rule.validate('Person', 'visit', '2024-01-05T10:00:00Z', null)).resolves.toBeUndefined();
      await expect(rule.validate('Person', 'visit', '2024-02-31', null)).rejects.toThrow('Visit must be a valid date');
    });

    test.each([['YYYY-MM-DD'], [undefined], [null], ['']])('the format %j logs no warning', (format) => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      validators.dateFormat('Visit', format);
      expect(warn).not.toHaveBeenCalled();
    });
  });

  describe('null bounds', () => {
    test('null bounds are unbounded in field validators', async () => {
      const accepts = (validator, value) => validator.validate('Post', 'field', value, null).then(() => true, () => false);
      expect(await accepts(validators.stringLength('Bio', 0, null).CREATE[0], 'Hello there')).toBe(true);
      expect(await accepts(validators.stringLength('Bio', 0, null).UPDATE[0], 'Hello there')).toBe(true);
      expect(await accepts(validators.stringLength('Bio', null, 20).CREATE[0], '')).toBe(true);
      expect(await accepts(validators.maxLength('Bio', null).CREATE[0], 'Hello there')).toBe(true);
      expect(await accepts(validators.numberRange('Delta', null, 100).CREATE[0], -5)).toBe(true);
      expect(await accepts(validators.numberRange('Qty', 0, null).CREATE[0], 7)).toBe(true);
      expect(await accepts(validators.arrayLength('Tags', null).CREATE[0], ['a'])).toBe(true);
    });

    test('the remaining bound still applies, and numeric-string bounds keep working', async () => {
      await expect(validators.numberRange('Delta', null, 100).CREATE[0].validate('Post', 'delta', 101, null))
        .rejects.toMatchObject({ message: 'Delta must be at most 100', extensions: { code: 'VALIDATION_ERROR', status: 400 } });
      await expect(validators.stringLength('Bio', 2, null).CREATE[0].validate('Post', 'bio', 'a', null))
        .rejects.toMatchObject({ message: 'Bio must be at least 2 characters' });
      await expect(validators.stringLength('Name', '2', '100').CREATE[0].validate('Post', 'name', 'Bob', null)).resolves.toBeUndefined();
      await expect(validators.stringLength('Name', '2', '100').CREATE[0].validate('Post', 'name', 'B', null))
        .rejects.toMatchObject({ message: 'Name must be at least 2 characters' });
    });
  });

  describe('futureDate validator', () => {
    afterEach(() => {
      vi.restoreAllMocks();
    });

    test('rejects impossible dates instead of rolling them into the next month', async () => {
      const year = new Date().getUTCFullYear() + 2;
      const validator = validators.futureDate('EventDate').CREATE[0];
      for (const value of [`${year}-02-31`, `${year}-04-31T10:00:00Z`, `02/31/${year}`]) {
        await expect(validator.validate('Event', 'eventDate', value, null), value)
          .rejects.toMatchObject({ message: 'EventDate must be a valid date', extensions: { code: 'VALIDATION_ERROR', status: 400 } });
      }
      await expect(validator.validate('Event', 'eventDate', `${year}-02-28`, null)).resolves.toBeUndefined();
      await expect(validator.validate('Event', 'eventDate', `02/28/${year}`, null)).resolves.toBeUndefined();
    });

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


