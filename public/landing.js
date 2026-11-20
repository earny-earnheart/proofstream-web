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
