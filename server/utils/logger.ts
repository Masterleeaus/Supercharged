'use strict';
/**
 * ============================================================
 * © 2025 Diploy — a brand of Bisht Technologies Private Limited
 * Original Author: BTPL Engineering Team
 * Website: https://diploy.in
 * Contact: cs@diploy.in
 *
 * Distributed under the Envato / CodeCanyon License Agreement.
 * Licensed to the purchaser for use as defined by the
 * Envato Market (CodeCanyon) Regular or Extended License.
 *
 * You are NOT permitted to redistribute, resell, sublicense,
 * or share this source code, in whole or in part.
 * Respect the author's rights and Envato licensing terms.
 * ============================================================
 */
/**
 * Professional logging utility for AgentLabs platform
 * Provides structured logging with different log levels and environment awareness
 * 
 * Every message, source and data value is redacted before it is written.
 * The rule set is copied from server/workforce/runtime/redact.ts (redactForAudit).
 * It is copied, not imported, so the logger does not depend on the workforce module.
 *
 * Rules:
 * - A key matching SENSITIVE_KEY has its value replaced with REDACTED, whatever the value's type.
 * - Strings have bearer tokens, sk_/pk_ keys and eyJ-form JWTs replaced with REDACTED.
 * - Email addresses keep their first local-part character and their domain; the rest is masked.
 * - Card-like digit runs (13 to 19 digits) keep only the last 4 digits.
 * - Values nested deeper than MAX_DEPTH, and cyclic references, become TRUNCATED.
 * Free text is only checked against the string rules above. A bare OTP digit run inside a
 * message is not masked; OTP values must be kept out of messages at the call site.
 *
 * @module logger
 */

const LOG_REDACTED = '[redacted]';
const LOG_TRUNCATED = '[truncated]';

const LOG_MAX_DEPTH = 10;

const LOG_SENSITIVE_KEY = /(token|secret|password|api[_-]?key|authorization|cookie|session|credential|otp|code)/i;

const LOG_BEARER = /(?<=\bBearer\s+)[A-Za-z0-9._~+/-]+=*/gi;
const LOG_API_KEY = /\b(?:sk|pk)_[A-Za-z0-9_]{8,}/g;
const LOG_JWT = /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g;
const LOG_EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g;
const LOG_CARD = /(?<!\d)\d{13,19}(?!\d)/g;

const maskLogEmail = (email: string): string => {
  const at = email.indexOf('@');
  const local = email.slice(0, at);
  const domain = email.slice(at);
  return local.charAt(0) + '*'.repeat(local.length - 1) + domain;
};

const maskLogCard = (digits: string): string =>
  '*'.repeat(digits.length - 4) + digits.slice(-4);

const redactLogText = (text: string): string =>
  text
    .replace(LOG_BEARER, LOG_REDACTED)
    .replace(LOG_JWT, LOG_REDACTED)
    .replace(LOG_API_KEY, LOG_REDACTED)
    .replace(LOG_EMAIL, maskLogEmail)
    .replace(LOG_CARD, maskLogCard);

const walkForLog = (value: unknown, depth: number, ancestors: Set<object>): unknown => {
  if (depth > LOG_MAX_DEPTH) return LOG_TRUNCATED;
  if (typeof value === 'string') return redactLogText(value);
  if (value === null || typeof value !== 'object') return value;
  // Dates have no own enumerable keys; return them so JSON.stringify still writes the ISO string.
  if (value instanceof Date) return value;
  // Error message and stack are not own enumerable keys, so copy them out explicitly.
  // Without this, an Error logged as data would serialize as {}.
  if (value instanceof Error) {
    return walkForLog({ name: value.name, message: value.message, stack: value.stack, ...value }, depth, ancestors);
  }
  if (ancestors.has(value)) return LOG_TRUNCATED;

  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      return value.map((item) => walkForLog(item, depth + 1, ancestors));
    }
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value)) {
      const child = LOG_SENSITIVE_KEY.test(key)
        ? LOG_REDACTED
        : walkForLog((value as Record<string, unknown>)[key], depth + 1, ancestors);
      // defineProperty keeps a literal "__proto__" key as data instead of setting the prototype.
      Object.defineProperty(out, key, { value: child, enumerable: true, writable: true, configurable: true });
    }
    return out;
  } finally {
    ancestors.delete(value);
  }
};

/**
 * Returns a redacted copy of a log value. The input is not mutated.
 * @param {unknown} value - Any value passed to a log call
 * @returns {unknown} Redacted copy
 */
export function redactForLog(value: unknown): unknown {
  return walkForLog(value, 0, new Set<object>());
}

type LogLevel = 'debug' | 'info' | 'warn' | 'error';

interface LogMessage {
  timestamp: string;
  level: LogLevel;
  message: string;
  data?: any;
  source?: string;
}

/**
 * Logger class for structured application logging
 * Supports multiple log levels and environment-aware output
 */
class Logger {
  private isDevelopment: boolean;
  private logLevel: LogLevel;

  constructor() {
    this.isDevelopment = process.env.NODE_ENV !== 'production';
    this.logLevel = this.getLogLevel();
  }

  /**
   * Determines the appropriate log level based on environment
   * @returns {LogLevel} The configured log level
   */
  private getLogLevel(): LogLevel {
    const envLevel = process.env.LOG_LEVEL?.toLowerCase();
    if (envLevel === 'debug' || envLevel === 'info' || envLevel === 'warn' || envLevel === 'error') {
      return envLevel;
    }
    return this.isDevelopment ? 'debug' : 'info';
  }

  /**
   * Formats timestamp for log output
   * @returns {string} Formatted timestamp
   */
  private getTimestamp(): string {
    return new Date().toLocaleTimeString('en-US', {
      hour: 'numeric',
      minute: '2-digit',
      second: '2-digit',
      hour12: true,
    });
  }

  /**
   * Determines if a log should be output based on current log level
   * @param {LogLevel} level - The level of the log message
   * @returns {boolean} Whether the log should be output
   */
  private shouldLog(level: LogLevel): boolean {
    const levels: LogLevel[] = ['debug', 'info', 'warn', 'error'];
    return levels.indexOf(level) >= levels.indexOf(this.logLevel);
  }

  /**
   * Formats and outputs a log message
   * @param {LogLevel} level - The severity level
   * @param {string} message - The log message
   * @param {any} data - Optional data to log
   * @param {string} source - Optional source identifier
   */
  private log(level: LogLevel, message: string, data?: any, source?: string): void {
    if (!this.shouldLog(level)) {
      return;
    }

    const logMessage: LogMessage = {
      timestamp: this.getTimestamp(),
      level,
      message: redactLogText(message),
      data: data === undefined ? undefined : redactForLog(data),
      source: source === undefined ? undefined : redactLogText(source),
    };

    const formattedMessage = this.isDevelopment
      ? this.formatDevelopmentLog(logMessage)
      : this.formatProductionLog(logMessage);

    switch (level) {
      case 'error':
        console.error(formattedMessage);
        break;
      case 'warn':
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
  private formatDevelopmentLog(logMessage: LogMessage): string {
    const { timestamp, level, message, data, source } = logMessage;
    const levelPrefix = {
      debug: '[DEBUG]',
      info: '[INFO] ',
      warn: '[WARN] ',
      error: '[ERROR]',
    };

    let formatted = `${timestamp} ${levelPrefix[level]}`;
    if (source) {
      formatted += ` [${source}]`;
    }
    formatted += ` ${message}`;

    if (data !== undefined) {
      formatted += `\n${JSON.stringify(data, null, 2)}`;
    }

    return formatted;
  }

  /**
   * Formats log message for production environment
   * @param {LogMessage} logMessage - The log message object
   * @returns {string} JSON formatted log string
   */
  private formatProductionLog(logMessage: LogMessage): string {
    return JSON.stringify(logMessage);
  }

  /**
   * Log debug message (development only)
   * @param {string} message - The debug message
   * @param {any} data - Optional data
   * @param {string} source - Optional source
   */
  debug(message: string, data?: any, source?: string): void {
    this.log('debug', message, data, source);
  }

  /**
   * Log info message
   * @param {string} message - The info message
   * @param {any} data - Optional data
   * @param {string} source - Optional source
   */
  info(message: string, data?: any, source?: string): void {
    this.log('info', message, data, source);
  }

  /**
   * Log warning message
   * @param {string} message - The warning message
   * @param {any} data - Optional data
   * @param {string} source - Optional source
   */
  warn(message: string, data?: any, source?: string): void {
    this.log('warn', message, data, source);
  }

  /**
   * Log error message
   * @param {string} message - The error message
   * @param {any} error - Optional error object or data
   * @param {string} source - Optional source
   */
  error(message: string, error?: any, source?: string): void {
    this.log('error', message, error, source);
  }

  /**
   * Log HTTP request/response
   * @param {string} method - HTTP method
   * @param {string} path - Request path
   * @param {number} statusCode - Response status code
   * @param {number} duration - Request duration in ms
   * @param {any} response - Optional response data
   */
  http(method: string, path: string, statusCode: number, duration: number, response?: any): void {
    if (path.startsWith('/api')) {
      let logLine = `${method} ${path} ${statusCode} in ${duration}ms`;
      if (response && this.isDevelopment) {
        const responseStr = JSON.stringify(redactForLog(response));
        if (responseStr.length > 80) {
          logLine += ` :: ${responseStr.slice(0, 79)}…`;
        } else {
          logLine += ` :: ${responseStr}`;
        }
      }
      this.info(logLine, undefined, 'HTTP');
    }
  }
}

// Export singleton instance
export const logger = new Logger();
