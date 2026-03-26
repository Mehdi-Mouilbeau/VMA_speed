// netlify/functions/garmin-login.js
// Authenticates with Garmin SSO using the same flow as the garth Python library.
// Returns { accessToken, refreshToken, expiresAt } on success, { error } on failure.
// NEVER logs credentials.

import fetch from 'node-fetch';
import { CookieJar } from 'tough-cookie';
import { HttpCookieAgent, HttpsCookieAgent } from 'http-cookie-agent/http';
import OAuth from 'oauth-1.0a';
import { createHmac } from 'crypto';

const DOMAIN = 'garmin.com';
const SSO       = `https://sso.${DOMAIN}/sso`;
const SSO_EMBED = `${SSO}/embed`;

const SSO_EMBED_PARAMS = new URLSearchParams({
  id: 'gauth-widget',
  embedWidget: 'true',
  gauthHost: SSO,
}).toString();

const SIGNIN_PARAMS = new URLSearchParams({
  id: 'gauth-widget',
  embedWidget: 'true',
  gauthHost: SSO_EMBED,
  service: SSO_EMBED,
  source: SSO_EMBED,
  redirectAfterAccountLoginUrl: SSO_EMBED,
  redirectAfterAccountCreationUrl: SSO_EMBED,
}).toString();

const SSO_UA = 'com.garmin.android.apps.connectmobile';
const API_UA = 'GCM-iOS-5.7.2.1';

const CORS = {
  'Access-Control-Allow-Origin': 'https://vma-speed.netlify.app',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

function makeFetchWithJar(jar) {
  const httpAgent  = new HttpCookieAgent({ cookies: { jar } });
  const httpsAgent = new HttpsCookieAgent({ cookies: { jar } });
  return (url, opts = {}) =>
    fetch(url, {
      ...opts,
      agent: url.startsWith('https') ? httpsAgent : httpAgent,
      redirect: 'follow',
    });
}

async function getOAuthConsumer() {
  const res = await fetch('https://thegarth.s3.amazonaws.com/oauth_consumer.json');
  return res.json(); // { consumer_key, consumer_secret }
}

function makeOAuth(consumerKey, consumerSecret) {
  return new OAuth({
    consumer: { key: consumerKey, secret: consumerSecret },
    signature_method: 'HMAC-SHA1',
    hash_function(base_string, key) {
      return createHmac('sha1', key).update(base_string).digest('base64');
    },
  });
}

export async function handler(event) {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers: CORS, body: '' };
  }
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers: CORS, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  let email, password;
  try {
    ({ email, password } = JSON.parse(event.body));
    if (!email || !password) throw new Error('missing');
  } catch {
    return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'Corps invalide' }) };
  }

  const jar = new CookieJar();
  const fetchJ = makeFetchWithJar(jar);

  try {
    // ── Step 0: Set initial SSO cookies ──────────────────────────────────────
    await fetchJ(`${SSO_EMBED}?${SSO_EMBED_PARAMS}`, {
      headers: { 'User-Agent': SSO_UA },
    });

    // ── Step 1: GET signin page — extract _csrf token ─────────────────────────
    const step1 = await fetchJ(`${SSO}/signin?${SIGNIN_PARAMS}`, {
      headers: { 'User-Agent': SSO_UA },
    });
    const html1 = await step1.text();
    const csrfMatch = html1.match(/name="_csrf"\s+value="([^"]+)"/);
    if (!csrfMatch) {
      return { statusCode: 502, headers: CORS, body: JSON.stringify({ error: 'Erreur Garmin, réessayez' }) };
    }
    const csrf = csrfMatch[1];

    // ── Step 2: POST credentials ──────────────────────────────────────────────
    const step2 = await fetchJ(`${SSO}/signin?${SIGNIN_PARAMS}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'User-Agent': SSO_UA,
        'Referer': `${SSO}/signin?${SIGNIN_PARAMS}`,
      },
      body: new URLSearchParams({
        username: email,
        password,
        embed: 'true',
        _csrf: csrf,
      }).toString(),
    });
    const html2 = await step2.text();

    // Check page title = "Success"
    const titleMatch = html2.match(/<title>([^<]+)<\/title>/);
    const pageTitle = titleMatch ? titleMatch[1].trim() : '(no title)';
    if (!titleMatch || !titleMatch[1].includes('Success')) {
      return { statusCode: 403, headers: CORS, body: JSON.stringify({ error: 'Identifiants incorrects', debug_title: pageTitle, debug_html: html2.slice(0, 600) }) };
    }

    // Extract ticket from HTML body (garth pattern: embed?ticket=...)
    const ticketMatch = html2.match(/embed\?ticket=([^"&\s]+)/);
    if (!ticketMatch) {
      return { statusCode: 502, headers: CORS, body: JSON.stringify({ error: 'Erreur Garmin, réessayez' }) };
    }
    const ticket = ticketMatch[1];

    // ── Step 3: Exchange SSO ticket for OAuth1 token ──────────────────────────
    const { consumer_key, consumer_secret } = await getOAuthConsumer();
    const oauthClient = makeOAuth(consumer_key, consumer_secret);

    const preAuthUrl =
      `https://connectapi.${DOMAIN}/oauth-service/oauth/preauthorized` +
      `?ticket=${ticket}&login-url=${encodeURIComponent(SSO_EMBED)}&accepts-mfa-tokens=true`;

    const preAuthAuth = oauthClient.toHeader(
      oauthClient.authorize({ url: preAuthUrl, method: 'GET' })
    );
    const preAuthResp = await fetch(preAuthUrl, {
      headers: { ...preAuthAuth, 'User-Agent': SSO_UA },
    });
    if (!preAuthResp.ok) {
      return { statusCode: 502, headers: CORS, body: JSON.stringify({ error: 'Erreur Garmin, réessayez' }) };
    }
    const preAuthText = await preAuthResp.text();
    const preAuthParams = new URLSearchParams(preAuthText);
    const oauth1Token  = preAuthParams.get('oauth_token');
    const oauth1Secret = preAuthParams.get('oauth_token_secret');
    if (!oauth1Token || !oauth1Secret) {
      return { statusCode: 502, headers: CORS, body: JSON.stringify({ error: 'Erreur Garmin, réessayez' }) };
    }

    // ── Step 4: Exchange OAuth1 for OAuth2 ────────────────────────────────────
    const exchangeUrl = `https://connectapi.${DOMAIN}/oauth-service/oauth/exchange/user/2.0`;
    const exchangeAuth = oauthClient.toHeader(
      oauthClient.authorize(
        { url: exchangeUrl, method: 'POST' },
        { key: oauth1Token, secret: oauth1Secret }
      )
    );
    const exchangeResp = await fetch(exchangeUrl, {
      method: 'POST',
      headers: {
        ...exchangeAuth,
        'User-Agent': API_UA,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
    });
    if (!exchangeResp.ok) {
      return { statusCode: 502, headers: CORS, body: JSON.stringify({ error: 'Erreur Garmin, réessayez' }) };
    }
    const oauth2 = await exchangeResp.json();

    const expiresAt = Date.now() + (oauth2.expires_in || 3600) * 1000;
    return {
      statusCode: 200,
      headers: { ...CORS, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        accessToken:  oauth2.access_token,
        refreshToken: oauth2.refresh_token,
        expiresAt,
      }),
    };

  } catch (err) {
    return {
      statusCode: 500,
      headers: CORS,
      body: JSON.stringify({ error: 'Erreur Garmin, réessayez' }),
    };
  }
}
