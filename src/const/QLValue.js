const graphql = require('graphql');

const { GraphQLScalarType, Kind } = graphql;

function parseQLValue(value) {
  return value;
}

const QLValue = new GraphQLScalarType({
  name: 'QLValue',
  serialize: parseQLValue,
  parseValue: parseQLValue,
  parseLiteral(ast) {
    if (ast.kind === Kind.INT) {
      return parseInt(ast.value, 10);
    } if (ast.kind === Kind.FLOAT) {
      return parseFloat(ast.value);
    } if (ast.kind === Kind.BOOLEAN) {
      return ast.value === 'true' || ast.value === true;
    } if (ast.kind === Kind.STRING) {
      return ast.value;
    } if (ast.kind === Kind.LIST) {
      const values = [];
      ast.values.forEach((value) => {
        if (value.kind === Kind.INT) {
          values.push(parseInt(value.value, 10));
        } else if (value.kind === Kind.FLOAT) {
          values.push(parseFloat(value.value));
        } else if (value.kind === Kind.BOOLEAN) {
          values.push(value.value === 'true' || value.value === true);
        } else if (value.kind === Kind.STRING) {
          values.push(value.value);
        }
      });
      return values;
    }
    return null;
  },
});

module.exports = QLValue;
