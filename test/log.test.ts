import { test } from 'node:test';
import assert from 'node:assert/strict';
import { redact, registerSecret, clearSecrets } from '../src/util/log.js';

test('secrets registered at startup never appear in log output, including inside JSON/error text', () => {
  clearSecrets();
  const key = 'sk-live-ABCDEF1234567890secretvalue';
  registerSecret(key);
  assert.equal(redact(`Authorization: Bearer ${key}`).includes(key), false);
  assert.equal(redact(JSON.stringify({ apiKey: key, other: 'x' })).includes(key), false);
  assert.ok(redact(`token=${key}`).includes('[REDACTED]'));
  clearSecrets();
});

test('short values are never auto-redacted (would nuke normal log text) but query-style keys always are', () => {
  clearSecrets();
  registerSecret('ab'); // too short, ignored
  assert.equal(redact('ab normal text ab'), 'ab normal text ab');
  assert.equal(redact('url?api-key=SECRET123&x=1').includes('SECRET123'), false);
  assert.equal(redact('"x-api-key": "abc123def"').includes('abc123def'), false);
});
