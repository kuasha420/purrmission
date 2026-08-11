import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { logger } from './logger.js';

describe('structured logger redaction boundary', () => {
  it('redacts camelCase and nested credential material at runtime', () => {
    const captured: string[] = [];
    const original = console.info;
    console.info = (...values: unknown[]) => captured.push(values.join(' '));
    try {
      logger.info('credential boundary', {
        userCode: 'ABCD-1234',
        deviceCode: 'device-raw',
        accessToken: 'access-raw',
        clientSecret: 'client-raw',
        totpCode: '123456',
        recoveryKey: 'recovery-raw',
        rawToken: 'token-raw',
        nested: [{ apiKey: 'api-raw', safeCount: 2 }],
      });
    } finally {
      console.info = original;
    }

    const output = captured.join('\n');
    for (const secret of [
      'ABCD-1234',
      'device-raw',
      'access-raw',
      'client-raw',
      '123456',
      'recovery-raw',
      'token-raw',
      'api-raw',
    ]) {
      assert.equal(output.includes(secret), false, `logger exposed ${secret}`);
    }
    assert.match(output, /"safeCount":2/);
  });

  it('redacts credential-shaped message strings', () => {
    const captured: string[] = [];
    const original = console.warn;
    console.warn = (...values: unknown[]) => captured.push(values.join(' '));
    try {
      logger.warn('Bearer should-never-log');
    } finally {
      console.warn = original;
    }
    assert.equal(captured.join('\n').includes('should-never-log'), false);
  });
});
