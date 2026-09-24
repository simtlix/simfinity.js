import assert from 'node:assert/strict';
import mongoose from 'mongoose';

// GHSA-664h-wqgq-64gw: casting must not mutate Object.prototype, even if it throws.
// Run in a subprocess so a vulnerable dependency cannot poison other tests.
const Model = mongoose.model('UpdateSecurity', new mongoose.Schema({ name: String }));
const before = Object.getOwnPropertyDescriptors(Object.prototype);
try {
  Model.updateOne({}, {})._castUpdate(JSON.parse('{"$set":{"__proto__.x":"value"}}'));
} catch {
  // Rejection is acceptable; prototype pollution is not.
}
assert.deepEqual(Object.getOwnPropertyDescriptors(Object.prototype), before);
