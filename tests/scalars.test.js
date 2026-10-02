import {
  describe, test, expect, beforeAll,
} from 'vitest';
import {
  GraphQLObjectType, GraphQLID, Kind,
} from 'graphql';
import { scalars } from '../packages/mongodb/src/index.js';
import * as simfinity from '../packages/mongodb/src/index.js';

// The original email pattern; only ever run on short strings here.
const referenceEmailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

describe('Pre-built Scalars', () => {
  beforeAll(() => {
    simfinity.preventCreatingCollection(true);
  });

  describe('EmailScalar', () => {
    test('should have correct name and base type', () => {
      expect(scalars.EmailScalar).toBeDefined();
      expect(scalars.EmailScalar.name).toBe('Email_String');
      expect(scalars.EmailScalar.baseScalarType.name).toBe('String');
    });

    test('should validate email format', () => {
      expect(() => scalars.EmailScalar.serialize('test@example.com')).not.toThrow();
      expect(() => scalars.EmailScalar.serialize('invalid-email')).toThrow('Invalid email format');
      expect(() => scalars.EmailScalar.serialize('notanemail')).toThrow('Invalid email format');
    });

    test.each(['a@b.c', 'a@b..c', 'a@.b.c', 'a@b.c.', 'first.last+tag@sub.example.co'])('accepts %j', (value) => {
      expect(scalars.EmailScalar.parseValue(value)).toBe(value);
    });

    test.each(['a@b', 'a@.b', 'a@b.', '@b.c', 'a@b@c.d', 'a@@b.c', 'a b@c.d', 'a@b.c ', 'a@b.c\n', 'a@b .c'])('rejects %j', (value) => {
      expect(() => scalars.EmailScalar.parseValue(value)).toThrow('Invalid email format');
    });

    test('accepts exactly the strings matched by the original email pattern', () => {
      const alphabet = ['a', '.', '@', ' ', ' ', '\n'];
      const accepts = (value) => {
        try {
          scalars.EmailScalar.parseValue(value);
          return true;
        } catch {
          return false;
        }
      };
      const mismatches = [];
      const visit = (value) => {
        if (accepts(value) !== referenceEmailPattern.test(value)) mismatches.push(value);
        if (value.length < 6) {
          for (const character of alphabet) visit(value + character);
        }
      };
      visit('');
      expect(mismatches).toEqual([]);
    });

    test('rejects hostile dot-filled domains in linear time on every coercion path', () => {
      // The first size already takes about a second with a backtracking pattern.
      for (const size of [32 * 1024, 1024 * 1024]) {
        for (const value of [`a@${'.'.repeat(size)} `, `a@${'.'.repeat(size)}@`]) {
          const coercions = [
            () => scalars.EmailScalar.parseValue(value),
            () => scalars.EmailScalar.parseLiteral({ kind: Kind.STRING, value }),
            () => scalars.EmailScalar.serialize(value),
          ];
          for (const coerce of coercions) {
            const started = performance.now();
            expect(coerce).toThrow('Invalid email format');
            expect(performance.now() - started).toBeLessThan(200);
          }
        }
      }
    });
  });

  describe('URLScalar', () => {
    test('should have correct name and base type', () => {
      expect(scalars.URLScalar).toBeDefined();
      expect(scalars.URLScalar.name).toBe('URL_String');
      expect(scalars.URLScalar.baseScalarType.name).toBe('String');
    });

    test('should validate URL format', () => {
      expect(() => scalars.URLScalar.serialize('https://example.com')).not.toThrow();
      expect(() => scalars.URLScalar.serialize('http://example.com')).not.toThrow();
      expect(() => scalars.URLScalar.serialize('not-a-url')).toThrow('Invalid URL format');
      expect(() => scalars.URLScalar.serialize('example.com')).toThrow('Invalid URL format');
    });
  });

  describe('PositiveIntScalar', () => {
    test('should have correct name and base type', () => {
      expect(scalars.PositiveIntScalar).toBeDefined();
      expect(scalars.PositiveIntScalar.name).toBe('PositiveInt_Int');
      expect(scalars.PositiveIntScalar.baseScalarType.name).toBe('Int');
    });

    test('should validate positive integers', () => {
      expect(() => scalars.PositiveIntScalar.serialize(1)).not.toThrow();
      expect(() => scalars.PositiveIntScalar.serialize(100)).not.toThrow();
      expect(() => scalars.PositiveIntScalar.serialize(0)).toThrow('Value must be positive');
      expect(() => scalars.PositiveIntScalar.serialize(-1)).toThrow('Value must be positive');
    });
  });

  describe('PositiveFloatScalar', () => {
    test('should have correct name and base type', () => {
      expect(scalars.PositiveFloatScalar).toBeDefined();
      expect(scalars.PositiveFloatScalar.name).toBe('PositiveFloat_Float');
      expect(scalars.PositiveFloatScalar.baseScalarType.name).toBe('Float');
    });

    test('should validate positive floats', () => {
      expect(() => scalars.PositiveFloatScalar.serialize(1.5)).not.toThrow();
      expect(() => scalars.PositiveFloatScalar.serialize(0.1)).not.toThrow();
      expect(() => scalars.PositiveFloatScalar.serialize(0)).toThrow('Value must be positive');
      expect(() => scalars.PositiveFloatScalar.serialize(-1.5)).toThrow('Value must be positive');
    });
  });
});

describe('Scalar Factory Functions', () => {
  beforeAll(() => {
    simfinity.preventCreatingCollection(true);
  });

  describe('createBoundedStringScalar', () => {
    test('should create a scalar with length validation', () => {
      const NameScalar = scalars.createBoundedStringScalar('Name', 2, 100);
      
      expect(NameScalar).toBeDefined();
      expect(NameScalar.name).toBe('Name_String');
      
      // Valid length
      expect(() => NameScalar.serialize('John Doe')).not.toThrow();
      expect(() => NameScalar.serialize('AB')).not.toThrow();
      expect(() => NameScalar.serialize('A'.repeat(100))).not.toThrow();
      
      // Too short
      expect(() => NameScalar.serialize('A')).toThrow('String must be at least 2 characters');
      
      // Too long
      expect(() => NameScalar.serialize('A'.repeat(101))).toThrow('String must be at most 100 characters');
    });

    test('should work with only min or max', () => {
      const MinStringScalar = scalars.createBoundedStringScalar('MinString', 5, undefined);
      expect(() => MinStringScalar.serialize('Hello')).not.toThrow();
      expect(() => MinStringScalar.serialize('Hi')).toThrow('String must be at least 5 characters');
      
      const MaxStringScalar = scalars.createBoundedStringScalar('MaxString', undefined, 10);
      expect(() => MaxStringScalar.serialize('Short')).not.toThrow();
      expect(() => MaxStringScalar.serialize('This is too long')).toThrow('String must be at most 10 characters');
    });
  });

  describe('createBoundedIntScalar', () => {
    test('should create a scalar with range validation', () => {
      const AgeScalar = scalars.createBoundedIntScalar('Age', 0, 120);
      
      expect(AgeScalar).toBeDefined();
      expect(AgeScalar.name).toBe('Age_Int');
      
      // Valid range
      expect(() => AgeScalar.serialize(25)).not.toThrow();
      expect(() => AgeScalar.serialize(0)).not.toThrow();
      expect(() => AgeScalar.serialize(120)).not.toThrow();
      
      // Below minimum
      expect(() => AgeScalar.serialize(-1)).toThrow('Value must be at least 0');
      
      // Above maximum
      expect(() => AgeScalar.serialize(121)).toThrow('Value must be at most 120');
    });
  });

  describe('createBoundedFloatScalar', () => {
    test('should create a scalar with range validation', () => {
      const RatingScalar = scalars.createBoundedFloatScalar('Rating', 0, 10);
      
      expect(RatingScalar).toBeDefined();
      expect(RatingScalar.name).toBe('Rating_Float');
      
      // Valid range
      expect(() => RatingScalar.serialize(5.5)).not.toThrow();
      expect(() => RatingScalar.serialize(0)).not.toThrow();
      expect(() => RatingScalar.serialize(10)).not.toThrow();
      
      // Below minimum
      expect(() => RatingScalar.serialize(-0.1)).toThrow('Value must be at least 0');
      
      // Above maximum
      expect(() => RatingScalar.serialize(10.1)).toThrow('Value must be at most 10');
    });
  });

  describe('createPatternStringScalar', () => {
    test('should create a scalar with regex pattern validation', () => {
      const PhoneScalar = scalars.createPatternStringScalar(
        'Phone',
        /^\+?[\d\s\-()]+$/,
        'Invalid phone number format',
      );
      
      expect(PhoneScalar).toBeDefined();
      expect(PhoneScalar.name).toBe('Phone_String');
      
      // Valid patterns
      expect(() => PhoneScalar.serialize('+1-555-123-4567')).not.toThrow();
      expect(() => PhoneScalar.serialize('555-123-4567')).not.toThrow();
      expect(() => PhoneScalar.serialize('(555) 123-4567')).not.toThrow();
      
      // Invalid patterns
      expect(() => PhoneScalar.serialize('invalid phone')).toThrow('Invalid phone number format');
      expect(() => PhoneScalar.serialize('abc123')).toThrow('Invalid phone number format');
    });

    test('should work with string pattern', () => {
      const AlphanumericScalar = scalars.createPatternStringScalar(
        'Alphanumeric',
        '^[a-zA-Z0-9]+$',
        'Must be alphanumeric',
      );
      
      expect(() => AlphanumericScalar.serialize('abc123')).not.toThrow();
      expect(() => AlphanumericScalar.serialize('ABC123')).not.toThrow();
      expect(() => AlphanumericScalar.serialize('abc-123')).toThrow('Must be alphanumeric');
    });

    test('a global regex accepts every valid value on every coercion path', () => {
      const SlugScalar = scalars.createPatternStringScalar('StatefulSlug', /^[a-z]+$/g, 'Invalid slug');
      for (const value of ['alpha', 'beta', 'gamma', 'delta']) {
        expect(SlugScalar.parseValue(value)).toBe(value);
        expect(SlugScalar.parseLiteral({ kind: Kind.STRING, value })).toBe(value);
        expect(SlugScalar.serialize(value)).toBe(value);
      }
    });

    test('a sticky regex does not carry lastIndex between values', () => {
      const pattern = /[0-9]{3}/y;
      const CodeScalar = scalars.createPatternStringScalar('StickyCode', pattern, 'Invalid code');
      expect(CodeScalar.parseValue('123')).toBe('123');
      expect(() => CodeScalar.parseValue('abc123')).toThrow('Invalid code');
      pattern.lastIndex = 3;
      expect(() => CodeScalar.parseValue('abc123')).toThrow('Invalid code');
      expect(pattern.lastIndex).toBe(3);
    });

    test.each([[{ test: () => true }], [123], [null]])('rejects the unsupported pattern %j at creation', (unsupported) => {
      expect(() => scalars.createPatternStringScalar('BadPattern', unsupported)).toThrow(TypeError);
    });
  });

  test('wrong-type variables report the base scalar error before validation', () => {
    expect(() => scalars.EmailScalar.parseValue(5)).toThrow('String cannot represent a non string value: 5');
    expect(() => scalars.createBoundedIntScalar('Quantity', 0, 10).parseValue('5')).toThrow('Int cannot represent non-integer value: "5"');
  });
});

describe('Integration: Using scalars in GraphQL types', () => {
  beforeAll(() => {
    simfinity.preventCreatingCollection(true);
  });

  test('should work with GraphQL type definitions', () => {
    const UserType = new GraphQLObjectType({
      name: 'User',
      fields: () => ({
        id: { type: GraphQLID },
        email: { type: scalars.EmailScalar },
        age: { type: scalars.PositiveIntScalar },
        website: { type: scalars.URLScalar },
      }),
    });

    expect(UserType).toBeDefined();
    const emailField = UserType.getFields().email;
    expect(emailField.type).toBe(scalars.EmailScalar);
    expect(emailField.type.name).toBe('Email_String');
    
    const ageField = UserType.getFields().age;
    expect(ageField.type).toBe(scalars.PositiveIntScalar);
    expect(ageField.type.name).toBe('PositiveInt_Int');
  });

  test('should work with factory-created scalars', () => {
    const NameScalar = scalars.createBoundedStringScalar('Name', 2, 100);
    const AgeScalar = scalars.createBoundedIntScalar('Age', 0, 120);

    const PersonType = new GraphQLObjectType({
      name: 'Person',
      fields: () => ({
        id: { type: GraphQLID },
        name: { type: NameScalar },
        age: { type: AgeScalar },
      }),
    });

    expect(PersonType).toBeDefined();
    expect(PersonType.getFields().name.type).toBe(NameScalar);
    expect(PersonType.getFields().name.type.name).toBe('Name_String');
    expect(PersonType.getFields().age.type).toBe(AgeScalar);
    expect(PersonType.getFields().age.type.name).toBe('Age_Int');
  });
});

