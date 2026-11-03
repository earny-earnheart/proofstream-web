// ProofStream's thin Cloudflare Workers Static Assets front controller.
// The only routes configured for production are the apex and www custom domains.
const CANONICAL_HOST = 'proofstreamapp.com';
const CANONICAL_ORIGIN = 'https://' + CANONICAL_HOST;

// Registration gate: the workspace shell and its script require a signed cookie.
const COOKIE_NAME = 'ps_reg';
const COOKIE_MAX_AGE = 60 * 60 * 24 * 365;
const GATED_PATHS = new Set(['/', '/index.html', '/app.js']);
const REGISTER_PAGE = '/register';
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// Turnstile (the sign-up bot check) is the only third-party origin.
const TURNSTILE_ORIGIN = 'https://challenges.cloudflare.com';
const TURNSTILE_VERIFY_URL = TURNSTILE_ORIGIN + '/turnstile/v0/siteverify';

// Our own scripts are files on 'self'. Cloudflare's bot detection injects an inline
// script into HTML pages and copies the nonce it finds in this header onto it, so
// every response gets a fresh nonce. The waveform uses static CSS classes, so inline
// style blocks and attributes stay disabled.
function contentSecurityPolicy(nonce) {
  return [
    "default-src 'self'",
    "base-uri 'none'",
    "frame-ancestors 'none'",
    "object-src 'none'",
    "form-action 'self'",
    `script-src 'self' 'nonce-${nonce}' ${TURNSTILE_ORIGIN}`,
    `frame-src ${TURNSTILE_ORIGIN}`,
    "style-src 'self'",
    "style-src-attr 'none'",
    "img-src 'self'",
    "font-src 'self'",
    "connect-src 'self'",
  ].join('; ');
}

function newNonce() {
  return base64url(crypto.getRandomValues(new Uint8Array(16)));
}

function secureResponse(response, request) {
  // Copy rather than replace asset headers: content-type, etag and caching survive.
  const headers = new Headers(response.headers);
  headers.set('strict-transport-security', 'max-age=31536000; includeSubDomains');
  headers.set('x-content-type-options', 'nosniff');
  headers.set('x-frame-options', 'DENY');
  headers.set('referrer-policy', 'strict-origin-when-cross-origin');
  headers.set('permissions-policy', 'camera=(), microphone=(), geolocation=()');
  headers.set('content-security-policy', contentSecurityPolicy(newNonce()));
  if (new URL(request.url).hostname !== CANONICAL_HOST) {
    headers.set('x-robots-tag', 'noindex, nofollow');
  }
  return new Response(request.method === 'HEAD' ? null : response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

const json = (body, status = 200, extra = {}) =>
  Response.json(body, { status, headers: { 'cache-control': 'no-store', ...extra } });

function base64url(bytes) {
  return btoa(String.fromCharCode(...new Uint8Array(bytes))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function hmac(secret, value) {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return base64url(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(value)));
}

function sameString(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function readCookie(request, name) {
  for (const part of (request.headers.get('cookie') || '').split(';')) {
    const [key, ...rest] = part.trim().split('=');
    if (key === name) return rest.join('=');
  }
  return null;
}

// The signed payload is `<id>.<issued-at seconds>`. A missing secret or database fails
// closed, cookies expire server-side, and deleting a registration row revokes access.
// Returns the registration id the cookie proves, or null.
async function accountId(request, env) {
  const value = readCookie(request, COOKIE_NAME);
  if (!value || !env.SESSION_SECRET || !env.DB) return null;
  const dot = value.lastIndexOf('.');
  if (dot < 1) return null;
  const payload = value.slice(0, dot);
  if (!sameString(value.slice(dot + 1), await hmac(env.SESSION_SECRET, payload))) return null;
  const [id, issuedAt] = payload.split('.');
  const age = Math.floor(Date.now() / 1000) - Number(issuedAt);
  if (!id || !Number.isInteger(Number(issuedAt)) || age < 0 || age > COOKIE_MAX_AGE) return null;
  const row = await env.DB.prepare('SELECT id FROM registrations WHERE id = ?').bind(id).first();
  return row ? row.id : null;
}

const isRegistered = async (request, env) => Boolean(await accountId(request, env));

async function sessionCookie(env, id) {
  const payload = `${id}.${Math.floor(Date.now() / 1000)}`;
  const value = `${payload}.${await hmac(env.SESSION_SECRET, payload)}`;
  return `${COOKIE_NAME}=${value}; Max-Age=${COOKIE_MAX_AGE}; Path=/; HttpOnly; Secure; SameSite=Lax`;
}

async function readSubmission(request) {
  const type = request.headers.get('content-type') || '';
  if (type.includes('application/json')) return await request.json();
  if (type.includes('application/x-www-form-urlencoded') || type.includes('multipart/form-data')) {
    return Object.fromEntries(await request.formData());
  }
  return null;
}

// Every sign-in or sign-up must carry a Turnstile token that Cloudflare confirms.
// A missing secret fails closed, like a missing session secret.
async function passedTurnstile(request, env, token) {
  if (!token || typeof token !== 'string' || token.length > 2048) return false;
  const form = new FormData();
  form.append('secret', env.TURNSTILE_SECRET);
  form.append('response', token);
  const ip = request.headers.get('cf-connecting-ip');
  if (ip) form.append('remoteip', ip);
  try {
    const result = await (await fetch(TURNSTILE_VERIFY_URL, { method: 'POST', body: form })).json();
    return result.success === true && (!result.hostname || result.hostname === CANONICAL_HOST);
  } catch {
    return false;
  }
}

async function register(request, env) {
  if (request.headers.get('origin') !== CANONICAL_ORIGIN) {
    return json({ error: 'Cross-origin registration is not allowed.' }, 403);
  }
  if (!env.DB || !env.SESSION_SECRET || !env.TURNSTILE_SECRET) {
    return json({ error: 'Registration is temporarily unavailable.' }, 503);
  }
  let body;
  try { body = await readSubmission(request); } catch { body = null; }
  if (!body || typeof body !== 'object') return json({ error: 'Send the form as JSON or form data.' }, 400);

  // Bots fill every field; people never see this one. Answer as if it worked, set nothing.
  if (body.website) return json({ ok: true }, 200);

  if (!(await passedTurnstile(request, env, body['cf-turnstile-response']))) {
    return json({ error: 'The bot check did not pass. Please complete it and try again.' }, 403);
  }

  const email = String(body.email ?? '').trim().toLowerCase();
  const name = String(body.name ?? '').trim();
  if (email.length > 254 || !EMAIL_PATTERN.test(email)) return json({ error: 'Enter a valid email address.' }, 400);
  if (!name || name.length > 100) return json({ error: 'Enter your name (up to 100 characters).' }, 400);

  // Returning registrants get back in even while new registration is closed.
  const existing = await env.DB.prepare('SELECT id FROM registrations WHERE email = ?').bind(email).first();
  if (existing) {
    return json({ ok: true, returning: true }, 200, { 'set-cookie': await sessionCookie(env, existing.id) });
  }
  if (env.REGISTRATION_OPEN !== 'true') {
    return json({ error: 'Registration is closed right now.' }, 403);
  }
  const id = crypto.randomUUID();
  const userAgent = (request.headers.get('user-agent') || '').slice(0, 300);
  await env.DB.prepare('INSERT INTO registrations (id, email, name, created_at, user_agent) VALUES (?, ?, ?, ?, ?) ON CONFLICT(email) DO NOTHING')
    .bind(id, email, name, new Date().toISOString(), userAgent).run();
  // A concurrent request may have won the insert; always sign the stored id.
  const row = await env.DB.prepare('SELECT id FROM registrations WHERE email = ?').bind(email).first();
  const created = row.id === id;
  return json({ ok: true, returning: !created }, created ? 201 : 200, { 'set-cookie': await sessionCookie(env, row.id) });
}

// Project storage: each creator's projects live in D1 under their registration id, so
// they follow the account across devices and never mix between accounts. Every project
// is rebuilt from an allow-list of metadata fields, so nothing else (such as file
// contents) can be stored, whatever the client sends.
const PROJECT_PATH = /^\/api\/projects\/([A-Za-z0-9-]{1,64})$/;
const MAX_PROJECT_BYTES = 512 * 1024;
const MAX_PROJECTS = 500;
const MAX_MILESTONES = 2000;
const STAGES = new Set(['Draft', 'Revision', 'Final']);
const HASH_PATTERN = /^[a-f0-9]{64}$/;
const ID_PATTERN = /^[A-Za-z0-9-]{1,64}$/;

function text(value, max, { required = false } = {}) {
  if (value === undefined || value === null || value === '') {
    if (required) throw new Error('missing');
    return '';
  }
  if (typeof value !== 'string' || value.length > max) throw new Error('too long');
  return value;
}

function timestamp(value) {
  if (typeof value !== 'string' || value.length > 40 || Number.isNaN(Date.parse(value))) throw new Error('bad date');
  return value;
}

function cleanMilestone(m) {
  if (!m || typeof m !== 'object') throw new Error('bad milestone');
  if (!ID_PATTERN.test(m.id) || !STAGES.has(m.stage) || !HASH_PATTERN.test(m.hash)) throw new Error('bad milestone');
  if (!Number.isSafeInteger(m.fileSize) || m.fileSize < 0) throw new Error('bad size');
  return {
    id: m.id,
    title: text(m.title, 100, { required: true }),
    stage: m.stage,
    creator: text(m.creator, 100, { required: true }),
    fileName: text(m.fileName, 255, { required: true }),
    fileSize: m.fileSize,
    hash: m.hash,
    createdAt: timestamp(m.createdAt),
  };
}

function cleanProject(id, p) {
  if (!p || typeof p !== 'object' || p.id !== id || !Array.isArray(p.milestones)) throw new Error('bad project');
  if (p.milestones.length > MAX_MILESTONES) throw new Error('too many milestones');
  return {
    id,
    name: text(p.name, 80, { required: true }),
    category: text(p.category, 40, { required: true }),
    description: text(p.description, 300),
    createdAt: timestamp(p.createdAt),
    milestones: p.milestones.map(cleanMilestone),
  };
}

async function listProjects(env, account) {
  const { results } = await env.DB.prepare('SELECT data FROM projects WHERE account_id = ? ORDER BY created_at DESC')
    .bind(account).all();
  return json({ projects: results.map(r => JSON.parse(r.data)) });
}

async function saveProject(request, env, account, id) {
  if (request.headers.get('origin') !== CANONICAL_ORIGIN) return json({ error: 'Cross-origin writes are not allowed.' }, 403);
  if (!(request.headers.get('content-type') || '').includes('application/json')) return json({ error: 'Send the project as JSON.' }, 415);
  const raw = await request.text();
  if (raw.length > MAX_PROJECT_BYTES) return json({ error: 'This project is too large to save.' }, 413);
  let project;
  try { project = cleanProject(id, JSON.parse(raw)); } catch { return json({ error: 'The project record is not valid.' }, 400); }

  const exists = await env.DB.prepare('SELECT id FROM projects WHERE account_id = ? AND id = ?').bind(account, id).first();
  if (!exists) {
    const { n } = await env.DB.prepare('SELECT COUNT(*) AS n FROM projects WHERE account_id = ?').bind(account).first();
    if (n >= MAX_PROJECTS) return json({ error: 'You have reached the project limit.' }, 409);
  }
  const now = new Date().toISOString();
  await env.DB.prepare('INSERT INTO projects (account_id, id, data, created_at, updated_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(account_id, id) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at')
    .bind(account, id, JSON.stringify(project), project.createdAt, now).run();
  return json({ ok: true, project }, exists ? 200 : 201);
}

function logout(request) {
  if (request.headers.get('origin') !== CANONICAL_ORIGIN) return json({ error: 'Cross-origin requests are not allowed.' }, 403);
  return json({ ok: true }, 200, { 'set-cookie': `${COOKIE_NAME}=; Max-Age=0; Path=/; HttpOnly; Secure; SameSite=Lax` });
}

async function projectsApi(request, env, url) {
  const account = await accountId(request, env);
  if (!account) return json({ error: 'Sign in to use your workspace.' }, 401);
  const match = url.pathname.match(PROJECT_PATH);
  if (url.pathname === '/api/projects' && (request.method === 'GET' || request.method === 'HEAD')) return listProjects(env, account);
  if (match && request.method === 'PUT') return saveProject(request, env, account, match[1]);
  return json({ error: 'Not found.' }, 404);
}

async function serveAsset(request, env, path) {
  try {
    const target = path ? new Request(new URL(path, request.url), request) : request;
    return await env.ASSETS.fetch(target);
  } catch {
    return new Response('The site is temporarily unavailable. Please try again.\n', {
      status: 502,
      headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' },
    });
  }
}

// Gated responses differ per visitor, so shared caches must not reuse them.
function privateResponse(response) {
  const headers = new Headers(response.headers);
  if (headers.get('cache-control') !== 'no-store') headers.set('cache-control', 'private, no-cache');
  headers.set('vary', 'cookie');
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    let response;

    // 1. Keep the path and search string when redirecting www to the canonical host.
    if (url.hostname === 'www.proofstreamapp.com') {
      url.hostname = CANONICAL_HOST;
      url.protocol = 'https:';
      url.port = '';
      response = new Response(null, { status: 301, headers: { location: url.href } });
    // 2. Registration, sign-out and project saves are the only writes; everything else is GET/HEAD.
    } else if (url.pathname === '/api/register' && request.method === 'POST') {
      response = await register(request, env);
    } else if (url.pathname === '/api/logout' && request.method === 'POST') {
      response = logout(request);
    } else if (url.pathname === '/api/projects' || url.pathname.startsWith('/api/projects/')) {
      response = await projectsApi(request, env, url);
    } else if (request.method !== 'GET' && request.method !== 'HEAD') {
      response = new Response('Method not allowed\n', {
        status: 405,
        headers: { allow: 'GET, HEAD', 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' },
      });
    // 3. Health is a live response and must never be cached.
    } else if (url.pathname === '/health') {
      response = Response.json({ status: 'ok', service: 'proofstream-web', time: new Date().toISOString() }, {
        headers: { 'cache-control': 'no-store' },
      });
    } else if (url.pathname === '/api/session') {
      response = json({ registered: await isRegistered(request, env), registrationOpen: env.REGISTRATION_OPEN === 'true' });
    // 4. Hash-based in-page navigation does not depend on trailing HTTP slashes.
    } else if (url.pathname !== '/' && url.pathname.endsWith('/')) {
      url.pathname = url.pathname.replace(/\/+$/, '') || '/';
      response = new Response(null, { status: 301, headers: { location: url.href } });
    // 5. The workspace needs a registration; unregistered visitors get the sign-up page.
    } else if (GATED_PATHS.has(url.pathname)) {
      if (await isRegistered(request, env)) {
        response = privateResponse(await serveAsset(request, env));
      } else if (url.pathname === '/app.js') {
        response = new Response('Registration required\n', {
          status: 403,
          headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' },
        });
      } else {
        response = privateResponse(await serveAsset(request, env, REGISTER_PAGE));
      }
    // 6. Cloudflare serves the files, including a real 404 for unknown paths.
    } else {
      response = await serveAsset(request, env);
    }

    // 7. Security headers and non-canonical noindex apply to every response.
    return secureResponse(response, request);
  },
};
