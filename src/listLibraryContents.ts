import { ChildProcess } from 'child_process';
import { Command } from 'commander';
import 'dotenv/config';
import express from 'express';
import fs from 'fs';
import { Auth } from 'googleapis';
import fetch from 'isomorphic-fetch';
import open from 'open';
import url from 'url';
import clientSecret from '../client_secret.json';

const {
  web: {
    client_id,
    client_secret,
    redirect_uris: [redirectUri],
  },
} = clientSecret;

if (!redirectUri) {
  throw new Error('"redirect_uris" cannot be empty.');
}
const uri = url.parse(redirectUri);
const port = uri.port && parseInt(uri.port);
const hostname = uri.hostname;
const path = uri.path ?? '';
if (!hostname) {
  throw new Error('Redirect URI must contain a hostname.');
}
if (!port || Number.isNaN(port)) {
  throw new Error('Redirect URI must contain a port number.');
}

const { out, tokensPath } = new Command()
  .requiredOption('-o --out <path>', 'Output path')
  .requiredOption('-t --tokens-path <path>', 'Tokens path')
  .parse(process.argv)
  .opts();

const oauth2Client = new Auth.OAuth2Client(
  client_id,
  client_secret,
  redirectUri,
);

const oauthUri = oauth2Client.generateAuthUrl({
  scope: ['https://www.googleapis.com/auth/photoslibrary.readonly'],
});

const assertToken: (
  token: string | null | undefined,
) => asserts token is string = (token) => {
  if (!token) {
    throw new Error('Missing "access_token" in credentials');
  }
};
const saveTokens = (tokens: Auth.Credentials) => {
  console.log('Saving tokens to ', tokensPath);
  return fs.promises.writeFile(tokensPath, JSON.stringify(tokens, null, 2));
};
const getTokens = async (code: string) => {
  console.log('Fetching tokens');
  const tokensResponse = await oauth2Client.getToken(code);

  await saveTokens(tokensResponse.tokens);

  return tokensResponse.tokens;
};

const fetchMediaItems = async (accessToken: string) => {
  console.log('Fetching media');
  const mediaItemsRes = await fetch(
    'https://photoslibrary.googleapis.com/v1/mediaItems',
    {
      headers: {
        'Content-type': 'application/json',
        authorization: `Bearer ${accessToken}`,
      },
    },
  );

  const mediaItems = await mediaItemsRes.json();

  return mediaItems;
};

const app = express();

let oauthProcess: ChildProcess | null = null;
let tokens: Auth.Credentials | null = null;

app.get('/', async (req, res) => {
  if (oauthProcess) {
    console.log('Disconnecting child process');
    oauthProcess.disconnect();
  } else {
    console.log('No child process available');
  }

  const { query } = url.parse(req.url, true);
  const code = Array.isArray(query.code) ? query.code[0] : query.code;
  if (!code) {
    console.log('Missing "code" query parameter');
    res.status(400);
    return res.send();
  }

  const authTokens = tokens ?? (await getTokens(code));

  assertToken(authTokens.access_token);
  const mediaItems = await fetchMediaItems(authTokens.access_token);
  const mediaItemsData =
    mediaItems.error?.code === 401
      ? await (async () => {
          const refreshTokenRes = await oauth2Client.refreshAccessToken();
          await saveTokens(refreshTokenRes.credentials);
          assertToken(refreshTokenRes.credentials.access_token);
          await fetchMediaItems(refreshTokenRes.credentials.access_token);
        })()
      : mediaItems;

  console.log('Writing media items to ', out);
  fs.promises.writeFile(out, JSON.stringify(mediaItemsData));

  res.status(200);
  res.send();

  server.close();
});

const server = app.listen(port, hostname, () => {
  console.log(path === '/' ? redirectUri : redirectUri.split(path).join());
});

(async () => {
  try {
    tokens = JSON.parse(
      await fs.promises.readFile(tokensPath, { encoding: 'utf8' }),
    );
    console.log({ tokens });
  } catch {}
  return open(oauthUri, { wait: true });
})();
