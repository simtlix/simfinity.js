import { describe, it, expect, vi } from 'vitest';
import mongoose from 'mongoose';

// In-memory records read by protect(): the shops and their owners, bookings and reviews.
const store = vi.hoisted(() => ({
  barbershop: {
    shop: { _id: 'shop', owner: 'owner', state: 'APPROVED' },
    'other-shop': { _id: 'other-shop', owner: 'other' },
    'empty-shop': { _id: 'empty-shop', owner: 'owner' },
    'reviewed-shop': { _id: 'reviewed-shop', owner: 'owner' },
  },
  service: { service: { _id: 'service', barbershop: 'other-shop' } },
  booking: {
    completed: { _id: 'completed', client: 'client', barbershop: 'shop', state: 'COMPLETED' },
    confirmed: { _id: 'confirmed', client: 'client', barbershop: 'shop', state: 'CONFIRMED' },
  },
  review: {
    answered: { _id: 'answered', client: 'client', barbershop: 'shop', booking: 'completed', rating: 3, comment: 'Ok', reply: 'Thanks', isReported: true },
    plain: { _id: 'plain', client: 'client', barbershop: 'shop', booking: 'other-booking', rating: 5, comment: null, reply: null, isReported: null },
    legacy: { _id: 'legacy', client: 'client', barbershop: 'reviewed-shop', rating: 4 },
  },
}));
vi.mock('@simtlix/simfinity-js', () => ({
  auth: { ForbiddenError: class ForbiddenError extends Error { constructor(message) { super(message); this.code = 'FORBIDDEN'; } } },
  SimfinityError: class SimfinityError extends Error { constructor(message, code, status) { super(message); this.extensions = { code, status }; } },
  getType: (name) => name,
  getModel: (name) => ({
    findById: (id) => ({ session: async () => (name === 'user' ? { id, role: 'CLIENT' } : store[name]?.[id] ?? null) }),
    exists: (filter) => ({
      session: async () => Object.values(store[name] ?? {}).find((row) => Object.entries(filter).every(([key, value]) => row[key] === value)) ?? null,
    }),
  }),
}));
const { protect } = await import('../auth/ownership.js');
const client = { user: { id: 'client', roles: ['CLIENT'] } };
const owner = { user: { id: 'owner', roles: ['OWNER'] } };
const otherOwner = { user: { id: 'other-owner', roles: ['OWNER'] } };
const admin = { user: { id: 'admin', roles: ['PLATFORM_ADMIN'] } };
const review = protect('review');
const booking = protect('booking');
const FORBIDDEN = { code: 'FORBIDDEN' };
const ownerValues = { reply: 'Owner: we overcharge everyone', isReported: false };
const db = {};

it('rejects self privilege escalation', async () => {
  await expect(protect('user').onUpdating('client', { role: 'PLATFORM_ADMIN' }, {}, client)).rejects.toMatchObject(FORBIDDEN);
});
it('rejects another user update', async () => {
  await expect(protect('user').onUpdating('other', { name: 'attack' }, {}, client)).rejects.toMatchObject(FORBIDDEN);
});
it('rejects another owner service update', async () => {
  await expect(protect('service').onUpdating('service', { name: 'attack' }, {}, owner)).rejects.toMatchObject(FORBIDDEN);
});

describe('review fields (#57)', () => {
  it.each(Object.entries(ownerValues))('rejects an author writing %s on create', async (field, value) => {
    await expect(review.onSaving({ rating: 1, client: 'client', barbershop: 'shop', [field]: value }, {}, {}, client)).rejects.toMatchObject(FORBIDDEN);
  });
  it.each(Object.entries(ownerValues))('rejects an author writing %s on update', async (field, value) => {
    await expect(review.onUpdating('answered', { id: 'answered', [field]: value }, {}, client)).rejects.toMatchObject(FORBIDDEN);
  });
  it.each(['reply', 'isReported'])('rejects an author clearing %s', async (field) => {
    await expect(review.onUpdating('answered', { id: 'answered', $unset: { [field]: '' } }, {}, client)).rejects.toMatchObject(FORBIDDEN);
  });
  it('reads a Mongoose create document through toObject()', async () => {
    // Mongoose documents keep their fields behind getters, so only toObject() lists them.
    const Review = mongoose.models.OwnershipReview ?? mongoose.model('OwnershipReview', new mongoose.Schema({
      rating: Number, client: String, barbershop: String, booking: String, reply: String, isReported: Boolean,
    }));
    const values = { rating: 1, client: 'client', barbershop: 'shop', booking: 'completed' };
    await expect(review.onSaving(new Review({ ...values, reply: 'Forged owner reply' }), {}, {}, client)).rejects.toMatchObject(FORBIDDEN);
    await expect(review.onSaving(new Review(values), {}, {}, client)).resolves.toBeUndefined();
  });
  it('lets an author edit the rating and comment', async () => {
    await expect(review.onUpdating('answered', { id: 'answered', rating: 4, comment: 'Better' }, {}, client)).resolves.toBeUndefined();
    await expect(review.onUpdating('answered', { id: 'answered', $unset: { comment: '' } }, {}, client)).resolves.toBeUndefined();
  });
  it('lets an author resend the stored reply, flag and booking unchanged', async () => {
    await expect(review.onUpdating('answered', { id: 'answered', rating: 2, reply: 'Thanks', isReported: true, booking: 'completed', barbershop: 'shop', client: 'client' }, {}, client)).resolves.toBeUndefined();
    await expect(review.onUpdating('plain', { id: 'plain', $unset: { reply: '', isReported: '' } }, {}, client)).resolves.toBeUndefined();
  });
  it('rejects an author moving the review to another booking or clearing it', async () => {
    await expect(review.onUpdating('answered', { id: 'answered', booking: 'confirmed' }, {}, client)).rejects.toMatchObject(FORBIDDEN);
    await expect(review.onUpdating('answered', { id: 'answered', $unset: { booking: '' } }, {}, client)).rejects.toMatchObject(FORBIDDEN);
  });
  it('rejects an author clearing the review client', async () => {
    await expect(review.onUpdating('answered', { id: 'answered', $unset: { client: '' } }, {}, client)).rejects.toMatchObject(FORBIDDEN);
  });
  it('lets only an admin delete a review', async () => {
    await expect(review.onDelete(store.review.answered, {}, client)).rejects.toMatchObject(FORBIDDEN);
    await expect(review.onDelete(store.review.answered, {}, owner)).rejects.toMatchObject(FORBIDDEN);
    await expect(review.onDelete(store.review.answered, {}, admin)).resolves.toBeUndefined();
  });
  it('lets the shop owner reply, withdraw the reply and flag the review', async () => {
    await expect(review.onUpdating('answered', { id: 'answered', reply: 'Sorry' }, {}, owner)).resolves.toBeUndefined();
    await expect(review.onUpdating('answered', { id: 'answered', $unset: { reply: '' } }, {}, owner)).resolves.toBeUndefined();
    await expect(review.onUpdating('plain', { id: 'plain', isReported: true }, {}, owner)).resolves.toBeUndefined();
    // updatebarbershop(reviews: { updated }) links the review to the shop it already belongs to.
    await expect(review.onUpdating('plain', { id: 'plain', reply: 'Nested', isReported: true, barbershop: 'shop' }, {}, owner)).resolves.toBeUndefined();
  });
  it('lets the shop owner resend unchanged review fields', async () => {
    await expect(review.onUpdating('answered', { id: 'answered', rating: 3, comment: 'Ok', isReported: true, reply: 'Updated' }, {}, owner)).resolves.toBeUndefined();
  });
  it('rejects the shop owner clearing the flag or editing the review', async () => {
    for (const changes of [{ isReported: false }, { $unset: { isReported: '' } }, { rating: 5 }, { comment: 'Edited' }, { client: 'owner' }, { booking: 'confirmed' }]) {
      await expect(review.onUpdating('answered', { id: 'answered', ...changes }, {}, owner)).rejects.toMatchObject(FORBIDDEN);
    }
  });
  it('rejects another owner flagging the review', async () => {
    await expect(review.onUpdating('plain', { id: 'plain', isReported: true }, {}, otherOwner)).rejects.toMatchObject(FORBIDDEN);
  });
  it('lets an admin clear the flag', async () => {
    await expect(review.onUpdating('answered', { id: 'answered', isReported: false }, {}, admin)).resolves.toBeUndefined();
  });
});

describe('booking guard (#58)', () => {
  it.each([['client', client], ['shop owner', owner], ['admin', admin]])('rejects the %s clearing the barbershop', async (_name, context) => {
    await expect(booking.onUpdating('confirmed', { id: 'confirmed', $unset: { barbershop: '' } }, {}, context)).rejects.toMatchObject(FORBIDDEN);
  });
  it('rejects a client clearing the client of their booking, but not the shop owner', async () => {
    await expect(booking.onUpdating('confirmed', { id: 'confirmed', $unset: { client: '' } }, {}, client)).rejects.toMatchObject(FORBIDDEN);
    await expect(booking.onUpdating('confirmed', { id: 'confirmed', $unset: { client: '' } }, {}, owner)).resolves.toBeUndefined();
  });
  it.each(['confirmed', 'completed'])('rejects a client deleting their own %s booking', async (id) => {
    await expect(booking.onDelete(store.booking[id], {}, client)).rejects.toMatchObject(FORBIDDEN);
  });
  it('lets the shop owner and an admin delete a booking', async () => {
    await expect(booking.onDelete(store.booking.confirmed, db, owner)).resolves.toBeUndefined();
    await expect(booking.onDelete(store.booking.completed, db, admin)).resolves.toBeUndefined();
  });
  it('still lets a client edit notes on their booking', async () => {
    await expect(booking.onUpdating('confirmed', { id: 'confirmed', notes: 'Late' }, {}, client)).resolves.toBeUndefined();
  });
});

// perm-1: deletes that would leave records pointing at nothing (MongoDB has no foreign keys).
describe('deletes of referenced records', () => {
  const barbershop = protect('barbershop');
  const IN_USE = { extensions: { code: 'RESOURCE_IN_USE', status: 409 } };
  it.each([['bookings and reviews', 'shop'], ['only a review', 'reviewed-shop']])('refuses the owner deleting a shop that has %s', async (_case, id) => {
    await expect(barbershop.onDelete(store.barbershop[id], db, owner)).rejects.toMatchObject(IN_USE);
  });
  it('lets the owner delete a shop that nothing references, and an admin any shop', async () => {
    await expect(barbershop.onDelete(store.barbershop['empty-shop'], db, owner)).resolves.toBeUndefined();
    await expect(barbershop.onDelete(store.barbershop.shop, db, admin)).resolves.toBeUndefined();
  });
  it('answers FORBIDDEN, not RESOURCE_IN_USE, to another owner', async () => {
    await expect(barbershop.onDelete(store.barbershop.shop, db, otherOwner)).rejects.toMatchObject(FORBIDDEN);
    await expect(booking.onDelete(store.booking.completed, db, otherOwner)).rejects.toMatchObject(FORBIDDEN);
  });
  it('refuses the shop owner deleting a booking that a review references', async () => {
    await expect(booking.onDelete(store.booking.completed, db, owner)).rejects.toMatchObject(IN_USE);
  });
});
