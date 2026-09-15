import * as graphql from 'graphql';
import * as simfinity from '@simtlix/simfinity-js';

const { GraphQLObjectType } = graphql;

const bundleItemType = new GraphQLObjectType({
  name: 'bundleItem',
  description: 'A single service included in a bundle (junction between bundle and service).',
  fields: () => ({
    service: {
      type: simfinity.getType('service'),
      description: 'The service included in the bundle.',
      extensions: { relation: { connectionField: 'service', displayField: 'name' } },
    },
  }),
});

export default bundleItemType;
simfinity.addNoEndpointType(bundleItemType);
