# GLMW Scout Calendar v2 — Cloudflare Deployment

## What's in this package
| File | Purpose |
|------|---------|
| `public/index.html` | Full calendar frontend (no build needed) |
| `public/glmw-logo.png` | GLMW Scouts logo |
| `public/google-cal-logo.png` | Google Calendar icon |
| `public/outlook-logo.png` | Outlook icon |
| `public/apple-cal-logo.png` | Apple Calendar icon |
| `functions/api/[[route]].js` | Cloudflare Pages Function (API + ICS feed) |
| `wrangler.toml` | Cloudflare config |
| `package.json` | Scripts |

---

## Prerequisites
- [Node.js 18+](https://nodejs.org) (LTS)
- A Cloudflare account (free tier works)
- A Google Cloud project (for OAuth — optional but recommended)

---

## Step 1 — Install Wrangler
```bash
cd glmw-calendar-v2
npm install
npx wrangler login
```

---

## Step 2 — Create KV namespace
```bash
npx wrangler kv namespace create CALENDAR_KV
npx wrangler kv namespace create CALENDAR_KV --preview
```
Copy the two `id` values printed and paste into `wrangler.toml`:
```toml
[[kv_namespaces]]
binding = "CALENDAR_KV"
id = "paste-your-id-here"
preview_id = "paste-your-preview-id-here"
```

---

## Step 3 — Set Google OAuth secrets (optional but recommended)

### Create OAuth credentials
1. Go to https://console.cloud.google.com
2. **New project** → APIs & Services → **Credentials**
3. Create credentials → **OAuth 2.0 Client ID** → Web application
4. Authorised redirect URIs:
   - `https://glmw-calendar.pages.dev/api/auth/callback`
   - `http://localhost:8788/api/auth/callback` (local dev)
5. Copy the Client ID and Client Secret

### Add as secrets (never put in wrangler.toml)
```bash
npx wrangler secret put GOOGLE_CLIENT_ID
npx wrangler secret put GOOGLE_CLIENT_SECRET
```

---

## Step 4 — Update your domain in wrangler.toml
```toml
[vars]
SITE_URL = "https://glmw-calendar.pages.dev"  # or your custom domain
```

---

## Step 5 — Deploy
```bash
npx wrangler pages deploy public --project-name glmw-calendar
```

Cloudflare prints your live URL, e.g. `https://glmw-calendar.pages.dev`

---

## Step 6 — Add custom domain (optional)
1. Cloudflare dashboard → Pages → glmw-calendar → **Custom domains**
2. Add `calendar.glmwscouts.org.uk`
3. Update `SITE_URL` in wrangler.toml and redeploy

---

## Step 7 — Migrate events from the claude.ai version
Sign in to the deployed calendar with your `@glmwscouts.org.uk` Google account.
Add events via the **＋ Add Event** button, or ask for a migration script.

---

## Local development
```bash
npm run dev
# → http://localhost:8788
```

---

## Calendar subscription URLs (after deploy)
| App | Action |
|-----|--------|
| Google Calendar | Click "Subscribe" tab → Google Calendar button |
| Apple Calendar | Click "Subscribe" tab → Apple Calendar button |
| Outlook | Click "Subscribe" tab → Outlook button |
| Direct ICS URL | `https://calendar.glmwscouts.org.uk/api/calendar.ics` |

The ICS feed refreshes every **6 hours** in subscribed apps.

---

## How editing works
- Visitors see the full calendar (read-only)
- Clicking **🔑 Login to edit** → Google OAuth → only `@glmwscouts.org.uk` accounts proceed
- Sessions last 24 hours (stored in KV, HttpOnly cookie)
- Editors see **＋ Add Event** and can edit/delete any event
