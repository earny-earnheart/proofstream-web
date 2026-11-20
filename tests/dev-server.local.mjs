// Local UI test server (not run by `npm test`): the real Worker with an in-memory D1, the
// test suite's fake Turnstile, and files from public/. Never deploy this.
//   node tests/dev-server.local.mjs [port]   then open http://localhost:<port>/__dev/login
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import worker from '../src/worker.js';
import { envWith, origin } from './helpers.mjs';

const port = Number(process.argv[2] || 8791);
const TYPES = { html: 'text/html; charset=utf-8', js: 'text/javascript', css: 'text/css', svg: 'image/svg+xml', jpg: 'image/jpeg', ico: 'image/x-icon', webm: 'video/webm', mp4: 'video/mp4', txt: 'text/plain', xml: 'application/xml' };
const assets = {
  async fetch(req) {
    let path = new URL(req.url).pathname;
    if (path === '/') path = '/index.html';
    else if (!path.includes('.')) path += '.html';
    try {
      const body = await readFile(new URL('../public' + path, import.meta.url));
      return new Response(body, { headers: { 'content-type': TYPES[path.split('.').pop()] || 'application/octet-stream' } });
    } catch {
      return new Response('Not found', { status: 404 });
    }
  },
};
const env = await envWith({ ASSETS: assets, ADMIN_EMAILS: 'admin@example.com' });

http.createServer(async (req, res) => {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const url = new URL(req.url, origin);
  let response;
  if (url.pathname === '/__dev/login') {
    // Creates (or signs in) a test account and drops its session cookie in this browser.
    const email = url.searchParams.get('email') || 'creator@example.com';
    const make = path => worker.fetch(new Request(origin + path, {
      method: 'POST', headers: { origin, 'content-type': 'application/json' },
      body: JSON.stringify({ 'cf-turnstile-response': 'pass', name: email.split('@')[0], email, password: 'correct horse battery' }),
    }), env);
    let r = await make('/api/register');
    if (r.status === 409) r = await make('/api/login');
    if (email === 'admin@example.com') env.DB.db.prepare('UPDATE registrations SET email_verified = 1 WHERE email = ?').run(email);
    const cookie = r.headers.getSetCookie()[0].replace('; Secure', '');
    res.writeHead(302, { location: '/', 'set-cookie': cookie });
    return res.end();
  }
  // The Worker only accepts writes from its own origin; present this request as that.
  const headers = new Headers(req.headers);
  if (headers.has('origin')) headers.set('origin', origin);
  response = await worker.fetch(new Request(url, { method: req.method, headers, body: ['GET', 'HEAD'].includes(req.method) ? undefined : Buffer.concat(chunks) }), env);
  const out = {};
  response.headers.forEach((v, k) => { if (k !== 'set-cookie' && k !== 'strict-transport-security') out[k] = v; });
  const cookies = response.headers.getSetCookie().map(c => c.replace('; Secure', ''));
  if (cookies.length) out['set-cookie'] = cookies;
  res.writeHead(response.status, out);
  res.end(Buffer.from(await response.arrayBuffer()));
}).listen(port, '127.0.0.1', () => console.log(`ProofStream dev server on http://localhost:${port}`));
