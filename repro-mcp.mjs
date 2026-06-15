import { GraphQLObjectType, GraphQLString, GraphQLNonNull, GraphQLID, GraphQLInputObjectType } from 'graphql';
import * as simfinity from '/Users/claudiogonzalez/SCM/GitHub/simfinity.js/src/index.js';

const BookType = new GraphQLObjectType({
  name: 'ReproBook',
  fields: () => ({
    id: { type: new GraphQLNonNull(GraphQLID) },
    title: { type: GraphQLString },
  }),
});

const stateMachine = {
  initialState: { name: 'DRAFT', value: 'DRAFT' },
  actions: {
    updateStatus: {  // no description, prefix collides with 'update'
      from: { name: 'DRAFT', value: 'DRAFT' },
      to: { name: 'PUBLISHED', value: 'PUBLISHED' },
    },
    deleteDraft: {  // no description, prefix collides with 'delete'
      from: { name: 'DRAFT', value: 'DRAFT' },
      to: { name: 'DISCARDED', value: 'DISCARDED' },
    },
    publish: {
      from: { name: 'DRAFT', value: 'DRAFT' },
      to: { name: 'PUBLISHED', value: 'PUBLISHED' },
    },
  },
};

const BalanceInput = new GraphQLInputObjectType({
  name: 'BalanceInput',
  fields: { amount: { type: GraphQLString } },
});
const BalanceResult = new GraphQLObjectType({
  name: 'BalanceResult',
  fields: { balance: { type: GraphQLString } },
});

simfinity.preventCreatingCollection(true);
simfinity.connect(null, BookType, 'reprobook', 'reprobooks', null, null, stateMachine);
simfinity.registerMutation('updateBalance', 'Increment the account balance by amount', BalanceInput, BalanceResult, async () => ({ balance: '1' }));

const schema = simfinity.createSchema();
const { tools } = simfinity.generateMCPTools(schema);
for (const name of ['updateStatus_reprobook', 'deleteDraft_reprobook', 'publish_reprobook', 'updateBalance', 'deletereprobook']) {
  const t = tools.find((x) => x.name === name);
  console.log('===', name);
  console.log('title:', t.title);
  console.log('description:', t.description);
  console.log('annotations:', JSON.stringify(t.annotations));
  console.log('inputSchema:', JSON.stringify(t.inputSchema));
}
