const SimfinityError = require('./simfinity.error');

class InternalServerError extends SimfinityError {
  constructor(message, cause) {
    super(message, 'INTERNAL_SERVER_ERROR');
    this.cause = cause;
    this.getCause = () => this.cause;
  }
}

module.exports = InternalServerError;
