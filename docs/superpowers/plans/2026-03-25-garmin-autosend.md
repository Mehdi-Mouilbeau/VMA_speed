# Garmin Connect Auto-Send Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add one-click Garmin Connect workout creation from the VMA calculator via Netlify serverless functions and Garmin's unofficial SSO API.

**Architecture:** Two Netlify Functions handle auth (`garmin-login.js`) and workout creation (`garmin-workout.js`); the frontend stores session cookies in localStorage and presents a two-state Garmin card (login form → connected). No OAuth registration required — uses Garmin's own web SSO flow.

**Tech Stack:** Node.js (Netlify Functions), `tough-cookie` (cookie jar), `node-fetch` (HTTP), vanilla JS/HTML (frontend), Netlify hosting.

**Spec:** `docs/superpowers/specs/2026-03-25-garmin-oauth-design.md`

---

## File Structure

| File | Action | Responsibility |
|------|--------|----------------|
| `package.json` | Create | npm dependencies for Netlify Functions |
| `netlify.toml` | Create | CORS headers, esbuild bundler config |
| `netlify/functions/garmin-login.js` | Create | 4-step Garmin SSO — returns session cookies |
| `netlify/functions/garmin-workout.js` | Create | POST workout JSON to Garmin Connect API |
| `index.html` | Modify | Garmin card UI + 4 JS functions + relabel .fit button |

---

## Task 1: Project Setup (package.json + netlify.toml)

**Files:**
- Create: `package.json`
- Create: `netlify.toml`

- [ ] **Step 1: Create package.json**

```json
{
  "dependencies": {
    "tough-cookie": "^4.1.3",
    "node-fetch": "^3.3.2",
    "http-cookie-agent": "^6.0.0"
  }
}
```

Save to `/path/to/repo/package.json` (repo root, same level as `index.html`).

- [ ] **Step 2: Create netlify.toml**

```toml
[functions]
  node_bundler = "esbuild"

[[headers]]
  for = "/.netlify/functions/*"
  [headers.values]
    Access-Control-Allow-Origin = "https://vma-speed.netlify.app"
    Access-Control-Allow-Methods = "POST, OPTIONS"
    Access-Control-Allow-Headers = "Content-Type"
```

Save to repo root.

- [ ] **Step 3: Create functions directory**

```bash
mkdir -p netlify/functions
```

- [ ] **Step 4: Verify files exist**

```bash
ls package.json netlify.toml netlify/functions/
```

Expected: both files present, `netlify/functions/` directory exists.

- [ ] **Step 5: Commit**

```bash
git add package.json netlify.toml
git commit -m "feat: add Netlify config and npm dependencies for Garmin functions"
```

---

## Task 2: garmin-login.js — 4-step SSO

**Files:**
- Create: `netlify/functions/garmin-login.js`

**What this does:** Accepts `{email, password}` POST body. Runs 4-step Garmin SSO using a `tough-cookie` jar to propagate cookies across steps. Returns `{sessionCookies, expiresAt}` on success, `{error}` on failure.

**Important:** Never log the request body, `email`, or `password` anywhere.

- [ ] **Step 1: Write garmin-login.js**

```js
// netlify/functions/garmin-login.js
// Authenticates with Garmin SSO (4-step unofficial flow).
// Returns { sessionCookies, expiresAt } on success, { error } on failure.
// NEVER logs credentials.

import fetch from 'node-fetch';
import { CookieJar } from 'tough-cookie';
import { CookieAgent } from 'http-cookie-agent/http';
import { HttpsCookieAgent } from 'http-cookie-agent/https';

// Helper: fetch with a cookie jar (node-fetch v3 + tough-cookie)
function makeFetchWithJar(jar) {
  const httpAgent  = new CookieAgent({ cookies: { jar } });
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
```

- [ ] **Step 2: Install dependencies**

```bash
npm install
```

Expected: `node_modules/` created with `tough-cookie` and `node-fetch`.

- [ ] **Step 3: Verify syntax**

```bash
node --input-type=module < netlify/functions/garmin-login.js
```

Expected: No errors (module just defines and exports `handler`, exits cleanly).

- [ ] **Step 4: Commit**

```bash
git add netlify/functions/garmin-login.js package-lock.json
git commit -m "feat: add garmin-login Netlify function (4-step SSO)"
```

---

## Task 3: garmin-workout.js — Create workout on Garmin Connect

**Files:**
- Create: `netlify/functions/garmin-workout.js`

**What this does:** Accepts `{sessionCookies, workoutName, blocs}` POST body. Constructs the Garmin workout JSON (`RepeatGroupDTO` + `ExecutableStepDTO` structure) and POSTs it to `https://connect.garmin.com/workout-service/workout`. Returns `{workoutId, workoutName}` on success.

**Key rules for building the Garmin workout JSON:**
- `stepOrder` on `RepeatGroupDTO`: ordinal among top-level steps (1, 2, 3…)
- `stepOrder` on `ExecutableStepDTO`: position within its parent group's `workoutSteps` (restarts at 1 for each group)
- `childStepId`: global counter across ALL `ExecutableStepDTO` leaf nodes, starting at 1, no gaps even when recovery is omitted

- [ ] **Step 1: Write garmin-workout.js**

```js
// netlify/functions/garmin-workout.js
// Creates a structured workout on Garmin Connect.
// Input: { sessionCookies, workoutName, blocs: [{reps, dist, pct, recup, durSec}] }
// Output: { workoutId, workoutName } or { error }

import fetch from 'node-fetch';

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

  let sessionCookies, workoutName, blocs;
  try {
    ({ sessionCookies, workoutName, blocs } = JSON.parse(event.body));
    if (!sessionCookies || !workoutName || !Array.isArray(blocs) || blocs.length === 0) {
      throw new Error('missing');
    }
  } catch {
    return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'Corps invalide' }) };
  }

  // Build Garmin workout JSON
  let groupOrder = 0;   // top-level RepeatGroupDTO stepOrder (1-based)
  let childStepId = 0;  // global leaf counter across all ExecutableStepDTOs (1-based)

  const workoutSteps = blocs.map(bloc => {
    groupOrder++;
    let stepInGroup = 0; // resets per group

    const innerSteps = [];

    // Active interval step
    stepInGroup++;
    childStepId++;
    innerSteps.push({
      type: 'ExecutableStepDTO',
      stepOrder: stepInGroup,
      childStepId,
      stepType: { stepTypeId: 3, stepTypeKey: 'interval' },
      endCondition: { conditionTypeId: 2, conditionTypeKey: 'time' },
      endConditionValue: bloc.durSec,
      targetType: { workoutTargetTypeId: 1, workoutTargetTypeKey: 'no.target' },
    });

    // Recovery step (only if recup > 0)
    if (bloc.recup > 0) {
      stepInGroup++;
      childStepId++;
      innerSteps.push({
        type: 'ExecutableStepDTO',
        stepOrder: stepInGroup,
        childStepId,
        stepType: { stepTypeId: 4, stepTypeKey: 'recovery' },
        endCondition: { conditionTypeId: 2, conditionTypeKey: 'time' },
        endConditionValue: bloc.recup * 60,
        targetType: { workoutTargetTypeId: 1, workoutTargetTypeKey: 'no.target' },
      });
    }

    return {
      type: 'RepeatGroupDTO',
      stepOrder: groupOrder,
      numberOfIterations: bloc.reps,
      smartRepeat: false,
      endCondition: { conditionTypeId: 7, conditionTypeKey: 'iterations' },
      workoutSteps: innerSteps,
    };
  });

  const workoutPayload = {
    workoutName,
    sportType: { sportTypeId: 1, sportTypeKey: 'running' },
    workoutSegments: [{
      segmentOrder: 1,
      sportType: { sportTypeId: 1, sportTypeKey: 'running' },
      workoutSteps,
    }],
  };

  try {
    const res = await fetch('https://connect.garmin.com/workout-service/workout', {
      method: 'POST',
      headers: {
        'Cookie': sessionCookies,
        'Content-Type': 'application/json',
        'NK': 'NT',
        'X-app-ver': '4.70.2.1',
        'User-Agent': 'Mozilla/5.0 (compatible; Garmin Connect)',
        'Origin': 'https://connect.garmin.com',
        'Referer': 'https://connect.garmin.com/modern/workout/create/running',
      },
      body: JSON.stringify(workoutPayload),
    });

    if (res.status === 401) {
      return {
        statusCode: 401,
        headers: CORS,
        body: JSON.stringify({ error: 'Session expirée, reconnectez-vous' }),
      };
    }
    if (!res.ok) {
      return {
        statusCode: 502,
        headers: CORS,
        body: JSON.stringify({ error: 'Erreur création séance' }),
      };
    }

    const data = await res.json();
    return {
      statusCode: 200,
      headers: { ...CORS, 'Content-Type': 'application/json' },
      body: JSON.stringify({ workoutId: data.workoutId, workoutName: data.workoutName }),
    };

  } catch {
    return {
      statusCode: 500,
      headers: CORS,
      body: JSON.stringify({ error: 'Erreur création séance' }),
    };
  }
}
```

- [ ] **Step 2: Verify syntax**

```bash
node --input-type=module < netlify/functions/garmin-workout.js
```

Expected: No errors.

- [ ] **Step 3: Commit**

```bash
git add netlify/functions/garmin-workout.js
git commit -m "feat: add garmin-workout Netlify function (workout creation)"
```

---

## Task 4: Frontend — Garmin card UI + JS functions

**Files:**
- Modify: `index.html`

**What to add:**
1. CSS: `.btn-garmin` style (blue, like Garmin's brand) + `.garmin-status` text style
2. HTML: a new card "ENVOYER SUR GARMIN" between the Results card and the Export card, with two states (A: login form, B: connected)
3. JS: `garminConnect()`, `garminSend()`, `garminDisconnect()`, `initGarminUI()` functions
4. Relabel the `.fit` button from "Télécharger .fit (Garmin / Polar)" to "Télécharger .fit (Polar)"
5. Call `initGarminUI()` at page load (after the existing `addBloc()` call)

**localStorage keys:**
- `garmin_session_cookies` — cookie string passed to garmin-workout
- `garmin_expires_at` — Unix ms timestamp
- `garmin_email` — display only

### Step 1: Add CSS for Garmin card

Add these styles inside the `<style>` block, after `.btn-tcx { ... }`:

- [ ] **Step 1: Add CSS**

```css
    /* Garmin card */
    .btn-garmin {
      background: #1da462;
      color: #fff;
      border: none;
      border-radius: 8px;
      padding: 12px 18px;
      font-size: 0.95rem;
      font-weight: 600;
      cursor: pointer;
      width: 100%;
      margin-top: 8px;
    }
    .btn-garmin:active { transform: scale(0.98); }
    .btn-garmin:disabled { opacity: 0.35; cursor: not-allowed; }
    .btn-garmin-secondary {
      background: transparent;
      color: #6b7280;
      border: none;
      font-size: 0.82rem;
      cursor: pointer;
      margin-top: 6px;
      text-decoration: underline;
    }
    .garmin-status {
      font-size: 0.9rem;
      color: #1da462;
      font-weight: 600;
      margin-bottom: 10px;
    }
    #garmin-msg {
      font-size: 0.85rem;
      margin-top: 8px;
      min-height: 20px;
    }
    #garmin-msg a { color: #1da462; }
```

### Step 2: Add HTML card

Insert this new card **after the `<!-- Results -->` card and before the `<!-- Export -->` card** (between lines 209 and 211 in the current file):

- [ ] **Step 2: Add Garmin card HTML**

```html
    <!-- Garmin auto-send -->
    <div class="card" id="garmin-card">
      <h2>Envoyer sur Garmin</h2>

      <!-- State A: not connected -->
      <div id="garmin-state-a">
        <div class="field" style="margin-bottom:10px">
          <label for="garmin-email">Email</label>
          <input type="text" id="garmin-email" placeholder="user@example.com">
        </div>
        <div class="field" style="margin-bottom:10px">
          <label for="garmin-password">Mot de passe</label>
          <input type="password" id="garmin-password" placeholder="••••••••">
        </div>
        <button class="btn-garmin" id="btn-garmin-connect" onclick="garminConnect()">
          Connecter mon compte Garmin
        </button>
        <div id="garmin-msg"></div>
      </div>

      <!-- State B: connected -->
      <div id="garmin-state-b" style="display:none">
        <div class="garmin-status" id="garmin-connected-label"></div>
        <button class="btn-garmin" id="btn-garmin-send" onclick="garminSend()">
          ↑ Envoyer la séance sur Garmin
        </button>
        <br>
        <button class="btn-garmin-secondary" onclick="garminDisconnect()">Se déconnecter</button>
        <div id="garmin-msg-b"></div>
      </div>
    </div>
```

### Step 3: Add JS functions

Add these functions inside `<script>`, after the `downloadBlob` function and before the `getExportData` function:

- [ ] **Step 3: Add garminConnect(), garminSend(), garminDisconnect(), initGarminUI()**

```js
  // ─── Garmin Connect auto-send ─────────────────────────────────────────────

  function garminShowState(state) {
    document.getElementById('garmin-state-a').style.display = state === 'a' ? '' : 'none';
    document.getElementById('garmin-state-b').style.display = state === 'b' ? '' : 'none';
  }

  function garminSetMsg(id, html) {
    document.getElementById(id).innerHTML = html;
  }

  async function garminConnect() {
    const email    = document.getElementById('garmin-email').value.trim();
    const password = document.getElementById('garmin-password').value;
    if (!email || !password) {
      garminSetMsg('garmin-msg', '<span style="color:#ef4444">Entrez votre email et mot de passe</span>');
      return;
    }
    const btn = document.getElementById('btn-garmin-connect');
    btn.disabled = true;
    btn.textContent = 'Connexion…';
    garminSetMsg('garmin-msg', '');

    try {
      const res = await fetch('/.netlify/functions/garmin-login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password }),
      });
      const data = await res.json();
      if (!res.ok) {
        garminSetMsg('garmin-msg', `<span style="color:#ef4444">${data.error || 'Erreur'}</span>`);
        btn.disabled = false;
        btn.textContent = 'Connecter mon compte Garmin';
        return;
      }
      localStorage.setItem('garmin_session_cookies', data.sessionCookies);
      localStorage.setItem('garmin_expires_at', String(data.expiresAt));
      localStorage.setItem('garmin_email', email);
      document.getElementById('garmin-connected-label').textContent = `Connecté (${email})`;
      garminShowState('b');
    } catch {
      garminSetMsg('garmin-msg', '<span style="color:#ef4444">Erreur réseau, réessayez</span>');
      btn.disabled = false;
      btn.textContent = 'Connecter mon compte Garmin';
    }
  }

  async function garminSend() {
    const sessionCookies = localStorage.getItem('garmin_session_cookies');
    const expiresAt      = parseInt(localStorage.getItem('garmin_expires_at') || '0', 10);
    if (!sessionCookies || Date.now() >= expiresAt) {
      garminDisconnect();
      return;
    }

    const { name, vma, blocData } = getExportData();
    const workoutName = ('VMA - ' + name).slice(0, 30);
    const blocs = blocData.map(b => {
      const { timeS } = calcBlock(vma, b.pct, b.dist);
      return { ...b, durSec: Math.round(timeS) };
    });

    const btn = document.getElementById('btn-garmin-send');
    btn.disabled = true;
    btn.textContent = 'Envoi…';
    garminSetMsg('garmin-msg-b', '');

    try {
      const res = await fetch('/.netlify/functions/garmin-workout', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionCookies, workoutName, blocs }),
      });
      const data = await res.json();
      if (res.status === 401) {
        garminDisconnect();
        garminSetMsg('garmin-msg', '<span style="color:#ef4444">Session expirée, reconnectez-vous</span>');
        return;
      }
      if (!res.ok) {
        garminSetMsg('garmin-msg-b', `<span style="color:#ef4444">${data.error || 'Erreur'}</span>`);
        btn.disabled = false;
        btn.textContent = '↑ Envoyer la séance sur Garmin';
        return;
      }
      const link = `https://connect.garmin.com/modern/workout/${data.workoutId}`;
      garminSetMsg('garmin-msg-b',
        `Séance envoyée ! <a href="${link}" target="_blank" rel="noopener">Ouvrir dans Garmin Connect →</a>`
      );
    } catch {
      garminSetMsg('garmin-msg-b', '<span style="color:#ef4444">Erreur réseau, réessayez</span>');
    } finally {
      btn.disabled = false;
      btn.textContent = '↑ Envoyer la séance sur Garmin';
    }
  }

  function garminDisconnect() {
    localStorage.removeItem('garmin_session_cookies');
    localStorage.removeItem('garmin_expires_at');
    localStorage.removeItem('garmin_email');
    document.getElementById('garmin-email').value = '';
    document.getElementById('garmin-password').value = '';
    garminShowState('a');
  }

  function initGarminUI() {
    const expiresAt = parseInt(localStorage.getItem('garmin_expires_at') || '0', 10);
    if (expiresAt && Date.now() < expiresAt) {
      const email = localStorage.getItem('garmin_email') || '';
      document.getElementById('garmin-connected-label').textContent = `Connecté (${email})`;
      garminShowState('b');
    } else {
      localStorage.removeItem('garmin_session_cookies');
      localStorage.removeItem('garmin_expires_at');
      localStorage.removeItem('garmin_email');
      garminShowState('a');
    }
  }
```

### Step 4: Relabel .fit button

Change the text of `btn-fit` from:
```
↓ Télécharger .fit (Garmin / Polar)
```
to:
```
↓ Télécharger .fit (Polar)
```

- [ ] **Step 4: Edit btn-fit label in index.html**

Find line ~216:
```html
          ↓ Télécharger .fit (Garmin / Polar)
```
Replace with:
```html
          ↓ Télécharger .fit (Polar)
```

### Step 5: Call initGarminUI() at page load

- [ ] **Step 5: Add initGarminUI() call after addBloc()**

Find:
```js
    // Start with one bloc
    addBloc();
```
Add after:
```js
    initGarminUI();
```

### Step 6: Manual verification in browser

- [ ] **Step 6: Open index.html in browser and verify:**

1. Garmin card appears between Results and Export sections
2. State A (login form) shows on first load when no localStorage keys exist
3. The .fit button label now reads "Télécharger .fit (Polar)"
4. In browser console: `localStorage.setItem('garmin_expires_at', Date.now() + 3600000)` then reload → State B appears with "Connecté ()"
5. Click "Se déconnecter" → clears localStorage, switches back to State A
6. With a valid session (after deploying to Netlify): full connect → send flow works

- [ ] **Step 7: Commit**

```bash
git add index.html
git commit -m "feat: add Garmin Connect auto-send UI (Garmin card, 4 JS functions)"
```

---

## Task 5: End-to-end verification (local dev + Netlify deploy)

**Files:** none (verification only)

- [ ] **Step 1: Install netlify-cli globally if not present**

```bash
npm list -g netlify-cli || npm install -g netlify-cli
```

- [ ] **Step 2: Start local dev server**

```bash
netlify dev
```

Expected: Site available at `http://localhost:8888`, functions available at `http://localhost:8888/.netlify/functions/`.

- [ ] **Step 3: Test garmin-login with curl (use real credentials)**

```bash
curl -s -X POST http://localhost:8888/.netlify/functions/garmin-login \
  -H 'Content-Type: application/json' \
  -d '{"email":"YOUR_EMAIL","password":"YOUR_PASSWORD"}' | jq .
```

Expected on success:
```json
{"sessionCookies":"SESSIONID=xxx; ...", "expiresAt": 1711234567890}
```
Expected on bad credentials:
```json
{"error":"Identifiants incorrects"}
```

- [ ] **Step 4: Test garmin-workout with curl (use cookies from Step 3)**

```bash
curl -s -X POST http://localhost:8888/.netlify/functions/garmin-workout \
  -H 'Content-Type: application/json' \
  -d '{
    "sessionCookies": "SESSIONID=xxx; ...",
    "workoutName": "VMA - Test",
    "blocs": [{"reps":3,"dist":800,"pct":90,"recup":2,"durSec":229}]
  }' | jq .
```

Expected:
```json
{"workoutId": 12345678, "workoutName": "VMA - Test"}
```

- [ ] **Step 5: Verify workout appears on Garmin Connect**

Open `https://connect.garmin.com/modern/workout/{workoutId}` — should show the structured workout with 3 × interval + 1 recovery group.

- [ ] **Step 6: Push to GitHub and deploy on Netlify**

```bash
git push origin main
```

On Netlify dashboard:
- Connect repo `Mehdi-Mouilbeau/VMA_speed`
- Build command: (none)
- Publish directory: `.`
- After deploy: update `netlify.toml` `Access-Control-Allow-Origin` if the Netlify URL is different from `https://vma-speed.netlify.app`

- [ ] **Step 7: Final browser test on Netlify URL**

Open the live Netlify URL, fill in name + VMA + blocs, click "Connecter mon compte Garmin" with real credentials. After connecting, click "Envoyer la séance sur Garmin". Verify success message and link to Garmin Connect workout.

---

## Notes

- **CORS origin:** `netlify.toml` sets `Access-Control-Allow-Origin: https://vma-speed.netlify.app`. If the Netlify app URL differs, update this value and redeploy.
- **tough-cookie + http-cookie-agent:** The `garmin-login.js` uses `http-cookie-agent` to integrate `tough-cookie` with `node-fetch`. Both are listed in `package.json`.
- **node-fetch v3:** Uses ES module syntax (`import`). Netlify Functions with `esbuild` bundler support ES modules natively.
- **Password security:** `garmin-login.js` never logs or returns `email` or `password`. Only `sessionCookies` (already issued by Garmin) and `expiresAt` are returned.
- **Token expiry:** Session is valid ~24h. On expiry, `initGarminUI()` clears localStorage and shows the login form again. There is no refresh flow.
