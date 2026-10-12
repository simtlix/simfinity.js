import * as graphql from 'graphql';
import * as simfinity from '@simtlix/simfinity-postgres';

const { GraphQLObjectType, GraphQLFloat, GraphQLInt } = graphql;

const bookingLineType = new GraphQLObjectType({
  name: 'bookingLine',
  description:
    'A line item within a booking: either a single service or a bundle, with the price and duration captured at booking time. Set either `service` or `bundle`, not both.',
  fields: () => ({
    service: {
      type: simfinity.getType('service'),
      description: 'The selected service (mutually exclusive with `bundle`).',
      extensions: { relation: { connectionField: 'service', displayField: 'name' } },
    },
    bundle: {
      type: simfinity.getType('bundle'),
      description: 'The selected bundle (mutually exclusive with `service`).',
      extensions: { relation: { connectionField: 'bundle', displayField: 'name' } },
    },
    price: {
      type: GraphQLFloat,
      description: "Price captured when the line is saved: the service's or bundle's catalog price, or the line's earlier price when an update keeps its service or bundle. Only the barbershop's owner or a platform admin may send another price, from 0 up to the catalog price.",
    },
    durationMinutes: {
      type: GraphQLInt,
      description: "Duration in minutes captured when the line is saved: the service's catalog duration, or the sum of the bundle's current services. A value sent in a mutation is ignored.",
    },
  }),
});

export default bookingLineType;
simfinity.addNoEndpointType(bookingLineType);
