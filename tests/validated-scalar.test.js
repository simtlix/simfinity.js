import {
  describe, test, expect, beforeAll,
} from 'vitest';
import {
  astFromValue, graphql, GraphQLObjectType, GraphQLScalarType, GraphQLSchema, GraphQLString, GraphQLInt, GraphQLFloat,
  GraphQLBoolean, GraphQLID, GraphQLList, GraphQLNonNull, Kind, print,
} from 'graphql';
import { createValidatedScalar, scalars } from '../packages/mongodb/src/index.js';
import * as simfinity from '../packages/mongodb/src/index.js';

const DateTime = new GraphQLScalarType({
  name: 'DateTime',
  serialize: (value) => new Date(value).toISOString(),
  parseValue: (value) => new Date(value),
  parseLiteral: (node) => (node.kind === Kind.STRING ? new Date(node.value) : undefined),
});

const echoResult = (result) => (result.errors ? { error: result.errors[0].message } : { value: result.data.echo });

const echoSchema = (scalar) => new GraphQLSchema({
  query: new GraphQLObjectType({
    name: 'Query',
    fields: {
      echo: {
        type: GraphQLString,
        args: { x: { type: scalar } },
        resolve: (_, { x }) => (x instanceof Date ? `Date:${x.toISOString()}` : `${typeof x}:${x}`),
      },
    },
  }),
});

// Sends an inline literal through graphql() and reports what the resolver received or the first error.
const coerceLiteral = async (scalar, literal) => echoResult(
  await graphql({ schema: echoSchema(scalar), source: `{ echo(x: ${literal}) }` }),
);

// Runs the same input as an inline literal and as a variable.
const coerceBothWays = async (scalar, literal, variable) => ({
  literal: await coerceLiteral(scalar, literal),
  variable: echoResult(await graphql({
    schema: echoSchema(scalar), source: `query($x: ${scalar.name}) { echo(x: $x) }`, variableValues: { x: variable },
  })),
});

describe('Custom Validated Scalar Types', () => {
  let EmailScalar;
  let PositiveIntScalar;
  let PhoneScalar;
  let UserType;

  beforeAll(() => {
    simfinity.preventCreatingCollection(true);
    // Create custom validated scalar types
    EmailScalar = createValidatedScalar(
      'Email',
      'A valid email address',
      GraphQLString,
      (value) => {
        const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
        if (!emailRegex.test(value)) {
          throw new Error('Invalid email format');
        }
      },
    );

    PositiveIntScalar = createValidatedScalar(
      'PositiveInt',
      'A positive integer',
      GraphQLInt,
      (value) => {
        if (value <= 0) {
          throw new Error('Value must be positive');
        }
      },
    );

    PhoneScalar = createValidatedScalar(
      'Phone',
      'A valid phone number',
      GraphQLString,
      (value) => {
        const phoneRegex = /^\+?[\d\s\-()]+$/;
        if (!phoneRegex.test(value)) {
          throw new Error('Invalid phone number format');
        }
      },
    );

    // Create a test type with custom scalars
    UserType = new GraphQLObjectType({
      name: 'User',
      fields: () => ({
        id: { type: GraphQLID },
        name: { type: GraphQLString },
        email: { type: EmailScalar },
        age: { type: PositiveIntScalar },
        phone: { type: PhoneScalar },
        emails: { type: new GraphQLList(EmailScalar) },
        requiredEmail: { type: new GraphQLNonNull(EmailScalar) },
        ages: { type: new GraphQLList(PositiveIntScalar) },
      }),
    });
  });

  describe('createValidatedScalar function', () => {
    test('should create a valid scalar type with baseScalarType property', () => {
      expect(EmailScalar).toBeDefined();
      expect(EmailScalar.name).toBe('Email_String');
      expect(EmailScalar.baseScalarType).toBe(GraphQLString);
      expect(EmailScalar.serialize).toBeDefined();
      expect(EmailScalar.parseValue).toBeDefined();
      expect(EmailScalar.parseLiteral).toBeDefined();
    });

    test('should validate baseScalarType parameter', () => {
      expect(() => {
        createValidatedScalar('Test', 'Test', null, () => {});
      }).toThrow('baseScalarType is required');

      expect(() => {
        createValidatedScalar('Test', 'Test', 'not a scalar', () => {});
      }).toThrow('baseScalarType must be a valid GraphQL scalar type');
    });

    test('should handle different base scalar types', () => {
      expect(PositiveIntScalar.baseScalarType).toBe(GraphQLInt);
      expect(PhoneScalar.baseScalarType).toBe(GraphQLString);
    });
  });

  describe('Custom scalar validation', () => {
    test('should validate email format correctly', () => {
      expect(() => EmailScalar.serialize('test@example.com')).not.toThrow();
      expect(() => EmailScalar.serialize('invalid-email')).toThrow('Invalid email format');
    });

    test('should validate positive integers correctly', () => {
      expect(() => PositiveIntScalar.serialize(5)).not.toThrow();
      expect(() => PositiveIntScalar.serialize(0)).toThrow('Value must be positive');
      expect(() => PositiveIntScalar.serialize(-1)).toThrow('Value must be positive');
    });

    test('should validate phone numbers correctly', () => {
      expect(() => PhoneScalar.serialize('+1-555-123-4567')).not.toThrow();
      expect(() => PhoneScalar.serialize('555-123-4567')).not.toThrow();
      expect(() => PhoneScalar.serialize('invalid phone')).toThrow('Invalid phone number format');
    });
  });

  describe('Schema generation with custom scalars', () => {
    let UserModel;

    beforeAll(() => {
      simfinity.connect(null, UserType, 'user', 'users');
      simfinity.createSchema(); // Models are now generated during schema creation
      UserModel = simfinity.getModel(UserType);
    });

    test('should generate schema with correct types for custom scalars', () => {
      const schema = UserModel.schema.obj;

      // Test individual fields
      expect(schema.email).toBe(String);
      expect(schema.age).toBe(Number);
      expect(schema.phone).toBe(String);

      // Test array fields
      expect(Array.isArray(schema.emails)).toBe(true);
      expect(schema.emails[0]).toBe(String);
      expect(Array.isArray(schema.ages)).toBe(true);
      expect(schema.ages[0]).toBe(Number);

      // Test required fields
      expect(schema.requiredEmail).toBe(String);
    });

    test('should preserve unique constraints', () => {
      const UserWithUniqueType = new GraphQLObjectType({
        name: 'UserWithUnique',
        fields: () => ({
          id: { type: GraphQLID },
          email: {
            type: EmailScalar,
            extensions: { unique: true },
          },
        }),
      });
      simfinity.connect(null, UserWithUniqueType, 'userWithUnique', 'usersWithUnique');
      simfinity.createSchema(); // Models are now generated during schema creation
      const UserWithUniqueModel = simfinity.getModel(UserWithUniqueType);
      const schema = UserWithUniqueModel.schema.obj;

      expect(schema.email).toEqual({ type: String, unique: true });
    });
  });

  describe('GraphQL schema integration', () => {
    test('should create valid GraphQL schema with custom scalars', () => {
      const schema = simfinity.createSchema();

      // The schema should be created without errors
      expect(schema).toBeDefined();
      expect(schema.getQueryType()).toBeDefined();
      expect(schema.getMutationType()).toBeDefined();
    });
  });
});

describe('validated scalar coercion parity', () => {
  test('DateTime base: validators receive the parsed Date for variables and literals', async () => {
    const seen = [];
    const Modern = createValidatedScalar('ParityModern', 'Date from 2000', DateTime, (value) => {
      seen.push(value instanceof Date);
      if (!(value instanceof Date) || value.getUTCFullYear() < 2000) throw new Error('A date from 2000 is required');
    });
    const iso = '2024-01-01T00:00:00.000Z';
    const result = await coerceBothWays(Modern, JSON.stringify(iso), iso);
    expect(result.literal).toEqual({ value: `Date:${iso}` });
    expect(result.variable).toEqual({ value: `Date:${iso}` });
    // graphql() checks literals during validation and again during execution.
    expect(seen.length).toBeGreaterThan(1);
    expect(seen).not.toContain(false);
  });

  test('DateTime base: an out-of-range date is rejected on both paths', async () => {
    const Modern = createValidatedScalar('ParityModernStrict', 'Date from 2000', DateTime, (value) => {
      if (value instanceof Date && value.getUTCFullYear() < 2000) throw new Error('A date from 2000 is required');
    });
    const iso = '1990-01-01T00:00:00.000Z';
    const result = await coerceBothWays(Modern, JSON.stringify(iso), iso);
    expect(result.literal.error).toContain('A date from 2000 is required');
    expect(result.variable.error).toContain('A date from 2000 is required');
  });

  test('ID base: an integer variable reaches the validator as the coerced string', async () => {
    const NumericKey = createValidatedScalar('ParityNumericKey', 'Digits', GraphQLID, (value) => {
      if (typeof value !== 'string' || !/^\d+$/.test(value)) throw new Error('Digits are required');
    });
    const result = await coerceBothWays(NumericKey, '"123"', 123);
    expect(result.literal).toEqual({ value: 'string:123' });
    expect(result.variable).toEqual({ value: 'string:123' });
  });

  test('normalizing custom base: validators judge the value that will be stored', async () => {
    const Trimmed = new GraphQLScalarType({
      name: 'ParityTrimmed',
      serialize: (value) => value,
      parseValue: (value) => String(value).trim(),
      parseLiteral: (node) => (node.kind === Kind.STRING ? node.value.trim() : undefined),
    });
    const Handle = createValidatedScalar('ParityHandle', 'Handle', Trimmed, (value) => {
      if (value.length < 3) throw new Error('At least 3 characters are required');
    });
    const result = await coerceBothWays(Handle, '"  a  "', '  a  ');
    expect(result.literal.error).toContain('At least 3 characters are required');
    expect(result.variable.error).toContain('At least 3 characters are required');
  });

  test('chained validated scalars run the inner validator first on both paths', () => {
    let order = [];
    const Inner = createValidatedScalar('ParityInner', 'Inner', GraphQLString, (value) => { order.push(`inner:${value}`); });
    const Outer = createValidatedScalar('ParityOuter', 'Outer', Inner, (value) => { order.push(`outer:${value}`); });
    Outer.parseLiteral({ kind: Kind.STRING, value: 'x' }, {});
    expect(order).toEqual(['inner:x', 'outer:x']);
    order = [];
    Outer.parseValue('x');
    expect(order).toEqual(['inner:x', 'outer:x']);
  });

  test('parseValue returns the base-parsed value', () => {
    const Modern = createValidatedScalar('ParityReturn', 'Any date', DateTime, () => {});
    expect(Modern.parseValue('2024-01-01T00:00:00.000Z')).toBeInstanceOf(Date);
  });

  test('base coercion errors win over validator errors for variables', () => {
    const Lower = createValidatedScalar('ParityLower', 'Lower', GraphQLString, (value) => {
      if (value !== value.toLowerCase()) throw new Error('Lowercase is required');
    });
    expect(() => Lower.parseValue(5)).toThrow('String cannot represent a non string value: 5');
  });

  test('a value the base rejects is reported without running the validator', async () => {
    const calls = [];
    const Epoch = new GraphQLScalarType({
      name: 'ParityEpoch',
      serialize: Number,
      parseValue: (value) => (Number.isInteger(value) ? value : undefined),
      parseLiteral: (node) => (node.kind === Kind.INT ? Number(node.value) : undefined),
    });
    const Recent = createValidatedScalar('ParityRecent', 'Recent epoch', Epoch, (value) => { calls.push(value); });
    const result = await coerceBothWays(Recent, '"soon"', 'soon');
    expect(result.literal.error).toContain('Expected value of type "ParityRecent_ParityEpoch"');
    expect(result.variable.error).toContain('Expected type "ParityRecent_ParityEpoch"');
    expect(calls).toEqual([]);
  });
});

describe('validated scalar literal kinds', () => {
  test('a chain over an Int scalar accepts integer literals and rejects strings', async () => {
    const Even = createValidatedScalar('LiteralEven', 'Even', scalars.PositiveIntScalar, (value) => {
      if (value % 2) throw new Error('An even number is required');
    });
    expect(await coerceLiteral(Even, '4')).toEqual({ value: 'number:4' });
    expect((await coerceLiteral(Even, '3')).error).toContain('An even number is required');
    expect((await coerceLiteral(Even, '-2')).error).toContain('Value must be positive');
    expect((await coerceLiteral(Even, '"4"')).error).toContain('LiteralEven_PositiveInt_Int must be a PositiveInt_Int');
  });

  test('a chain over a Float scalar accepts float and integer literals and rejects strings', async () => {
    const Ratio = createValidatedScalar('LiteralRatio', 'Ratio', scalars.PositiveFloatScalar, () => {});
    expect(await coerceLiteral(Ratio, '4.5')).toEqual({ value: 'number:4.5' });
    expect(await coerceLiteral(Ratio, '4')).toEqual({ value: 'number:4' });
    expect((await coerceLiteral(Ratio, '-4')).error).toContain('Value must be positive');
    expect((await coerceLiteral(Ratio, '"4"')).error).toContain('LiteralRatio_PositiveFloat_Float must be a PositiveFloat_Float');
  });

  test('Float-rooted scalars accept the integer literal graphql-js prints for an integral default', async () => {
    const Rating = scalars.createBoundedFloatScalar('LiteralRating', 0, 10);
    const Half = createValidatedScalar('LiteralHalf', 'Half', scalars.PositiveFloatScalar, () => {});
    for (const [scalar, value] of [[scalars.PositiveFloatScalar, 5], [Rating, 5], [Half, 2]]) {
      // MCP and other tools inline argument defaults this way, e.g. `$x: PositiveFloat_Float = 5`.
      const literal = print(astFromValue(value, scalar));
      expect(literal).toBe(String(value));
      const result = await graphql({
        schema: echoSchema(scalar), source: `query($x: ${scalar.name} = ${literal}) { echo(x: $x) }`,
      });
      expect(echoResult(result)).toEqual({ value: `number:${value}` });
    }
  });

  test('a hand-set baseScalarType on a custom scalar does not override its literal syntax', async () => {
    const Duration = new GraphQLScalarType({
      name: 'LiteralDuration',
      serialize: (value) => `${value}s`,
      parseValue: (value) => Number.parseInt(value, 10),
      parseLiteral: (node) => (node.kind === Kind.STRING ? Number.parseInt(node.value, 10) : undefined),
    });
    // A storage hint for the backends; Duration still parses string literals such as "30s".
    Duration.baseScalarType = GraphQLInt;
    const Short = createValidatedScalar('LiteralShort', 'Short duration', Duration, (value) => {
      if (value > 60) throw new Error('At most 60 seconds');
    });
    const Shorter = createValidatedScalar('LiteralShorter', 'Shorter duration', Short, () => {});
    for (const scalar of [Short, Shorter]) {
      expect(await coerceLiteral(scalar, '"30s"')).toEqual({ value: 'number:30' });
      expect((await coerceLiteral(scalar, '"90s"')).error).toContain('At most 60 seconds');
      expect((await coerceLiteral(scalar, '30')).error).toContain(`Expected value of type "${scalar.name}", found 30.`);
    }
  });

  test('chains over Boolean and ID scalars keep their root literal kinds', async () => {
    const Toggle = createValidatedScalar('LiteralToggle', 'Toggle', GraphQLBoolean, () => {});
    const Flag = createValidatedScalar('LiteralFlag', 'Flag', Toggle, () => {});
    expect(await coerceLiteral(Flag, 'true')).toEqual({ value: 'boolean:true' });
    expect((await coerceLiteral(Flag, '"true"')).error).toContain('LiteralFlag_LiteralToggle_Boolean must be a LiteralToggle_Boolean');

    const Key = createValidatedScalar('LiteralKey', 'Key', GraphQLID, () => {});
    const Reference = createValidatedScalar('LiteralReference', 'Reference', Key, () => {});
    expect(await coerceLiteral(Reference, '"k1"')).toEqual({ value: 'string:k1' });
    expect((await coerceLiteral(Reference, '5')).error).toContain('LiteralReference_LiteralKey_ID must be a LiteralKey_ID');
  });

  test('a custom root scalar decides its own literal kinds, directly and through a chain', async () => {
    const Epoch = new GraphQLScalarType({
      name: 'LiteralEpoch',
      serialize: Number,
      parseValue: Number,
      parseLiteral: (node) => (node.kind === Kind.INT ? Number(node.value) : undefined),
    });
    const Recent = createValidatedScalar('LiteralRecent', 'Recent epoch', Epoch, (value) => {
      if (value < 1600000000) throw new Error('A recent epoch is required');
    });
    const Audited = createValidatedScalar('LiteralAudited', 'Audited epoch', Recent, () => {});
    for (const scalar of [Recent, Audited]) {
      expect(await coerceLiteral(scalar, '1700000000')).toEqual({ value: 'number:1700000000' });
      expect((await coerceLiteral(scalar, '1500000000')).error).toContain('A recent epoch is required');
      expect((await coerceLiteral(scalar, '"1700000000"')).error).toContain(`Expected value of type "${scalar.name}"`);
    }
  });

  test('standard String, ID and Boolean bases keep their literal checks', async () => {
    const Label = createValidatedScalar('LiteralLabel', 'Label', GraphQLString, () => {});
    expect(await coerceLiteral(Label, '"a"')).toEqual({ value: 'string:a' });
    expect((await coerceLiteral(Label, '5')).error).toContain('LiteralLabel_String must be a String');

    const Code = createValidatedScalar('LiteralCode', 'Code', GraphQLID, () => {});
    expect(await coerceLiteral(Code, '"c1"')).toEqual({ value: 'string:c1' });
    expect((await coerceLiteral(Code, '5')).error).toContain('LiteralCode_ID must be a ID');

    const Active = createValidatedScalar('LiteralActive', 'Active', GraphQLBoolean, () => {});
    expect(await coerceLiteral(Active, 'false')).toEqual({ value: 'boolean:false' });
    expect((await coerceLiteral(Active, '"false"')).error).toContain('LiteralActive_Boolean must be a Boolean');
  });

  test('standard Int and Float bases keep their literal checks', async () => {
    const Count = createValidatedScalar('LiteralCount', 'Count', GraphQLInt, () => {});
    expect(await coerceLiteral(Count, '3')).toEqual({ value: 'number:3' });
    expect((await coerceLiteral(Count, '3.5')).error).toContain('LiteralCount_Int must be a Int');

    const Share = createValidatedScalar('LiteralShare', 'Share', GraphQLFloat, () => {});
    expect(await coerceLiteral(Share, '0.5')).toEqual({ value: 'number:0.5' });
    expect(await coerceLiteral(Share, '1')).toEqual({ value: 'number:1' });
    expect((await coerceLiteral(Share, '"1"')).error).toContain('LiteralShare_Float must be a Float');
  });
});
