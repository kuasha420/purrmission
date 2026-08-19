import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';

import type { AuditSurface } from '../domain/models.js';

const CORRELATION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

export interface CorrelationStore {
  correlationId: string;
  causationId?: string;
  surface?: AuditSurface;
  operation?: string;
}

export const correlationStorage = new AsyncLocalStorage<CorrelationStore>();

export function isValidCorrelationId(value: unknown): value is string {
  return typeof value === 'string' && CORRELATION_ID_PATTERN.test(value);
}

export function requireValidCorrelationId(value: unknown): string {
  if (!isValidCorrelationId(value)) {
    throw new Error('Correlation ID must be 1-128 safe ASCII identifier characters.');
  }
  return value;
}

export function createCorrelationId(): string {
  return randomUUID();
}

export function resolveCorrelationId(untrustedValue?: unknown): string {
  return untrustedValue === undefined
    ? createCorrelationId()
    : requireValidCorrelationId(untrustedValue);
}
