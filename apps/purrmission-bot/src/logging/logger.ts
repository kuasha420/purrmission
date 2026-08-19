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
const REDACTED = '[REDACTED]';
const SENSITIVE_LOG_KEYS = new Set([
  'authorization',
  'body',
  'code',
  'context',
  'cookie',
  'csrf',
  'error',
  'password',
  'payload',
  'secret',
  'stack',
  'token',
  'value',
]);
const SAFE_CODE_KEYS = new Set(['decision_code', 'error_code', 'reason_code', 'status_code']);

function keyParts(key: string): string[] {
  return key
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

function isSensitiveLogKey(key: string): boolean {
  const parts = keyParts(key);
  const normalized = parts.join('_');
  if (SAFE_CODE_KEYS.has(normalized)) return false;
  if (SENSITIVE_LOG_KEYS.has(normalized)) return true;
  return ['secret', 'token', 'key', 'code', 'password'].some(
    (suffix) => normalized.endsWith(`_${suffix}`) || normalized.startsWith(`${suffix}_`)
  );
}

function sanitizeLogValue(value: unknown, key = '', seen = new WeakSet<object>()): unknown {
  if (isSensitiveLogKey(key)) return REDACTED;
  if (typeof value === 'string') {
    if (/^bearer\s+\S+/i.test(value) || /^otpauth:\/\//i.test(value)) return REDACTED;
    return value.length > 1024 ? `${value.slice(0, 1024)}…` : value;
  }
  if (typeof value === 'bigint') return value.toString();
  if (!value || typeof value !== 'object') return value;
  if (seen.has(value)) return '[CIRCULAR]';
  seen.add(value);
  if (value instanceof Error) return { errorType: value.name };
  if (Array.isArray(value)) return value.map((item) => sanitizeLogValue(item, key, seen));
  return Object.fromEntries(
    Object.entries(value).map(([childKey, childValue]) => [
      childKey,
      sanitizeLogValue(childValue, childKey, seen),
    ])
  );
}

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

  const metaStr = finalMeta !== undefined ? ` ${JSON.stringify(sanitizeLogValue(finalMeta))}` : '';
  const safeMessage = /bearer\s+\S+|otpauth:\/\/\S+/i.test(message) ? REDACTED : message;
  return `[${timestamp}] [${level}] ${safeMessage}${metaStr}`;
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
