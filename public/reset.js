'use strict';
// The token is in the URL fragment, which browsers never send to servers or in referrers.
const token = location.hash.slice(1);
history.replaceState(null, '', location.pathname);
const form = document.getElementById('reset-form');
const error = form.querySelector('.form-error');
const button = document.getElementById('reset-submit');
if (!token) error.textContent = 'This page needs the link from your reset email. Ask for a new one from the sign-in page.';

form.addEventListener('submit', async e => {
  e.preventDefault();
  error.textContent = '';
  if (!token || !form.reportValidity()) return;
  button.disabled = true;
  try {
    const response = await fetch('/api/password/reset', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token, password: document.getElementById('reset-password').value }),
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(result.error || 'That did not work. Please try again.');
    location.replace('/');
  } catch (err) {
    error.textContent = err.message;
    button.disabled = false;
  }
});
