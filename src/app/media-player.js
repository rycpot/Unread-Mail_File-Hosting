// Video and audio attachments, played by Chrome's own <video>/<audio> with
// controls drawn to match the app: play/pause, time, a seek bar, mute and
// volume, speed (1×, 1.25×, 1.5×, 2×, 0.75×) and, for video, full screen.
// Keys: Space or K play/pause, M mute, F full screen (←/→ stay with the
// viewer for moving between attachments).
// Audio shows as a card with the file name and size; a video file without a
// picture (e.g. an .mp4 voice recording) switches to the card as well.

import { mediaType } from '../media-types.js';

const svg = (d, fill = false) =>
  `<svg viewBox="0 0 24 24" fill="${fill ? 'currentColor' : 'none'}" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${d}</svg>`;
const ICON = {
  play: svg('<path d="M7 4.5v15l12-7.5z"/>', true),
  pause: svg('<rect x="6" y="4.5" width="4" height="15" rx="1"/><rect x="14" y="4.5" width="4" height="15" rx="1"/>', true),
  volume: svg('<path d="M11 5 6 9H3v6h3l5 4z"/><path d="M15.5 8.5a5 5 0 0 1 0 7M18.5 5.5a9 9 0 0 1 0 13"/>'),
  muted: svg('<path d="M11 5 6 9H3v6h3l5 4z"/><path d="m16 9 6 6M22 9l-6 6"/>'),
  full: svg('<path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/>'),
  exitFull: svg('<path d="M9 4v5H4M15 4v5h5M9 20v-5H4M15 20v-5h5"/>'),
};
const SPEEDS = [1, 1.25, 1.5, 2, 0.75];

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

export function fmtClock(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) return '0:00';
  const s = Math.floor(seconds);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = String(s % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
}

// kind: 'video' | 'audio'. onUnplayable() is called when Chrome can't play
// the file (the viewer then offers Download). Returns { cleanup }.
export function showMedia({ file, body, kind, sizeText, onUnplayable }) {
  const url = URL.createObjectURL(new Blob([file.bytes], { type: mediaType(file.filename, file.mimeType) || `${kind}/mp4` }));
  let el;
  let root;
  let closed = false;

  const controls = (audio) => `
    <span class="mp-time" data-m="now">0:00</span>
    ${audio ? '' : '<span class="mp-time mp-sep">/</span><span class="mp-time" data-m="total">0:00</span>'}
    <input type="range" class="mp-range mp-seek" min="0" max="0" step="0.1" value="0" aria-label="Seek">
    ${audio ? '<span class="mp-time" data-m="total">0:00</span>' : ''}
    <button type="button" class="mp-speed" data-m="speed" title="Playback speed">1×</button>
    <button type="button" class="mp-btn" data-m="mute" title="Mute (M)">${ICON.volume}</button>
    <input type="range" class="mp-range mp-vol" min="0" max="1" step="0.05" value="1" aria-label="Volume">
    ${audio ? '' : `<button type="button" class="mp-btn" data-m="full" title="Full screen (F)">${ICON.full}</button>`}`;

  function build(audio) {
    const time = el ? el.currentTime : 0;
    el?.pause();
    body.innerHTML = audio
      ? `<div class="mp mp-audio">
          <button type="button" class="mp-bigplay" data-m="play" title="Play (Space)">${ICON.play}</button>
          <div class="mp-title"><span class="mp-name">${esc(file.filename)}</span><span class="mp-size">${esc(sizeText)}</span></div>
          <div class="mp-bar">${controls(true)}</div>
          <audio preload="metadata"></audio>
        </div>`
      : `<div class="mp mp-video">
          <video preload="metadata" playsinline></video>
          <div class="mp-bar"><button type="button" class="mp-btn" data-m="play" title="Play (Space)">${ICON.play}</button>${controls(false)}</div>
        </div>`;
    root = body.querySelector('.mp');
    el = root.querySelector('video, audio');
    el.src = url;
    if (time) el.currentTime = time;
    wire(audio);
  }

  const $ = (sel) => root.querySelector(sel);
  const fill = (range) => {
    const max = Number(range.max) || 1;
    range.style.setProperty('--p', `${(Number(range.value) / max) * 100}%`);
  };

  function wire(audio) {
    const seek = $('.mp-seek');
    const vol = $('.mp-vol');
    let dragging = false;
    const sync = () => {
      const playing = !el.paused && !el.ended;
      root.querySelectorAll('[data-m="play"]').forEach((b) => {
        b.innerHTML = playing ? ICON.pause : ICON.play;
        b.title = playing ? 'Pause (Space)' : 'Play (Space)';
      });
      $('[data-m="now"]').textContent = fmtClock(el.currentTime);
      $('[data-m="total"]').textContent = fmtClock(el.duration);
      seek.max = Number.isFinite(el.duration) ? el.duration : 0;
      if (!dragging) seek.value = el.currentTime;
      fill(seek);
      const quiet = el.muted || el.volume === 0;
      $('[data-m="mute"]').innerHTML = quiet ? ICON.muted : ICON.volume;
      $('[data-m="mute"]').title = quiet ? 'Unmute (M)' : 'Mute (M)';
      vol.value = el.muted ? 0 : el.volume;
      fill(vol);
      $('[data-m="speed"]').textContent = `${el.playbackRate}×`;
      const full = $('[data-m="full"]');
      if (full) {
        const on = document.fullscreenElement === root;
        full.innerHTML = on ? ICON.exitFull : ICON.full;
        full.title = on ? 'Exit full screen (F)' : 'Full screen (F)';
      }
    };
    for (const ev of ['play', 'pause', 'ended', 'timeupdate', 'durationchange', 'loadedmetadata', 'volumechange', 'ratechange']) el.addEventListener(ev, sync);
    root.addEventListener('fullscreenchange', sync);
    el.addEventListener('loadedmetadata', () => {
      // A "video" with no picture plays better as the audio card.
      if (!audio && el.videoWidth === 0 && el.videoHeight === 0) build(true);
    });
    el.addEventListener('error', () => !closed && onUnplayable?.());
    seek.addEventListener('input', () => {
      dragging = true;
      $('[data-m="now"]').textContent = fmtClock(Number(seek.value));
      fill(seek);
    });
    seek.addEventListener('change', () => {
      dragging = false;
      el.currentTime = Number(seek.value);
    });
    vol.addEventListener('input', () => {
      el.volume = Number(vol.value);
      el.muted = el.volume === 0;
    });
    root.addEventListener('click', (e) => {
      const b = e.target.closest('[data-m]');
      if (e.target === el) return toggle();
      if (!b) return;
      if (b.dataset.m === 'play') toggle();
      else if (b.dataset.m === 'mute') toggleMute();
      else if (b.dataset.m === 'speed') el.playbackRate = SPEEDS[(SPEEDS.indexOf(el.playbackRate) + 1) % SPEEDS.length];
      else if (b.dataset.m === 'full') toggleFull();
    });
    if (!audio) el.addEventListener('dblclick', toggleFull);
    sync();
  }

  const toggle = () => (el.paused || el.ended ? el.play().catch(() => {}) : el.pause());
  const toggleMute = () => {
    if (el.muted || el.volume === 0) {
      el.muted = false;
      if (el.volume === 0) el.volume = 1;
    } else el.muted = true;
  };
  const toggleFull = () => {
    if (!root.classList.contains('mp-video')) return;
    if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
    else root.requestFullscreen().catch(() => {});
  };

  // Space/K, M and F, unless typing or a button or slider has the key.
  const onKey = (e) => {
    if (e.metaKey || e.ctrlKey || e.altKey || e.target.closest?.('input:not([type="range"]), textarea, select')) return;
    const k = e.key.toLowerCase();
    if ((k === ' ' && !e.target.closest?.('button')) || k === 'k') toggle();
    else if (k === 'm') toggleMute();
    else if (k === 'f') toggleFull();
    else return;
    e.preventDefault();
  };
  document.addEventListener('keydown', onKey);

  build(kind === 'audio');
  return {
    cleanup: () => {
      closed = true;
      document.removeEventListener('keydown', onKey);
      if (document.fullscreenElement === root) document.exitFullscreen().catch(() => {});
      el.pause();
      el.removeAttribute('src');
      el.load();
      URL.revokeObjectURL(url);
    },
  };
}
