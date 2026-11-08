class Logger {
  isDevelopment;
  logLevel;
  constructor() {
    this.isDevelopment = process.env.NODE_ENV !== "production";
    this.logLevel = this.getLogLevel();
  }
  /**
   * Determines the appropriate log level based on environment
   * @returns {LogLevel} The configured log level
   */
  getLogLevel() {
    const envLevel = process.env.LOG_LEVEL?.toLowerCase();
    if (envLevel === "debug" || envLevel === "info" || envLevel === "warn" || envLevel === "error") {
      return envLevel;
    }
    return this.isDevelopment ? "debug" : "info";
  }
  /**
   * Formats timestamp for log output
   * @returns {string} Formatted timestamp
   */
  getTimestamp() {
    return (/* @__PURE__ */ new Date()).toLocaleTimeString("en-US", {
      hour: "numeric",
      minute: "2-digit",
      second: "2-digit",
      hour12: true
    });
  }
  /**
   * Determines if a log should be output based on current log level
   * @param {LogLevel} level - The level of the log message
   * @returns {boolean} Whether the log should be output
   */
  shouldLog(level) {
    const levels = ["debug", "info", "warn", "error"];
    return levels.indexOf(level) >= levels.indexOf(this.logLevel);
  }
  /**
   * Formats and outputs a log message
   * @param {LogLevel} level - The severity level
   * @param {string} message - The log message
   * @param {any} data - Optional data to log
   * @param {string} source - Optional source identifier
   */
  log(level, message, data, source) {
    if (!this.shouldLog(level)) {
      return;
    }
    const logMessage = {
      timestamp: this.getTimestamp(),
      level,
      message,
      data,
      source
    };
    const formattedMessage = this.isDevelopment ? this.formatDevelopmentLog(logMessage) : this.formatProductionLog(logMessage);
    switch (level) {
      case "error":
        console.error(formattedMessage);
        break;
      case "warn":
        console.warn(formattedMessage);
        break;
      default:
        console.log(formattedMessage);
    }
  }
  /**
   * Formats log message for development environment
   * @param {LogMessage} logMessage - The log message object
   * @returns {string} Formatted log string
   */
  formatDevelopmentLog(logMessage) {
    const { timestamp, level, message, data, source } = logMessage;
    const levelPrefix = {
      debug: "[DEBUG]",
      info: "[INFO] ",
      warn: "[WARN] ",
      error: "[ERROR]"
    };
    let formatted = `${timestamp} ${levelPrefix[level]}`;
    if (source) {
      formatted += ` [${source}]`;
    }
    formatted += ` ${message}`;
    if (data !== void 0) {
      formatted += `
${JSON.stringify(data, null, 2)}`;
    }
    return formatted;
  }
  /**
   * Formats log message for production environment
   * @param {LogMessage} logMessage - The log message object
   * @returns {string} JSON formatted log string
   */
  formatProductionLog(logMessage) {
    return JSON.stringify(logMessage);
  }
  /**
   * Log debug message (development only)
   * @param {string} message - The debug message
   * @param {any} data - Optional data
   * @param {string} source - Optional source
   */
  debug(message, data, source) {
    this.log("debug", message, data, source);
  }
  /**
   * Log info message
   * @param {string} message - The info message
   * @param {any} data - Optional data
   * @param {string} source - Optional source
   */
  info(message, data, source) {
    this.log("info", message, data, source);
  }
  /**
   * Log warning message
   * @param {string} message - The warning message
   * @param {any} data - Optional data
   * @param {string} source - Optional source
   */
  warn(message, data, source) {
    this.log("warn", message, data, source);
  }
  /**
   * Log error message
   * @param {string} message - The error message
   * @param {any} error - Optional error object or data
   * @param {string} source - Optional source
   */
  error(message, error, source) {
    this.log("error", message, error, source);
  }
  /**
   * Log HTTP request/response
   * @param {string} method - HTTP method
   * @param {string} path - Request path
   * @param {number} statusCode - Response status code
   * @param {number} duration - Request duration in ms
   * @param {any} response - Optional response data
   */
  http(method, path, statusCode, duration, response) {
    if (path.startsWith("/api")) {
      let logLine = `${method} ${path} ${statusCode} in ${duration}ms`;
      if (response && this.isDevelopment) {
        const responseStr = JSON.stringify(response);
        if (responseStr.length > 80) {
          logLine += ` :: ${responseStr.slice(0, 79)}\u2026`;
        } else {
          logLine += ` :: ${responseStr}`;
        }
      }
      this.info(logLine, void 0, "HTTP");
    }
  }
}
const logger = new Logger();
export {
  logger
};
