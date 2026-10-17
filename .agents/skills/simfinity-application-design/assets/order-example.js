import {
  GraphQLEnumType, GraphQLID, GraphQLInt, GraphQLList, GraphQLNonNull,
  GraphQLObjectType, GraphQLString,
} from 'graphql';
import { auth, SimfinityError, validators } from '@simtlix/simfinity-core';

// Build once per runtime. Storage is application code for the selected engine.
export function createOrderExample(api, storage) {
  const identity = (context) => {
    auth.requireAuth()(null, {}, context);
    if (typeof context.user.tenantId !== 'string' || !context.user.tenantId) throw new auth.ForbiddenError();
    return context.user;
  };
  const writer = (context) => {
    identity(context);
    auth.requirePermission('orders:write')(null, {}, context);
  };
  const tenantScope = ({ args, context }) => {
    const user = identity(context);
    args.AND = [...(args.AND || []), { conditions: [{ field: 'tenantId', operator: 'EQ', value: user.tenantId }] }];
  };
  const scope = { find: tenantScope, get_by_id: tenantScope, aggregate: tenantScope };
  const tenantField = () => ({ type: GraphQLString, extensions: { readOnly: true } });
  const State = new GraphQLEnumType({ name: 'SkillOrderState', values: { DRAFT: {}, APPROVED: {} } });
  const Customer = new GraphQLObjectType({
    name: 'SkillCustomer', extensions: { scope },
    fields: { id: { type: GraphQLID }, name: { type: new GraphQLNonNull(GraphQLString) }, tenantId: tenantField() },
  });
  const Order = new GraphQLObjectType({
    name: 'SkillOrder', extensions: { scope },
    fields: () => ({
      id: { type: GraphQLID }, label: { type: new GraphQLNonNull(GraphQLString) }, tenantId: tenantField(),
      state: { type: State }, total: { type: GraphQLInt, extensions: { readOnly: true } },
      customer: { type: new GraphQLNonNull(Customer), extensions: { relation: { connectionField: 'customerId' } } },
      lines: { type: new GraphQLList(Line), extensions: { relation: { connectionField: 'orderId' } } },
    }),
  });
  const Line = new GraphQLObjectType({
    name: 'SkillLine', extensions: { scope },
    fields: () => ({
      id: { type: GraphQLID }, tenantId: tenantField(),
      sku: { type: new GraphQLNonNull(GraphQLString) },
      quantity: { type: new GraphQLNonNull(GraphQLInt), extensions: { validations: validators.numberRange('Quantity', 1, 10000) } },
      unitPrice: { type: new GraphQLNonNull(GraphQLInt), extensions: { validations: validators.numberRange('Price', 0, 1000000) } },
      order: { type: new GraphQLNonNull(Order), extensions: { relation: { connectionField: 'orderId' } } },
    }),
  });
  const owned = async (type, id, session, context) => {
    const record = await storage.get(type, id, session);
    if (!record || record.tenantId !== identity(context).tenantId) throw new auth.ForbiddenError();
    return record;
  };
  const editable = async (id, session, context) => {
    writer(context);
    const order = await owned(Order, id, session, context);
    if (order.state !== 'DRAFT') throw new SimfinityError('Approved orders cannot change', 'ORDER_CLOSED', 409);
    return order;
  };
  const priceLine = (line) => {
    // Illustrative business policy: PROMO lines have a fixed price in minor units.
    if (line.sku === 'PROMO') line.unitPrice = 75;
    if (!Number.isInteger(line.quantity) || line.quantity < 1 || line.quantity > 10000
      || !Number.isInteger(line.unitPrice) || line.unitPrice < 0 || line.unitPrice > 1000000) {
      throw new SimfinityError('Invalid line values', 'INVALID_LINE', 400);
    }
  };
  const refresh = async (order, session) => {
    const id = order._id ?? order.id;
    const lines = await storage.lines(Line, id, session);
    const total = lines.reduce((sum, line) => sum + line.quantity * line.unitPrice, 0);
    if (!Number.isSafeInteger(total) || total > 2147483647) throw new SimfinityError('Total exceeds GraphQL Int', 'INVALID_TOTAL', 400);
    await storage.setTotal(Order, id, total, session);
    order.total = total; // Persisted and returned values must agree.
  };
  api.connect(null, Customer, 'customer', 'customers', {
    onSaving(record, args, session, context) { writer(context); record.tenantId = identity(context).tenantId; },
  });
  api.connect(null, Order, 'order', 'orders', {
    async onSaving(record, args, session, context) {
      writer(context);
      record.tenantId = identity(context).tenantId;
      await owned(Customer, record.customerId, session, context);
    },
    async onUpdating(id, changes, session, context) {
      await editable(id, session, context);
      if (changes.$unset?.customerId) throw new auth.ForbiddenError();
      if (Object.hasOwn(changes, 'customerId')) await owned(Customer, changes.customerId, session, context);
    },
    onSaved: (order, args, session) => refresh(order, session),
    onUpdated: (order, session) => refresh(order, session),
  }, null, {
    initialState: State.getValue('DRAFT'),
    actions: { approve: { from: State.getValue('DRAFT'), to: State.getValue('APPROVED') } },
  });
  api.connect(null, Line, 'line', 'lines', {
    async onSaving(line, args, session, context) {
      const parent = await editable(line.orderId, session, context);
      line.tenantId = parent.tenantId;
      priceLine(line);
    },
    async onUpdating(id, changes, session, context) {
      const current = await owned(Line, id, session, context);
      await editable(current.orderId, session, context);
      const effective = { ...current, ...changes };
      priceLine(effective);
      changes.unitPrice = effective.unitPrice;
    },
    async onDelete(line, session, context) {
      if (line) await editable(line.orderId, session, context);
    },
  });
  // Lines can change only through their parent, ensuring its total is refreshed.
  const schema = api.createSchema(null, [Customer, Order]);
  const read = auth.composeRules(auth.requireAuth(), auth.requirePermission('orders:read'));
  const write = auth.composeRules(auth.requireAuth(), auth.requirePermission('orders:write'));
  const permissions = {
    RootQueryType: { '*': read },
    Mutation: { addcustomer: write, addorder: write, updateorder: write,
      approve_order: auth.composeRules(write, auth.requirePermission('orders:approve')) },
    SkillCustomer: { '*': auth.allow() }, SkillOrder: { '*': auth.allow() },
    SkillLine: { '*': auth.allow() }, QLTypeAggregationResult: { '*': auth.allow() },
  };
  // Standalone execution needs this hook; Yoga can install this plugin instead.
  auth.createAuthPlugin(permissions, { defaultPolicy: 'DENY' }).onSchemaChange({ schema });
  return { schema, types: { Customer, Order, Line } };
}

export const operations = {
  customer: 'mutation($name: String!) { addcustomer(input: { name: $name }) { id } }',
  create: 'mutation($input: SkillOrderInput!) { addorder(input: $input) { id label total state lines { id quantity unitPrice } } }',
  update: 'mutation($input: SkillOrderInputForUpdate!) { updateorder(input: $input) { id total } }',
  read: 'query($id: ID!) { order(id: $id) { id label total state customer { id } lines { id quantity unitPrice } } }',
  list: `query($page: Int!) { orders(OR: [
    { conditions: [{ field: "tenantId", operator: EQ, value: "A" }] },
    { conditions: [{ field: "tenantId", operator: EQ, value: "B" }] }
  ], sort: { terms: [{ field: "label", order: ASC }] }, pagination: { page: $page, size: 2, count: true }) { id label } }`,
  report: 'query { orders_aggregate(aggregation: { groupId: "tenantId", facts: [{ operation: SUM, factName: "total", path: "total" }] }) { groupId facts } }',
  approve: 'mutation($id: ID!) { approve_order(input: { id: $id }) { id state } }',
};
