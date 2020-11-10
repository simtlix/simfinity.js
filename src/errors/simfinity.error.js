class SimfinityError extends Error {
  constructor(message, code, status) {
    super(message);
    this.extensions = {
      code,
      status,
      timestamp: new Date().toUTCString(),
    };
    this.getCode = () => this.extensions.code;
    this.getStatus = () => this.extensions.status;
    this.getTimestamp = () => this.extensions.timestamp;
  }
}

module.exports = SimfinityError;
