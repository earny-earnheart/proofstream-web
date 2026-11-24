'use strict';
// The hero video plays muted on its own where the browser allows it. When it does not
// (battery saver, reduced motion, an autoplay block) the play button starts it.
const video = document.querySelector('.hero-video');
const play = document.querySelector('.hero-play');
const sync = () => {
  play.hidden = !video.paused;
  play.setAttribute('aria-label', video.paused ? 'Play the ProofStream video' : 'Pause the ProofStream video');
};
video.addEventListener('play', sync);
video.addEventListener('pause', sync);
play.addEventListener('click', () => { video.play().catch(() => {}); });
video.addEventListener('click', () => { if (!video.paused) video.pause(); });
if (matchMedia('(prefers-reduced-motion: reduce)').matches) {
  video.removeAttribute('autoplay');
  video.pause();
}
sync();

document.getElementById('year').textContent = new Date().getFullYear();

// ---- Private preview: request an invitation ----
const requestForm = document.getElementById('request-form');
if (requestForm) {
  const requestError = requestForm.querySelector('.form-error');
  const requestButton = document.getElementById('request-submit');
  requestForm.addEventListener('submit', async event => {
    event.preventDefault();
    requestError.textContent = '';
    if (!requestForm.reportValidity()) return;
    const body = Object.fromEntries(new FormData(requestForm));
    if (!body['cf-turnstile-response']) {
      requestError.textContent = 'Please wait for the bot check to finish, then try again.';
      return;
    }
    requestButton.disabled = true;
    try {
      const response = await fetch('/api/access-request', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      const result = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(result.error || 'That did not go through. Please try again.');
      document.getElementById('request-email').textContent = body.email;
      requestForm.hidden = true;
      const done = document.getElementById('request-done');
      done.hidden = false;
      done.focus();
    } catch (error) {
      requestError.textContent = error.message;
      if (window.turnstile) window.turnstile.reset();
    } finally {
      requestButton.disabled = false;
    }
  });
}

// ---- Launch film slot: shown only once the film file is in public/media ----
const film = document.getElementById('launch-film');
if (film) {
  fetch('/media/proofstream-launch.mp4', { method: 'HEAD' })
    .then(response => { if (response.ok) film.hidden = false; })
    .catch(() => {});
}
