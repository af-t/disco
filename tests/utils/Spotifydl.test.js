import test from 'node:test';
import assert from 'node:assert';

test('downloadTrack should throw error if SPOTIFY_CLIENT_ID is missing', async () => {
  let downloadTrack;
  try {
    const mod = await import('../../src/utils/Spotifydl.js');
    downloadTrack = mod.default;
  } catch (e) {
    if (e.code === 'ERR_MODULE_NOT_FOUND') {
      console.warn('Skipping Spotifydl tests: dependencies missing');
      return;
    }
    throw e;
  }

  const originalId = process.env.SPOTIFY_CLIENT_ID;
  delete process.env.SPOTIFY_CLIENT_ID;
  
  try {
    await assert.rejects(async () => {
      await downloadTrack('https://open.spotify.com/track/123');
    }, /SPOTIFY_CLIENT_ID and SPOTIFY_CLIENT_SECRET environment variables are required/);
  } finally {
    process.env.SPOTIFY_CLIENT_ID = originalId;
  }
});
