import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { GraphQLID, GraphQLList, GraphQLNonNull, GraphQLObjectType, GraphQLString, graphql } from 'graphql';
import pg from 'pg';
import { createPostgres } from '../../packages/postgres/src/index.js';
import { createFunctionSQL } from '../../packages/postgres/src/schema/ddl.js';

const uri = process.env.SIMFINITY_POSTGRES_URI;
const embedded = { relation: { embedded: true } };
const reference = { relation: { embedded: false } };
const pick = (fields, names) => Object.fromEntries(names.map((name) => [name, fields[name]]));

// Owned tables are queried through LATERAL (stored rows UNION ALL a null row). A migration that
// adds a field appends its columns, so the physical order no longer follows the field order.
describe.skipIf(!uri)('PostgreSQL owned tables whose physical column order differs from the description', () => {
  let pool;
  const schemas = [];
  beforeAll(() => { pool = new pg.Pool({ connectionString: uri }); });
  afterAll(async () => {
    for (const name of schemas) await pool.query(`DROP SCHEMA IF EXISTS "${name}" CASCADE`);
    await pool.end();
  });

  const runtime = (schema, order, itemRequired) => {
    const list = (type) => new GraphQLList(itemRequired ? new GraphQLNonNull(type) : type);
    const Star = new GraphQLObjectType({ name: 'OrderStar', fields: { id: { type: GraphQLID }, name: { type: GraphQLString } } });
    const Credit = new GraphQLObjectType({ name: 'OrderCredit', fields: pick({
      role: { type: GraphQLString }, note: { type: GraphQLString }, star: { type: Star, extensions: reference },
    }, order.credit) });
    const Detail = new GraphQLObjectType({ name: 'OrderDetail', fields: pick({
      tag: { type: GraphQLString }, memo: { type: GraphQLString }, star: { type: Star, extensions: reference },
    }, order.detail) });
    const Season = new GraphQLObjectType({ name: 'OrderSeason', fields: pick({
      number: { type: GraphQLString }, label: { type: GraphQLString },
      detail: { type: Detail, extensions: embedded }, credits: { type: list(Credit), extensions: embedded },
    }, order.season) });
    const Serie = new GraphQLObjectType({ name: 'OrderSerie', fields: {
      id: { type: GraphQLID }, title: { type: GraphQLString },
      credits: { type: list(Credit), extensions: embedded }, seasons: { type: list(Season), extensions: embedded },
    } });
    const api = createPostgres({ pool, schema });
    api.connect(null, Star, 'orderStar', 'orderStars');
    api.connect(null, Serie, 'orderSerie', 'orderSeries');
    for (const type of [Credit, Detail, Season]) api.addNoEndpointType(type);
    const gql = api.createSchema();
    const run = async (source) => {
      const result = await graphql({ schema: gql, source, contextValue: {} });
      expect(result.errors, source).toBeUndefined();
      return result.data;
    };
    return { api, run };
  };

  // An explicit migration brings every generated object in line with the new description: it adds the
  // new columns (PostgreSQL appends them) and replaces generated functions whose bodies changed.
  const migrate = async (schema, before, after) => {
    for (const table of after.tables) {
      const previous = before.tables.find((item) => item.name === table.name);
      for (const column of table.columns.filter((item) => !previous.columns.some((old) => old.name === item.name))) {
        await pool.query(`ALTER TABLE "${schema}"."${table.name}" ADD COLUMN "${column.name}" ${column.type}${column.collation ? ` COLLATE "${column.collation}"` : ''}${column.nullable ? '' : ' NOT NULL'}${column.default ? ` DEFAULT ${column.default}` : ''}`);
      }
    }
    for (const fn of after.functions.filter((item) => before.functions.find((old) => old.name === item.name)?.body !== item.body)) {
      await pool.query(createFunctionSQL(schema, fn).replace('CREATE FUNCTION', 'CREATE OR REPLACE FUNCTION'));
    }
  };
  const physicalColumns = async (schema, table) => (await pool.query(`SELECT a.attname FROM pg_attribute a
    WHERE a.attrelid = $1::regclass AND a.attnum > 0 AND NOT a.attisdropped ORDER BY a.attnum`, [`"${schema}"."${table}"`])).rows.map((row) => row.attname);

  const sorted = 'sort:{terms:[{field:"title",order:ASC}]}';
  const filter = (field, path, value, operator = 'EQ') => `{orderSeries(${field}:{terms:[{path:"${path}",operator:${operator},value:"${value}"}]},${sorted}){title}}`;
  const queries = [
    filter('credits', 'role', 'lead'),
    filter('credits', 'role', 'lead', 'NE'),
    '{orderSeries(credits:{terms:[{path:"star.name",operator:EQ,value:"Ann"}]},pagination:{page:1,size:10,count:true}){title}}',
    '{orderSeries(sort:{terms:[{field:"credits.role",order:DESC},{field:"title",order:ASC}]}){title}}',
    '{orderSeries_aggregate(aggregation:{groupId:"credits.star.name",facts:[{operation:COUNT,factName:"n",path:"id"}]},sort:{terms:[{field:"groupId",order:ASC}]}){groupId facts}}',
    filter('seasons', 'credits.role', 'lead'),
    filter('seasons', 'credits.star.name', 'Ann'),
    filter('seasons', 'number', '1'),
    filter('seasons', 'detail.tag', 't1'),
    filter('seasons', 'detail.star.name', 'Ann'),
    '{orderSeries(seasons:{terms:[{path:"credits.role",operator:EQ,value:"extra"}]},pagination:{page:1,size:10,count:true}){title}}',
    '{orderSeries(sort:{terms:[{field:"seasons.credits.role",order:DESC},{field:"title",order:ASC}]}){title}}',
    '{orderSeries_aggregate(aggregation:{groupId:"seasons.credits.star.name",facts:[{operation:COUNT,factName:"n",path:"id"}]},sort:{terms:[{field:"groupId",order:ASC}]}){groupId facts}}',
  ];
  const migrated = ['OrderSerie__credits', 'OrderSerie__seasons', 'OrderSerie__seasons__credits', 'OrderSerie__seasons__detail'];

  it.each([true, false])('keeps filter, sort, count and aggregate results after appended columns and reordered fields (item required: %s)', async (itemRequired) => {
    const schema = `column_order_${randomUUID().replaceAll('-', '')}`;
    schemas.push(schema);
    const v1 = runtime(schema, { credit: ['role', 'star'], detail: ['tag', 'star'], season: ['number', 'detail', 'credits'] }, itemRequired);
    await v1.api.initializeDatabase();
    const star = (await v1.run('mutation{addorderStar(input:{name:"Ann"}){id}}')).addorderStar.id;
    await v1.run(`mutation{addorderSerie(input:{title:"A",credits:[{role:"lead",star:{id:"${star}"}}],seasons:[{number:"1",detail:{tag:"t1",star:{id:"${star}"}},credits:[{role:"lead",star:{id:"${star}"}}]}]}){id}}`);
    await v1.run('mutation{addorderSerie(input:{title:"B",credits:[{role:"extra"}],seasons:[{number:"2",credits:[{role:"extra"}]}]}){id}}');
    await v1.run('mutation{addorderSerie(input:{title:"C",credits:[],seasons:[]}){id}}');
    await v1.run('mutation{addorderSerie(input:{title:"D"}){id}}');
    if (!itemRequired) await v1.run('mutation{addorderSerie(input:{title:"E",credits:[null],seasons:[null,{number:"3",credits:[null]}]}){id}}');
    const expected = [];
    for (const source of queries) expected.push(await v1.run(source));
    expect(expected[0].orderSeries).toEqual([{ title: 'A' }]);
    expect(expected[6].orderSeries).toEqual([{ title: 'A' }]);
    expect(expected[9].orderSeries).toEqual([{ title: 'A' }]);

    // Fields inserted mid-type: PostgreSQL appends their columns.
    const v2 = runtime(schema, { credit: ['role', 'note', 'star'], detail: ['tag', 'memo', 'star'], season: ['number', 'label', 'detail', 'credits'] }, itemRequired);
    await migrate(schema, v1.api.describeDatabase(), v2.api.describeDatabase());
    await expect(v2.api.initializeDatabase({ mode: 'validate' })).resolves.toEqual({ mode: 'validate', created: [] });
    for (const name of migrated) {
      const table = v2.api.describeDatabase().tables.find((item) => item.name === name);
      const physical = await physicalColumns(schema, name);
      expect([...physical].sort()).toEqual(table.columns.map((column) => column.name).sort());
      expect(physical, name).not.toEqual(table.columns.map((column) => column.name));
    }
    for (const [index, source] of queries.entries()) expect(await v2.run(source), source).toEqual(expected[index]);

    // Reordered fields change only the description's column order (and generated function bodies).
    const v3 = runtime(schema, { credit: ['star', 'note', 'role'], detail: ['star', 'memo', 'tag'], season: ['credits', 'detail', 'label', 'number'] }, itemRequired);
    await migrate(schema, v2.api.describeDatabase(), v3.api.describeDatabase());
    await expect(v3.api.initializeDatabase({ mode: 'validate' })).resolves.toEqual({ mode: 'validate', created: [] });
    for (const name of migrated) {
      const table = v3.api.describeDatabase().tables.find((item) => item.name === name);
      expect(await physicalColumns(schema, name), name).not.toEqual(table.columns.map((column) => column.name));
    }
    for (const [index, source] of queries.entries()) expect(await v3.run(source), source).toEqual(expected[index]);
  });
});
