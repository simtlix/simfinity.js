import { GraphQLScalarType, GraphQLString, GraphQLInt, GraphQLFloat, GraphQLBoolean, GraphQLID, Kind } from 'graphql';

export function createValidatedScalar(name, description, baseScalarType, validate) {
  if (!baseScalarType) {
    throw new Error('baseScalarType is required');
  }

  if (!(baseScalarType instanceof GraphQLScalarType)) {
    throw new Error('baseScalarType must be a valid GraphQL scalar type');
  }

  const validScalarTypes = [GraphQLString, GraphQLInt, GraphQLFloat, GraphQLBoolean, GraphQLID];
  const isValidStandardType = validScalarTypes.some((type) => baseScalarType === type);

  if (!isValidStandardType && !baseScalarType.name) {
    throw new Error('baseScalarType must be a standard GraphQL scalar type or a custom scalar with a valid name');
  }

  const kindMap = {
    String: Kind.STRING,
    Int: Kind.INT,
    Float: Kind.FLOAT,
    Boolean: Kind.BOOLEAN,
    ID: Kind.STRING,
  };

  const baseKind = kindMap[baseScalarType.name] || Kind.STRING;

  const scalar = new GraphQLScalarType({
    name: `${name}_${baseScalarType.name}`,
    description,
    serialize(value) {
      validate(value);
      return baseScalarType.serialize(value);
    },
    parseValue(value) {
      validate(value);
      return baseScalarType.parseValue(value);
    },
    parseLiteral(ast, variables) {
      if (ast.kind !== baseKind) {
        throw new Error(`${name}_${baseScalarType.name} must be a ${baseScalarType.name}`);
      }
      const value = baseScalarType.parseLiteral(ast, variables);
      validate(value);
      return value;
    },
  });

  scalar.baseScalarType = baseScalarType;
  return scalar;
}
