import * as graphql from 'graphql';

const { GraphQLEnumType } = graphql;

export const PaymentMethodEnum = new GraphQLEnumType({
  name: 'PaymentMethod',
  values: {
    ON_SITE: { value: 'ON_SITE' },
  },
});

export const BookingStateEnum = new GraphQLEnumType({
  name: 'BookingState',
  values: {
    CONFIRMED: { value: 'CONFIRMED' },
    COMPLETED: { value: 'COMPLETED' },
    CANCELLED_BY_CLIENT: { value: 'CANCELLED_BY_CLIENT' },
    CANCELLED_BY_SHOP: { value: 'CANCELLED_BY_SHOP' },
    NO_SHOW: { value: 'NO_SHOW' },
  },
});

export const bookingStateMachine = {
  initialState: BookingStateEnum.getValue('CONFIRMED'),
  actions: {
    complete: {
      description:
        'Mark a confirmed booking as completed after the service was delivered (CONFIRMED -> COMPLETED). Performed by the barbershop.',
      from: BookingStateEnum.getValue('CONFIRMED'),
      to: BookingStateEnum.getValue('COMPLETED'),
    },
    cancelbyclient: {
      description:
        'Cancel a confirmed booking on behalf of the client (CONFIRMED -> CANCELLED_BY_CLIENT). May incur a fee per the cancellation policy.',
      from: BookingStateEnum.getValue('CONFIRMED'),
      to: BookingStateEnum.getValue('CANCELLED_BY_CLIENT'),
    },
    cancelbyshop: {
      description:
        'Cancel a confirmed booking on behalf of the barbershop (CONFIRMED -> CANCELLED_BY_SHOP).',
      from: BookingStateEnum.getValue('CONFIRMED'),
      to: BookingStateEnum.getValue('CANCELLED_BY_SHOP'),
    },
    noshow: {
      description:
        'Mark a confirmed booking as a no-show when the client did not attend (CONFIRMED -> NO_SHOW). Performed by the barbershop.',
      from: BookingStateEnum.getValue('CONFIRMED'),
      to: BookingStateEnum.getValue('NO_SHOW'),
    },
  },
};
