import { describe, it, expect } from 'vitest';
import { barbershopStateMachine } from '../types/barbershop.stateMachine.js';

describe('barbershopStateMachine', () => {
  it('clears the rejection reason when the owner resubmits or an admin approves', async () => {
    for (const name of ['resubmit', 'approve']) {
      const args = { id: 'shop-1', rejectionReason: 'Missing licence' };
      await barbershopStateMachine.actions[name].action(args);
      expect(args).toEqual({ id: 'shop-1', rejectionReason: null });
    }
  });

  it('leaves the reason alone on the other transitions', () => {
    for (const name of ['submitforreview', 'reject', 'suspend', 'reactivate']) {
      expect(barbershopStateMachine.actions[name].action).toBeUndefined();
    }
  });
});
