import { describe, expect, test } from 'vitest';
import {
  GraphQLID, GraphQLList, GraphQLNonNull, GraphQLObjectType, GraphQLString, validateSchema,
} from 'graphql';
import mongoose from 'mongoose';
import * as simfinity from '../src/index.js';
import { buildMaterializationTypes } from './fixtures/materialization-types.js';

describe('Wrapped list schema and input generation', () => {
  test('keeps scalar and relation list wrappers across inputs, models, and query arguments', () => {
    const { schema, Parent, listFields } = buildMaterializationTypes();
    expect(validateSchema(schema)).toEqual([]);
    const create = simfinity.getInputType(Parent).getFields();
    const update = schema.getType('MaterialParentInputForUpdate').getFields();
    const model = simfinity.getModel(Parent);
    for (const [name, field] of Object.entries(listFields)) {
      expect(String(create[name].type)).toBe(String(field.type));
      expect(String(update[name].type)).toBe(String(field.type instanceof GraphQLNonNull ? field.type.ofType : field.type));
      expect(model.schema.obj[name]).toEqual([field.mongo === 'ObjectId' ? mongoose.Schema.Types.ObjectId : field.mongo]);
      expect(schema.getQueryType().getFields().materialparents.args.find((arg) => arg.name === name).type.name).toBe('QLFilter');
    }
    expect(String(create.detail.type)).toBe('MaterialDetailInput!');
    expect(String(update.detail.type)).toBe('MaterialDetailInputForUpdate');
    expect(String(create.embedded.type)).toBe('[MaterialDetailInput]!');
    expect(String(update.embedded.type)).toBe('[MaterialDetailInputForUpdate]');
    expect(String(create.strictEmbedded.type)).toBe('[MaterialDetailInput!]!');
    expect(String(update.strictEmbedded.type)).toBe('[MaterialDetailInputForUpdate!]');
    expect(String(create.optionalEmbedded.type)).toBe('[MaterialDetailInput]');
    expect(String(create.optionalStrictEmbedded.type)).toBe('[MaterialDetailInput!]');
    expect(create.children.type).toBeInstanceOf(GraphQLNonNull);
    expect(update.children.type).not.toBeInstanceOf(GraphQLNonNull);
    expect(String(create.children.type.ofType.getFields().added.type)).toContain('!]');
    expect(Parent.getFields().children.resolve).toBeTypeOf('function');
    expect(String(create.strictChildren.type.getFields().added.type)).toContain('!]');
    expect(create.requiredNullableChildren.type).toBeInstanceOf(GraphQLNonNull);
    expect(String(create.requiredNullableChildren.type.ofType.getFields().added.type)).not.toContain('!]');
    expect(String(create.nullableChildren.type.getFields().added.type)).not.toContain('!]');
  });

  test('preserves wrapped self-reference collection inputs and only requires the entity ID on update', () => {
    const Tree = new GraphQLObjectType({
      name: 'MaterialTree',
      fields: () => ({
        id: { type: new GraphQLNonNull(GraphQLID) },
        externalId: { type: GraphQLID },
        text: { type: GraphQLString },
        parent: { type: Tree, extensions: { relation: { embedded: false } } },
        nodes: {
          type: new GraphQLNonNull(new GraphQLList(new GraphQLNonNull(Tree))),
          extensions: { relation: { embedded: false, connectionField: 'parent' } },
        },
      }),
    });
    simfinity.connect(null, Tree, 'materialtree', 'materialtrees');
    const schema = simfinity.createSchema();
    expect(validateSchema(schema)).toEqual([]);
    const create = simfinity.getInputType(Tree).getFields();
    const update = schema.getType('MaterialTreeInputForUpdate').getFields();
    expect(create).not.toHaveProperty('id');
    expect(String(update.id.type)).toBe('ID!');
    expect(String(update.externalId.type)).toBe('ID');
    expect(create.nodes.type).toBeInstanceOf(GraphQLNonNull);
    expect(update.nodes.type).not.toBeInstanceOf(GraphQLNonNull);
    expect(String(create.nodes.type.ofType.getFields().added.type)).toContain('!]');
    expect(Tree.getFields().nodes.resolve).toBeTypeOf('function');
  });
});
