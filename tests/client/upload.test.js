import { describe, it, mock, afterEach } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import { Readable } from 'node:stream';
import DiscordClient from '../../src/client/level_3.js';

afterEach(() => mock.restoreAll());

function makeClient() {
  const client = Object.create(DiscordClient.prototype);
  client._temps = new Map();
  return client;
}

describe('_fileInfo temp path collisions', () => {
  it('gives two URLs with the same basename different filepaths', async () => {
    const client = makeClient();
    mock.method(global, 'fetch', async (url) => ({
      body: Readable.from([Buffer.from(`content-for-${url}`)]),
    }));

    const a = await client._fileInfo('https://host-a.example.com/image.png');
    const b = await client._fileInfo('https://host-b.example.com/image.png');

    try {
      assert.notEqual(a.filepath, b.filepath);
      assert.equal(fs.existsSync(a.filepath), true);
      assert.equal(fs.existsSync(b.filepath), true);
      assert.notEqual(a.checksum, b.checksum);
    } finally {
      fs.rmSync(a.filepath, { force: true });
      fs.rmSync(b.filepath, { force: true });
    }
  });

  it('reuses the cached temp file for a repeated identical URL', async () => {
    const client = makeClient();
    let fetchCalls = 0;
    mock.method(global, 'fetch', async (url) => {
      fetchCalls++;
      return { body: Readable.from([Buffer.from(`content-for-${url}`)]) };
    });

    const first = await client._fileInfo('https://host-a.example.com/image.png');
    const second = await client._fileInfo('https://host-a.example.com/image.png');

    try {
      assert.equal(first.filepath, second.filepath);
      assert.equal(fetchCalls, 1);
    } finally {
      fs.rmSync(first.filepath, { force: true });
    }
  });
});
