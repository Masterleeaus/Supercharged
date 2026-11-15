/**
 * ============================================================
 * © 2025 Diploy — a brand of Bisht Technologies Private Limited
 * Original Author: BTPL Engineering Team
 * Website: https://diploy.in
 * Contact: cs@diploy.in
 *
 * Licensed under the MIT License. See the LICENSE file at the repository root.
 * Copyright (c) Titan Zero.
 * ============================================================
 */

type LogLevel = 'debug' | 'info' | 'warn' | 'error';

interface LogContext {
  [key: string]: unknown;
}

function formatTimestamp(): string {
  return new Date().toISOString();
}

function formatMessage(level: LogLevel, message: string, context?: LogContext): string {
  const timestamp = formatTimestamp();
  const prefix = `[${timestamp}] [${level.toUpperCase()}]`;
  
  if (context && Object.keys(context).length > 0) {
    return `${prefix} ${message} ${JSON.stringify(context)}`;
  }
  return `${prefix} ${message}`;
}

export const diployLogger = {
  debug(message: string, context?: LogContext): void {
    if (process.env.NODE_ENV === 'development') {
      console.debug(formatMessage('debug', message, context));
    }
  },

  info(message: string, context?: LogContext): void {
    console.info(formatMessage('info', message, context));
  },

  warn(message: string, context?: LogContext): void {
    console.warn(formatMessage('warn', message, context));
  },

  error(message: string, context?: LogContext): void {
    console.error(formatMessage('error', message, context));
  },

  service(serviceName: string) {
    return {
      debug: (message: string, context?: LogContext) => 
        diployLogger.debug(`[${serviceName}] ${message}`, context),
      info: (message: string, context?: LogContext) => 
        diployLogger.info(`[${serviceName}] ${message}`, context),
      warn: (message: string, context?: LogContext) => 
        diployLogger.warn(`[${serviceName}] ${message}`, context),
      error: (message: string, context?: LogContext) => 
        diployLogger.error(`[${serviceName}] ${message}`, context),
    };
  }
};
