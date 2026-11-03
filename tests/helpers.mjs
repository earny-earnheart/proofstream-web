// Shared test harness: a real SQLite database behind the D1 API, and stand-ins for
// Cloudflare Turnstile and Google's token endpoint.
import { readFile, readdir } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import worker from '../src/worker.js';

export const origin = 'https://proofstreamapp.com';

// The subset of the D1 API the Worker uses, with every migration applied and foreign
// keys enforced as D1 does.
export async function d1() {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  for (const file of (await readdir(new URL('../migrations/', import.meta.url))).sort()) {
    db.exec(await readFile(new URL('../migrations/' + file, import.meta.url), 'utf8'));
  }
  return {
    db,
    prepare(sql) {
      return {
        bind(...args) {
          const statement = db.prepare(sql);
          return {
            async first() { return statement.get(...args) ?? null; },
            async all() { return { results: statement.all(...args) }; },
            async run() { statement.run(...args); return { success: true }; },
          };
        },
      };
    },
  };
}

// Turnstile: the token 'pass' succeeds, 'down' is a network failure.
export const verifyCalls = [];
// Google: tests set `google.claims` to the ID token claims the token endpoint returns.
export const google = { claims: null, status: 200, calls: [] };

const realFetch = globalThis.fetch;
globalThis.fetch = async (url, init) => {
  if (String(url) === 'https://challenges.cloudflare.com/turnstile/v0/siteverify') {
    const form = init.body;
    verifyCalls.push({ secret: form.get('secret'), response: form.get('response'), remoteip: form.get('remoteip') });
    if (form.get('response') === 'down') throw new Error('network');
    const success = form.get('response') === 'pass' && form.get('secret') === 'turnstile-secret';
    return Response.json({ success, hostname: form.get('response') === 'pass' ? 'proofstreamapp.com' : undefined });
  }
  if (String(url) === 'https://oauth2.googleapis.com/token') {
    google.calls.push(Object.fromEntries(new URLSearchParams(String(init.body))));
    if (google.status !== 200) return Response.json({ error: 'invalid_grant' }, { status: google.status });
    const part = value => Buffer.from(JSON.stringify(value)).toString('base64url');
    return Response.json({ id_token: `${part({ alg: 'RS256' })}.${part(google.claims)}.signature` });
  }
  return realFetch(url, init);
};

export async function envWith(overrides = {}) {
  const calls = [];
  return {
    calls,
    DB: await d1(),
    SESSION_SECRET: 'test-secret-value',
    TURNSTILE_SECRET: 'turnstile-secret',
    REGISTRATION_OPEN: 'true',
    ASSETS: { fetch: async req => { calls.push(new URL(req.url).pathname); return new Response('asset:' + new URL(req.url).pathname, { headers: { 'content-type': 'text/html' } }); } },
    ...overrides,
  };
}

export const get = (path, cookie) => new Request(origin + path, { headers: cookie ? { cookie } : {} });

// POST a sign-up or sign-in form; the Turnstile token defaults to 'pass'.
export function post(path, body, { origin: from = origin, type = 'application/json', token = 'pass' } = {}) {
  const withToken = token === null ? body : { 'cf-turnstile-response': token, ...body };
  return new Request(origin + path, {
    method: 'POST',
    headers: { origin: from, 'content-type': type, 'cf-connecting-ip': '203.0.113.7' },
    body: type === 'application/json' ? JSON.stringify(withToken) : new URLSearchParams(withToken),
  });
}

// The `name=value` of a cookie the response sets, or undefined.
export const cookieOf = (response, name = 'ps_session') =>
  response.headers.getSetCookie().map(c => c.split(';')[0]).find(c => c.startsWith(name + '='));

export const PASSWORD = 'correct horse battery';

export async function signUp(env, email, password = PASSWORD) {
  const response = await worker.fetch(post('/api/register', { name: email.split('@')[0], email, password }), env);
  return cookieOf(response);
}

export async function signIn(env, email, password = PASSWORD) {
  return cookieOf(await worker.fetch(post('/api/login', { email, password }), env));
}
