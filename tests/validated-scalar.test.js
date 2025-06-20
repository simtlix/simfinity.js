const {
  GraphQLObjectType, GraphQLString, GraphQLInt, GraphQLID, GraphQLList, GraphQLNonNull,
} = require('graphql');
const { createValidatedScalar } = require('../src/index');
const simfinity = require('../src/index');

describe('Custom Validated Scalar Types', () => {
  let EmailScalar;
  let PositiveIntScalar;
  let PhoneScalar;
  let UserType;

  beforeAll(() => {
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
      expect(EmailScalar.name).toBe('Email');
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
