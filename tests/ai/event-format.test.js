import test from 'node:test';
import assert from 'node:assert';
import { snapshotFromMessage, renderEventBlock } from '../../src/ai/event-format.js';

test('snapshotFromMessage extracts the fields we need', () => {
  const msg = {
    id: '111',
    channel_id: '222',
    guild_id: '333',
    content: 'hi',
    author: { id: '444', username: 'alice', global_name: 'Alice' },
    timestamp: '2026-05-19T10:00:00Z',
    attachments: [{ filename: 'pic.png', content_type: 'image/png', url: 'http://x/pic.png', size: 100 }],
    message_reference: { message_id: '999' },
  };
  const snap = snapshotFromMessage(msg, { flag: 'new' });
  assert.equal(snap.id, '111');
  assert.equal(snap.author_id, '444');
  assert.equal(snap.author_name, 'Alice');
  assert.equal(snap.content, 'hi');
  assert.equal(snap.reply_to, '999');
  assert.equal(snap.attachments_meta.length, 1);
  assert.equal(snap.attachments_meta[0].filename, 'pic.png');
  assert.equal(snap.flag, 'new');
});

test('renderEventBlock produces a <discord-event> XML-ish block', () => {
  const snap = {
    id: '1',
    author_id: 'u1',
    author_name: 'alice',
    content: 'hello',
    reply_to: null,
    attachments_meta: [],
    timestamp: 1234567890000,
    flag: 'new',
  };
  const out = renderEventBlock(snap, { channel_name: 'general', channel_id: 'c1' });
  assert.match(out, /<discord-event/);
  assert.match(out, /author="alice \(u1\)"/);
  assert.match(out, /channel="general \(c1\)"/);
  assert.match(out, /flag="NEW"/);
  assert.match(out, /<content>\nhello\n<\/content>/);
});

test('renderEventBlock encodes attachments compactly', () => {
  const snap = {
    id: '1',
    author_id: 'u1',
    author_name: 'alice',
    content: '',
    reply_to: null,
    timestamp: 0,
    flag: 'observed',
    attachments_meta: [
      { filename: 'a.png', content_type: 'image/png' },
      { filename: 'b.pdf', content_type: 'application/pdf' },
    ],
  };
  const out = renderEventBlock(snap, { channel_name: 'g', channel_id: 'c' });
  assert.match(out, /attachments="image:a\.png; pdf:b\.pdf"/);
});
