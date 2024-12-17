import ytdl from '@distube/ytdl-core';
import yts from 'yt-search';
import SpotifyClient from 'spotify-web-api-node';
import { PassThrough } from 'node:stream';

const spotifyApi = new SpotifyClient({
  clientId: process.env.SPOTIFY_CLIENT_ID,
  clientSecret: process.env.SPOTIFY_CLIENT_SECRET
});

async function authenticate() {
  const data = await spotifyApi.clientCredentialsGrant();
  spotifyApi.setAccessToken(data.body['access_token']);
}

function extractTrackId(trackUrl) {
  const match = trackUrl.match(/\/track\/([a-zA-Z0-9]+)/);
  return match ? match[1] : null;
}

async function downloadTrack(trackUrl) {
  if (!process.env.SPOTIFY_CLIENT_ID || !process.env.SPOTIFY_CLIENT_SECRET) {
    throw Error('SPOTIFY_CLIENT_ID and SPOTIFY_CLIENT_SECRET environment variables are required');
  }

  await authenticate();

  const trackId = extractTrackId(trackUrl);
  if (!trackId) throw Error('Invalid Spotify track URL');

  const trackInfo = await spotifyApi.getTrack(trackId);
  const searchQuery = `${trackInfo.body.name} - ${trackInfo.body.artists.map(a => a.name).join(', ')}`;

  const searchResults = await yts(searchQuery);
  if (searchResults.length < 1) {
    throw Error('Track not found on youtube');
  }

  let streamData = Buffer.alloc(0);

  return new Promise((resolve, reject) => {
    const stream = new PassThrough();
    stream.on('data', chunk => streamData = Buffer.concat([streamData, chunk]));
    stream.on('end', () => resolve(streamData));

    const downloader = ytdl(searchResults.videos[0].url, { quality: 'highestaudio', filter: 'audioonly' });
    downloader.pipe(stream);
    downloader.on('error', reject);
  });
}

export default downloadTrack;
