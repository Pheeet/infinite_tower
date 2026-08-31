'use strict';
/* sound.js — V0.9.3 "The Sound" — PROCEDURAL CHIPTUNE, zero audio assets.
   WebAudio only: every SFX is a synthesized envelope, the music is a tiny
   square/triangle/noise sequencer with a lookahead scheduler. No files, no
   network, nothing to load — mute is one localStorage flag.

   Public surface (all guarded — game runs silent if AudioContext is missing
   or the browser blocks it):
     IT.snd.play(name)        — 'hit','crit','heal','death','kill','skill',
                                'mark','tap','victory','defeat','coin'
     IT.snd.music(track)      — 'lobby' | 'battle' | 'boss' | null (stop)
     IT.snd.toggle()          — mute on/off, returns muted state
     IT.snd.muted             — current state (persisted, key infinite_tower_snd)

   Autoplay policy: the context is created/resumed on the FIRST user gesture
   (pointerdown once, capture). Until then everything no-ops silently. */
window.IT = window.IT || {};
IT.snd = (function () {

var KEY = 'infinite_tower_snd';
/* v0.9.5: continuous volume 0..1 (the header meter). Stored as a string
   float; the old 3-level values and the legacy mute flag migrate cleanly. */
var level = 1;
try {
  var lv = parseFloat(localStorage.getItem(KEY));
  if (isNaN(lv)) lv = (localStorage.getItem(KEY) === '1') ? 0 : 1;   // legacy mute flag
  level = Math.max(0, Math.min(1, lv));
} catch (e) { level = 1; }
var muted = (level <= 0.001);   // kept for the header icon contract

var ctx = null, master = null, musicGain = null, sfxGain = null;
var seq = null;               // active music scheduler handle

/* ============================ context ============================ */
function ensure() {
  if (ctx) { if (ctx.state === 'suspended') { try { ctx.resume(); } catch (e) { /* ignore */ } } return !!ctx; }
  var AC = (typeof window !== 'undefined') && (window.AudioContext || window.webkitAudioContext);
  if (!AC) return false;
  try {
    ctx = new AC();
    /* v0.9.5c mix: master → compressor → out (no more clipped stacks), and
       the music bus runs through a lowpass — raw squares were ear-piercing. */
    var comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -18; comp.knee.value = 20; comp.ratio.value = 6;
    master = ctx.createGain();
    master.gain.value = level * level;   // perceptual
    master.connect(comp); comp.connect(ctx.destination);
    sfxGain = ctx.createGain(); sfxGain.gain.value = 0.42; sfxGain.connect(master);
    musicGain = ctx.createGain(); musicGain.gain.value = 0.085;
    var mlp = ctx.createBiquadFilter();
    mlp.type = 'lowpass'; mlp.frequency.value = 2100; mlp.Q.value = 0.4;
    musicGain.connect(mlp); mlp.connect(master);
  } catch (e) { ctx = null; return false; }
  return true;
}
/* unlock on first gesture — browsers require it before any sound */
if (typeof document !== 'undefined' && document.addEventListener) {
  try {
    document.addEventListener('pointerdown', function unlock() {
      ensure();
      try { document.removeEventListener('pointerdown', unlock); } catch (e) { /* ignore */ }
    }, { capture: true, once: true });
  } catch (e) { /* ignore */ }
}

/* v0.9.5: continuous volume. Perceptual curve (v²) so the meter's middle
   actually sounds like half. muted is just level==0. */
function setLevel(v) {
  level = Math.max(0, Math.min(1, Number(v) || 0));
  muted = (level <= 0.001);
  try { localStorage.setItem(KEY, String(level)); } catch (e) { /* ignore */ }
  /* v0.9.5b: ramp the param instead of writing .value — direct writes are
     unreliable on WebKit while notes are mid-schedule. */
  if (master && ctx) {
    try {
      var t = ctx.currentTime;
      master.gain.cancelScheduledValues(t);
      master.gain.setTargetAtTime(level * level, t, 0.02);
    } catch (e) { try { master.gain.value = level * level; } catch (e2) { /* ignore */ } }
  }
  return level;
}
function toggle() {   // kept for keyboard/quick callers: cycles 1 → .5 → 0
  return setLevel(level > 0.5 ? 0.5 : (level > 0.001 ? 0 : 1));
}

/* ============================ synth primitives ============================ */
/* one pitched blip: type wave, f0→f1 glide, exp decay */
function tone(t0, dur, f0, f1, type, vol, dest) {
  if (!ctx) return;
  var o = ctx.createOscillator(), g = ctx.createGain();
  o.type = type || 'square';
  o.frequency.setValueAtTime(Math.max(20, f0), t0);
  if (f1 && f1 !== f0) o.frequency.exponentialRampToValueAtTime(Math.max(20, f1), t0 + dur);
  g.gain.setValueAtTime(0.0001, t0);
  g.gain.exponentialRampToValueAtTime(vol || 0.3, t0 + 0.008);
  g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
  o.connect(g); g.connect(dest || sfxGain);
  o.start(t0); o.stop(t0 + dur + 0.02);
}
/* noise burst through a bandpass — impacts, death crunch */
function noise(t0, dur, freq, q, vol) {
  if (!ctx) return;
  var n = Math.floor(ctx.sampleRate * dur) + 1;
  var buf = ctx.createBuffer(1, n, ctx.sampleRate);
  var d = buf.getChannelData(0);
  for (var i = 0; i < n; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / n);
  var src = ctx.createBufferSource(); src.buffer = buf;
  var bp = ctx.createBiquadFilter(); bp.type = 'bandpass';
  bp.frequency.value = freq || 800; bp.Q.value = q || 0.8;
  var g = ctx.createGain(); g.gain.value = vol || 0.3;
  src.connect(bp); bp.connect(g); g.connect(sfxGain);
  src.start(t0);
}
function arp(t0, notes, step, type, vol) {
  for (var i = 0; i < notes.length; i++) {
    tone(t0 + i * step, step * 1.6, notes[i], notes[i], type || 'square', vol || 0.22);
  }
}

/* ============================ SFX ============================ */
var N = { C3: 130.8, D3: 146.8, E3: 164.8, F3: 174.6, G3: 196, A3: 220, B3: 246.9,
  C4: 261.6, D4: 293.7, E4: 329.6, F4: 349.2, G4: 392, A4: 440, B4: 493.9,
  C5: 523.3, D5: 587.3, E5: 659.3, G5: 784, A5: 880, C6: 1046.5, E6: 1318.5 };

function play(name) {
  if (muted || !ensure()) return;
  try {
    var t = ctx.currentTime;
    switch (name) {
      case 'hit':     noise(t, 0.09, 700, 0.7, 0.34); tone(t, 0.07, 160, 90, 'square', 0.18); break;
      case 'crit':    noise(t, 0.16, 1100, 0.6, 0.42); tone(t, 0.14, 220, 70, 'sawtooth', 0.3);
                      tone(t + 0.02, 0.1, N.A4, N.E5, 'square', 0.16); break;
      case 'heal':    arp(t, [N.E4, N.G4, N.B4, N.E5], 0.07, 'triangle', 0.22); break;
      case 'burn':    noise(t, 0.14, 2400, 0.5, 0.14); tone(t, 0.1, N.E3, N.C3, 'sawtooth', 0.1); break;
      case 'death':   tone(t, 0.7, N.A3, 55, 'sawtooth', 0.3); noise(t + 0.05, 0.25, 300, 0.6, 0.3);
                      arp(t + 0.3, [N.E4, N.D4, N.C4], 0.16, 'triangle', 0.14); break;
      case 'kill':    noise(t, 0.2, 500, 0.5, 0.35); tone(t, 0.22, N.D4, N.G3, 'square', 0.2); break;
      case 'skill':   arp(t, [N.C5, N.E5, N.G5], 0.055, 'square', 0.18); break;
      case 'mark':    tone(t, 0.3, N.C3, N.C3, 'triangle', 0.3); tone(t + 0.16, 0.3, N.G3, N.G3, 'triangle', 0.24); break;
      case 'shake':   noise(t, 0.12, 180, 0.4, 0.4); break;
      case 'tap':     tone(t, 0.04, N.C6, N.C6, 'square', 0.1); break;
      case 'coin':    arp(t, [N.B4, N.E5], 0.06, 'square', 0.18); break;
      case 'victory': arp(t, [N.C4, N.E4, N.G4, N.C5, N.E5, N.G5], 0.11, 'square', 0.2); break;
      case 'defeat':  arp(t, [N.C4, N.B3, N.A3, N.G3, N.E3, N.C3], 0.19, 'triangle', 0.22); break;
      default: break;
    }
  } catch (e) { /* never let audio break gameplay */ }
}

/* ============================ music sequencer ============================ */
/* Tiny tracker: patterns are arrays of [note, beats] per voice; the scheduler
   looks ahead 0.2s on a 90ms interval. Voices: lead square, bass triangle,
   hat = short noise. Loop length = pattern beats × spb. */
function voiceNote(t0, dur, freq, type, vol) {
  if (!freq) return;
  var o = ctx.createOscillator(), g = ctx.createGain();
  o.type = type; o.frequency.value = freq;
  g.gain.setValueAtTime(0.0001, t0);
  g.gain.exponentialRampToValueAtTime(vol, t0 + 0.02);
  g.gain.setValueAtTime(vol, Math.max(t0 + 0.02, t0 + dur - 0.06));
  g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
  o.connect(g); g.connect(musicGain);
  o.start(t0); o.stop(t0 + dur + 0.02);
}
function hat(t0, vol) {
  var n = Math.floor(ctx.sampleRate * 0.05) + 1;
  var buf = ctx.createBuffer(1, n, ctx.sampleRate);
  var d = buf.getChannelData(0);
  for (var i = 0; i < n; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / n);
  var src = ctx.createBufferSource(); src.buffer = buf;
  var hp = ctx.createBiquadFilter(); hp.type = 'highpass'; hp.frequency.value = 7600;
  var g = ctx.createGain(); g.gain.value = vol;
  src.connect(hp); hp.connect(g); g.connect(musicGain);
  src.start(t0);
}
/* 16-step patterns; null = rest. Written for the tower: lobby = slow candle
   waltz, battle = driving minor pulse, boss = tritone menace. */
var TRACKS = {
  lobby: {
    spb: 0.34,   // ~88bpm
    lead: [N.E4, null, N.G4, null, N.B4, null, N.G4, null, N.A4, null, N.G4, null, N.E4, null, N.D4, null,
           N.E4, null, N.G4, null, N.C5, null, N.B4, null, N.A4, null, N.B4, null, N.G4, null, null, null],
    bass: [N.C3, null, null, null, N.G3, null, null, null, N.A3, null, null, null, N.E3, null, null, null,
           N.C3, null, null, null, N.G3, null, null, null, N.F3, null, null, null, N.G3, null, null, null],
    hat:  [0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1, 1]
  },
  battle: {
    spb: 0.21,   // ~143bpm
    lead: [N.A4, N.C5, N.E5, N.C5, N.A4, N.C5, N.E5, N.G5, N.F5, N.E5, N.D5, N.E5, N.C5, N.B4, N.A4, N.B4,
           N.A4, N.C5, N.E5, N.C5, N.G4, N.B4, N.D5, N.B4, N.C5, N.E5, N.G5, N.E5, N.D5, N.C5, N.B4, N.A4],
    bass: [N.A3, N.A3, N.E3, N.E3, N.F3, N.F3, N.C3, N.C3, N.D3, N.D3, N.A3, N.A3, N.E3, N.E3, N.E3, N.E3,
           N.A3, N.A3, N.E3, N.E3, N.G3, N.G3, N.D3, N.D3, N.F3, N.F3, N.C3, N.C3, N.E3, N.E3, N.E3, N.E3],
    hat:  [1, 0, 1, 1, 1, 0, 1, 1, 1, 0, 1, 1, 1, 0, 1, 1, 1, 0, 1, 1, 1, 0, 1, 1, 1, 0, 1, 1, 1, 0, 1, 1]
  },
  boss: {
    spb: 0.26,
    lead: [N.C4, null, N.G4, null, N.C5, null, N.G4, null, N.C4 + 0.6, null, N.G4 + 0.6, null, N.C5 + 0.6, null, null, null,
           N.C4, null, N.G4, null, N.D5, null, N.C5, null, N.B4, null, N.A4, null, N.G4, null, null, null],
    bass: [N.C3, N.C3, null, N.C3, N.F3, N.F3, null, N.F3, N.G3, N.G3, null, N.G3, N.C3, null, N.C3, null,
           N.C3, N.C3, null, N.C3, N.E3, N.E3, null, N.E3, N.G3, N.G3, null, N.G3, N.C3, null, null, null],
    hat:  [1, 1, 0, 1, 1, 1, 0, 1, 1, 1, 0, 1, 1, 1, 0, 1, 1, 1, 0, 1, 1, 1, 0, 1, 1, 1, 0, 1, 1, 1, 1, 1]
  }
};

function music(track) {
  if (seq) { clearInterval(seq.i); seq = null; }
  if (!track || !ensure()) return;   /* start even while muted — the scheduler
                                        paces itself silently and resumes on unmute */
  var tr = TRACKS[track];
  if (!tr) return;
  try {
    var steps = tr.lead.length, stepDur = tr.spb;
    var next = ctx.currentTime + 0.1, pos = 0;
    seq = { name: track, i: 0 };
    seq.i = setInterval(function () {
      if (!seq || !ctx) return;
      try {
        var nowT = ctx.currentTime;
        /* v0.9.5 FIX: while muted (or the tab throttled us) the cursor must
           KEEP PACE with the clock — otherwise every step queued during the
           silence fires at once on unmute and the track "restarts". */
        if (muted) { next = Math.max(next, nowT + 0.05); return; }
        if (next < nowT - 0.05) next = nowT + 0.05;   // resync, keep pattern position
        while (next < nowT + 0.25) {
          var t0 = next;
          if (tr.lead[pos]) voiceNote(t0, stepDur * 0.9, tr.lead[pos], 'square', 0.11);
          if (tr.bass[pos]) voiceNote(t0, stepDur * 0.95, tr.bass[pos], 'triangle', 0.15);
          if (tr.hat[pos]) hat(t0, 0.028);
          next += stepDur; pos = (pos + 1) % steps;
        }
      } catch (e) { /* keep the loop alive */ }
    }, 90);
  } catch (e) { seq = null; }
}

return {
  play: play,
  music: music,
  toggle: toggle,
  setLevel: setLevel,   // v0.9.5: continuous 0..1 (the meter)
  get muted() { return muted; },
  get level() { return level; }
};

})();
