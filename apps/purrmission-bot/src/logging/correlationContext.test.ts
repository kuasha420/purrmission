import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  correlationStorage,
  isValidCorrelationId,
  requireValidCorrelationId,
  resolveCorrelationId,
} from './correlationContext.js';

describe('correlation context', () => {
  it('accepts bounded safe identifiers and rejects unrestricted log input', () => {
    assert.equal(isValidCorrelationId('request:abc-123_4.5'), true);
    assert.equal(isValidCorrelationId('a'.repeat(129)), false);
    assert.equal(isValidCorrelationId('line\nbreak'), false);
    assert.equal(isValidCorrelationId(['array']), false);
    assert.throws(() => requireValidCorrelationId('bad value'), /1-128 safe ASCII/);
  });

  it('generates a valid server identifier and retains causation across async work', async () => {
    assert.equal(isValidCorrelationId(resolveCorrelationId()), true);
    await correlationStorage.run(
      {
        correlationId: 'request-1',
        causationId: 'command-1',
        surface: 'PAWTHY',
      },
      async () => {
        await Promise.resolve();
        assert.deepEqual(correlationStorage.getStore(), {
          correlationId: 'request-1',
          causationId: 'command-1',
          surface: 'PAWTHY',
        });
      }
    );
  });
});
