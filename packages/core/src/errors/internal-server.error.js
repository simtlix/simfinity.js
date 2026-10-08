import SimfinityError from './simfinity.error.js';

// An unexpected failure: code INTERNAL_SERVER_ERROR and status 500. `cause` keeps the original error.
// The cause is never included in GraphQL responses, or in the errors that buildErrorFormatter returns
// when they are serialized. It is an enumerable own property of this error, so JSON.stringify(error),
// or a logger that copies enumerable properties, includes it.
class InternalServerError extends SimfinityError {
  constructor(message, cause) {
    super(message, 'INTERNAL_SERVER_ERROR', 500);
    this.cause = cause;
    this.getCause = () => this.cause;
  }
}

export default InternalServerError;
