import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { createPawthyCorrelationContext, pawthyRequestHeaders } from './correlation.js';

describe('Pawthy correlation propagation', () => {
  it('uses unique request IDs with a stable command causation ID', () => {
    const context = createPawthyCorrelationContext();
    const first = pawthyRequestHeaders(context, { Authorization: 'Bearer test' });
    const second = pawthyRequestHeaders(context);
    assert.match(first['x-correlation-id'], /^[0-9a-f-]{36}$/);
    assert.notEqual(first['x-correlation-id'], second['x-correlation-id']);
    assert.equal(first['x-causation-id'], context.commandId);
    assert.equal(second['x-causation-id'], context.commandId);
    assert.equal(first.Authorization, 'Bearer test');
  });
});
