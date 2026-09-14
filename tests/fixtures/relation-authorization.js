import {
  GraphQLID, GraphQLList, GraphQLObjectType, GraphQLString,
} from 'graphql';
import mongoose from 'mongoose';
import * as defaultRuntime from '../../packages/mongodb/src/index.js';

export const createRelationFixture = (prefix, customId = false, parentField = 'parent_id', simfinity = defaultRuntime, customConnectionField = 'child_id') => {
  const child = new GraphQLObjectType({
    name: `${prefix}Child`,
    fields: () => ({
      id: { type: GraphQLID },
      name: { type: GraphQLString },
      tenant: { type: GraphQLString },
      [parentField]: {
        type: parent,
        extensions: { relation: { connectionField: 'parent_id' } },
      },
    }),
    extensions: {
      scope: {
        get_by_id: async ({ args, context }) => {
          await Promise.resolve();
          if (context.rejectScope) throw new simfinity.SimfinityError('Scope denied', 'FORBIDDEN', 403);
          args.tenant = { value: context.tenant };
          if (context.redirectScopeId) args.id = { value: context.redirectScopeId };
        },
        find: async ({ args, context }) => {
          await Promise.resolve();
          if (context.rejectScope) throw new simfinity.SimfinityError('Scope denied', 'FORBIDDEN', 403);
          args.tenant = { value: context.tenant };
          if (context.redirectParent) {
            args[parentField] = { terms: [{ path: 'id', value: context.redirectParent }] };
          }
        },
      },
    },
  });
  const customResolver = (_parent, _args, context) => ({ name: context.customName });
  const parent = new GraphQLObjectType({
    name: `${prefix}Parent`,
    fields: () => ({
      id: { type: GraphQLID },
      name: { type: GraphQLString },
      child: {
        type: child,
        extensions: { relation: { connectionField: 'child_id' } },
      },
      customChild: {
        type: child,
        extensions: { readOnly: true, relation: { connectionField: customConnectionField } },
        resolve: customResolver,
      },
      children: {
        type: new GraphQLList(child),
        extensions: { relation: { connectionField: 'parent_id' } },
      },
    }),
  });
  const controller = {
    onUpdating: async (_id, update, _session, context) => {
      await context.beforeChildUpdate?.();
      if (context.hookParent) update.parent_id = context.hookParent;
      if (context.hookUnsetParent) update.$unset = { parent_id: '' };
      if (context.hookSetParent) update.$set = { parent_id: context.hookSetParent };
    },
    onSaving: (document, _args, _session, context) => {
      if (context.hookParent) document.parent_id = context.hookParent;
    },
  };
  let childModel = null;
  let parentModel = null;
  if (customId) {
    child.extensions.scope = {};
    childModel = mongoose.model(child.name, new mongoose.Schema({ _id: String, name: String, tenant: String, parent_id: String }));
    parentModel = mongoose.model(parent.name, new mongoose.Schema({ _id: String, name: String, child_id: String }));
  }
  simfinity.connect(childModel, child, `${prefix.toLowerCase()}child`, `${prefix.toLowerCase()}children`, controller);
  simfinity.connect(parentModel, parent, `${prefix.toLowerCase()}parent`, `${prefix.toLowerCase()}parents`);
  simfinity.use(async ({ type, args, operation, context }, next) => {
    if (type.gqltype === child) {
      await Promise.resolve();
      context.calls?.push({ operation, args: structuredClone(args) });
      if (context.rejectOperation === operation) {
        throw new simfinity.SimfinityError('Operation denied', 'FORBIDDEN', 403);
      }
      if (context.redirectMutationId && operation === 'update') args.input.id = context.redirectMutationId;
      if (context.redirectMutationId && operation === 'delete') args.id = context.redirectMutationId;
      if (context.redirectReadId && operation === 'get_by_id') args.id = context.redirectReadId;
    }
    await next();
  });
  const schema = simfinity.createSchema();
  return { schema, child, parent, customResolver };
};
