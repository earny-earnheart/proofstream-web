'use strict';
const summary = document.getElementById('plan-summary');
const error = document.getElementById('billing-error');
const plans = document.getElementById('plans');
const portal = document.getElementById('portal');
const day = iso => new Date(iso).toLocaleDateString(undefined, { month: 'long', day: 'numeric', year: 'numeric' });

async function post(path, body) {
  const response = await fetch(path, { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body || {}) });
  const result = await response.json().catch(() => ({}));
  if (!response.ok || !result.url) throw new Error(result.error || 'That did not work. Please try again.');
  return result.url;
}

fetch('/api/billing/status', { credentials: 'same-origin' }).then(r => r.json()).then(s => {
  if (!s.paywall) { summary.textContent = 'Your account has full access during the private preview.'; return; }
  if (s.plan === 'trial' && s.writable) summary.textContent = `You're on the free trial until ${day(s.trialEndsAt)}. Choose a plan any time to keep going after that.`;
  else if (s.plan === 'trial' || s.status === 'unconfirmed') summary.textContent = s.reason;
  else if (s.plan === 'comp') summary.textContent = 'You have complimentary access.';
  else if (s.writable) summary.textContent = `You're on ${s.plans[s.plan].label}${s.currentPeriodEnd ? (s.cancelAtPeriodEnd ? `, ending ${day(s.currentPeriodEnd)}` : `, renewing ${day(s.currentPeriodEnd)}`) : ''}.`;
  else summary.textContent = s.reason;
  plans.hidden = s.plan === 'comp' || (s.writable && (s.plan === 'creator' || s.plan === 'pro'));
  portal.hidden = !(s.plan === 'creator' || s.plan === 'pro');
  if (new URLSearchParams(location.search).get('checkout') === 'done') summary.textContent = 'Thanks. Your payment is being confirmed; this page updates once Polar tells us.';
}).catch(() => { summary.textContent = 'Your plan could not be loaded.'; });

plans.addEventListener('click', async e => {
  const button = e.target.closest('[data-plan]');
  if (!button) return;
  button.disabled = true;
  error.textContent = '';
  try { location.assign(await post('/api/billing/checkout', { plan: button.dataset.plan })); }
  catch (err) { error.textContent = err.message; button.disabled = false; }
});
portal.addEventListener('click', async () => {
  error.textContent = '';
  try { location.assign(await post('/api/billing/portal')); } catch (err) { error.textContent = err.message; }
});
