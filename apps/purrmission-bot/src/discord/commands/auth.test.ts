import assert from 'node:assert';
import { describe, test } from 'node:test';
import { authCommand } from './auth.js';

describe('/auth command definition', () => {
  test('accepts the full 64-bit device-flow user code', () => {
    const definition = authCommand.toJSON();
    const login = definition.options?.find((option) => option.name === 'login');
    assert.ok(login && 'options' in login);
    const code = login.options?.find((option) => option.name === 'code');

    assert.ok(code && 'max_length' in code && 'min_length' in code);
    assert.strictEqual(code.min_length, 19);
    assert.strictEqual(code.max_length, 19);
  });
});
