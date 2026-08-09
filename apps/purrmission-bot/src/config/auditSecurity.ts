import { z } from 'zod';

const keySchema = z.string().regex(/^[0-9a-fA-F]{64}$/);

export interface AuditSecurityConfig {
  auditIntegrityKey: Buffer;
  auditIntegrityKeyId: string;
  /** Historical verification keys. The current key is always added by the loader. */
  auditIntegrityKeys?: ReadonlyMap<string, Buffer>;
  outboxIntegrityKey: Buffer;
  outboxIntegrityKeyId: string;
  /** Historical verification keys. Pending envelopes remain verifiable during rotation. */
  outboxIntegrityKeys?: ReadonlyMap<string, Buffer>;
  retentionDays: number;
  checkpointInterval: number;
}

function readKeyRing(
  name: 'AUDIT_INTEGRITY_KEYS_JSON' | 'OUTBOX_INTEGRITY_KEYS_JSON'
): Map<string, Buffer> {
  const raw = process.env[name];
  if (!raw) return new Map();
  const parsed = z
    .record(z.string().regex(/^[A-Za-z0-9._:-]{1,64}$/), keySchema)
    .parse(JSON.parse(raw));
  return new Map(Object.entries(parsed).map(([id, value]) => [id, Buffer.from(value, 'hex')]));
}

function readKey(name: 'AUDIT_INTEGRITY_KEY' | 'OUTBOX_INTEGRITY_KEY'): Buffer {
  const parsed = keySchema.safeParse(process.env[name]);
  if (!parsed.success) {
    throw new Error(`${name} must be a purpose-specific 32-byte hexadecimal key`);
  }
  return Buffer.from(parsed.data, 'hex');
}

export function loadAuditSecurityConfig(): AuditSecurityConfig {
  const retentionDays = z.coerce
    .number()
    .int()
    .min(1)
    .max(3650)
    .default(365)
    .parse(process.env.AUDIT_RETENTION_DAYS);
  const checkpointInterval = z.coerce
    .number()
    .int()
    .min(1)
    .max(1_000_000)
    .default(1000)
    .parse(process.env.AUDIT_CHECKPOINT_INTERVAL);
  const auditIntegrityKeyId = z
    .string()
    .regex(/^[A-Za-z0-9._:-]{1,64}$/)
    .default('audit-v1')
    .parse(process.env.AUDIT_INTEGRITY_KEY_ID);
  const outboxIntegrityKeyId = z
    .string()
    .regex(/^[A-Za-z0-9._:-]{1,64}$/)
    .default('outbox-v1')
    .parse(process.env.OUTBOX_INTEGRITY_KEY_ID);

  const auditIntegrityKey = readKey('AUDIT_INTEGRITY_KEY');
  const outboxIntegrityKey = readKey('OUTBOX_INTEGRITY_KEY');
  if (auditIntegrityKey.equals(outboxIntegrityKey)) {
    throw new Error('AUDIT_INTEGRITY_KEY and OUTBOX_INTEGRITY_KEY must be purpose-separated');
  }

  const auditIntegrityKeys = readKeyRing('AUDIT_INTEGRITY_KEYS_JSON');
  const outboxIntegrityKeys = readKeyRing('OUTBOX_INTEGRITY_KEYS_JSON');
  auditIntegrityKeys.set(auditIntegrityKeyId, auditIntegrityKey);
  outboxIntegrityKeys.set(outboxIntegrityKeyId, outboxIntegrityKey);

  return {
    auditIntegrityKey,
    auditIntegrityKeyId,
    auditIntegrityKeys,
    outboxIntegrityKey,
    outboxIntegrityKeyId,
    outboxIntegrityKeys,
    retentionDays,
    checkpointInterval,
  };
}
