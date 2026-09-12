import { GraphQLID, GraphQLInt, GraphQLList, GraphQLNonNull, GraphQLObjectType, GraphQLString } from 'graphql';
import mongoose from 'mongoose';
import * as simfinity from '@simtlix/simfinity-js';

const SeasonType = new GraphQLObjectType({
  name: 'Season',
  fields: { number: { type: GraphQLInt } },
});

export const SerieType = new GraphQLObjectType({
  name: 'Serie',
  description: 'A television serie in the catalog.',
  fields: {
    id: { type: GraphQLID },
    name: {
      type: new GraphQLNonNull(GraphQLString),
      extensions: { validations: simfinity.validators.stringLength('Name', 2, 120) },
    },
    year: { type: GraphQLInt },
    category: { type: GraphQLString },
    seasons: {
      type: new GraphQLList(SeasonType),
      extensions: { relation: { embedded: true } },
    },
  },
});

const uri = process.env.MONGODB_URI
  || 'mongodb://127.0.0.1:27017/series?replicaSet=rs0&directConnection=true';
await mongoose.connect(uri);

simfinity.addNoEndpointType(SeasonType);
simfinity.connect(null, SerieType, 'serie', 'series');
export const schema = simfinity.createSchema();
await simfinity.getModel(SerieType).init();
