import * as graphql from 'graphql';
import * as simfinity from '@simtlix/simfinity-js';

const { GraphQLObjectType, GraphQLString } = graphql;

const addressType = new GraphQLObjectType({
  name: 'address',
  description: 'A postal/street address, embedded in a barbershop.',
  fields: () => ({
    street: { type: GraphQLString, description: 'Street name.' },
    number: { type: GraphQLString, description: 'Street/building number.' },
    city: { type: GraphQLString, description: 'City or locality.' },
    state: { type: GraphQLString, description: 'State, province or region.' },
    zip: { type: GraphQLString, description: 'Postal/ZIP code.' },
    country: { type: GraphQLString, description: 'Country name or code.' },
  }),
});

export default addressType;
simfinity.addNoEndpointType(addressType);
