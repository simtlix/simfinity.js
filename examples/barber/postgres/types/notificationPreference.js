import { protect } from '../auth/ownership.js';
import * as graphql from 'graphql';
import * as simfinity from '@simtlix/simfinity-postgres';
import { notificationPreferenceScopes } from './notificationPreference.scopes.js';

const {
  GraphQLObjectType,
  GraphQLID,
  GraphQLString,
  GraphQLBoolean,
} = graphql;

const notificationPreferenceType = new GraphQLObjectType({
  name: 'notificationPreference',
  description: "A user's preferences for which channels are used to deliver notifications.",
  extensions: {
    scope: notificationPreferenceScopes,
  },
  fields: () => ({
    id: { type: GraphQLID, description: 'Unique identifier of the preference record.' },
    emailEnabled: { type: GraphQLBoolean, description: 'Whether email notifications are enabled.' },
    whatsappEnabled: { type: GraphQLBoolean, description: 'Whether WhatsApp notifications are enabled.' },
    pushEnabled: { type: GraphQLBoolean, description: 'Whether push notifications are enabled.' },
    user: {
      type: simfinity.getType('user'),
      description: 'The user these preferences belong to.',
      extensions: { relation: { connectionField: 'user', displayField: 'email' } },
    },
  }),
});

export default notificationPreferenceType;
simfinity.connect(
  null,
  notificationPreferenceType,
  'notificationPreference',
  'notificationPreferences',
  protect('notificationPreference'),
  null,
  null
);
