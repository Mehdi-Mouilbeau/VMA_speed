# Garmin Connect Auto-Send — Design Spec

**Date:** 2026-03-25
**Status:** Approved

---

## Overview

Add automated Garmin Connect workout creation to the existing VMA calculator. The athlete enters their Garmin credentials once, a Netlify serverless function logs in on their behalf (using Garmin's unofficial internal SSO flow) and creates the structured workout directly on their Garmin Connect account. The session token is cached in localStorage so subsequent sends require no re-authentication.

Polar keeps the existing `.fit` file download (manual import via Polar Flow, button relabelled "Polar uniquement").
Huawei keeps the existing `.tcx` file download.

---

## User Flow

1. Athlete fills in their VMA and training session as before
2. In the "Envoyer sur Garmin" section, enters their Garmin email + password (`type="password"`, never visible)
3. Clicks "Connecter" — credentials sent over HTTPS to `garmin-login` Netlify Function
4. Function logs into Garmin SSO (4-step flow, see below), receives session cookies
5. Session cookies returned to frontend, stored in localStorage with an expiry timestamp — credentials never stored
6. UI switches: email/password fields hidden, "Envoyer la séance" button shown, email displayed ("Connecté en tant que user@email.com")
7. Athlete clicks "Envoyer la séance" → workout JSON POSTed to `garmin-workout` function → created on Garmin Connect
8. Success message: "✅ Séance envoyée !" with link `https://connect.garmin.com/modern/workout/{workoutId}`

On subsequent visits: if token in localStorage is still valid (expiry not reached), steps 2–6 are skipped.

---

## Architecture

```
Netlify (static hosting + serverless functions)
├── index.html                      ← frontend (existing VMA calculator)
└── netlify/
    └── functions/
        ├── garmin-login.js         ← authenticate with Garmin SSO (4 steps)
        └── garmin-workout.js       ← create workout via Connect API
```

No environment variables needed — no registered OAuth credentials required.
CORS policy: `Access-Control-Allow-Origin` restricted to the Netlify site's own origin (not wildcard).

---

## Netlify Functions

### `garmin-login.js`

**Input (POST body, JSON):**
```json
{ "email": "user@example.com", "password": "secret" }
```

**4-step SSO flow** (based on Garmin Connect web app's internal flow):

**Step 1 — Fetch CSRF token**
```
GET https://sso.garmin.com/sso/signin
  ?service=https%3A%2F%2Fconnect.garmin.com%2Fmodern%2F
  &gauthHost=https%3A%2F%2Fsso.garmin.com
  &embed=false
Headers:
  User-Agent: Mozilla/5.0 (compatible; Garmin Connect)
  Origin: https://sso.garmin.com
```
→ Extract `_csrf` value from HTML response body (hidden input field)
→ Extract `GARMIN-SSO-GUID` cookie from response `Set-Cookie` header

**Step 2 — Submit credentials**
```
POST https://sso.garmin.com/sso/signin
Content-Type: application/x-www-form-urlencoded
Cookie: GARMIN-SSO-GUID={value from Step 1}
User-Agent: Mozilla/5.0 (compatible; Garmin Connect)
Origin: https://sso.garmin.com
Referer: https://sso.garmin.com/sso/signin

Body (form-urlencoded):
  username={email}
  password={password}
  _csrf={value from Step 1}
  embed=false
  gauthHost=https://sso.garmin.com
  service=https://connect.garmin.com/modern/
```
→ Follow redirect chain (all hops must go through the `tough-cookie` jar so cookies are preserved across redirects). Extract service ticket from the final URL: `?ticket=ST-...`

**Step 3 — Exchange ticket for session**
```
GET https://connect.garmin.com/modern/di-oauth/exchange?ticket={ST-...}
User-Agent: Mozilla/5.0 (compatible; Garmin Connect)
Origin: https://connect.garmin.com
Referer: https://connect.garmin.com/modern/
```
→ Response sets session cookies (`SESSIONID`, `CONSUMER_DIRECT_SESSIONID`, etc.)
→ Collect all `Set-Cookie` values for use in Step 4

**Step 4 — Fetch access token**
```
GET https://connect.garmin.com/modern/proxy/userprofile-service/socialProfile
Cookie: {all cookies from Step 3}
NK: NT
User-Agent: Mozilla/5.0 (compatible; Garmin Connect)
Origin: https://connect.garmin.com
```
→ If 200: session is valid. Return the full cookie string + a computed expiry timestamp (now + 24h) to the frontend.

**Important implementation note:** Use a cookie jar (Node.js `tough-cookie` package) across all 4 steps to correctly propagate cookies between requests. Standard `fetch` discards cookies between calls.

**Output (success):**
```json
{
  "sessionCookies": "SESSIONID=xxx; CONSUMER_DIRECT_SESSIONID=yyy; ...",
  "expiresAt": 1711234567890
}
```
Credentials (`email`, `password`) are never logged or included in any response.

**Output (error):**
```json
{ "error": "Identifiants incorrects" }        // 403 from Garmin
{ "error": "Erreur Garmin, réessayez" }       // other failures
```

**Security:**
- HTTPS only
- No `console.log` of request body or passwords
- Stateless — no server-side storage
- Rate limiting: not configurable via `netlify.toml` on the free Netlify tier — requires Netlify Pro (paid) or dashboard "Traffic Rules". Out of scope for this project.

---

### `garmin-workout.js`

**Input (POST body, JSON):**
```json
{
  "sessionCookies": "SESSIONID=xxx; ...",
  "workoutName": "VMA - Mehdi",
  "blocs": [
    { "reps": 3, "dist": 800, "pct": 90, "recup": 2, "durSec": 229 },
    { "reps": 3, "dist": 400, "pct": 105, "recup": 2, "durSec": 98 }
  ]
}
```
Note: `durSec = Math.round(timeS)` is computed by the frontend before sending. The function uses the integer directly as `endConditionValue`.

**Garmin Connect API call:**
```
POST https://connect.garmin.com/workout-service/workout
Cookie: {sessionCookies}
Content-Type: application/json
NK: NT
X-app-ver: 4.70.2.1
User-Agent: Mozilla/5.0 (compatible; Garmin Connect)
Origin: https://connect.garmin.com
Referer: https://connect.garmin.com/modern/workout/create/running
```

**Garmin workout JSON structure:**

- `stepOrder` on `RepeatGroupDTO`: ordinal among top-level steps (1, 2, 3...)
- `stepOrder` on `ExecutableStepDTO`: position within its parent group's `workoutSteps` array (restarts at 1 for each group)
- `childStepId`: global counter across ALL `ExecutableStepDTO` leaf nodes in the segment, starting at 1

Example for 2 blocs:
```json
{
  "workoutName": "VMA - Mehdi",
  "sportType": { "sportTypeId": 1, "sportTypeKey": "running" },
  "workoutSegments": [{
    "segmentOrder": 1,
    "sportType": { "sportTypeId": 1, "sportTypeKey": "running" },
    "workoutSteps": [
      {
        "type": "RepeatGroupDTO",
        "stepOrder": 1,
        "numberOfIterations": 3,
        "smartRepeat": false,
        "endCondition": { "conditionTypeId": 7, "conditionTypeKey": "iterations" },
        "workoutSteps": [
          {
            "type": "ExecutableStepDTO",
            "stepOrder": 1,
            "childStepId": 1,
            "stepType": { "stepTypeId": 3, "stepTypeKey": "interval" },
            "endCondition": { "conditionTypeId": 2, "conditionTypeKey": "time" },
            "endConditionValue": 229,
            "targetType": { "workoutTargetTypeId": 1, "workoutTargetTypeKey": "no.target" }
          },
          {
            "type": "ExecutableStepDTO",
            "stepOrder": 2,
            "childStepId": 2,
            "stepType": { "stepTypeId": 4, "stepTypeKey": "recovery" },
            "endCondition": { "conditionTypeId": 2, "conditionTypeKey": "time" },
            "endConditionValue": 120,
            "targetType": { "workoutTargetTypeId": 1, "workoutTargetTypeKey": "no.target" }
          }
        ]
      },
      {
        "type": "RepeatGroupDTO",
        "stepOrder": 2,
        "numberOfIterations": 3,
        "smartRepeat": false,
        "endCondition": { "conditionTypeId": 7, "conditionTypeKey": "iterations" },
        "workoutSteps": [
          {
            "type": "ExecutableStepDTO",
            "stepOrder": 1,
            "childStepId": 3,
            "stepType": { "stepTypeId": 3, "stepTypeKey": "interval" },
            "endCondition": { "conditionTypeId": 2, "conditionTypeKey": "time" },
            "endConditionValue": 98,
            "targetType": { "workoutTargetTypeId": 1, "workoutTargetTypeKey": "no.target" }
          },
          {
            "type": "ExecutableStepDTO",
            "stepOrder": 2,
            "childStepId": 4,
            "stepType": { "stepTypeId": 4, "stepTypeKey": "recovery" },
            "endCondition": { "conditionTypeId": 2, "conditionTypeKey": "time" },
            "endConditionValue": 120,
            "targetType": { "workoutTargetTypeId": 1, "workoutTargetTypeKey": "no.target" }
          }
        ]
      }
    ]
  }]
}
```

If `recup = 0` for a bloc, its recovery `ExecutableStepDTO` is omitted. The `childStepId` counter does NOT skip — the next leaf step takes the next consecutive integer. Example: if bloc 1 has `recup=0`, bloc 1 active gets `childStepId: 1`, bloc 2 active gets `childStepId: 2` (no gap for the missing recovery).

**Output (success):**
```json
{ "workoutId": 12345678, "workoutName": "VMA - Mehdi" }
```
Frontend constructs workout link as: `https://connect.garmin.com/modern/workout/{workoutId}`

**Output (error):**
```json
{ "error": "Session expirée, reconnectez-vous" }   // 401
{ "error": "Erreur création séance" }              // other
```

---

## Frontend Changes (index.html)

### New "Envoyer sur Garmin" card

Added below the results section, above export buttons.

**State A — not connected:**
```
┌─────────────────────────────────────────┐
│  ENVOYER SUR GARMIN                     │
│  Email : [____________]  type="text"    │
│  Mot de passe : [______]  type="password"│
│  [🔗 Connecter mon compte Garmin]       │
└─────────────────────────────────────────┘
```

**State B — connected (token valid):**
```
┌─────────────────────────────────────────┐
│  ENVOYER SUR GARMIN                     │
│  ✅ Connecté (user@email.com)           │
│  [↑ Envoyer la séance sur Garmin]       │
│  [Se déconnecter]                       │
└─────────────────────────────────────────┘
```

### localStorage keys
- `garmin_session_cookies` — full cookie string for API calls
- `garmin_expires_at` — Unix timestamp (ms) for expiry check
- `garmin_email` — display only (shown in State B)

Password is **never** stored anywhere.

### JS functions added to index.html
- `garminConnect()` — POSTs to `garmin-login`, stores tokens + expiry + email, switches to State B
- `garminSend()` — POSTs to `garmin-workout` with current form data (`durSec = Math.round(timeS)` computed here) + stored cookies
- `garminDisconnect()` — clears all 3 localStorage keys, resets to State A
- `initGarminUI()` — on page load: if `garmin_expires_at` exists and `Date.now() < garmin_expires_at`, show State B; otherwise clear keys and show State A

### Error handling
- 401 from `garmin-workout`: show "Session expirée, reconnectez-vous", clear keys, switch to State A
- Network error: show "Erreur réseau, réessayez"
- Success: show "✅ Séance envoyée ! [Ouvrir dans Garmin Connect →]" (link to `https://connect.garmin.com/modern/workout/{workoutId}`)

---

## `.fit` Button Relabelling

The existing `.fit` download button label is updated from "Télécharger .fit (Garmin / Polar)" to "Télécharger .fit (Polar)" since Garmin now has its own dedicated send flow.

---

## Deployment (Migration from GitHub Pages to Netlify)

1. Connect Netlify to GitHub repo `Mehdi-Mouilbeau/VMA_speed`
2. Build settings: no build command, publish directory = `.` (root)
3. Add `netlify.toml` at repo root with rate limiting for `garmin-login`:
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
4. Install `tough-cookie` as a dependency for `garmin-login.js` (cookie jar handling)
5. `package.json` at repo root:
```json
{
  "dependencies": {
    "tough-cookie": "^4.1.3",
    "node-fetch": "^3.3.2"
  }
}
```

---

## Polar & Huawei (unchanged)

- **Polar**: `.fit` download button (relabelled "Polar uniquement"), manual import via Polar Flow web
- **Huawei**: `.tcx` download button, manual import via Huawei Health app

---

## Out of Scope

- Token refresh (token expires after ~24h, user re-enters credentials)
- Multi-user accounts or club admin features
- Garmin device push (handled by Garmin Connect app after workout creation)
- Polar API integration (deferred until `.fit` import is tested)
- MFA / 2-factor authentication on Garmin accounts
