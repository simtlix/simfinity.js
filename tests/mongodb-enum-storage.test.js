import {
  afterAll, beforeAll, beforeEach, describe, expect, test,
} from 'vitest';
import mongoose from 'mongoose';
import {
  graphql, GraphQLEnumType, GraphQLID, GraphQLList, GraphQLNonNull, GraphQLObjectType, GraphQLString,
} from 'graphql';
import { createMongoAdapter, createRuntime } from '../packages/mongodb/src/index.js';

const uri = process.env.SIMFINITY_TEST_MONGODB_URI;
const embedded = { relation: { embedded: true } };

// Generated MongoDB models store enum internal values with their own BSON type.
const Priority = new GraphQLEnumType({ name: 'EnumStoragePriority', values: { LOW: { value: 1 }, HIGH: { value: 2 } } });
const Answer = new GraphQLEnumType({ name: 'EnumStorageAnswer', values: { YES: { value: true }, NO: { value: false } } });
const Shape = new GraphQLEnumType({ name: 'EnumStorageShape', values: { ONE: { value: 1 }, TWO: { value: 'two' } } });
const Color = new GraphQLEnumType({ name: 'EnumStorageColor', values: { RED: {}, BLUE: { value: 'blue' } } });
const Stage = new GraphQLEnumType({ name: 'EnumStorageStage', values: { DRAFT: { value: 10 }, ACTIVE: { value: 20 } } });
const Level = new GraphQLEnumType({ name: 'EnumStorageLevel', values: { TWO: { value: 2 }, TEN: { value: 10 } } });
const Boxed = new GraphQLEnumType({ name: 'EnumStorageBoxed', values: { A: { value: { k: 1 } }, B: { value: { k: 2 } } } });

const Detail = new GraphQLObjectType({
  name: 'EnumStorageDetail',
  fields: { priority: { type: Priority }, answer: { type: Answer } },
});
const Task = new GraphQLObjectType({
  name: 'EnumStorageTask',
  fields: {
    id: { type: GraphQLID },
    title: { type: GraphQLString },
    priority: { type: new GraphQLNonNull(Priority) },
    answer: { type: Answer },
    shape: { type: Shape },
    color: { type: Color },
    level: { type: Level },
    priorities: { type: new GraphQLList(Priority) },
    answers: { type: new GraphQLList(new GraphQLNonNull(Answer)) },
    shapes: { type: new GraphQLList(Shape) },
    detail: { type: Detail, extensions: embedded },
    details: { type: new GraphQLList(Detail), extensions: embedded },
  },
});
const Workflow = new GraphQLObjectType({
  name: 'EnumStorageWorkflow',
  fields: {
    id: { type: GraphQLID }, title: { type: GraphQLString }, state: { type: Stage }, stage: { type: Stage },
  },
});
// A plain field that happens to be named `state` is not managed by a state machine.
const Label = new GraphQLObjectType({
  name: 'EnumStorageLabel',
  fields: { id: { type: GraphQLID }, title: { type: GraphQLString }, state: { type: Priority } },
});
const Unique = new GraphQLObjectType({
  name: 'EnumStorageUnique',
  fields: { id: { type: GraphQLID }, code: { type: Priority, extensions: { unique: true } } },
});

const adapter = createMongoAdapter();
const runtime = createRuntime(adapter);
runtime.preventCreatingCollection(true);
runtime.addNoEndpointType(Detail);
runtime.connect(null, Task, 'enumtask', 'enumtasks');
runtime.connect(null, Workflow, 'enumworkflow', 'enumworkflows', null, null, {
  initialState: Stage.getValue('DRAFT'),
  actions: { activate: { from: Stage.getValue('DRAFT'), to: Stage.getValue('ACTIVE') } },
});
runtime.connect(null, Label, 'enumlabel', 'enumlabels');
runtime.connect(null, Unique, 'enumunique', 'enumuniques');
const BoxedHolder = new GraphQLObjectType({
  name: 'EnumStorageBoxedHolder',
  fields: { id: { type: GraphQLID }, kind: { type: Boxed } },
});
runtime.connect(null, BoxedHolder, 'enumboxed', 'enumboxeds');
const schema = runtime.createSchema();

const TaskModel = runtime.getModel(Task);
const WorkflowModel = runtime.getModel(Workflow);
const LabelModel = runtime.getModel(Label);
const instanceOf = (Model, path) => Model.schema.path(path)?.instance;
const itemInstanceOf = (Model, path) => Model.schema.path(path)?.caster?.instance;
const match = async (filters, type = Task) => (await adapter.buildQuery(filters, type))
  .find((stage) => stage.$match).$match;

describe('generated MongoDB enum storage', () => {
  test('chooses the storage type from the enum internal values', () => {
    expect({
      priority: instanceOf(TaskModel, 'priority'),
      answer: instanceOf(TaskModel, 'answer'),
      shape: instanceOf(TaskModel, 'shape'),
      color: instanceOf(TaskModel, 'color'),
      priorities: itemInstanceOf(TaskModel, 'priorities'),
      answers: itemInstanceOf(TaskModel, 'answers'),
      shapes: itemInstanceOf(TaskModel, 'shapes'),
      detailPriority: instanceOf(TaskModel, 'detail.priority'),
      detailAnswer: instanceOf(TaskModel, 'detail.answer'),
      detailsPriority: instanceOf(TaskModel, 'details.priority'),
      unique: instanceOf(runtime.getModel(Unique), 'code'),
    }).toEqual({
      priority: 'Number',
      answer: 'Boolean',
      shape: 'Mixed',
      color: 'String',
      priorities: 'Number',
      answers: 'Boolean',
      shapes: 'Mixed',
      detailPriority: 'Number',
      detailAnswer: 'Boolean',
      detailsPriority: 'Number',
      unique: 'Number',
    });
    expect(runtime.getModel(Unique).schema.path('code').options.unique).toBe(true);
  });

  test('keeps string storage for enums with non-primitive internal values', () => {
    // Mixed would commit values that GraphQL cannot serialize back, so such writes stay rejected.
    expect(instanceOf(runtime.getModel(BoxedHolder), 'kind')).toBe('String');
  });

  test('keeps state-machine names storable in a non-string state field', () => {
    expect(instanceOf(WorkflowModel, 'state')).toBe('Mixed');
    expect(instanceOf(WorkflowModel, 'stage')).toBe('Number');
    expect(instanceOf(LabelModel, 'state')).toBe('Mixed');
    expect(new WorkflowModel({ state: 'DRAFT', stage: 20 }).toObject()).toMatchObject({ state: 'DRAFT', stage: 20 });
    expect(new LabelModel({ state: 2 }).toObject()).toMatchObject({ state: 2 });
  });

  test('persists internal values without converting them to strings', () => {
    const record = new TaskModel({
      priority: 1,
      answer: false,
      shape: 1,
      color: 'RED',
      priorities: [1, 2],
      answers: [true],
      shapes: ['two', 1],
      detail: { priority: 2, answer: true },
      details: [{ priority: 1 }],
    });
    expect(record.validateSync()).toBeUndefined();
    expect(record.toObject()).toMatchObject({
      priority: 1,
      answer: false,
      shape: 1,
      color: 'RED',
      priorities: [1, 2],
      answers: [true],
      shapes: ['two', 1],
      detail: { priority: 2, answer: true },
      details: [{ priority: 1 }],
    });
  });

  test('casts enum filters to the stored value type', async () => {
    expect(await match({ priority: { value: 'LOW' } })).toEqual({ priority: 1 });
    expect(await match({ priority: { value: 2 } })).toEqual({ priority: 2 });
    expect(await match({ priority: { operator: 'IN', value: ['LOW', 'HIGH'] } })).toEqual({ priority: { $in: [1, 2] } });
    expect(await match({ priority: { operator: 'LT', value: 'HIGH' } })).toEqual({ priority: { $lt: 2 } });
    expect(await match({ answer: { value: 'NO' } })).toEqual({ answer: false });
    expect(await match({ shape: { value: 'TWO' } })).toEqual({ shape: 'two' });
    expect(await match({ shape: { value: 'ONE' } })).toEqual({ shape: 1 });
    expect(await match({ priorities: { value: 'HIGH' } })).toEqual({ priorities: 2 });
    expect(await match({ detail: { terms: [{ path: 'priority', value: 'HIGH' }] } })).toEqual({ 'detail.priority': 2 });
    expect(await match({ details: { terms: [{ path: 'priority', value: 'LOW' }] } })).toEqual({ 'details.priority': 1 });
    expect(await match({ state: { value: 'ACTIVE' } }, Workflow)).toEqual({ state: 'ACTIVE' });
    expect(await match({ state: { value: 20 } }, Workflow)).toEqual({ state: 'ACTIVE' });
    expect(await match({ stage: { value: 'ACTIVE' } }, Workflow)).toEqual({ stage: 20 });
    expect(await match({ state: { value: 'HIGH' } }, Label)).toEqual({ state: 2 });
    await expect(adapter.buildQuery({ priority: { value: '1' } }, Task))
      .rejects.toMatchObject({ extensions: { code: 'INVALID_FILTER_VALUE' } });
  });
});

describe.skipIf(!uri)('generated MongoDB enum storage against a database', () => {
  const selection = 'id title priority answer shape color priorities answers shapes detail { priority answer } details { priority answer }';
  const execute = async (source) => graphql({ schema, source, contextValue: {} });
  const expectData = async (source) => {
    const result = await execute(source);
    expect(result.errors).toBeUndefined();
    return result.data;
  };
  const addTask = async (title, fields) => (await expectData(`mutation { addenumtask(input: { title: "${title}", ${fields} }) { ${selection} } }`)).addenumtask;
  const titles = async (filter) => (await expectData(`{ enumtasks(${filter}, sort: { terms: [{ field: "title", order: ASC }] }) { title } }`))
    .enumtasks.map(({ title }) => title);

  beforeAll(async () => {
    await mongoose.connect(uri);
    for (const Model of [TaskModel, WorkflowModel, LabelModel]) await Model.createCollection();
  });

  beforeEach(async () => {
    for (const Model of [TaskModel, WorkflowModel, LabelModel]) await Model.deleteMany({});
  });

  afterAll(async () => {
    if (mongoose.connection.readyState === 1) {
      for (const Model of [TaskModel, WorkflowModel, LabelModel]) await Model.collection.drop().catch(() => {});
      await mongoose.disconnect();
    }
  });

  test('returns numeric, boolean and mixed enums from create, get by id and list reads', async () => {
    const expected = {
      title: 'first',
      priority: 'LOW',
      answer: 'NO',
      shape: 'TWO',
      color: 'BLUE',
      priorities: ['LOW', 'HIGH'],
      answers: ['YES', 'NO'],
      shapes: ['ONE', 'TWO'],
      detail: { priority: 'HIGH', answer: 'YES' },
      details: [{ priority: 'LOW', answer: 'NO' }],
    };
    const added = await addTask('first', `priority: LOW, answer: NO, shape: TWO, color: BLUE,
      priorities: [LOW, HIGH], answers: [YES, NO], shapes: [ONE, TWO],
      detail: { priority: HIGH, answer: YES }, details: [{ priority: LOW, answer: NO }]`);
    expect(added).toMatchObject(expected);

    const stored = await TaskModel.collection.findOne({ _id: new mongoose.Types.ObjectId(added.id) });
    expect(stored).toMatchObject({
      priority: 1,
      answer: false,
      shape: 'two',
      color: 'blue',
      priorities: [1, 2],
      answers: [true, false],
      shapes: [1, 'two'],
      detail: { priority: 2, answer: true },
      details: [{ priority: 1, answer: false }],
    });

    const byId = await expectData(`{ enumtask(id: "${added.id}") { ${selection} } }`);
    expect(byId.enumtask).toEqual(added);
    const list = await expectData(`{ enumtasks { ${selection} } }`);
    expect(list.enumtasks).toEqual([added]);
  });

  test('filters numeric and boolean enums by name and internal value', async () => {
    await addTask('low', 'priority: LOW, answer: YES, priorities: [LOW], detail: { priority: LOW }');
    await addTask('high', 'priority: HIGH, answer: NO, priorities: [LOW, HIGH], detail: { priority: HIGH }');

    expect(await titles('priority: { value: "LOW" }')).toEqual(['low']);
    expect(await titles('priority: { value: 2 }')).toEqual(['high']);
    expect(await titles('priority: { operator: IN, value: ["LOW", "HIGH"] }')).toEqual(['high', 'low']);
    expect(await titles('priority: { operator: GT, value: "LOW" }')).toEqual(['high']);
    expect(await titles('answer: { value: "YES" }')).toEqual(['low']);
    expect(await titles('priorities: { value: "HIGH" }')).toEqual(['high']);
    expect(await titles('detail: { terms: [{ path: "priority", value: "HIGH" }] }')).toEqual(['high']);
  });

  test('compares, sorts and groups numeric enums as numbers', async () => {
    await addTask('ten', 'priority: LOW, level: TEN');
    await addTask('two', 'priority: LOW, level: TWO');

    expect(await titles('level: { operator: LT, value: "TEN" }')).toEqual(['two']);
    expect(await titles('level: { operator: GTE, value: "TEN" }')).toEqual(['ten']);
    const sorted = await expectData('{ enumtasks(sort: { terms: [{ field: "level", order: ASC }] }) { title } }');
    expect(sorted.enumtasks.map(({ title }) => title)).toEqual(['two', 'ten']);
    const grouped = await expectData('{ enumtasks_aggregate(aggregation: { groupId: "level", facts: [{ operation: COUNT, path: "id", factName: "n" }] }) { groupId } }');
    expect(grouped.enumtasks_aggregate.map(({ groupId }) => groupId)).toEqual([2, 10]);
  });

  test('returns the updated enum values from update mutations', async () => {
    const added = await addTask('update', 'priority: LOW, answer: YES, priorities: [LOW]');
    const result = await expectData(`mutation { updateenumtask(input: { id: "${added.id}", priority: HIGH, answer: NO, priorities: [HIGH, LOW], detail: { priority: HIGH } }) { priority answer priorities detail { priority } } }`);
    expect(result.updateenumtask).toEqual({
      priority: 'HIGH', answer: 'NO', priorities: ['HIGH', 'LOW'], detail: { priority: 'HIGH' },
    });
    const stored = await TaskModel.collection.findOne({ _id: new mongoose.Types.ObjectId(added.id) });
    expect(stored).toMatchObject({ priority: 2, answer: false, priorities: [2, 1], detail: { priority: 2 } });
  });

  test('keeps storing state-machine names while ordinary enum fields store values', async () => {
    const { addenumworkflow: added } = await expectData('mutation { addenumworkflow(input: { title: "flow", stage: ACTIVE }) { id state stage } }');
    expect(added).toMatchObject({ state: 'DRAFT', stage: 'ACTIVE' });
    const _id = new mongoose.Types.ObjectId(added.id);
    expect(await WorkflowModel.collection.findOne({ _id })).toMatchObject({ state: 'DRAFT', stage: 20 });

    const { activate_enumworkflow: activated } = await expectData(`mutation { activate_enumworkflow(input: { id: "${added.id}" }) { state stage } }`);
    expect(activated).toEqual({ state: 'ACTIVE', stage: 'ACTIVE' });
    expect(await WorkflowModel.collection.findOne({ _id })).toMatchObject({ state: 'ACTIVE', stage: 20 });
    const { enumworkflows } = await expectData('{ enumworkflows(state: { value: "ACTIVE" }, stage: { value: "ACTIVE" }) { title stage } }');
    expect(enumworkflows).toEqual([{ title: 'flow', stage: 'ACTIVE' }]);

    const { addenumlabel: label } = await expectData('mutation { addenumlabel(input: { title: "label", state: HIGH }) { id state } }');
    expect(label.state).toBe('HIGH');
    expect(await LabelModel.collection.findOne({ _id: new mongoose.Types.ObjectId(label.id) })).toMatchObject({ state: 2 });
    expect((await expectData('{ enumlabels(state: { value: "HIGH" }) { state } }')).enumlabels).toEqual([{ state: 'HIGH' }]);
  });

  test('reads legacy string values by ID and lists them after the documented migration', async () => {
    const { insertedId } = await TaskModel.collection.insertOne({
      title: 'legacy', priority: '1', answer: 'true', priorities: ['1', '2'], details: [{ priority: '2' }], shape: '1',
    });

    // Hydrated reads cast legacy strings in Number and Boolean paths; list reads and filters see the stored strings.
    const byId = await expectData(`{ enumtask(id: "${insertedId}") { priority answer priorities details { priority } } }`);
    expect(byId.enumtask).toEqual({ priority: 'LOW', answer: 'YES', priorities: ['LOW', 'HIGH'], details: [{ priority: 'HIGH' }] });
    const legacyList = await execute('{ enumtasks { priority } }');
    expect(legacyList.errors?.[0].message).toContain('cannot represent value: "1"');
    expect(await titles('priority: { value: "LOW" }')).toEqual([]);
    // A mixed-value enum is stored as given, so even a hydrated read keeps the legacy string.
    const legacyShape = await execute(`{ enumtask(id: "${insertedId}") { shape } }`);
    expect(legacyShape.errors?.[0].message).toContain('cannot represent value: "1"');

    await TaskModel.collection.updateMany({ priority: { $type: 'string' } }, [{ $set: { priority: { $toInt: '$priority' } } }]);
    await TaskModel.collection.updateMany({ answer: { $type: 'string' } }, [{ $set: { answer: { $eq: ['$answer', 'true'] } } }]);
    await TaskModel.collection.updateMany({ priorities: { $type: 'string' } }, [{ $set: { priorities: { $map: { input: '$priorities', in: { $toInt: '$$this' } } } } }]);
    await TaskModel.collection.updateMany({ 'details.priority': { $type: 'string' } }, [{
      $set: { details: { $map: { input: '$details', in: { $mergeObjects: ['$$this', { priority: { $toInt: '$$this.priority' } }] } } } },
    }]);
    await TaskModel.collection.updateMany({ shape: '1' }, { $set: { shape: 1 } });
    expect((await expectData('{ enumtasks { title priority answer priorities details { priority } shape } }')).enumtasks)
      .toEqual([{
        title: 'legacy', priority: 'LOW', answer: 'YES', priorities: ['LOW', 'HIGH'], details: [{ priority: 'HIGH' }], shape: 'ONE',
      }]);
    expect(await titles('priority: { value: "LOW" }')).toEqual(['legacy']);
  });
});
