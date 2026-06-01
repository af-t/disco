import { describe, it } from 'node:test';
import assert from 'node:assert';
import { formatToolError } from '../../../src/ai/tools/error.js';

describe('formatToolError', () => {
  it('returns the message of an Error', () => {
    assert.equal(formatToolError(new Error('boom')), 'boom');
  });

  it('preserves a Discord error body including its code', () => {
    const out = formatToolError({ message: 'Missing Permissions', code: 50013 });
    assert.match(out, /Missing Permissions/);
    assert.match(out, /50013/);
  });

  it('decodes a Buffer body to text', () => {
    assert.equal(formatToolError(Buffer.from('upstream failure', 'utf8')), 'upstream failure');
  });

  it('never returns [object Object] for a message-less object', () => {
    const out = formatToolError({ code: 50035, errors: { field: 'bad' } });
    assert.doesNotMatch(out, /\[object Object\]/);
    assert.match(out, /50035/);
  });

  it('falls back to String without throwing on a circular object', () => {
    const circular = {};
    circular.self = circular;
    assert.doesNotThrow(() => formatToolError(circular));
  });

  it('stringifies a primitive', () => {
    assert.equal(formatToolError('plain'), 'plain');
  });
});
