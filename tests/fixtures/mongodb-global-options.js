import assert from 'node:assert/strict';
import mongoose from 'mongoose';
import { GraphQLID, GraphQLObjectType, GraphQLString } from 'graphql';

// The application configures Mongoose and builds a model before the facade is evaluated.
const scenario = process.argv[2];
const settings = { throw: 'throw', true: true, unset: undefined };
assert.ok(Object.hasOwn(settings, scenario), `Unknown scenario ${scenario}`);
const expected = settings[scenario];
if (scenario !== 'unset') mongoose.set('strictQuery', expected);
const AppModel = mongoose.model('GlobalOptionsAppModel', new mongoose.Schema({ name: String }));
const optionsBefore = { ...mongoose.options };

const simfinity = await import('@simtlix/simfinity-js');

assert.equal(mongoose.get('strictQuery'), expected);
assert.deepEqual({ ...mongoose.options }, optionsBefore);

// The application's filters follow its own setting.
const castFilter = () => AppModel.find({ bogus: 1 }).cast();
if (expected === 'throw') assert.throws(castFilter, { name: 'StrictModeError' });
else assert.deepEqual(castFilter(), expected === true ? {} : { bogus: 1 });

// The facade registers its models on this same Mongoose instance, so the checks above are not
// observing an unrelated copy.
const FacadeType = new GraphQLObjectType({
  name: 'GlobalOptionsFacadeModel',
  fields: { id: { type: GraphQLID }, name: { type: GraphQLString } },
});
simfinity.preventCreatingCollection(true);
simfinity.connect(null, FacadeType, 'globaloptionsfacademodel', 'globaloptionsfacademodels');
simfinity.createSchema();
assert.ok(mongoose.modelNames().includes(FacadeType.name));
assert.equal(simfinity.getModel(FacadeType).base, mongoose);
assert.equal(mongoose.get('strictQuery'), expected);

console.log(`${scenario}: passed`);
