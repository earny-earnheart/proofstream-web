'use strict';
// A button press, not page load, confirms: mail scanners that open links do not click.
const token = location.hash.slice(1);
history.replaceState(null, '', location.pathname);
const status = document.getElementById('verify-status');
const error = document.querySelector('.form-error');
const button = document.getElementById('verify-submit');
if (!token) { error.textContent = 'This page needs the link from your confirmation email.'; button.disabled = true; }

button.addEventListener('click', async () => {
  error.textContent = '';
  button.disabled = true;
  try {
    const response = await fetch('/api/email/verify', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token }),
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(result.error || 'That did not work. Please try again.');
    status.textContent = 'Your email is confirmed. Thank you.';
    button.hidden = true;
  } catch (err) {
    error.textContent = err.message;
    if (!/^This confirmation link/.test(err.message)) button.disabled = false;
  }
});
