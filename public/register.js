'use strict';
const form = document.getElementById('register-form');
const error = form.querySelector('.form-error');
const button = document.getElementById('register-submit');
const password = document.getElementById('register-password');
const name = document.getElementById('register-name');
const success = form.querySelector('.form-success');
const forgot = document.getElementById('forgot-link');
let emailLinks = false;
let mode = 'create';

const AUTH_ERRORS = {
  failed: 'Google sign-in did not complete. Please try again.',
  exists: 'An account with this email already exists. Sign in with your email and password.',
  closed: 'New registration is closed right now. Existing creators can still sign in.',
  unavailable: 'Google sign-in is not available right now. Use your email and password instead.',
};
const authError = new URLSearchParams(location.search).get('auth');
if (AUTH_ERRORS[authError]) error.textContent = AUTH_ERRORS[authError];

const ENDPOINTS = { create: '/api/register', signin: '/api/login', forgot: '/api/password/forgot' };

function setMode(next) {
  mode = next;
  const creating = mode === 'create';
  const forgetting = mode === 'forgot';
  success.textContent = '';
  document.getElementById('password-field').hidden = forgetting;
  password.required = !forgetting;
  forgot.hidden = mode !== 'signin' || !emailLinks;
  document.querySelectorAll('[data-mode]').forEach(b => {
    b.classList.toggle('selected', b.dataset.mode === mode);
    b.setAttribute('aria-pressed', String(b.dataset.mode === mode));
  });
  document.getElementById('register-title').textContent = creating ? 'Create your account.' : forgetting ? 'Reset your password.' : 'Welcome back.';
  document.getElementById('name-field').hidden = !creating;
  document.getElementById('password-note').hidden = !creating;
  name.required = creating;
  password.autocomplete = creating ? 'new-password' : 'current-password';
  password.minLength = creating ? 10 : 1;
  form.action = ENDPOINTS[mode];
  button.textContent = creating ? 'Create account ↗' : forgetting ? 'Email me a reset link ↗' : 'Sign in ↗';
}
document.querySelectorAll('[data-mode]').forEach(b => b.addEventListener('click', () => { error.textContent = ''; setMode(b.dataset.mode); }));
forgot.addEventListener('click', () => { error.textContent = ''; setMode('forgot'); });

fetch('/api/session', { credentials: 'same-origin' }).then(r => r.json()).then(s => {
  if (s.registered) location.replace('/');
  document.getElementById('google-sign-in').hidden = !s.googleSignIn;
  document.getElementById('register-divider').hidden = !s.googleSignIn;
  emailLinks = Boolean(s.emailLinks);
  setMode(mode);
  if (!s.registrationOpen) {
    setMode('signin');
    if (!error.textContent) error.textContent = 'New registration is closed right now. Existing creators can still sign in.';
  }
}).catch(() => {});

form.addEventListener('submit', async e => {
  e.preventDefault();
  error.textContent = '';
  success.textContent = '';
  if (!form.reportValidity()) return;
  if (!new FormData(form).get('cf-turnstile-response')) {
    error.textContent = 'Please wait for the bot check to finish, then try again.';
    return;
  }
  button.disabled = true;
  try {
    const body = Object.fromEntries(new FormData(form));
    if (mode !== 'create') delete body.name;
    if (mode === 'forgot') delete body.password;
    const response = await fetch(ENDPOINTS[mode], {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(result.error || 'That did not work. Please try again.');
    if (mode === 'forgot') {
      success.textContent = result.message || 'If an account uses that email, a reset link is on its way.';
      if (window.turnstile) window.turnstile.reset();
      return;
    }
    location.replace('/');
  } catch (err) {
    error.textContent = err.message;
    // Turnstile tokens work once; get a fresh one for the next attempt.
    if (window.turnstile) window.turnstile.reset();
  } finally {
    button.disabled = false;
  }
});
