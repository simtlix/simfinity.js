import { GraphQLScalarType, GraphQLString, GraphQLInt, GraphQLFloat, GraphQLBoolean, GraphQLID, Kind } from 'graphql';

// The base each validated scalar delegates parsing to. A base exists before its scalar, so these links cannot cycle.
const validatedBases = new WeakMap();

// Follow validated-scalar chains to the scalar that defines the literal syntax. Any other scalar is the root, even
// with a hand-set `baseScalarType` storage hint, because its own parseLiteral decides which literals it takes.
const findRootScalar = (scalarType) => {
  let root = scalarType;
  while (validatedBases.has(root)) {
    root = validatedBases.get(root);
  }
  return root;
};

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

  // Float takes integer literals too, as GraphQLFloat does, so an integral default printed as `5` stays valid.
  const kindMap = {
    String: [Kind.STRING],
    Int: [Kind.INT],
    Float: [Kind.FLOAT, Kind.INT],
    Boolean: [Kind.BOOLEAN],
    ID: [Kind.STRING],
  };

  // Custom root scalars define their own literal kinds, so their parseLiteral decides.
  const rootScalarType = findRootScalar(baseScalarType);
  const baseKinds = Object.hasOwn(kindMap, rootScalarType.name) ? kindMap[rootScalarType.name] : undefined;

  // Input is parsed by the base first, so validators judge the same internal value for variables and literals.
  // An undefined result is the base rejecting the input; GraphQL reports it without running the validator.
  const scalar = new GraphQLScalarType({
    name: `${name}_${baseScalarType.name}`,
    description,
    serialize(value) {
      validate(value);
      return baseScalarType.serialize(value);
    },
    parseValue(value) {
      const parsed = baseScalarType.parseValue(value);
      if (parsed !== undefined) validate(parsed);
      return parsed;
    },
    parseLiteral(ast, variables) {
      if (baseKinds !== undefined && !baseKinds.includes(ast.kind)) {
        throw new Error(`${name}_${baseScalarType.name} must be a ${baseScalarType.name}`);
      }
      const value = baseScalarType.parseLiteral(ast, variables);
      if (value !== undefined) validate(value);
      return value;
    },
  });

  scalar.baseScalarType = baseScalarType;
  validatedBases.set(scalar, baseScalarType);
  return scalar;
}
