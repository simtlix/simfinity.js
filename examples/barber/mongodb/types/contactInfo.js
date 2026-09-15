import * as graphql from 'graphql';
import * as simfinity from '@simtlix/simfinity-js';
import { scalars } from '@simtlix/simfinity-js';

const { GraphQLObjectType, GraphQLString } = graphql;
const { URLScalar } = scalars;

const contactInfoType = new GraphQLObjectType({
  name: 'contactInfo',
  description: 'Public contact channels for a barbershop, embedded in the barbershop record.',
  fields: () => ({
    phone: { type: GraphQLString, description: 'Primary phone number.' },
    email: { type: GraphQLString, description: 'Public contact email address.' },
    whatsapp: { type: GraphQLString, description: 'WhatsApp contact number.' },
    instagramUrl: { type: URLScalar, description: 'Full URL of the Instagram profile.' },
    facebookUrl: { type: URLScalar, description: 'Full URL of the Facebook page.' },
  }),
});

export default contactInfoType;
simfinity.addNoEndpointType(contactInfoType);
