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

// No third-party origins, inline scripts, eval, fonts or analytics are needed.
// The waveform uses static CSS classes, so inline style blocks and attributes
// can both remain disabled.
const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "base-uri 'none'",
  "frame-ancestors 'none'",
  "object-src 'none'",
  "form-action 'self'",
  "script-src 'self'",
  "style-src 'self'",
  "style-src-attr 'none'",
  "img-src 'self'",
  "font-src 'self'",
  "connect-src 'self'",
].join('; ');

function secureResponse(response, request) {
  // Copy rather than replace asset headers: content-type, etag and caching survive.
  const headers = new Headers(response.headers);
  headers.set('strict-transport-security', 'max-age=31536000; includeSubDomains');
  headers.set('x-content-type-options', 'nosniff');
  headers.set('x-frame-options', 'DENY');
  headers.set('referrer-policy', 'strict-origin-when-cross-origin');
  headers.set('permissions-policy', 'camera=(), microphone=(), geolocation=()');
  headers.set('content-security-policy', CONTENT_SECURITY_POLICY);
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

// A missing secret fails closed: nobody is treated as registered.
async function isRegistered(request, env) {
  const value = readCookie(request, COOKIE_NAME);
  if (!value || !env.SESSION_SECRET) return false;
  const dot = value.lastIndexOf('.');
  if (dot < 1) return false;
  return sameString(value.slice(dot + 1), await hmac(env.SESSION_SECRET, value.slice(0, dot)));
}

async function sessionCookie(env, id) {
  const value = `${id}.${await hmac(env.SESSION_SECRET, id)}`;
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

async function register(request, env) {
  if (request.headers.get('origin') !== CANONICAL_ORIGIN) {
    return json({ error: 'Cross-origin registration is not allowed.' }, 403);
  }
  if (!env.DB || !env.SESSION_SECRET) {
    return json({ error: 'Registration is temporarily unavailable.' }, 503);
  }
  let body;
  try { body = await readSubmission(request); } catch { body = null; }
  if (!body || typeof body !== 'object') return json({ error: 'Send the form as JSON or form data.' }, 400);

  // Bots fill every field; people never see this one. Answer as if it worked, set nothing.
  if (body.website) return json({ ok: true }, 200);

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
    // 2. Registration is the only write; everything else is GET/HEAD.
    } else if (url.pathname === '/api/register' && request.method === 'POST') {
      response = await register(request, env);
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
