import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';

import { loadAuditSecurityConfig } from './auditSecurity.js';

const original = {
  audit: process.env.AUDIT_INTEGRITY_KEY,
  outbox: process.env.OUTBOX_INTEGRITY_KEY,
};

afterEach(() => {
  process.env.AUDIT_INTEGRITY_KEY = original.audit;
  process.env.OUTBOX_INTEGRITY_KEY = original.outbox;
});

describe('audit security configuration', () => {
  it('requires valid purpose-separated integrity keys', () => {
    process.env.AUDIT_INTEGRITY_KEY = 'aa'.repeat(32);
    process.env.OUTBOX_INTEGRITY_KEY = 'aa'.repeat(32);
    assert.throws(() => loadAuditSecurityConfig(), /purpose-separated/);

    process.env.OUTBOX_INTEGRITY_KEY = 'bb'.repeat(32);
    const config = loadAuditSecurityConfig();
    assert.equal(config.auditIntegrityKey.length, 32);
    assert.equal(config.outboxIntegrityKey.length, 32);
    assert.equal(config.retentionDays, 365);
  });
});
