const {
  GraphQLObjectType, GraphQLString, GraphQLInt, GraphQLID, GraphQLList,
} = require('graphql');
const { createValidatedScalar } = require('../src/index');
const simfinity = require('../src/index');

console.log('🧪 Testing Custom Validated Scalar Types...\n');

// Test 1: Create custom scalars
console.log('📝 Test 1: Creating custom validated scalar types...');
try {
  const EmailScalar = createValidatedScalar(
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

  const PositiveIntScalar = createValidatedScalar(
    'PositiveInt',
    'A positive integer',
    GraphQLInt,
    (value) => {
      if (value <= 0) {
        throw new Error('Value must be positive');
      }
    },
  );

  const PhoneScalar = createValidatedScalar(
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

  console.log('✅ Custom scalars created successfully');
  console.log(`   - EmailScalar base type: ${EmailScalar.baseScalarType.name}`);
  console.log(`   - PositiveIntScalar base type: ${PositiveIntScalar.baseScalarType.name}`);
  console.log(`   - PhoneScalar base type: ${PhoneScalar.baseScalarType.name}`);
} catch (error) {
  console.log('❌ Failed to create custom scalars:', error.message);
  process.exit(1);
}

// Test 2: Validation
console.log('\n📝 Test 2: Testing validation logic...');
try {
  const EmailScalar = createValidatedScalar(
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

  const PositiveIntScalar = createValidatedScalar(
    'PositiveInt',
    'A positive integer',
    GraphQLInt,
    (value) => {
      if (value <= 0) {
        throw new Error('Value must be positive');
      }
    },
  );

  // Test valid values
  EmailScalar.serialize('test@example.com');
  PositiveIntScalar.serialize(5);

  // Test invalid values
  try {
    EmailScalar.serialize('invalid-email');
    console.log('❌ Email validation should have failed');
    process.exit(1);
  } catch (error) {
    console.log('✅ Email validation correctly rejects invalid emails');
  }

  try {
    PositiveIntScalar.serialize(0);
    console.log('❌ Positive integer validation should have failed');
    process.exit(1);
  } catch (error) {
    console.log('✅ Positive integer validation correctly rejects non-positive values');
  }

  console.log('✅ All validation tests passed');
} catch (error) {
  console.log('❌ Validation test failed:', error.message);
  process.exit(1);
}

// Test 3: Schema generation
console.log('\n📝 Test 3: Testing schema generation...');
try {
  const EmailScalar = createValidatedScalar(
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

  const PositiveIntScalar = createValidatedScalar(
    'PositiveInt',
    'A positive integer',
    GraphQLInt,
    (value) => {
      if (value <= 0) {
        throw new Error('Value must be positive');
      }
    },
  );

  const UserType = new GraphQLObjectType({
    name: 'User',
    fields: () => ({
      id: { type: GraphQLID },
      name: { type: GraphQLString },
      email: { type: EmailScalar },
      age: { type: PositiveIntScalar },
      emails: { type: new GraphQLList(EmailScalar) },
      ages: { type: new GraphQLList(PositiveIntScalar) },
    }),
  });

  simfinity.connect(null, UserType, 'user', 'users');
  const UserModel = simfinity.getModel(UserType);
  const schema = UserModel.schema.obj;

  console.log('✅ Schema generation successful');
  console.log('Generated schema fields:');
  console.log(`   - id: ${schema.id.schemaName || 'ObjectId'}`);
  console.log(`   - name: ${schema.name === String ? 'String' : typeof schema.name}`);
  console.log(`   - email: ${schema.email === String ? 'String' : typeof schema.email}`);
  console.log(`   - age: ${schema.age === Number ? 'Number' : typeof schema.age}`);
  console.log(`   - emails: ${Array.isArray(schema.emails) ? '[String]' : typeof schema.emails}`);
  console.log(`   - ages: ${Array.isArray(schema.ages) ? '[Number]' : typeof schema.ages}`);

  // Verify correct types
  if (schema.email !== String) {
    console.log('❌ Email field not correctly mapped to String');
    process.exit(1);
  }
  if (schema.age !== Number) {
    console.log('❌ Age field not correctly mapped to Number');
    process.exit(1);
  }
  if (!Array.isArray(schema.emails) || schema.emails[0] !== String) {
    console.log('❌ Emails array field not correctly mapped to [String]');
    process.exit(1);
  }
  if (!Array.isArray(schema.ages) || schema.ages[0] !== Number) {
    console.log('❌ Ages array field not correctly mapped to [Number]');
    process.exit(1);
  }

  console.log('✅ All schema type mappings are correct');
} catch (error) {
  console.log('❌ Schema generation test failed:', error.message);
  process.exit(1);
}

// Test 4: Error handling
console.log('\n📝 Test 4: Testing error handling...');
try {
  // Test missing baseScalarType
  try {
    createValidatedScalar('Test', 'Test', null, () => {});
    console.log('❌ Should have thrown error for missing baseScalarType');
    process.exit(1);
  } catch (error) {
    if (error.message === 'baseScalarType is required') {
      console.log('✅ Correctly throws error for missing baseScalarType');
    } else {
      console.log('❌ Wrong error message for missing baseScalarType');
      process.exit(1);
    }
  }

  // Test invalid baseScalarType
  try {
    createValidatedScalar('Test', 'Test', 'not a scalar', () => {});
    console.log('❌ Should have thrown error for invalid baseScalarType');
    process.exit(1);
  } catch (error) {
    if (error.message === 'baseScalarType must be a valid GraphQL scalar type') {
      console.log('✅ Correctly throws error for invalid baseScalarType');
    } else {
      console.log('❌ Wrong error message for invalid baseScalarType');
      process.exit(1);
    }
  }

  console.log('✅ All error handling tests passed');
} catch (error) {
  console.log('❌ Error handling test failed:', error.message);
  process.exit(1);
}

console.log('\n🎉 All tests passed successfully!');
console.log('✅ Custom validated scalar types are working correctly');
console.log('✅ Schema generation supports custom scalars');
console.log('✅ Validation logic works as expected');
console.log('✅ Error handling is robust');
