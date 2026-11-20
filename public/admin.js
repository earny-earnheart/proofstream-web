'use strict';
const escapeHTML = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const queue = document.getElementById('queue');
const error = document.getElementById('error');

async function call(path, body) {
  const response = await fetch(path, body === undefined
    ? { credentials: 'same-origin' }
    : { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(result.detail || result.error || 'Request failed (' + response.status + ').');
  return result;
}

function item(r) {
  const rights = r.rights.map(x => `${escapeHTML(x.role)} · ${x.split_bps / 100}% · ${escapeHTML(x.territory)}${x.ipi ? ' · IPI ' + escapeHTML(x.ipi) : ''}`).join('<br>');
  const current = r.versions.find(v => v.version === r.current_version);
  return `<article class="milestone" data-id="${escapeHTML(r.recording_id)}" data-version="${r.current_version}">
    <span class="tag">${escapeHTML(r.isrc)}${r.competing_claims ? ` · ${r.competing_claims} competing claim${r.competing_claims === 1 ? '' : 's'}` : ''}</span>
    <h3>${escapeHTML(r.title)} — ${escapeHTML(r.artist_display)}</h3>
    <p>Version ${r.current_version} (${escapeHTML(current?.reason)}) · requested ${escapeHTML(new Date(r.verification.requested_at).toLocaleString())} · ${escapeHTML(r.account_email)}</p>
    <p>${rights}</p>
    <p>Evidence (SHA-256):</p>${r.evidence_hashes.map(h => `<div class="hash">${escapeHTML(h)}</div>`).join('')}
    <div class="hash">payload ${escapeHTML(current?.payload_hash)}</div>
    <div class="actions">
      <button type="button" class="primary" data-action="verify">Verify version ${r.current_version}</button>
      <button type="button" class="outline-button" data-action="reject">Reject request</button>
      <button type="button" class="outline-button" data-action="revoke">Revoke claim</button>
    </div>
  </article>`;
}

async function load() {
  error.textContent = '';
  try {
    const { queue: items } = await call('/api/v1/admin/verification-queue');
    queue.innerHTML = items.length ? items.map(item).join('') : '<p>No verification requests are waiting.</p>';
  } catch (e) {
    error.textContent = e.message;
  }
}

queue.addEventListener('click', async event => {
  const button = event.target.closest('button[data-action]');
  if (!button) return;
  const card = button.closest('[data-id]');
  const action = button.dataset.action;
  const body = { version: Number(card.dataset.version) };
  if (action !== 'verify') {
    const reason = prompt(action === 'reject' ? 'Why is the request rejected? The creator sees this.' : 'Why is the claim revoked? This is final.');
    if (!reason) return;
    body.reason = reason;
  } else if (!confirm('Verify this version and queue it for anchoring on-chain?')) {
    return;
  }
  button.disabled = true;
  error.textContent = '';
  try {
    await call(`/api/v1/admin/recordings/${encodeURIComponent(card.dataset.id)}/${action}`, body);
    await load();
  } catch (e) {
    error.textContent = e.message;
    button.disabled = false;
  }
});

document.getElementById('refresh').addEventListener('click', load);
document.getElementById('anchor-now').addEventListener('click', async e => {
  e.target.disabled = true;
  const out = document.getElementById('anchor-result');
  out.textContent = 'Running…';
  try {
    const result = await call('/api/v1/admin/anchor-now', {});
    out.textContent = result.skipped || `${result.results.length} processed: ` + result.results.map(r => `${r.recording_id.slice(0, 12)} v${r.version} ${r.result}`).join(', ');
  } catch (err) {
    out.textContent = err.message;
  } finally {
    e.target.disabled = false;
  }
});
load();
