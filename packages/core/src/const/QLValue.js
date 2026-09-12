import { GraphQLScalarType, Kind } from 'graphql';

const parseQLValue = (value) => value;

const QLValue = new GraphQLScalarType({
  name: 'QLValue',
  serialize: parseQLValue,
  parseValue: parseQLValue,
  parseLiteral(ast) {
    if (ast.kind === Kind.INT) return parseInt(ast.value, 10);
    if (ast.kind === Kind.FLOAT) return parseFloat(ast.value);
    if (ast.kind === Kind.BOOLEAN) return ast.value === 'true' || ast.value === true;
    if (ast.kind === Kind.STRING) return ast.value;
    if (ast.kind === Kind.LIST) {
      return ast.values
        .map((value) => QLValue.parseLiteral(value))
        .filter((value) => value !== null);
    }
    return null;
  },
});

export default QLValue;
