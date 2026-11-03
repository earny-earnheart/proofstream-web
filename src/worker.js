// ProofStream's thin Cloudflare Workers Static Assets front controller.
// The only routes configured for production are the apex and www custom domains.
const CANONICAL_HOST = 'proofstreamapp.com';
const CANONICAL_ORIGIN = 'https://' + CANONICAL_HOST;

// Registration gate: the workspace shell and its script require a signed cookie.
// Renamed from ps_reg: cookies issued by the old email-only sign-up are no longer accepted.
const COOKIE_NAME = 'ps_session';
const COOKIE_MAX_AGE = 60 * 60 * 24 * 365;
const GATED_PATHS = new Set(['/', '/index.html', '/app.js']);
const REGISTER_PAGE = '/register';
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// Turnstile (the bot check) is the only third-party origin pages load from. Google
// sign-in is a top-level redirect, so the CSP needs no Google origins.
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

// Sessions. The signed payload is `<id>.<session version>.<issued-at seconds>`. A missing
// secret or database fails closed, cookies expire server-side, deleting a registration
// row revokes access, and bumping `session_version` signs that account out everywhere.
// Returns the registration id the cookie proves, or null.
async function accountId(request, env) {
  const value = readCookie(request, COOKIE_NAME);
  if (!value || !env.SESSION_SECRET || !env.DB) return null;
  const dot = value.lastIndexOf('.');
  if (dot < 1) return null;
  const payload = value.slice(0, dot);
  if (!sameString(value.slice(dot + 1), await hmac(env.SESSION_SECRET, payload))) return null;
  const [id, version, issuedAt] = payload.split('.');
  const age = Math.floor(Date.now() / 1000) - Number(issuedAt);
  if (!id || !Number.isInteger(Number(issuedAt)) || age < 0 || age > COOKIE_MAX_AGE) return null;
  const row = await env.DB.prepare('SELECT id, session_version FROM registrations WHERE id = ?').bind(id).first();
  return row && String(row.session_version) === version ? row.id : null;
}

const isRegistered = async (request, env) => Boolean(await accountId(request, env));

async function sessionCookie(env, id) {
  const row = await env.DB.prepare('SELECT session_version FROM registrations WHERE id = ?').bind(id).first();
  const payload = `${id}.${row.session_version}.${Math.floor(Date.now() / 1000)}`;
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

// Every password sign-up or sign-in must carry a Turnstile token that Cloudflare
// confirms, which also slows password guessing. A missing secret fails closed.
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

// Passwords are stored as salted PBKDF2-SHA256 at 100,000 iterations, the most the
// Workers runtime allows: `pbkdf2-sha256$<iterations>$<salt>$<hash>`.
const PBKDF2_ITERATIONS = 100000;
const PASSWORD_MIN = 10;
const PASSWORD_MAX = 128;

function fromBase64url(text) {
  return Uint8Array.from(atob(text.replace(/-/g, '+').replace(/_/g, '/')), c => c.charCodeAt(0));
}

async function pbkdf2(password, salt, iterations) {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveBits']);
  return base64url(await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations }, key, 256));
}

async function hashPassword(password) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  return `pbkdf2-sha256$${PBKDF2_ITERATIONS}$${base64url(salt)}$${await pbkdf2(password, salt, PBKDF2_ITERATIONS)}`;
}

async function checkPassword(password, stored) {
  const [scheme, iterations, salt, hash] = String(stored).split('$');
  if (scheme !== 'pbkdf2-sha256' || !Number.isInteger(Number(iterations)) || !salt || !hash) return false;
  return sameString(await pbkdf2(password, fromBase64url(salt), Number(iterations)), hash);
}

const validPassword = password => typeof password === 'string' && password.length >= PASSWORD_MIN && password.length <= PASSWORD_MAX;

// Shared checks for the password forms: same origin, configured, parseable, not the
// honeypot, and Turnstile passed. Returns { body } or { response } to send instead.
async function passwordForm(request, env) {
  if (request.headers.get('origin') !== CANONICAL_ORIGIN) {
    return { response: json({ error: 'Cross-origin sign-in is not allowed.' }, 403) };
  }
  if (!env.DB || !env.SESSION_SECRET || !env.TURNSTILE_SECRET) {
    return { response: json({ error: 'Sign-in is temporarily unavailable.' }, 503) };
  }
  let body;
  try { body = await readSubmission(request); } catch { body = null; }
  if (!body || typeof body !== 'object') return { response: json({ error: 'Send the form as JSON or form data.' }, 400) };
  // Bots fill every field; people never see this one. Answer as if it worked, set nothing.
  if (body.website) return { response: json({ ok: true }, 200) };
  if (!(await passedTurnstile(request, env, body['cf-turnstile-response']))) {
    return { response: json({ error: 'The bot check did not pass. Please complete it and try again.' }, 403) };
  }
  return { body };
}

// Creates an email-and-password account. A registration left over from the earlier
// email-only sign-up (no password, no Google link) can be claimed with a password.
// Such accounts stay unverified, so a later Google sign-in with that email takes them
// over and removes the password (see googleCallback).
async function register(request, env) {
  const { body, response } = await passwordForm(request, env);
  if (response) return response;
  const email = String(body.email ?? '').trim().toLowerCase();
  const name = String(body.name ?? '').trim();
  if (email.length > 254 || !EMAIL_PATTERN.test(email)) return json({ error: 'Enter a valid email address.' }, 400);
  if (!name || name.length > 100) return json({ error: 'Enter your name (up to 100 characters).' }, 400);
  if (!validPassword(body.password)) {
    return json({ error: `Choose a password of ${PASSWORD_MIN} to ${PASSWORD_MAX} characters.` }, 400);
  }
  const taken = json({ error: 'An account with this email already exists. Sign in instead.' }, 409);
  const existing = await env.DB.prepare('SELECT id, password_hash, (SELECT COUNT(*) FROM identities WHERE account_id = registrations.id) AS linked FROM registrations WHERE email = ?')
    .bind(email).first();
  if (existing) {
    if (existing.password_hash || existing.linked) return taken;
    // The UPDATE re-checks every condition, so a Google sign-in that verifies or links
    // this account between the SELECT above and here wins and no password is set.
    const claimed = await env.DB.prepare('UPDATE registrations SET password_hash = ?, session_version = session_version + 1 WHERE id = ? AND password_hash IS NULL AND email_verified = 0 AND NOT EXISTS (SELECT 1 FROM identities WHERE account_id = registrations.id) RETURNING id')
      .bind(await hashPassword(body.password), existing.id).first();
    if (!claimed) return taken;
    return json({ ok: true, returning: true }, 200, { 'set-cookie': await sessionCookie(env, existing.id) });
  }
  if (env.REGISTRATION_OPEN !== 'true') return json({ error: 'Registration is closed right now.' }, 403);
  const id = crypto.randomUUID();
  const userAgent = (request.headers.get('user-agent') || '').slice(0, 300);
  await env.DB.prepare('INSERT INTO registrations (id, email, name, created_at, user_agent, password_hash) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(email) DO NOTHING')
    .bind(id, email, name, new Date().toISOString(), userAgent, await hashPassword(body.password)).run();
  // A concurrent request may have won the insert; that account is not ours to sign into.
  const row = await env.DB.prepare('SELECT id FROM registrations WHERE email = ?').bind(email).first();
  if (row.id !== id) return taken;
  return json({ ok: true, returning: false }, 201, { 'set-cookie': await sessionCookie(env, id) });
}

async function login(request, env) {
  const { body, response } = await passwordForm(request, env);
  if (response) return response;
  const email = String(body.email ?? '').trim().toLowerCase();
  const password = typeof body.password === 'string' ? body.password.slice(0, PASSWORD_MAX) : '';
  const row = email.length <= 254
    ? await env.DB.prepare('SELECT id, password_hash FROM registrations WHERE email = ?').bind(email).first()
    : null;
  // Hash even when there is no password to compare, so timing does not reveal accounts.
  const ok = row?.password_hash ? await checkPassword(password, row.password_hash) : (await hashPassword(password), false);
  if (!ok) return json({ error: 'That email and password do not match an account. Accounts made with Google sign in with Google.' }, 401);
  return json({ ok: true }, 200, { 'set-cookie': await sessionCookie(env, row.id) });
}

// Google sign-in: the OAuth authorization-code flow with PKCE. The state and code
// verifier travel in a short-lived signed cookie scoped to /auth/google. Google's token
// endpoint is called directly over TLS, so its ID token can be read without checking
// its signature (OpenID Connect Core 3.1.3.7); its audience, issuer, expiry and
// email_verified flag are still checked. Only verified emails are accepted.
// Google vouches for who currently owns an email only for Gmail addresses and for Google
// Workspace accounts whose `hd` claim matches the email's domain. Other addresses may
// have been verified long ago, so they can open a new account but never take over or
// link to an existing one, and a later sign-in that Google does vouch for replaces them.
const GOOGLE_AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
const GOOGLE_ISSUERS = new Set(['https://accounts.google.com', 'accounts.google.com']);
const GOOGLE_REDIRECT = CANONICAL_ORIGIN + '/auth/google/callback';
const OAUTH_COOKIE = 'ps_oauth';
const OAUTH_MAX_AGE = 600;

const googleEnabled = env => Boolean(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET && env.SESSION_SECRET && env.DB);

function redirect(location, cookies = []) {
  const headers = new Headers({ location, 'cache-control': 'no-store' });
  for (const cookie of cookies) headers.append('set-cookie', cookie);
  return new Response(null, { status: 302, headers });
}

const oauthCookie = (value, maxAge) => `${OAUTH_COOKIE}=${value}; Max-Age=${maxAge}; Path=/auth/google; HttpOnly; Secure; SameSite=Lax`;
const authFailed = reason => redirect('/?auth=' + reason, [oauthCookie('', 0)]);

async function googleStart(env) {
  if (!googleEnabled(env)) return redirect('/?auth=unavailable');
  const random = () => base64url(crypto.getRandomValues(new Uint8Array(32)));
  const state = random();
  const verifier = random();
  const challenge = base64url(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier)));
  const payload = `${state}.${verifier}.${Math.floor(Date.now() / 1000)}`;
  const target = new URL(GOOGLE_AUTH_URL);
  target.search = new URLSearchParams({
    client_id: env.GOOGLE_CLIENT_ID,
    redirect_uri: GOOGLE_REDIRECT,
    response_type: 'code',
    scope: 'openid email profile',
    state,
    code_challenge: challenge,
    code_challenge_method: 'S256',
    prompt: 'select_account',
  });
  return redirect(target.href, [oauthCookie(`${payload}.${await hmac(env.SESSION_SECRET, payload)}`, OAUTH_MAX_AGE)]);
}

async function googleProfile(env, code, verifier) {
  try {
    const response = await fetch(GOOGLE_TOKEN_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code,
        code_verifier: verifier,
        client_id: env.GOOGLE_CLIENT_ID,
        client_secret: env.GOOGLE_CLIENT_SECRET,
        redirect_uri: GOOGLE_REDIRECT,
        grant_type: 'authorization_code',
      }),
    });
    if (!response.ok) return null;
    const token = (await response.json()).id_token;
    const claims = JSON.parse(new TextDecoder().decode(fromBase64url(String(token).split('.')[1])));
    if (claims.aud !== env.GOOGLE_CLIENT_ID || !GOOGLE_ISSUERS.has(claims.iss)) return null;
    if (!(claims.exp > Date.now() / 1000) || claims.email_verified !== true) return null;
    if (typeof claims.sub !== 'string' || !claims.sub || typeof claims.email !== 'string') return null;
    const email = claims.email.trim().toLowerCase();
    const domain = email.split('@').pop();
    const authoritative = domain === 'gmail.com' || (typeof claims.hd === 'string' && claims.hd.toLowerCase() === domain);
    return { subject: claims.sub, email, authoritative, name: String(claims.name || '').trim().slice(0, 100) };
  } catch {
    return null;
  }
}

async function googleCallback(request, env, url) {
  if (!googleEnabled(env)) return authFailed('unavailable');
  const cookie = readCookie(request, OAUTH_COOKIE) || '';
  const dot = cookie.lastIndexOf('.');
  const payload = cookie.slice(0, Math.max(dot, 0));
  const [state, verifier, issuedAt] = payload.split('.');
  const age = Math.floor(Date.now() / 1000) - Number(issuedAt);
  const returnedState = url.searchParams.get('state') || '';
  const code = url.searchParams.get('code');
  if (dot < 1 || !sameString(cookie.slice(dot + 1), await hmac(env.SESSION_SECRET, payload))
      || !state || !verifier || !(age >= 0 && age <= OAUTH_MAX_AGE) || !sameString(returnedState, state) || !code) {
    return authFailed('failed');
  }
  const profile = await googleProfile(env, code, verifier);
  if (!profile || profile.email.length > 254 || !EMAIL_PATTERN.test(profile.email)) return authFailed('failed');

  const now = new Date().toISOString();
  const linked = await env.DB.prepare("SELECT account_id FROM identities WHERE provider = 'google' AND subject = ?").bind(profile.subject).first();
  let account = linked?.account_id;
  if (!account) {
    const existing = await env.DB.prepare('SELECT id, email_verified, (SELECT COUNT(*) FROM identities WHERE account_id = registrations.id) AS linked FROM registrations WHERE email = ?')
      .bind(profile.email).first();
    if (existing) {
      // Only a Google account that vouches for the email may join an existing account,
      // and never one already owned by another vouched Google account.
      if (!profile.authoritative || (existing.email_verified && existing.linked)) return authFailed('exists');
      account = existing.id;
      // Google proved who owns this email. Whoever held the account without that proof
      // (a password, or a Google account that could not vouch for the email) loses
      // access, and every existing session for the account ends.
      if (!existing.email_verified) {
        const taken = await env.DB.prepare('UPDATE registrations SET email_verified = 1, password_hash = NULL, session_version = session_version + 1 WHERE id = ? AND email_verified = 0 RETURNING id')
          .bind(account).first();
        if (!taken) return authFailed('exists');
        await env.DB.prepare('DELETE FROM identities WHERE account_id = ?').bind(account).run();
      }
    } else {
      if (env.REGISTRATION_OPEN !== 'true') return authFailed('closed');
      account = crypto.randomUUID();
      const userAgent = (request.headers.get('user-agent') || '').slice(0, 300);
      await env.DB.prepare('INSERT INTO registrations (id, email, name, created_at, user_agent, email_verified) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(email) DO NOTHING')
        .bind(account, profile.email, profile.name || profile.email.split('@')[0], now, userAgent, profile.authoritative ? 1 : 0).run();
      // A concurrent sign-up may have created the row first. Do not sign into it here;
      // a retry goes through the existing-account rules above.
      const row = await env.DB.prepare('SELECT id FROM registrations WHERE email = ?').bind(profile.email).first();
      if (row.id !== account) return authFailed('exists');
    }
    const link = await env.DB.prepare("INSERT INTO identities (provider, subject, account_id, email, created_at) SELECT 'google', ?, ?, ?, ? WHERE NOT EXISTS (SELECT 1 FROM identities WHERE account_id = ?) ON CONFLICT(provider, subject) DO NOTHING RETURNING account_id")
      .bind(profile.subject, account, profile.email, now, account).first();
    if (!link) return authFailed('exists');
  }
  return redirect('/', [oauthCookie('', 0), await sessionCookie(env, account)]);
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
    // 2. Sign-up, sign-in, sign-out and project saves are the only writes; everything else is GET/HEAD.
    } else if (url.pathname === '/api/register' && request.method === 'POST') {
      response = await register(request, env);
    } else if (url.pathname === '/api/login' && request.method === 'POST') {
      response = await login(request, env);
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
      response = json({ registered: await isRegistered(request, env), registrationOpen: env.REGISTRATION_OPEN === 'true', googleSignIn: googleEnabled(env) });
    } else if (url.pathname === '/auth/google') {
      response = await googleStart(env);
    } else if (url.pathname === '/auth/google/callback') {
      response = await googleCallback(request, env, url);
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
