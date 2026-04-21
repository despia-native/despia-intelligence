import assert from 'node:assert/strict';
import test from 'node:test';
import intelligence from '../index.js';

test('ESM default import resolves', () => {
  assert.ok(intelligence);
  assert.ok(typeof intelligence.run === 'function');
  assert.equal(intelligence.runtime.ok, false);
});
