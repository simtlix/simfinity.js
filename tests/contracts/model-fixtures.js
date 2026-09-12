import {
  GraphQLFloat,
  GraphQLID,
  GraphQLInt,
  GraphQLList,
  GraphQLNonNull,
  GraphQLObjectType,
  GraphQLString,
} from 'graphql';

const reference = (connectionField, extra = {}) => ({
  relation: {
    embedded: false,
    ...(connectionField ? { connectionField } : {}),
  },
  ...extra,
});

const embedded = () => ({ relation: { embedded: true } });

const recordHook = (hookEvents, type, hook, record, session, context) => {
  hookEvents.push({
    type,
    hook,
    id: record?._id?.toString(),
    title: record?.title,
    context,
    session,
    inTransaction: session?.inTransaction(),
  });
};

const createController = (type, hookEvents) => ({
  async onSaving(record, args, session, context) {
    recordHook(hookEvents, type, 'onSaving', record, session, context);
  },
  async onSaved(record, args, session, context) {
    recordHook(hookEvents, type, 'onSaved', record, session, context);
  },
  async onUpdating(id, update, session, context) {
    hookEvents.push({
      type,
      hook: 'onUpdating',
      id: id.toString(),
      update,
      context,
      session,
      inTransaction: session?.inTransaction(),
    });
  },
  async onUpdated(record, session, context) {
    recordHook(hookEvents, type, 'onUpdated', record, session, context);
  },
  async onDelete(record, session, context) {
    recordHook(hookEvents, type, 'onDelete', record, session, context);
  },
});

export const createContractModelFixtures = ({ hookEvents = [] } = {}) => {
  const ContractLabel = new GraphQLObjectType({
    name: 'ContractLabel',
    fields: () => ({
      id: { type: GraphQLID },
      name: { type: new GraphQLNonNull(GraphQLString), extensions: { unique: true } },
    }),
  });

  const ContractDirector = new GraphQLObjectType({
    name: 'ContractDirector',
    fields: () => ({
      name: { type: new GraphQLNonNull(GraphQLString) },
      country: { type: GraphQLString },
    }),
  });

  const ContractCredit = new GraphQLObjectType({
    name: 'ContractCredit',
    fields: () => ({
      role: { type: new GraphQLNonNull(GraphQLString) },
      star: {
        type: new GraphQLNonNull(ContractStar),
        extensions: reference('star'),
      },
    }),
  });

  const ContractSerie = new GraphQLObjectType({
    name: 'ContractSerie',
    extensions: {
      scope: {
        find: async ({ args, context }) => {
          if (context?.tenant) {
            args.tenant = { operator: 'EQ', value: context.tenant };
          }
        },
        get_by_id: async ({ args, context }) => {
          if (context?.tenant) {
            args.tenant = { operator: 'EQ', value: context.tenant };
          }
        },
        aggregate: async ({ args, context }) => {
          if (context?.tenant) {
            args.tenant = { operator: 'EQ', value: context.tenant };
          }
        },
      },
    },
    fields: () => ({
      id: { type: GraphQLID },
      tenant: { type: new GraphQLNonNull(GraphQLString) },
      title: { type: new GraphQLNonNull(GraphQLString) },
      label: {
        type: ContractLabel,
        extensions: reference(),
      },
      director: {
        type: ContractDirector,
        extensions: embedded(),
      },
      categories: { type: new GraphQLList(GraphQLString) },
      seasons: {
        type: new GraphQLList(ContractSeason),
        extensions: reference('serie'),
      },
      assignments: {
        type: new GraphQLList(ContractAssignment),
        extensions: reference('serie'),
      },
      credits: {
        type: new GraphQLList(ContractCredit),
        extensions: embedded(),
      },
      notes: {
        type: new GraphQLList(ContractNote),
        extensions: reference('serie_id'),
      },
    }),
  });

  const ContractSeason = new GraphQLObjectType({
    name: 'ContractSeason',
    fields: () => ({
      id: { type: GraphQLID },
      number: {
        type: new GraphQLNonNull(GraphQLInt),
        extensions: {
          validations: {
            CREATE: [{
              async validate(typeName, fieldName, value) {
                if (value === 999) throw new Error('Season number 999 is invalid');
              },
            }],
            UPDATE: [{
              async validate(typeName, fieldName, value) {
                if (value === 999) throw new Error('Season number 999 is invalid');
              },
            }],
          },
        },
      },
      year: { type: GraphQLInt },
      serie: {
        type: new GraphQLNonNull(ContractSerie),
        extensions: reference('serie'),
      },
      episodes: {
        type: new GraphQLList(ContractEpisode),
        extensions: reference('season'),
      },
    }),
  });

  const ContractEpisode = new GraphQLObjectType({
    name: 'ContractEpisode',
    fields: () => ({
      id: { type: GraphQLID },
      title: { type: new GraphQLNonNull(GraphQLString) },
      kind: { type: new GraphQLNonNull(GraphQLString) },
      duration: { type: new GraphQLNonNull(GraphQLFloat) },
      season: {
        type: new GraphQLNonNull(ContractSeason),
        extensions: reference('season'),
      },
    }),
  });

  const ContractStar = new GraphQLObjectType({
    name: 'ContractStar',
    fields: () => ({
      id: { type: GraphQLID },
      name: { type: new GraphQLNonNull(GraphQLString), extensions: { unique: true } },
      assignments: {
        type: new GraphQLList(ContractAssignment),
        extensions: reference('star'),
      },
    }),
  });

  const ContractAssignment = new GraphQLObjectType({
    name: 'ContractAssignment',
    fields: () => ({
      id: { type: GraphQLID },
      billingOrder: { type: GraphQLInt },
      serie: {
        type: new GraphQLNonNull(ContractSerie),
        extensions: reference('serie'),
      },
      star: {
        type: new GraphQLNonNull(ContractStar),
        extensions: reference('star'),
      },
    }),
  });

  const ContractNote = new GraphQLObjectType({
    name: 'ContractNote',
    fields: () => ({
      id: { type: GraphQLID },
      text: { type: GraphQLString },
      serie_id: { type: GraphQLID, extensions: { readOnly: true } },
    }),
  });

  const types = {
    ContractLabel,
    ContractDirector,
    ContractCredit,
    ContractSerie,
    ContractSeason,
    ContractEpisode,
    ContractStar,
    ContractAssignment,
    ContractNote,
  };

  const registrations = [
    { gqltype: ContractLabel, endpoint: false },
    { gqltype: ContractDirector, endpoint: false },
    { gqltype: ContractCredit, endpoint: false },
    {
      gqltype: ContractSerie,
      endpoint: true,
      simpleEntityEndpointName: 'contractserie',
      listEntitiesEndpointName: 'contractseries',
      controller: createController('ContractSerie', hookEvents),
    },
    {
      gqltype: ContractSeason,
      endpoint: true,
      simpleEntityEndpointName: 'contractseason',
      listEntitiesEndpointName: 'contractseasons',
      controller: createController('ContractSeason', hookEvents),
    },
    {
      gqltype: ContractEpisode,
      endpoint: true,
      simpleEntityEndpointName: 'contractepisode',
      listEntitiesEndpointName: 'contractepisodes',
      controller: createController('ContractEpisode', hookEvents),
    },
    {
      gqltype: ContractStar,
      endpoint: true,
      simpleEntityEndpointName: 'contractstar',
      listEntitiesEndpointName: 'contractstars',
    },
    {
      gqltype: ContractAssignment,
      endpoint: true,
      simpleEntityEndpointName: 'contractassignment',
      listEntitiesEndpointName: 'contractassignments',
    },
    { gqltype: ContractNote, endpoint: false },
  ];

  return { types, registrations, hookEvents };
};

export const createModelFixtures = createContractModelFixtures;
