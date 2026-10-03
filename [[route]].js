/**
 * GLMW Scout Calendar – Cloudflare Pages Functions API
 * Routes:
 *   GET    /api/events              → list all events (public)
 *   POST   /api/events              → create event (auth required)
 *   PUT    /api/events/:id          → update event (auth required)
 *   DELETE /api/events/:id          → delete event (auth required)
 *   GET    /api/districts           → list districts (public)
 *   POST   /api/districts           → create district (auth required)
 *   DELETE /api/districts/:id       → delete district (auth required)
 *   GET    /api/calendar.ics        → live ICS subscription feed (public)
 *   GET    /api/auth/google         → start Google OAuth
 *   GET    /api/auth/callback       → Google OAuth callback
 *   GET    /api/auth/me             → get current session
 *   POST   /api/auth/logout         → sign out
 */

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET,POST,PUT,DELETE,OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type,Authorization,X-Editor-Password',
};

// ── Response helpers ──────────────────────────────────────────
function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...CORS_HEADERS },
  });
}
function err(msg, status = 400) { return json({ error: msg }, status); }
function redirect(url, headers = {}) {
  return new Response(null, { status: 302, headers: { Location: url, ...headers } });
}

// ── Crypto helpers ────────────────────────────────────────────
function randomToken() {
  const buf = new Uint8Array(32);
  crypto.getRandomValues(buf);
  return Array.from(buf).map(b => b.toString(16).padStart(2, '0')).join('');
}
function nanoid() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 9);
}

// ── KV helpers ────────────────────────────────────────────────
async function kvList(kv, prefix) {
  const items = [];
  let cursor;
  do {
    const res = await kv.list({ prefix, ...(cursor ? { cursor } : {}), limit: 1000 });
    for (const key of res.keys) {
      const raw = await kv.get(key.name);
      if (raw) {
        try {
          const obj = JSON.parse(raw);
          obj.id = key.name.slice(prefix.length + 1); // strip "prefix:" 
          items.push(obj);
        } catch {}
      }
    }
    cursor = res.list_complete ? null : res.cursor;
  } while (cursor);
  return items;
}

// ── ICS builder ───────────────────────────────────────────────
function escICS(s) {
  return (s || '').replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/,/g, '\\,').replace(/;/g, '\\;');
}
function icsDate(s) {
  if (!s) return '';
  const [y, m, d] = s.split('-');
  return `${y}${m.padStart(2, '0')}${d.padStart(2, '0')}`;
}
function icsDatePlusOne(s) {
  const d = new Date(`${s}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(d.getUTCDate()).padStart(2, '0');
  return `${y}${m}${dd}`;
}
function buildICS(events, districts) {
  const distMap = Object.fromEntries(districts.map(d => [d.id, d.name]));
  const TYPE_LABEL = {
    national: 'National', county: 'County (GLMW)', training: 'Training',
    region: 'London Region', international: 'International', district: 'District',
  };
  const stamp = new Date().toISOString().replace(/[-:.]/g, '').slice(0, 15) + 'Z';

  let cal = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//GLMW Scouts//Calendar 2.0//EN',
    'X-WR-CALNAME:GLMW Scout Calendar 2026–27',
    'X-WR-CALDESC:Greater London Middlesex West Scout Calendar',
    'X-WR-TIMEZONE:Europe/London',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    'REFRESH-INTERVAL;VALUE=DURATION:PT6H',
    'X-PUBLISHED-TTL:PT6H',
    '',
  ].join('\r\n');

  for (const e of events) {
    if (!e.date) continue;
    const dtStart = icsDate(e.date);
    const dtEnd = e.endDate && e.endDate > e.date ? icsDate(e.endDate) : e.date;
    const dtEndExcl = icsDatePlusOne(e.endDate && e.endDate > e.date ? e.endDate : e.date);
    const dName = e.type === 'district' ? (distMap[e.district] || '') : '';
    const typeLabel = dName || TYPE_LABEL[e.type] || e.type;
    const summary = `[${typeLabel}] ${e.name}`;
    const desc = [e.notes, e.location ? `Location: ${e.location}` : ''].filter(Boolean).join(' | ');

    cal += [
      'BEGIN:VEVENT',
      `UID:glmw-${e.id}@glmwscouts.org.uk`,
      `DTSTAMP:${stamp}`,
      `DTSTART;VALUE=DATE:${dtStart}`,
      `DTEND;VALUE=DATE:${dtEndExcl}`,
      `SUMMARY:${escICS(summary)}`,
      e.location ? `LOCATION:${escICS(e.location)}` : '',
      desc ? `DESCRIPTION:${escICS(desc)}` : '',
      `CATEGORIES:${(e.type || '').toUpperCase()}`,
      `STATUS:CONFIRMED`,
      'END:VEVENT',
      '',
    ].filter(l => l !== '').join('\r\n');
  }
  cal += 'END:VCALENDAR';
  return cal;
}

// ── Auth ──────────────────────────────────────────────────────
async function getSession(request, env) {
  // Check Authorization header first
  const authHeader = request.headers.get('Authorization') || '';
  let token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;

  // Fall back to cookie
  if (!token) {
    const cookie = request.headers.get('Cookie') || '';
    token = cookie.match(/glmw_sess=([a-f0-9]{64})/)?.[1] || null;
  }
  if (!token) return null;

  const raw = await env.CALENDAR_KV.get(`sessions:${token}`);
  if (!raw) return null;
  const sess = JSON.parse(raw);
  if (sess.exp < Date.now()) {
    await env.CALENDAR_KV.delete(`sessions:${token}`);
    return null;
  }
  return { ...sess, token };
}

async function requireAuth(request, env) {
  const sess = await getSession(request, env);
  if (sess) return sess;
  // Password fallback
  const pw = request.headers.get('X-Editor-Password');
  if (pw && pw === env.EDITOR_PASSWORD) {
    return { email: 'editor@local', name: 'Editor (password)', role: 'editor' };
  }
  return null;
}

// ── Main handler ──────────────────────────────────────────────
export async function onRequest(context) {
  const { request, env, params } = context;
  const url = new URL(request.url);
  const route = (params.route || []).join('/');
  const method = request.method;

  if (method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS_HEADERS });

  // ── ICS feed ───────────────────────────────────────────────
  if (route === 'calendar.ics') {
    const [events, districts] = await Promise.all([
      kvList(env.CALENDAR_KV, 'events'),
      kvList(env.CALENDAR_KV, 'districts'),
    ]);
    events.sort((a, b) => (a.date || '').localeCompare(b.date || ''));
    return new Response(buildICS(events, districts), {
      headers: {
        'Content-Type': 'text/calendar; charset=utf-8',
        'Content-Disposition': 'attachment; filename="glmw-scouts-calendar.ics"',
        'Cache-Control': 'public, max-age=21600, stale-while-revalidate=3600',
        'Access-Control-Allow-Origin': '*',
      },
    });
  }

  // ── Events ─────────────────────────────────────────────────
  if (route === 'events') {
    if (method === 'GET') {
      const evts = await kvList(env.CALENDAR_KV, 'events');
      evts.sort((a, b) => (a.date || '').localeCompare(b.date || ''));
      return json(evts);
    }
    if (method === 'POST') {
      const sess = await requireAuth(request, env);
      if (!sess) return err('Unauthorised – please sign in', 401);
      let body;
      try { body = await request.json(); } catch { return err('Invalid JSON'); }
      if (!body.name?.trim()) return err('name is required');
      if (!body.date) return err('date is required');
      const id = nanoid();
      const event = {
        name: String(body.name).trim().slice(0, 100),
        date: String(body.date),
        endDate: String(body.endDate || ''),
        type: String(body.type || 'county'),
        district: String(body.district || ''),
        location: String(body.location || '').trim().slice(0, 120),
        notes: String(body.notes || '').trim().slice(0, 600),
        createdBy: sess.email,
        createdAt: new Date().toISOString(),
      };
      await env.CALENDAR_KV.put(`events:${id}`, JSON.stringify(event));
      return json({ id, ...event }, 201);
    }
  }

  // ── Event by ID ────────────────────────────────────────────
  const evtMatch = route.match(/^events\/([a-z0-9]+)$/);
  if (evtMatch) {
    const id = evtMatch[1];
    if (method === 'PUT') {
      const sess = await requireAuth(request, env);
      if (!sess) return err('Unauthorised', 401);
      const raw = await env.CALENDAR_KV.get(`events:${id}`);
      if (!raw) return err('Not found', 404);
      let body; try { body = await request.json(); } catch { return err('Invalid JSON'); }
      const existing = JSON.parse(raw);
      const event = {
        ...existing,
        name: String(body.name || existing.name).trim().slice(0, 100),
        date: String(body.date || existing.date),
        endDate: String(body.endDate ?? existing.endDate ?? ''),
        type: String(body.type || existing.type),
        district: String(body.district ?? existing.district ?? ''),
        location: String(body.location ?? existing.location ?? '').trim().slice(0, 120),
        notes: String(body.notes ?? existing.notes ?? '').trim().slice(0, 600),
        updatedBy: sess.email,
        updatedAt: new Date().toISOString(),
      };
      await env.CALENDAR_KV.put(`events:${id}`, JSON.stringify(event));
      return json({ id, ...event });
    }
    if (method === 'DELETE') {
      const sess = await requireAuth(request, env);
      if (!sess) return err('Unauthorised', 401);
      await env.CALENDAR_KV.delete(`events:${id}`);
      return json({ deleted: id });
    }
  }

  // ── Districts ──────────────────────────────────────────────
  if (route === 'districts') {
    if (method === 'GET') {
      const dists = await kvList(env.CALENDAR_KV, 'districts');
      dists.sort((a, b) => (a.name || '').localeCompare(b.name || ''));
      return json(dists);
    }
    if (method === 'POST') {
      const sess = await requireAuth(request, env);
      if (!sess) return err('Unauthorised', 401);
      let body; try { body = await request.json(); } catch { return err('Invalid JSON'); }
      if (!body.name?.trim()) return err('name is required');
      const id = nanoid();
      await env.CALENDAR_KV.put(`districts:${id}`, JSON.stringify({ name: String(body.name).trim().slice(0, 60) }));
      return json({ id, name: body.name }, 201);
    }
  }

  const distMatch = route.match(/^districts\/([a-z0-9]+)$/);
  if (distMatch && method === 'DELETE') {
    const sess = await requireAuth(request, env);
    if (!sess) return err('Unauthorised', 401);
    await env.CALENDAR_KV.delete(`districts:${distMatch[1]}`);
    return json({ deleted: distMatch[1] });
  }

  // ── Google OAuth ────────────────────────────────────────────
  if (route === 'auth/google') {
    if (!env.GOOGLE_CLIENT_ID) {
      return new Response('<html><body style="font-family:sans-serif;padding:40px"><h2>Google OAuth not configured</h2><p>Set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET as Wrangler secrets.</p><p><a href="/">← Back</a></p></body></html>', 
        { status: 503, headers: {'Content-Type':'text/html'} });
    }
    const state = randomToken();
    await env.CALENDAR_KV.put(`oauth_state:${state}`, '1', { expirationTtl: 300 });
    const p = new URLSearchParams({
      client_id: env.GOOGLE_CLIENT_ID,
      redirect_uri: `${env.SITE_URL}/api/auth/callback`,
      response_type: 'code',
      scope: 'openid email profile',
      state,
      hd: env.ALLOWED_DOMAIN,
      prompt: 'select_account',
    });
    return redirect(`https://accounts.google.com/o/oauth2/v2/auth?${p}`);
  }

  if (route === 'auth/callback') {
    const code = url.searchParams.get('code');
    const state = url.searchParams.get('state');
    if (!code || !state) return err('Missing OAuth parameters', 400);
    const stateOk = await env.CALENDAR_KV.get(`oauth_state:${state}`);
    if (!stateOk) return new Response(
      '<html><body style="font-family:sans-serif;padding:40px"><h2>Session expired</h2><p>Please <a href="/api/auth/google">try signing in again</a>.</p></body></html>',
      { status: 400, headers: {'Content-Type':'text/html'} });
    await env.CALENDAR_KV.delete(`oauth_state:${state}`);

    // Exchange code for tokens
    const tokRes = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code, client_id: env.GOOGLE_CLIENT_ID, client_secret: env.GOOGLE_CLIENT_SECRET,
        redirect_uri: `${env.SITE_URL}/api/auth/callback`, grant_type: 'authorization_code',
      }),
    });
    const tokens = await tokRes.json();
    if (!tokens.access_token) {
      return new Response('<html><body style="font-family:sans-serif;padding:40px"><h2>Sign-in failed</h2><p>Could not complete Google sign-in. <a href="/api/auth/google">Try again</a>.</p></body></html>',
        { status: 500, headers: {'Content-Type':'text/html'} });
    }

    // Get user info
    const userRes = await fetch('https://www.googleapis.com/oauth2/v3/userinfo', {
      headers: { Authorization: `Bearer ${tokens.access_token}` },
    });
    const user = await userRes.json();

    // Domain check
    if (!user.email?.endsWith(`@${env.ALLOWED_DOMAIN}`)) {
      return new Response(`
        <html><head><style>body{font-family:sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;background:#f1f3f4}
        .card{background:#fff;border-radius:12px;padding:32px;max-width:420px;text-align:center;box-shadow:0 4px 20px rgba(0,0,0,.15)}
        h2{color:#c5221f}p{color:#70757a;margin:12px 0}a{color:#7B3F8C}</style></head>
        <body><div class="card"><div style="font-size:3rem">🚫</div>
        <h2>Access Denied</h2>
        <p>Only <strong>@${env.ALLOWED_DOMAIN}</strong> accounts can edit this calendar.</p>
        <p>You signed in as <strong>${user.email}</strong>.</p>
        <p><a href="/">← Back to calendar</a></p></div></body></html>`,
        { status: 403, headers: { 'Content-Type': 'text/html' } });
    }

    // Create 24h session
    const token = randomToken();
    const sess = { email: user.email, name: user.name, picture: user.picture || '', exp: Date.now() + 86400000 };
    await env.CALENDAR_KV.put(`sessions:${token}`, JSON.stringify(sess), { expirationTtl: 86400 });

    return new Response(null, {
      status: 302,
      headers: {
        Location: '/',
        'Set-Cookie': `glmw_sess=${token}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=86400`,
      },
    });
  }

  if (route === 'auth/me') {
    const sess = await getSession(request, env);
    if (!sess) return json({ authenticated: false });
    return json({ authenticated: true, email: sess.email, name: sess.name, picture: sess.picture || '' });
  }

  if (route === 'auth/logout' && method === 'POST') {
    const sess = await getSession(request, env);
    if (sess?.token) await env.CALENDAR_KV.delete(`sessions:${sess.token}`);
    return new Response(null, {
      status: 302,
      headers: {
        Location: '/',
        'Set-Cookie': 'glmw_sess=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax',
      },
    });
  }

  return err('Not found', 404);
}
