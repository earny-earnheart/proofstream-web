'use strict';
// The launch film plays muted on its own where the browser allows it. When it does not
// (battery saver, reduced motion, an autoplay block) the play button starts it.
// "Sound on" unmutes it and starts it from the beginning.
const video = document.getElementById('launch-film');
const play = document.querySelector('.hero-play');
const sound = document.querySelector('.film-sound');
const sync = () => {
  play.hidden = !video.paused;
  play.setAttribute('aria-label', video.paused ? 'Play the launch film' : 'Pause the launch film');
  sound.textContent = video.muted ? 'Sound on' : 'Sound off';
  sound.setAttribute('aria-pressed', String(!video.muted));
};
video.addEventListener('play', sync);
video.addEventListener('pause', sync);
video.addEventListener('volumechange', sync);
play.addEventListener('click', () => { video.play().catch(() => {}); });
video.addEventListener('click', () => { if (!video.paused) video.pause(); });
sound.addEventListener('click', () => {
  const unmute = video.muted;
  video.muted = !unmute;
  if (unmute) { video.currentTime = 0; video.play().catch(() => {}); }
});
if (matchMedia('(prefers-reduced-motion: reduce)').matches) {
  video.removeAttribute('autoplay');
  video.pause();
}
sync();

document.getElementById('year').textContent = new Date().getFullYear();
