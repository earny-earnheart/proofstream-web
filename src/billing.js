// Free trial, paid plans and the Polar integration.
//
// The paywall is off unless PAYWALL_ENABLED is "true": with it off, every account keeps
// today's limits and nothing below changes behaviour. With it on:
// - An account with a confirmed email gets a 14-day trial the first time it is checked.
// - The trial and each plan have limits; a write past a limit answers 402 with an upgrade link.
// - When a trial or plan ends, the account is read-only: everything stays visible and exportable.
// - Polar (merchant of record) takes payment. POLAR_API_BASE picks sandbox or production,
//   POLAR_ACCESS_TOKEN and POLAR_WEBHOOK_SECRET are secrets, POLAR_PRODUCT_CREATOR and
//   POLAR_PRODUCT_PRO are the product ids. Nothing here creates products or prices.

export const TRIAL_DAYS = 14;
const UNLIMITED = Number.MAX_SAFE_INTEGER;

export const PLANS = {
  trial: { label: 'Free trial', projects: 3, fingerprints: 25, recordings: 5, verifications: 1 },
  creator: { label: 'Creator', projects: 10, fingerprints: 1000, recordings: 25, verifications: 25 },
  pro: { label: 'Pro', projects: UNLIMITED, fingerprints: UNLIMITED, recordings: 500, verifications: UNLIMITED },
  comp: { label: 'Complimentary', projects: UNLIMITED, fingerprints: UNLIMITED, recordings: UNLIMITED, verifications: UNLIMITED },
};
const READ_ONLY = { label: 'Read-only', projects: 0, fingerprints: 0, recordings: 0, verifications: 0 };
const WEBHOOK_TOLERANCE_SECONDS = 5 * 60;

const paywallOn = env => env.PAYWALL_ENABLED === 'true';
const addDays = (date, days) => new Date(date.getTime() + days * 86400000).toISOString();

// What an account may do now. `writable` is false once a trial or plan has ended.
export async function entitlements(env, account, now = new Date()) {
  if (!paywallOn(env)) return { paywall: false, writable: true, plan: 'open', limits: null };
  let row = await env.DB.prepare('SELECT * FROM subscriptions WHERE account_id = ?').bind(account).first();
  if (!row) {
    const reg = await env.DB.prepare('SELECT email_verified FROM registrations WHERE id = ?').bind(account).first();
    if (!reg || reg.email_verified !== 1) {
      return { paywall: true, writable: false, plan: 'none', status: 'unconfirmed', limits: READ_ONLY, reason: 'Confirm your email to start your free trial.' };
    }
    const stamp = now.toISOString();
    await env.DB.prepare("INSERT INTO subscriptions (account_id, plan, status, trial_ends_at, created_at, updated_at) VALUES (?, 'trial', 'trialing', ?, ?, ?) ON CONFLICT(account_id) DO NOTHING")
      .bind(account, addDays(now, TRIAL_DAYS), stamp, stamp).run();
    row = await env.DB.prepare('SELECT * FROM subscriptions WHERE account_id = ?').bind(account).first();
  }
  const ends = row.plan === 'trial' ? row.trial_ends_at : row.current_period_end;
  const lapsed = row.status === 'expired' || row.status === 'canceled'
    || (row.plan !== 'comp' && ends && new Date(ends) <= now && row.status !== 'past_due');
  const writable = row.plan === 'comp' || (!lapsed && ['trialing', 'active', 'past_due'].includes(row.status));
  return {
    paywall: true,
    writable,
    plan: row.plan,
    status: lapsed && row.plan === 'trial' ? 'trial_ended' : row.status,
    limits: writable ? PLANS[row.plan] : READ_ONLY,
    trialEndsAt: row.trial_ends_at,
    currentPeriodEnd: row.current_period_end,
    cancelAtPeriodEnd: Boolean(row.cancel_at_period_end),
    reason: writable ? null : (row.plan === 'trial' ? 'Your free trial has ended. Choose a plan to keep adding work; everything you saved stays here.' : 'Your plan has ended. Choose a plan to keep adding work; everything you saved stays here.'),
  };
}

// The 402 answer for a write past a limit. `what` names the limit, e.g. "recordings".
export function paymentRequired(json, ent, what) {
  const detail = ent.reason || `Your ${PLANS[ent.plan]?.label || 'current'} plan includes ${ent.limits[what]} ${what}. Upgrade to add more.`;
  return json({
    type: 'https://proofstreamapp.com/errors/plan-limit',
    title: 'Plan limit reached',
    status: 402,
    error: detail,
    detail,
    limit: what,
    plan: ent.plan,
    upgrade: '/account/billing',
  }, 402, { 'cache-control': 'no-store' });
}

// Checks one limit before a write. Returns a Response to send, or null to go ahead.
export async function checkLimit(env, account, what, used, json) {
  const ent = await entitlements(env, account);
  if (!ent.paywall) return null;
  if (!ent.writable || used >= ent.limits[what]) return paymentRequired(json, ent, what);
  return null;
}

// ---- Polar ----

const polarBase = env => env.POLAR_API_BASE || 'https://sandbox-api.polar.sh/v1';
const productFor = (env, plan) => ({ creator: env.POLAR_PRODUCT_CREATOR, pro: env.POLAR_PRODUCT_PRO })[plan];
const planFor = (env, productId) => productId && productId === env.POLAR_PRODUCT_PRO ? 'pro' : productId && productId === env.POLAR_PRODUCT_CREATOR ? 'creator' : null;

async function polar(env, path, body) {
  const response = await fetch(polarBase(env) + path, {
    method: 'POST',
    headers: { authorization: 'Bearer ' + env.POLAR_ACCESS_TOKEN, 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify(body),
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error('Polar answered ' + response.status);
  return result;
}

// Starts a Polar checkout for the signed-in account and returns its URL.
export async function startCheckout(env, account, plan, origin, ip) {
  const product = productFor(env, plan);
  if (!product || !env.POLAR_ACCESS_TOKEN) return { error: 'Plans are not available yet.' };
  const reg = await env.DB.prepare('SELECT email, name FROM registrations WHERE id = ?').bind(account).first();
  const checkout = await polar(env, '/checkouts/', {
    products: [product],
    external_customer_id: account,
    customer_email: reg?.email,
    customer_name: reg?.name,
    ...(ip ? { customer_ip_address: ip } : {}),
    success_url: origin + '/account/billing?checkout=done',
    metadata: { account_id: account, plan },
  });
  return checkout.url ? { url: checkout.url } : { error: 'Checkout could not start.' };
}

// Opens Polar's customer portal (invoices, card, cancel) for the signed-in account.
export async function customerPortal(env, account, origin) {
  if (!env.POLAR_ACCESS_TOKEN) return { error: 'Billing is not available yet.' };
  const session = await polar(env, '/customer-sessions/', { external_customer_id: account, return_url: origin + '/account/billing' });
  return session.customer_portal_url ? { url: session.customer_portal_url } : { error: 'The billing portal could not open.' };
}

// Standard Webhooks signatures (what Polar sends): HMAC-SHA256 over "id.timestamp.body",
// base64, in a space-separated "v1,<sig>" list. Polar secrets made before Sept 8, 2026 use the
// UTF-8 bytes of the whole "whsec_..." string as the key, so both keys are tried.
async function hmacBase64(keyBytes, message) {
  const key = await crypto.subtle.importKey('raw', keyBytes, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const mac = new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(message)));
  return btoa(String.fromCharCode(...mac));
}

function secretKeys(secret) {
  const keys = [new TextEncoder().encode(secret)];
  const encoded = secret.startsWith('whsec_') ? secret.slice(6) : secret;
  try { keys.unshift(Uint8Array.from(atob(encoded), c => c.charCodeAt(0))); } catch {}
  return keys;
}

function sameString(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export async function verifyWebhook(headers, body, secret, nowSeconds = Math.floor(Date.now() / 1000)) {
  const id = headers.get('webhook-id');
  const timestamp = headers.get('webhook-timestamp');
  const signatures = (headers.get('webhook-signature') || '').split(' ').map(s => s.split(',')).filter(p => p[0] === 'v1').map(p => p[1]);
  if (!secret || !id || !timestamp || !signatures.length) return false;
  if (!/^\d+$/.test(timestamp) || Math.abs(nowSeconds - Number(timestamp)) > WEBHOOK_TOLERANCE_SECONDS) return false;
  for (const key of secretKeys(secret)) {
    const expected = await hmacBase64(key, `${id}.${timestamp}.${body}`);
    if (signatures.some(sig => sig && sameString(sig, expected))) return true;
  }
  return false;
}

const STATUS = { active: 'active', trialing: 'active', past_due: 'past_due', unpaid: 'past_due', canceled: 'canceled', incomplete_expired: 'expired', incomplete: 'past_due' };

// Polar's webhook. Verifies the signature, records the delivery once, and applies
// subscription events to the account named by the customer's external id.
export async function polarWebhook(request, env, json) {
  const body = await request.text();
  if (body.length > 256 * 1024) return json({ error: 'Too large.' }, 413);
  if (!(await verifyWebhook(request.headers, body, env.POLAR_WEBHOOK_SECRET))) return json({ error: 'Bad signature.' }, 403);
  let event;
  try { event = JSON.parse(body); } catch { return json({ error: 'Bad JSON.' }, 400); }
  const id = request.headers.get('webhook-id');
  const type = String(event?.type || '');
  const sub = event?.data || {};
  const account = sub.customer?.external_id || sub.metadata?.account_id || null;
  const fresh = await env.DB.prepare('INSERT INTO billing_events (id, type, account_id, provider_subscription_id, received_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(id) DO NOTHING RETURNING id')
    .bind(id, type.slice(0, 64), account, sub.id || null, new Date().toISOString()).first();
  if (!fresh) return json({ ok: true, duplicate: true }, 200);
  if (!type.startsWith('subscription.') || !account) return json({ ok: true, ignored: true }, 200);
  const known = await env.DB.prepare('SELECT 1 AS ok FROM registrations WHERE id = ?').bind(account).first();
  const plan = planFor(env, sub.product_id || sub.product?.id);
  if (!known || !plan) return json({ ok: true, ignored: true }, 200);

  const status = type === 'subscription.revoked' ? 'canceled' : (STATUS[sub.status] || 'active');
  const now = new Date().toISOString();
  // A comp plan given by the team is never overwritten by a webhook.
  await env.DB.prepare(`INSERT INTO subscriptions (account_id, plan, status, current_period_end, cancel_at_period_end, provider, provider_customer_id, provider_subscription_id, provider_product_id, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, 'polar', ?, ?, ?, ?, ?)
      ON CONFLICT(account_id) DO UPDATE SET plan = excluded.plan, status = excluded.status, current_period_end = excluded.current_period_end,
        cancel_at_period_end = excluded.cancel_at_period_end, provider = 'polar', provider_customer_id = excluded.provider_customer_id,
        provider_subscription_id = excluded.provider_subscription_id, provider_product_id = excluded.provider_product_id, updated_at = excluded.updated_at
      WHERE subscriptions.plan != 'comp'`)
    .bind(account, plan, status, sub.current_period_end || null, sub.cancel_at_period_end ? 1 : 0, sub.customer_id || sub.customer?.id || null, sub.id || null, sub.product_id || sub.product?.id || null, now, now).run();
  await env.DB.prepare('UPDATE billing_events SET applied = 1 WHERE id = ?').bind(id).run();
  return json({ ok: true }, 200);
}
