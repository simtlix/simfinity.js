import * as graphql from 'graphql';
import * as simfinity from '@simtlix/simfinity-postgres';

const { GraphQLObjectType } = graphql;

const professionalServiceType = new GraphQLObjectType({
  name: 'professionalService',
  description:
    'A service a professional is able to perform (junction between professional and service).',
  fields: () => ({
    service: {
      type: simfinity.getType('service'),
      description: 'The service the professional can perform.',
      extensions: { relation: { connectionField: 'service', displayField: 'name' } },
    },
  }),
});

export default professionalServiceType;
simfinity.addNoEndpointType(professionalServiceType);
