import { GraphQLEnumType, GraphQLID, GraphQLInt, GraphQLList, GraphQLNonNull, GraphQLObjectType, GraphQLString } from 'graphql';
import { createRuntime } from '../../packages/core/src/index.js';

// Synthetic shared model for legacy parity, the public format example and MCP contract checks.
export const descriptorModel = () => {
  const api = createRuntime({ createModel: () => ({}) });
  const State = new GraphQLEnumType({ name: 'PublicationState', values: { DRAFT: { value: 10 }, LIVE: { value: 20 } } });
  const Details = new GraphQLObjectType({ name: 'Details', fields: { note: { type: GraphQLString } } });
  const Serie = new GraphQLObjectType({ name: 'Serie', fields: () => ({
    id: { type: GraphQLID },
    name: { type: new GraphQLNonNull(GraphQLString), extensions: { unique: true } },
    state: { type: State },
    details: { type: Details, extensions: { relation: { embedded: true } } },
    summary: { type: GraphQLString, extensions: { virtual: true }, resolve: () => 'Summary' },
    seasons: { type: new GraphQLList(Season), extensions: { relation: { connectionField: 'serie_key', displayField: 'number' } } },
  }) });
  const Season = new GraphQLObjectType({ name: 'Season', fields: () => ({
    id: { type: GraphQLID }, number: { type: GraphQLInt },
    serie: { type: new GraphQLNonNull(Serie), extensions: { relation: { connectionField: 'serie_key', displayField: 'name' } } },
    episodes: { type: new GraphQLList(Episode), extensions: { relation: { connectionField: 'season', displayField: 'title' } } },
  }) });
  const Episode = new GraphQLObjectType({ name: 'Episode', fields: () => ({
    id: { type: GraphQLID }, title: { type: GraphQLString },
    season: { type: Season, extensions: { relation: { displayField: 'number' } } },
  }) });
  api.addNoEndpointType(Details);
  api.connect(null, Serie, 'serie', 'series', null, null, { initialState: State.getValue('DRAFT'), actions: {
    publish: { from: State.getValue('DRAFT'), to: State.getValue('LIVE'), description: 'Publish a serie' },
  } });
  api.connect(null, Season, 'season', 'seasons'); api.connect(null, Episode, 'episode', 'episodes');
  api.registerCustomQuery('greeting', 'Greeting', null, GraphQLString, () => 'Hello');
  api.registerMutation('notify', 'Notify', null, GraphQLString, () => 'ok');
  api.registerView('featured', { type: Serie, description: 'Featured series', params: { label: { type: GraphQLString, defaultValue: 'all' } }, where: () => [] });
  api.createSchema();
  api.getInputType(Episode).getFields().title.defaultValue = 'Untitled';
  return { api, Serie, Season, Episode, Details, schema: api.createSchema() };
};
