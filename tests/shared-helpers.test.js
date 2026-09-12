import { describe, expect, it } from 'vitest';
import * as mongo from '../src/index.js';
import * as postgres from '../packages/postgres/src/index.js';
import * as core from '../packages/core/src/index.js';

describe('shared helper facades', () => {
  it('preserves one helper identity across core and both database facades', () => {
    expect(postgres.auth.createAuthPlugin).toBe(mongo.auth.createAuthPlugin);
    expect(postgres.scalars.EmailScalar).toBe(mongo.scalars.EmailScalar);
    expect(postgres.validators.email).toBe(mongo.validators.email);
    expect(postgres.plugins.envelopCountPlugin).toBe(mongo.plugins.envelopCountPlugin);
    expect(postgres.auth).toBe(core.auth);
    expect(postgres.scalars).toBe(core.scalars);
    expect(postgres.validators).toBe(core.validators);
    expect(postgres.plugins).toBe(core.plugins);
  });

  it('exposes the shared helpers on PostgreSQL instances', () => {
    const instance = postgres.createPostgres();

    expect(instance.auth).toBeDefined();
    expect(instance.scalars).toBeDefined();
    expect(instance.validators).toBeDefined();
    expect(instance.plugins).toBeDefined();
    expect(instance.auth).toBe(postgres.auth);
    expect(instance.scalars).toBe(postgres.scalars);
    expect(instance.validators).toBe(postgres.validators);
    expect(instance.plugins).toBe(postgres.plugins);
  });
});
