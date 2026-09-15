import * as graphql from 'graphql';

const { GraphQLEnumType } = graphql;

export const BarbershopStateEnum = new GraphQLEnumType({
  name: 'BarbershopState',
  values: {
    DRAFT: { value: 'DRAFT' },
    PENDING_REVIEW: { value: 'PENDING_REVIEW' },
    APPROVED: { value: 'APPROVED' },
    REJECTED: { value: 'REJECTED' },
    SUSPENDED: { value: 'SUSPENDED' },
  },
});

export const barbershopStateMachine = {
  initialState: BarbershopStateEnum.getValue('DRAFT'),
  actions: {
    submitforreview: {
      description:
        'Submit a DRAFT barbershop for platform review (DRAFT -> PENDING_REVIEW). Performed by the owner once the profile is complete.',
      from: BarbershopStateEnum.getValue('DRAFT'),
      to: BarbershopStateEnum.getValue('PENDING_REVIEW'),
    },
    resubmit: {
      description:
        'Resubmit a previously REJECTED barbershop for another review (REJECTED -> PENDING_REVIEW). Performed by the owner after addressing the rejection reason.',
      from: BarbershopStateEnum.getValue('REJECTED'),
      to: BarbershopStateEnum.getValue('PENDING_REVIEW'),
    },
    approve: {
      description:
        'Approve a barbershop under review, making it publicly visible to clients (PENDING_REVIEW -> APPROVED). Platform admin only.',
      from: BarbershopStateEnum.getValue('PENDING_REVIEW'),
      to: BarbershopStateEnum.getValue('APPROVED'),
    },
    reject: {
      description:
        'Reject a barbershop under review (PENDING_REVIEW -> REJECTED). Platform admin only; set rejectionReason to explain why.',
      from: BarbershopStateEnum.getValue('PENDING_REVIEW'),
      to: BarbershopStateEnum.getValue('REJECTED'),
    },
    suspend: {
      description:
        'Suspend an approved barbershop, hiding it from clients (APPROVED -> SUSPENDED). Platform admin only.',
      from: BarbershopStateEnum.getValue('APPROVED'),
      to: BarbershopStateEnum.getValue('SUSPENDED'),
    },
    reactivate: {
      description:
        'Reactivate a suspended barbershop, making it visible again (SUSPENDED -> APPROVED). Platform admin only.',
      from: BarbershopStateEnum.getValue('SUSPENDED'),
      to: BarbershopStateEnum.getValue('APPROVED'),
    },
  },
};
