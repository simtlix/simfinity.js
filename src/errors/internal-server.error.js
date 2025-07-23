import SimfinityError from './simfinity.error.js';

class InternalServerError extends SimfinityError {
  constructor(message, cause) {
    super(message, 'INTERNAL_SERVER_ERROR');
    this.cause = cause;
    this.getCause = () => this.cause;
  }
}

export default InternalServerError;
