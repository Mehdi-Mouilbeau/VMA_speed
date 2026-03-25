// netlify/functions/garmin-login.js
// Authenticates with Garmin SSO (4-step unofficial flow).
// Returns { sessionCookies, expiresAt } on success, { error } on failure.
// NEVER logs credentials.

import fetch from 'node-fetch';
import { CookieJar } from 'tough-cookie';
import { HttpCookieAgent, HttpsCookieAgent } from 'http-cookie-agent/http';

// Helper: fetch with a cookie jar (node-fetch v3 + tough-cookie)
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

const CORS = {
  'Access-Control-Allow-Origin': 'https://vma-speed.netlify.app',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

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
    // ── Step 1: GET signin page to extract _csrf token + GARMIN-SSO-GUID cookie ──
    const signinUrl =
      'https://sso.garmin.com/sso/signin' +
      '?service=https%3A%2F%2Fconnect.garmin.com%2Fmodern%2F' +
      '&gauthHost=https%3A%2F%2Fsso.garmin.com' +
      '&embed=false';

    const step1 = await fetchJ(signinUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; Garmin Connect)',
        'Origin': 'https://sso.garmin.com',
      },
    });
    const html1 = await step1.text();
    const csrfMatch = html1.match(/name="_csrf"\s+value="([^"]+)"/);
    if (!csrfMatch) {
      return { statusCode: 502, headers: CORS, body: JSON.stringify({ error: 'Erreur Garmin, réessayez' }) };
    }
    const csrf = csrfMatch[1];

    // ── Step 2: POST credentials — follow redirect chain, extract ST-... ticket ──
    const body2 = new URLSearchParams({
      username: email,
      password,
      _csrf: csrf,
      embed: 'false',
      gauthHost: 'https://sso.garmin.com',
      service: 'https://connect.garmin.com/modern/',
    });

    const step2 = await fetchJ(
      'https://sso.garmin.com/sso/signin',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'User-Agent': 'Mozilla/5.0 (compatible; Garmin Connect)',
          'Origin': 'https://sso.garmin.com',
          'Referer': 'https://sso.garmin.com/sso/signin',
        },
        body: body2.toString(),
      }
    );

    // After redirect chain, the final URL contains ?ticket=ST-...
    const finalUrl = step2.url;
    const ticketMatch = finalUrl.match(/[?&]ticket=(ST-[^&]+)/);
    if (!ticketMatch) {
      // Garmin returns 200 with error page when credentials are wrong
      return { statusCode: 403, headers: CORS, body: JSON.stringify({ error: 'Identifiants incorrects' }) };
    }
    const ticket = ticketMatch[1];

    // ── Step 3: Exchange ticket for session cookies ────────────────────────────
    await fetchJ(
      `https://connect.garmin.com/modern/di-oauth/exchange?ticket=${ticket}`,
      {
        headers: {
          'User-Agent': 'Mozilla/5.0 (compatible; Garmin Connect)',
          'Origin': 'https://connect.garmin.com',
          'Referer': 'https://connect.garmin.com/modern/',
        },
      }
    );

    // ── Step 4: Validate session with socialProfile endpoint ─────────────────
    // Collect all cookies from the jar for connect.garmin.com
    const cookies = await jar.getCookies('https://connect.garmin.com/');
    const cookieHeader = cookies.map(c => `${c.key}=${c.value}`).join('; ');

    const step4 = await fetchJ(
      'https://connect.garmin.com/modern/proxy/userprofile-service/socialProfile',
      {
        headers: {
          'Cookie': cookieHeader,
          'NK': 'NT',
          'User-Agent': 'Mozilla/5.0 (compatible; Garmin Connect)',
          'Origin': 'https://connect.garmin.com',
        },
      }
    );

    if (step4.status !== 200) {
      return { statusCode: 403, headers: CORS, body: JSON.stringify({ error: 'Identifiants incorrects' }) };
    }

    const expiresAt = Date.now() + 24 * 60 * 60 * 1000; // +24h
    return {
      statusCode: 200,
      headers: { ...CORS, 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionCookies: cookieHeader, expiresAt }),
    };

  } catch (err) {
    return {
      statusCode: 500,
      headers: CORS,
      body: JSON.stringify({ error: 'Erreur Garmin, réessayez' }),
    };
  }
}
