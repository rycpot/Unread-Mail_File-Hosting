// Offscreen document (a service worker cannot play audio). Plays a short,
// soft two-note chime synthesised with Web Audio, so no sound file is needed.

let ctx;

function note(freq, start, { gain = 0.16, length = 0.9 } = {}) {
  const t = ctx.currentTime + start;
  const env = ctx.createGain();
  env.gain.setValueAtTime(0.0001, t);
  env.gain.exponentialRampToValueAtTime(gain, t + 0.015); // soft attack
  env.gain.exponentialRampToValueAtTime(0.0001, t + length); // long, gentle decay
  env.connect(ctx.destination);
  // A sine plus a faint octave gives a rounded, bell-like tone.
  for (const [mult, level] of [[1, 1], [2, 0.18]]) {
    const osc = ctx.createOscillator();
    const g = ctx.createGain();
    osc.type = 'sine';
    osc.frequency.value = freq * mult;
    g.gain.value = level;
    osc.connect(g).connect(env);
    osc.start(t);
    osc.stop(t + length + 0.05);
  }
}

async function chime() {
  ctx ??= new AudioContext();
  if (ctx.state === 'suspended') await ctx.resume();
  note(783.99, 0); // G5
  note(1174.66, 0.14, { gain: 0.12 }); // D6, a fifth above: calm, not urgent
}

chrome.runtime.onMessage.addListener((msg) => {
  if (msg?.target === 'offscreen' && msg.cmd === 'chime') chime();
});
