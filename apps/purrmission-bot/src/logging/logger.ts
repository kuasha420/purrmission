/**
 * Minimal logger wrapper providing structured console output.
 * Prepends timestamp and log level to all messages.
 *
 * TODO: Replace with a more robust logging library (e.g., pino, winston)
 * for production use with features like:
 * - Log levels based on environment
 * - JSON structured logging
 * - Log rotation and file output
 */

import { correlationStorage } from './correlationContext.js';

type LogLevel = 'DEBUG' | 'INFO' | 'WARN' | 'ERROR';

function formatTimestamp(): string {
  return new Date().toISOString();
}

function formatMessage(level: LogLevel, message: string, meta?: unknown): string {
  const timestamp = formatTimestamp();

  // Inject correlationId if active in context
  const store = correlationStorage.getStore();
  let finalMeta = meta;
  if (store?.correlationId) {
    if (meta && typeof meta === 'object') {
      finalMeta = { correlationId: store.correlationId, ...meta };
    } else {
      finalMeta = { correlationId: store.correlationId };
    }
  }

  const metaStr = finalMeta !== undefined ? ` ${JSON.stringify(finalMeta)}` : '';
  return `[${timestamp}] [${level}] ${message}${metaStr}`;
}

export const logger = {
  debug(message: string, meta?: unknown): void {
    console.debug(formatMessage('DEBUG', message, meta));
  },

  info(message: string, meta?: unknown): void {
    console.info(formatMessage('INFO', message, meta));
  },

  warn(message: string, meta?: unknown): void {
    console.warn(formatMessage('WARN', message, meta));
  },

  error(message: string, meta?: unknown): void {
    console.error(formatMessage('ERROR', message, meta));
  },
};

export type Logger = typeof logger;
