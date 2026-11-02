'use strict';
const form = document.getElementById('register-form');
const error = form.querySelector('.form-error');
const button = form.querySelector('button[type=submit]');

fetch('/api/session', { credentials: 'same-origin' }).then(r => r.json()).then(s => {
  if (s.registered) location.replace('/');
  else if (!s.registrationOpen) error.textContent = 'New registration is closed right now. Registered creators can still sign in with their email.';
}).catch(() => {});

form.addEventListener('submit', async e => {
  e.preventDefault();
  error.textContent = '';
  if (!form.reportValidity()) return;
  if (!new FormData(form).get('cf-turnstile-response')) {
    error.textContent = 'Please wait for the bot check to finish, then try again.';
    return;
  }
  button.disabled = true;
  try {
    const response = await fetch('/api/register', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(Object.fromEntries(new FormData(form))),
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(result.error || 'Registration failed. Please try again.');
    location.replace('/');
  } catch (err) {
    error.textContent = err.message;
    // Turnstile tokens work once; get a fresh one for the next attempt.
    if (window.turnstile) window.turnstile.reset();
  } finally {
    button.disabled = false;
  }
});
