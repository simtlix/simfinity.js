import { describe, it, expect, vi } from 'vitest';

vi.mock('@simtlix/simfinity-js', () => ({
  default: {},
  getType: vi.fn(),
  getModel: vi.fn(),
  connect: vi.fn(),
  addNoEndpointType: vi.fn(),
}));

const { applyNotificationCreatedAt } = await import('../types/notification.controller.js');

describe('applyNotificationCreatedAt', () => {
  it('sets createdAt when missing', () => {
    const doc = {};
    applyNotificationCreatedAt(doc);
    expect(doc.createdAt).toBeDefined();
    expect(typeof doc.createdAt).toBe('string');
  });

  it('preserves existing createdAt', () => {
    const doc = { createdAt: '2025-06-01T12:00:00.000Z' };
    applyNotificationCreatedAt(doc);
    expect(doc.createdAt).toBe('2025-06-01T12:00:00.000Z');
  });
});
