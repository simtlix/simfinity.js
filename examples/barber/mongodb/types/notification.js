import { protect } from '../auth/ownership.js';
import * as graphql from 'graphql';
import * as simfinity from '@simtlix/simfinity-js';
import { notificationScopes } from './notification.scopes.js';
import { notificationController } from './notification.controller.js';

const {
  GraphQLObjectType,
  GraphQLID,
  GraphQLString,
  GraphQLBoolean,
  GraphQLNonNull,
} = graphql;

const notificationType = new GraphQLObjectType({
  name: 'notification',
  description: 'A system notification addressed to a single user.',
  extensions: {
    scope: notificationScopes,
  },
  fields: () => ({
    id: { type: GraphQLID, description: 'Unique identifier of the notification.' },
    title: { type: new GraphQLNonNull(GraphQLString), description: 'Short headline of the notification.' },
    body: { type: GraphQLString, description: 'Full message body.' },
    read: { type: GraphQLBoolean, description: 'Whether the recipient has read the notification.' },
    channel: {
      type: GraphQLString,
      description: "Delivery channel used (e.g. 'email', 'whatsapp', 'push', 'in_app').",
    },
    user: {
      type: simfinity.getType('user'),
      description: 'The recipient of the notification.',
      extensions: { relation: { connectionField: 'user', displayField: 'email' } },
    },
    createdAt: { type: GraphQLString, description: 'Timestamp when the notification was created.' },
  }),
});

export default notificationType;
simfinity.connect(null, notificationType, 'notification', 'notifications', protect('notification', notificationController), null, null);
