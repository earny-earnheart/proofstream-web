// Invitation-only access. While REGISTRATION_OPEN is not "true", a new account can only be
// created with an email an admin has approved. Visitors ask through the landing page's
// request form; admins review the requests on the admin page. No email is sent from here:
// approved people are told by the team, then create their account with that email.

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
export const ROLES = ['Artist', 'Producer', 'Songwriter', 'Label', 'Publisher', 'Manager', 'Other'];
const ACCESS_ADMIN_PATH = /^\/api\/v1\/admin\/access-requests\/(req_[a-f0-9-]{36})\/(approve|decline)$/;

// The one answer every request gets, so the form never reveals who has asked or who is a member.
export const REQUEST_RECEIVED = 'Your request is in. The ProofStream team reviews every request personally; if you are approved, you will hear from us and can create your account with this email.';

export async function audit(env, actor, action, subject, detail) {
  try {
    await env.DB.prepare('INSERT INTO audit_log (at, actor, action, subject, detail) VALUES (?, ?, ?, ?, ?)')
      .bind(new Date().toISOString(), actor || null, action, subject || null, detail ? JSON.stringify(detail).slice(0, 2000) : null).run();
  } catch (error) {
    console.error('audit log write failed', error?.message);
  }
}

// True when this email may create a new account right now.
export async function mayCreateAccount(env, email) {
  if (env.REGISTRATION_OPEN === 'true') return true;
  if (!env.DB || !email) return false;
  const row = await env.DB.prepare("SELECT 1 AS ok FROM access_requests WHERE email = ? AND status = 'approved'").bind(email).first();
  return Boolean(row);
}

// Validates and stores a request. The caller has already checked origin, honeypot and Turnstile.
export async function storeAccessRequest(request, env, body, json) {
  const email = String(body.email ?? '').trim().toLowerCase();
  const name = String(body.name ?? '').trim();
  const role = String(body.role ?? '').trim();
  const note = String(body.note ?? '').trim();
  if (email.length > 254 || !EMAIL_PATTERN.test(email)) return json({ error: 'Enter a valid email address.' }, 400);
  if (!name || name.length > 100) return json({ error: 'Enter your name (up to 100 characters).' }, 400);
  if (!ROLES.includes(role)) return json({ error: 'Choose what best describes you.' }, 400);
  if (note.length > 500) return json({ error: 'Keep the note to 500 characters.' }, 400);
  const userAgent = (request.headers.get('user-agent') || '').slice(0, 300);
  // A repeat request keeps the first one; a declined email cannot reset itself to pending.
  await env.DB.prepare('INSERT INTO access_requests (id, email, name, role, note, created_at, user_agent) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(email) DO NOTHING')
    .bind('req_' + crypto.randomUUID(), email, name, role, note || null, new Date().toISOString(), userAgent).run();
  return json({ ok: true, message: REQUEST_RECEIVED }, 200);
}

// Admin endpoints, reached only after the caller has been confirmed as an admin.
export async function accessAdminApi(request, env, url, adminAccount, json) {
  const { pathname } = url;
  if (pathname === '/api/v1/admin/access-requests' && (request.method === 'GET' || request.method === 'HEAD')) {
    const status = ['pending', 'approved', 'declined'].includes(url.searchParams.get('status')) ? url.searchParams.get('status') : 'pending';
    const { results } = await env.DB.prepare('SELECT a.id, a.email, a.name, a.role, a.note, a.status, a.created_at, a.decided_at, EXISTS (SELECT 1 FROM registrations r WHERE r.email = a.email) AS has_account FROM access_requests a WHERE a.status = ? ORDER BY a.created_at LIMIT 200')
      .bind(status).all();
    return json({ requests: results.map(r => ({ ...r, has_account: Boolean(r.has_account) })) }, 200, { 'cache-control': 'no-store' });
  }
  const match = pathname.match(ACCESS_ADMIN_PATH);
  if (match && request.method === 'POST') {
    const [, id, action] = match;
    const status = action === 'approve' ? 'approved' : 'declined';
    const row = await env.DB.prepare('UPDATE access_requests SET status = ?, decided_at = ?, decided_by = ? WHERE id = ? RETURNING id, email, status')
      .bind(status, new Date().toISOString(), adminAccount, id).first();
    if (!row) return json({ error: 'No such request.' }, 404);
    await audit(env, adminAccount, 'access.' + action, id);
    return json({ ok: true, request: row }, 200);
  }
  return null;
}
