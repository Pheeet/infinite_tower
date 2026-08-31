'use strict';
/* scene.js — V0.9 "The Battle Scene" — CANVAS PRESENTATION LAYER ONLY.
   The battle stops being cards and becomes a room: a stone chamber lit by
   torches, figures that lunge and reel, sparks, floating damage, screen
   shake, HP bars that bleed down. ZERO mechanics here — the engine
   (combat.js) stays frozen; this file only READS snapshots and plays
   effects the engine reports through fx().

   Contract with combat.js (all guarded — combat runs untouched without it):
     IT.scene.attach(rootEl) -> handle | null
       Builds the battle layout INSIDE #battle-view: floor/round kicker,
       one <canvas>, the collapsible log strip, the command bar. Returns
         { fx, sync, detach, onHeroTap, floor, round, log, logWrap, logBtn, bar }
       or null when <canvas> is not usable (headless mini-DOM) — the caller
       then keeps its legacy DOM view. Also null when requestAnimationFrame
       is missing.
     handle.sync(snapshot) — full unit state, called from renderAll().
     handle.fx(type, data) — beat effects: 'skill' 'hit' 'heal' 'burn'
       'death' 'mark' 'shake'.
     handle.onHeroTap(fn) — canvas taps hit-test hero slots (Master Command
       picker); fn(heroId).

   Scene-side randomness (torch flicker, spark scatter) draws from its own
   Math.random calls ONLY — it never touches the engine's rng stream, so
   golden.js stays bit-identical. */
window.IT = window.IT || {};
IT.scene = (function () {

var HAS_DOM = (typeof document !== 'undefined') && !!document.createElement;
var HAS_RAF = (typeof requestAnimationFrame === 'function');
var C = {   // tokens (mirror style.css / combat.js literals)
  bg0: '#07080c', bg1: '#0d1017', wall: '#141822', wall2: '#1b2130',
  line: '#262d3d', txt: '#d7dce6', dim: '#8b94a7',
  gold: '#e8b04b', red: '#e05263', green: '#5fbf77', blue: '#5aa2e8',
  cls: { Warrior: '#d98e3f', Tank: '#7f8fa6', Rogue: '#7ec97e', Mage: '#9b6ee8', Healer: '#5fd4e0' }
};
var SERIF = '"Cinzel",Georgia,serif';
var PIXEL = '"Press Start 2P","Cinzel",monospace';   // damage numbers / banners / nameplates

/* ============================ scoped style ============================ */
var CSS = [
  '#battle-view #cb-canvas{display:block;width:100%;background:' + C.bg0 + ';border-bottom:1px solid rgba(232,176,75,.14);touch-action:manipulation;}',
  '@media(max-width:400px){#battle-view #cb-canvas{min-height:400px;}}'
].join('\n');
function injectStyle() {
  try {
    if (document.getElementById('it-scene-style')) return;
    var s = document.createElement('style');
    s.id = 'it-scene-style';
    s.textContent = CSS;
    document.head.appendChild(s);
  } catch (e) { /* cosmetic */ }
}

/* ============================ attached state ============================ */
var st = null;
var api = null;

function reducedMotion() {
  try {
    return !!(typeof window !== 'undefined' && window.matchMedia &&
      window.matchMedia('(prefers-reduced-motion: reduce)').matches);
  } catch (e) { return false; }
}

/* ============================ layout ============================ */
/* Canvas logical size (css px). Slot geometry is recomputed per frame from
   the snapshot (rosters can grow mid-battle: Hollow King summons). */
function resize() {
  if (!st) return;
  try {
    /* ponytail: no 300px floor — a 320px device has ~288px content; a floor
       stretches the bitmap ≠ hitboxes (offset taps). h also respects viewport
       height so the command bar isn't below the fold on short/rotated phones */
    var w = Math.min(430, st.root.clientWidth || st.root.offsetWidth || 430);
    var vh = (typeof window !== 'undefined' && window.innerHeight) || 0;
    var h = Math.max(320, Math.min(480, Math.round(w * 1.08), vh ? Math.round(vh * 0.62) : 480));
    var dpr = Math.max(1, Math.min(3, (typeof devicePixelRatio === 'number') ? devicePixelRatio : 1));
    st.w = w; st.h = h; st.dpr = dpr;
    st.canvas.width = Math.round(w * dpr);
    st.canvas.height = Math.round(h * dpr);
    st.canvas.style.height = h + 'px';
    st.ctx.imageSmoothingEnabled = false;   // pixel sprites stay chunky
  } catch (e) { /* keep last size */ }
}

function heroSlots(n) {
  var out = [], w = st.w;
  for (var i = 0; i < n; i++) out.push({ x: w * (i + 1) / (n + 1), y: st.h * 0.72 });
  return out;
}
function mobSlots(n, withBoss) {
  var out = [], w = st.w;
  var y = withBoss ? st.h * 0.46 : st.h * 0.28;
  for (var i = 0; i < n; i++) out.push({ x: w * (i + 1) / (n + 1), y: y });
  return out;
}

/* ============================ units ============================ */
/* Registry keyed 'h<id>' / 'e<uid>' — persists per battle so animation state
   (display hp, flash, tweens) survives syncs. */
function unit(key, glyph, name) {
  return {
    key: key, glyph: glyph, name: name,
    hp: 1, max: 1, disp: 1, lag: 1,       // hp fractions (0..1); lag trails disp
    dead: false, gone: false, flash: 0, phase: Math.random() * 6.28,
    anim: null, dieT: -1, intro: 0,
    spr: null, sc: 3, baseAlpha: 1
  };
}
function uHero(ref) { return st.units['h' + ref.id]; }
function uFoe(ref) { return st.units['e' + ref.uid]; }

/* ============================ pixel sprites (v0.9.1) ============================
   Procedural pixel figures drawn 1px-at-a-time on a tiny offscreen canvas,
   blitted with imageSmoothing OFF at integer scale — chunky by construction.
   HEROES: one body plan per class (helm/shield/hood/hat/robe + weapon),
   then per-HERO variation seeded by hero id: hair color, skin tone, cloth
   shade — Mage #1 and Mage #2 look different, same silhouette language.
   FOES: 6 body plans (humanoid/beast/skeleton/ghost/ogre/spider) picked by
   name keywords, cloth hue from a name hash (deterministic — same foe name,
   same look, every run). BOSSES: dedicated 18x22 sprites (Executioner axe,
   Hollow King crown+cape).
   All rng here is a LOCAL mulberry32 seeded by id/name — presentation-only,
   never touches the engine stream (golden stays bit-identical). */
function mulberry(a) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    var t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function sprCanvas(w, h) {
  var c = document.createElement('canvas');
  c.width = w; c.height = h;
  return { c: c, g: c.getContext('2d'), w: w, h: h };
}
function R(g, x, y, w0, h0, col) { g.fillStyle = col; g.fillRect(x, y, w0, h0); }
function hexRgb(hex) {
  var n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
function shade(hex, f) {   // f>0 toward white, f<0 toward black
  var c = hexRgb(hex), out = '#';
  for (var i = 0; i < 3; i++) {
    var v = f > 0 ? c[i] + (255 - c[i]) * f : c[i] * (1 + f);
    out += ('0' + Math.max(0, Math.min(255, Math.round(v))).toString(16)).slice(-2);
  }
  return out;
}
var SKINS = ['#e8b48c', '#c98d63', '#8d5a3b', '#f0c8a0'];
var HAIRS = ['#2b2b33', '#6b4a2b', '#a8763a', '#c9c9d1', '#7e3a2b', '#3d5a3b', '#8a5a7a'];
var MET_L = '#aeb6c4', MET_D = '#7d8698', STEEL = '#d8dde8', WOOD = '#6b4a2b', EYE = '#1a1d26';

/* v0.19 HERO SPRITES — Korean mobile-RPG chibi, procedural:
   24x28, big head (~45% height), BIG expressive eyes with a highlight
   pixel, every material carries THREE tones (base/shadow/light), and a
   real outline is grown from the silhouette (outlinePass) so chunky
   clusters read crisply at any integer-ish scale. Poses unchanged:
   idle0 / idle1 (breathe) / atk (weapon up). */
/* v0.24 outlinePass v3 — NAVY-TINTED colored outline: sample the brightest
   neighbor, keep 50% of it, then lean 30% toward dark navy. Reads as one
   family line around every hero without the heavy black-box look that
   drowned in dark scenes. */
function outlinePass(s) {
  var g = s.g, w0 = s.w, h0 = s.h, id;
  try { id = g.getImageData(0, 0, w0, h0); } catch (e) { return; }
  var d = id.data, out = new Uint8Array(w0 * h0), col = new Uint8Array(w0 * h0 * 3), x, y, i;
  var NV = [18, 24, 36];
  for (y = 0; y < h0; y++) {
    for (x = 0; x < w0; x++) {
      i = (y * w0 + x) * 4;
      if (d[i + 3] > 40) continue;
      var best = -1, bx = 0, bg2 = 0, bb = 0;
      var around = [[-1, 0], [1, 0], [0, -1], [0, 1]];
      for (var a = 0; a < 4; a++) {
        var nx = x + around[a][0], ny = y + around[a][1];
        if (nx < 0 || ny < 0 || nx >= w0 || ny >= h0) continue;
        var j = (ny * w0 + nx) * 4;
        if (d[j + 3] > 40 && d[j] + d[j + 1] + d[j + 2] > best) {
          best = d[j] + d[j + 1] + d[j + 2]; bx = d[j]; bg2 = d[j + 1]; bb = d[j + 2];
        }
      }
      if (best >= 0) {
        out[y * w0 + x] = 1;
        var r = bx * 0.38, gg = bg2 * 0.38, b = bb * 0.38;
        col[(y * w0 + x) * 3] = Math.round(r * 0.78 + NV[0] * 0.22);
        col[(y * w0 + x) * 3 + 1] = Math.round(gg * 0.78 + NV[1] * 0.22);
        col[(y * w0 + x) * 3 + 2] = Math.round(b * 0.78 + NV[2] * 0.22);
      }
    }
  }
  for (var k2 = 0; k2 < out.length; k2++) {
    if (out[k2]) {
      var k = k2 * 4, c = k2 * 3;
      d[k] = col[c]; d[k + 1] = col[c + 1]; d[k + 2] = col[c + 2]; d[k + 3] = 255;
    }
  }
  g.putImageData(id, 0, 0);
}

/* ============================ V0.28 HERO SPRITES — hand-crafted grids ============================
   Designed ON a 12x16 grid (not rectangles reduced to pixels): asymmetric
   idle poses (lean, akimbo arms, uneven shoulders), weapons fused into the
   silhouette, per-hero fringe variants + palette swaps for face identity,
   and a DIRECTIONAL outline (shadow side only — light side stays open, so
   the sprite reads drawn, not stickered). Rows are auto-padded, so the
   authored grids never need exact-width counting.
   chars: H hair · S skin · E eye · C cloth · c cloth-shade · A accent ·
          M metal · m metal-shade · G gold · L leather/wood · B blade ·
          b blade-shade · O orb (class color) · o orb-shade · W white      */
var GRID_W = 12, GRID_H = 16;

var HERO_GRIDS = {
/* V0.29 CONSTRUCTION RULES — one skeleton for the whole roster:
   rows 0-1 headgear · 2-5 face (cols 3-8) · 6 shoulders (2-9) · 6-11 torso ·
   12-14 legs · 15 FEET ON THE BASELINE. Every class shares this exact
   skeleton; equipment may occupy the side columns (0-2 / 9-11) and the
   headgear rows, but NEVER shifts the body axis. Alignment reference =
   the feet, not the weapon bounding box. */
Warrior: {
  idle: [
    '...MMMMMM',
    '...MMMMMM',
    '...MMMMMM',
    '...MEMMEM',
    '...MMMMMM',
    '....SSSS',
    'MMCCCCCCCCSB',
    'MMCCCCCCCC.B',
    'MMCCCCCCCC.B',
    'MMCCCCCCCC.B',
    'MMcccGGccc.B',
    'MMCCCCCCCC.B',
    'MM..CC..CCLG',
    'MM..CC..CC',
    'MM..LL..LL',
    'MM.LLL..LLL'
  ],
  atk: [
    '..........Bb',
    '..........BB',
    '...MMMMMMGB',
    '...MMMMMMGB',
    '...MEMMEMGB',
    '....SSSS.GB',
    'MMCCCCCCCCSB',
    'MMCCCCCCCC.B',
    'MMCCCCCCCC.B',
    'MMCCCCCCCC',
    'MMcccGGccc',
    'MMCCCCCCCC',
    'MM..CC..CC',
    'MM..CC..CC',
    'MM..LL..LL',
    'MM.LLL..LLL'
  ]
},
Tank: {
  idle: [
    '...MMMMMM',
    '...MMMMMM',
    '...MEMMEM',
    '...MMMMMM',
    '...MMMMMM',
    '....SSSS',
    'MMMCCCCCCCM',
    'MMMCCCCCCCM',
    'MMMCCCCCCCL',
    'MMMCCCCCCSCL',
    'MMMcccGGccL',
    'MMMCCCCCCCC',
    'MMM..CC..CC',
    'MMM..CC..CC',
    'MMM..LL..LL',
    'MMMLLL..LLL'
  ],
  atk: [
    '..........MM',
    '..........MM',
    '...MMMMMMLL',
    '...MEMMEMLL',
    '...MMMMMMLL',
    '....SSSS',
    'MMMCCCCCCCM',
    'MMMCCCCCCCM',
    'MMMCCCCCCCC',
    'MMMCCCCCCCC',
    'MMMcccGGccc',
    'MMMCCCCCCCC',
    'MMM..CC..CC',
    'MMM..CC..CC',
    'MMM..LL..LL',
    'MMMLLL..LLL'
  ]
},
Rogue: {
  idle: [
    '...CCCCCC',
    '...CCCCCC',
    '...CCCCCC',
    '...CESEEC',
    '....SSSS',
    '....SSSS',
    '..CCCCCCCCSB',
    '..CCCCCCCC.B',
    '..CCCCCCCC.B',
    '..CCCCCCCC.B',
    '..cccGGccc.B',
    '..CCCCCCCC.B',
    '...CC..CCLG',
    '...CC..CC',
    '...LL..LL',
    '..LLL..LLL'
  ],
  atk: [
    '.........Bb',
    '.........BB',
    '...CCCCCCLB',
    '...CESEECLB',
    '....SSSS.LB',
    '....SSSS',
    '..CCCCCCCCSB',
    '..CCCCCCCC',
    '..CCCCCCCC',
    '..CCCCCCCC',
    '..cccGGccc',
    '..CCCCCCCC',
    '...CC..CC',
    '...CC..CC',
    '...LL..LL',
    '..LLL..LLL'
  ]
},
Mage: {
  idle: [
    '..........OO',
    '.........OoO',
    '..CCCCCCCCGL',
    '...HSHSHH',
    '...SESSES',
    '....SSSS',
    '..CCCCCCCC',
    '..CCCCCCCC',
    '..CCCCCCCC',
    '..CCCAACCC',
    '..cccGGccc',
    '..CCCCCCCC',
    '...CCCCCC',
    '...CCCCCC',
    '...CCCCCC',
    '..LLL..LLL'
  ],
  atk: [
    '..........WW',
    '.........OOO',
    '..CCCCCCCCGL',
    '...HSHSHH',
    '...SESSES',
    '....SSSS',
    '..CCCCCCCC',
    '..CCCCCCCC',
    '..CCCCCCCC',
    '..CCCAACCC',
    '..cccGGccc',
    '..CCCCCCCC',
    '...CCCCCC',
    '...CCCCCC',
    '...CCCCCC',
    '..LLL..LLL'
  ]
},
Healer: {
  idle: [
    '...HHHHHH',
    '...HHHHHH',
    '...GGGGGG',
    '...SESSES',
    '...SESSES',
    '....SSSS',
    'H.CCCCCCCC.A',
    'H.CCCCCCCC.A',
    'H.CCCAACCC.A',
    'H.CCCAACCC.A',
    'H.cccGGccc.A',
    'H.CCCCCCCC.L',
    'H..CCCCCC.L',
    'H..CCCCCC.L',
    'H..CCCCCC.L',
    'H.LLL..LLL'
  ],
  atk: [
    '..........AA',
    '.........AAA',
    '...HHHHHHLA',
    '...GGGGGGLL',
    '...SESSES',
    '....SSSS',
    'H.CCCCCCCC',
    'H.CCCCCCCC',
    'H.CCCAACCC',
    'H.CCCAACCC',
    'H.cccGGccc',
    'H.CCCCCCCC',
    'H..CCCCCC',
    'H..CCCCCC',
    'H..CCCCCC',
    'H.LLL..LLL'
  ]
}
};

/* per-hero fringe variants — face identity without breaking the axis */
function applyFringe(rows, v, cls) {
  var r = rows.slice();
  if (v === 1) {            /* side-swept */
    r[0] = '..HHHHHH';
    r[1] = '..HHHHHH';
  } else if (v === 2 && cls !== 'Tank' && cls !== 'Rogue') {  /* hair over the left eye */
    var row3 = r[3].split('');
    if (row3[4] === 'E') row3[4] = 'H';
    r[3] = row3.join('');
  }
  return r;
}

/* directional outline: dark rim on the SHADOW side only (neighbors above
   and to the LEFT are the light side and stay open) */
function outlineDarkSide(s) {
  var g = s.g, w0 = s.w, h0 = s.h, id;
  try { id = g.getImageData(0, 0, w0, h0); } catch (e) { return; }
  var d = id.data, x, y, i;
  var NV = [18, 22, 30];
  for (y = 0; y < h0; y++) {
    for (x = 0; x < w0; x++) {
      i = (y * w0 + x) * 4;
      if (d[i + 3] > 40) continue;
      /* shadow rim: opaque neighbor BELOW or RIGHT (light from top-left) */
      var nb = null;
      if (y < h0 - 1 && d[i + w0 * 4 + 3] > 40) nb = i + w0 * 4;
      else if (x < w0 - 1 && d[i + 4 + 3] > 40) nb = i + 4;
      if (nb == null) continue;
      var r = Math.round((d[nb] * 0.34) * 0.8 + NV[0] * 0.2);
      var gg = Math.round((d[nb + 1] * 0.34) * 0.8 + NV[1] * 0.2);
      var b = Math.round((d[nb + 2] * 0.34) * 0.8 + NV[2] * 0.2);
      d[i] = r; d[i + 1] = gg; d[i + 2] = b; d[i + 3] = 255;
    }
  }
  g.putImageData(id, 0, 0);
}

function makeHeroSprite(cls, id, pose, marks) {
  pose = pose || 'idle0';
  var rng = mulberry((id | 0) * 7919 + 13);
  var skin = SKINS[Math.floor(rng() * SKINS.length)];
  var hair = HAIRS[Math.floor(rng() * HAIRS.length)];
  var VIVID = { Warrior: '#d24a33', Tank: '#3f6ea8', Rogue: '#2f9153',
                Mage: '#8a4fc0', Healer: '#2fb9c9' };
  var cloth = shade(VIVID[cls] || '#8a93a8', 0.1 + (rng() - 0.5) * 0.12);
  var fringeV = Math.floor(rng() * 3);

  var pal = {
    H: hair, S: skin, E: '#20242e',
    C: cloth, c: shade(cloth, -0.32), A: '#f2e8d0',
    M: '#9aa5b5', m: '#6d7686', G: '#e8b04b',
    L: '#6b4a2b', B: '#dde3ec', b: '#a9b2c2',
    O: shade(VIVID[cls] || '#8a93a8', 0.35), o: shade(VIVID[cls] || '#8a93a8', -0.1),
    W: '#ffffff'
  };

  var base = HERO_GRIDS[cls] || HERO_GRIDS.Warrior;
  var rows = applyFringe(base[pose === 'atk' ? 'atk' : 'idle'], fringeV, cls);
  var dy = (pose === 'idle1') ? 1 : 0;   /* breathe: head block sinks, feet stay */

  var s = sprCanvas(GRID_W, GRID_H), g = s.g;
  for (var y = 0; y < GRID_H; y++) {
    var row = (rows[y] || '').padEnd(GRID_W, '.').slice(0, GRID_W);
    for (var x = 0; x < GRID_W; x++) {
      var ch = row.charAt(x);
      if (ch === '.' || !pal[ch]) continue;
      var yy = (y <= 6 && dy) ? y + 1 : y;   /* rows 0-6 = head block */
      if (yy >= GRID_H) continue;
      g.fillStyle = pal[ch];
      g.fillRect(x, yy, 1, 1);
    }
  }

  /* marks — legacy scar on the cheek, pact = both eyes burn, gold brand */
  if (marks) {
    if (marks.legacy) { g.fillStyle = '#9a6a5a'; g.fillRect(8, 4, 1, 2); }
    if (marks.pact) {
      g.fillStyle = '#5e1620'; g.fillRect(3, 3, 6, 1);
      g.fillStyle = '#e05263'; g.fillRect(4, 3, 1, 1); g.fillRect(7, 3, 1, 1);
    }
    if (marks.brand) { g.fillStyle = '#e8b04b'; g.fillRect(5, 1, 2, 1); }
  }

  outlineDarkSide(s);
  return s;
}

/* ============================ FOE SPRITES ============================ */
function foeKind(name) {
  var s = String(name || '').toLowerCase();
  if (/skeleton/.test(s)) return 'skeleton';
  if (/widow|spider/.test(s)) return 'spider';
  if (/wraith|ghost/.test(s)) return 'ghost';
  if (/bat|rat|wolf|beast/.test(s)) return 'beast';
  if (/ogre|warden|abomination|orc/.test(s)) return 'ogre';
  if (/cultist|priest|courtier/.test(s)) return 'courtier';
  return 'humanoid';
}
function hashStr(s) { var h = 0; s = String(s || ''); for (var i = 0; i < s.length; i++) h = ((h * 31) + s.charCodeAt(i)) >>> 0; return h; }
function makeFoeSprite(name, pose) {
  pose = pose || 'idle0';
  var kind = foeKind(name);
  var rng = mulberry(hashStr(name) + 7);
  var C0 = shade(['#6b4a5a', '#4a5a6b', '#5a6b4a', '#6b5a4a', '#54486b'][Math.floor(rng() * 5)], (rng() - 0.5) * 0.4);
  var cd = shade(C0, -0.35);
  var s = sprCanvas(12, 14), g = s.g;
  var dy = (pose === 'idle1') ? 1 : 0;
  if (kind === 'skeleton') {
    var bone = '#d8d4c8';
    R(g, 4, 1 + dy, 5, 4, bone); R(g, 5, 3 + dy, 1, 1, '#0b0d12'); R(g, 7, 3 + dy, 1, 1, '#0b0d12');
    R(g, 5, 5 + dy, 3, 1, '#b8b2a4');
    R(g, 5, 6 + dy, 3, 4, bone);
    R(g, 4, 7 + dy, 5, 1, bone); R(g, 4, 9 + dy, 5, 1, bone);
    R(g, 3, 7 + dy, 1, 3, bone); R(g, 8, 7 + dy, 1, 3, bone);
    R(g, 5, 10, 1, 3, bone); R(g, 7, 10, 1, 3, bone);
    R(g, 10, 4 + dy, 1, 8 - dy, WOOD); R(g, 9, 4 + dy, 1, 3, '#9aa08c');
  } else if (kind === 'beast') {
    R(g, 2, 6 + dy, 8, 4, C0); R(g, 2, 6 + dy, 8, 1, shade(C0, 0.2));
    R(g, 8, 4 + dy, 4, 4, C0); R(g, 8, 3 + dy, 1, 1, C0); R(g, 11, 3 + dy, 1, 1, C0);
    R(g, 10, 5 + dy, 1, 1, C.red); R(g, 12, 6 + dy, 1, 1, '#e8e4da');
    var lo = (pose === 'idle1') ? 1 : 0;
    R(g, 3, 10, 1, 3, cd); R(g, 5 - lo, 10, 1, 3, cd);
    R(g, 7, 10, 1, 3, cd); R(g, 9 + lo, 10, 1, 3, cd);
    R(g, 0, 6 + dy, 2, 1, cd);
  } else if (kind === 'spider') {
    var k = (pose === 'idle1') ? 1 : 0;
    R(g, 2, 4, 6, 5, C0); R(g, 3, 3, 4, 1, shade(C0, 0.2));
    R(g, 7, 5, 4, 3, cd);
    R(g, 8, 6, 1, 1, C.red); R(g, 10, 6, 1, 1, C.red);
    R(g, 1 - k, 3, 2, 1, cd); R(g, 0, 5, 2, 1, cd); R(g, 1 - k, 7, 2, 1, cd);
    R(g, 8, 3, 2, 1, cd); R(g, 10, 5, 2, 1, cd); R(g, 8 + k, 7, 2, 1, cd);
  } else if (kind === 'ghost') {
    R(g, 4, 1 + dy, 5, 3, C0);
    R(g, 3, 4 + dy, 7, 5, C0);
    R(g, 4, 9 + dy, 6, 2, C0);
    if (pose === 'idle1') { R(g, 5, 11, 1, 1, C0); R(g, 8, 11, 1, 1, C0); R(g, 3, 10, 1, 2, C0); }
    else { R(g, 4, 11, 1, 1, C0); R(g, 6, 11, 1, 1, C0); R(g, 8, 11, 1, 1, C0); }
    R(g, 5, 3 + dy, 1, 1, '#5fd4e0'); R(g, 7, 3 + dy, 1, 1, '#5fd4e0');
    s._float = true;
  } else if (kind === 'ogre') {
    s = sprCanvas(14, 16); g = s.g;
    R(g, 4, 0 + dy, 6, 4, C0); R(g, 5, 2 + dy, 1, 1, C.red); R(g, 8, 2 + dy, 1, 1, C.red);
    R(g, 2, 4 + dy, 10, 2, cd);
    R(g, 2, 6 + dy, 10, 6, C0); R(g, 4, 7 + dy, 6, 4, shade(C0, 0.18));
    R(g, 0, 6 + dy, 2, 4, cd); R(g, 12, 6 + dy, 2, 4, cd);
    R(g, 3, 12, 3, 3, cd); R(g, 8, 12, 3, 3, cd);
    R(g, 12, 1 + dy, 1, 9 - dy, WOOD); R(g, 11, 0 + dy, 3, 3, '#54402a');
  } else if (kind === 'courtier') {
    var rob = shade('#4a4066', (rng() - 0.5) * 0.3);
    R(g, 3, 0 + dy, 6, 4, rob);
    R(g, 4, 3 + dy, 5, 2, '#14121d');
    R(g, 5, 4 + dy, 1, 1, '#9b6ee8'); R(g, 7, 4 + dy, 1, 1, '#9b6ee8');
    R(g, 3, 6 + dy, 6, 5, rob); R(g, 3, 6 + dy, 6, 1, shade(rob, 0.25));
    R(g, 4, 11, 1, 2, shade(rob, -0.3)); R(g, 7, 11, 1, 2, shade(rob, -0.3));
  } else {
    R(g, 3, 0 + dy, 6, 2, '#3a3326');
    R(g, 4, 2 + dy, 5, 2, '#c9b491'); R(g, 5, 3 + dy, 1, 1, EYE); R(g, 7, 3 + dy, 1, 1, EYE);
    R(g, 3, 5 + dy, 6, 5, C0); R(g, 3, 5 + dy, 6, 1, shade(C0, 0.2));
    R(g, 3, 9 + dy, 6, 1, cd);
    R(g, 2, 5 + dy, 1, 4, C0); R(g, 9, 5 + dy, 1, 4, C0);
    R(g, 4, 10, 2, 3, cd); R(g, 6, 10, 2, 3, cd);
    R(g, 10, 4 + dy, 1, 6 - dy, WOOD); R(g, 9, 3 + dy, 3, 2, '#8a8f99');
  }
  return s;
}
function makeBossSprite(name) {
  var king = /HOLLOW KING/i.test(String(name || ''));
  var s = sprCanvas(18, 22), g = s.g;
  if (!king) {
    R(g, 4, 0, 10, 6, '#2a2d38'); R(g, 4, 0, 10, 1, '#3a3f4d');
    R(g, 6, 3, 7, 3, '#0b0d12');
    R(g, 7, 4, 2, 1, C.red); R(g, 10, 4, 2, 1, C.red);
    R(g, 1, 6, 16, 3, '#3a3f4d'); R(g, 1, 6, 16, 1, '#4d5870');
    R(g, 3, 9, 12, 6, '#2f333f');
    R(g, 3, 15, 12, 1, WOOD);
    R(g, 4, 16, 4, 5, '#262a33'); R(g, 10, 16, 4, 5, '#262a33');
    R(g, 16, 1, 1, 17, WOOD);
    R(g, 12, 2, 4, 7, '#c9ccd6'); R(g, 12, 2, 1, 7, '#e8ebf2');
    R(g, 13, 1, 2, 1, '#c9ccd6');
  } else {
    R(g, 6, 0, 1, 2, C.gold); R(g, 8, 0, 1, 2, C.gold); R(g, 10, 0, 1, 2, C.gold);
    R(g, 5, 2, 8, 1, C.gold);
    R(g, 5, 3, 8, 4, '#0b0d12');
    R(g, 7, 5, 1, 1, '#5fd4e0'); R(g, 10, 5, 1, 1, '#5fd4e0');
    R(g, 3, 6, 12, 1, '#6a5a9b');
    R(g, 2, 7, 14, 11, '#4a3d6b'); R(g, 2, 7, 14, 1, '#5d4d85');
    R(g, 4, 18, 3, 3, '#3a3055'); R(g, 9, 18, 3, 3, '#3a3055');
    R(g, 16, 4, 1, 12, WOOD);
    R(g, 15, 1, 3, 3, '#9b6ee8'); R(g, 16, 2, 1, 1, '#d5c8f2');
  }
  return s;
}

/* ============================ BATTLE: helpers ============================ */
function ts() { return st && st.snap ? Math.max(1, Math.min(8, st.snap.speed || 1)) : 1; }
function nowMs() { return st ? (performance.now() - st.t0) : 0; }
function snd(name) {
  if (!name || typeof IT === 'undefined' || !IT.snd) return;
  try { IT.snd.play(name); } catch (e) { /* audio is best-effort */ }
}
function torchPts() {
  return [[st.w * 0.10, st.h * 0.22], [st.w * 0.90, st.h * 0.22],
          [st.w * 0.06, st.h * 0.78], [st.w * 0.94, st.h * 0.78]];
}
function shadowDir(x) {
  var pts = torchPts(), best = pts[0], bd = 1e9;
  for (var i = 0; i < pts.length; i++) {
    var d = Math.abs(pts[i][0] - x) + Math.abs(pts[i][1] - st.h * 0.5);
    if (d < bd) { bd = d; best = pts[i]; }
  }
  return best[0] > x ? -1 : 1;
}
function shadow(ctx, x, y, w0, dir) {
  dir = dir || 0;
  ctx.fillStyle = 'rgba(0,0,0,.42)';
  ctx.beginPath();
  ctx.ellipse(x + dir * w0 * 0.4, y, w0 * (1 + Math.abs(dir) * 0.22), w0 * 0.24, dir * 0.1, 0, 6.283);
  ctx.fill();
}
function lightSources(t) {
  var out = [], i;
  var dim = st.snap && st.snap.ruleTint === 'darkness';
  var pts = torchPts();
  for (i = 0; i < pts.length; i++) {
    var fl = 0.8 + 0.14 * Math.sin(t * 7.3 + i * 2.1) + 0.06 * Math.sin(t * 13.7 + i);
    out.push({ x: pts[i][0], y: pts[i][1], r: (dim ? 58 : 100) * fl, a: 0.95,
      warm: 'rgba(232,160,75,' + (0.10 * fl).toFixed(3) + ')' });
  }
  if (st.snap) {
    var hs = st.snap.heroes || [];
    hs.forEach(function (h, idx) {
      if (h.dead || h.withdrawn) return;
      var s = heroSlots(hs.length)[idx];
      out.push({ x: s.x, y: s.y, r: 56, a: 0.6, warm: 'rgba(232,176,90,.05)' });
    });
    if (st.snap.boss && st.snap.boss.hp > 0) {
      out.push({ x: st.w / 2, y: st.h * 0.185, r: 120, a: 0.75, warm: 'rgba(224,82,99,.08)' });
    }
  }
  return out;
}
function lighting(ctx, t) {
  try {
    if (!st.lc || st.lc.width !== st.canvas.width || st.lc.height !== st.canvas.height) {
      st.lc = document.createElement('canvas');
      st.lc.width = st.canvas.width; st.lc.height = st.canvas.height;
      st.lg = st.lc.getContext('2d');
    }
    var lg = st.lg; if (!lg) return;
    lg.setTransform(st.dpr, 0, 0, st.dpr, 0, 0);
    lg.globalCompositeOperation = 'source-over';
    lg.clearRect(0, 0, st.w, st.h);
    var dark = (st.snap && st.snap.ruleTint === 'darkness') ? 0.66 : 0.48;
    lg.fillStyle = 'rgba(2,4,10,' + dark + ')';
    lg.fillRect(0, 0, st.w, st.h);
    lg.globalCompositeOperation = 'destination-out';
    var srcs = lightSources(t), i, L;
    for (i = 0; i < srcs.length; i++) {
      L = srcs[i];
      var g = lg.createRadialGradient(L.x, L.y, 1, L.x, L.y, L.r);
      g.addColorStop(0, 'rgba(0,0,0,' + L.a + ')');
      g.addColorStop(1, 'rgba(0,0,0,0)');
      lg.fillStyle = g;
      lg.beginPath(); lg.arc(L.x, L.y, L.r, 0, 6.283); lg.fill();
    }
    ctx.drawImage(st.lc, 0, 0, st.w, st.h);
    ctx.globalCompositeOperation = 'lighter';
    for (i = 0; i < srcs.length; i++) {
      L = srcs[i];
      if (!L.warm) continue;
      var g2 = ctx.createRadialGradient(L.x, L.y, 1, L.x, L.y, L.r);
      g2.addColorStop(0, L.warm);
      g2.addColorStop(1, 'rgba(0,0,0,0)');
      ctx.fillStyle = g2;
      ctx.beginPath(); ctx.arc(L.x, L.y, L.r, 0, 6.283); ctx.fill();
    }
    ctx.globalCompositeOperation = 'source-over';
  } catch (e) { /* lighting is gravy, never fatal */ }
}
function spawnAmbient(dt) {
  if (reducedMotion()) return;
  st.embAcc = (st.embAcc || 0) + dt;
  while (st.embAcc > 0.22) {
    st.embAcc -= 0.22;
    var p = torchPts()[Math.floor(Math.random() * 4)];
    st.parts.push({ x: p[0] + (Math.random() - 0.5) * 8, y: p[1] - 4,
      vx: (Math.random() - 0.5) * 10, vy: -22 - Math.random() * 18,
      life: 1, decay: 0.9, size: 1.4 + Math.random(),
      color: Math.random() < 0.5 ? '#e8a04b' : '#ffb254', soft: true });
    if (Math.random() < 0.6) st.parts.push({ x: Math.random() * st.w, y: Math.random() * st.h,
      vx: (Math.random() - 0.5) * 6, vy: -3 - Math.random() * 4,
      life: 1, decay: 0.25, size: 1, color: 'rgba(220,215,200,.45)', soft: true });
  }
}
function drawStrikes(ctx) {
  var i, k, a;
  for (i = st.arcs.length - 1; i >= 0; i--) {
    a = st.arcs[i]; k = (nowMs() - a.t0) / a.dur;
    if (k >= 1) { st.arcs.splice(i, 1); continue; }
    ctx.globalAlpha = (1 - k) * 0.9;
    ctx.strokeStyle = '#fff2d8'; ctx.lineWidth = 3 * (1 - k * 0.5);
    ctx.beginPath(); ctx.arc(a.x, a.y, a.r * (0.7 + 0.3 * k), a.a0, a.a0 + 1.7); ctx.stroke();
  }
  for (i = st.rings.length - 1; i >= 0; i--) {
    a = st.rings[i]; k = (nowMs() - a.t0) / a.dur;
    if (k >= 1) { st.rings.splice(i, 1); continue; }
    ctx.globalAlpha = (1 - k) * 0.8;
    ctx.strokeStyle = a.color; ctx.lineWidth = 2.5 * (1 - k) + 0.5;
    ctx.beginPath(); ctx.arc(a.x, a.y, a.r0 + (a.r1 - a.r0) * k, 0, 6.283); ctx.stroke();
  }
  ctx.globalAlpha = 1;
}
function barrierShimmer(ctx, p, phase, up) {
  var a0 = up ? -2.6 : 0.54, a1 = up ? -0.54 : 2.6;
  var ba = 0.35 + 0.25 * Math.sin(performance.now() / 200 + phase);
  ctx.strokeStyle = 'rgba(127,176,232,' + ba.toFixed(3) + ')';
  ctx.lineWidth = 2;
  ctx.beginPath(); ctx.arc(p.x, p.y, 31, a0, a1); ctx.stroke();
}

/* ============================ BATTLE: units ============================ */
function mergeUnits(snap) {
  var live = {};
  function touch(key, glyph, name, hp, max, dead, gone) {
    var u = st.units[key];
    if (!u) { u = st.units[key] = unit(key, glyph, name); u.disp = u.lag = max > 0 ? hp / max : 1; u.intro = 0.001; }
    u.glyph = glyph; u.name = name; u.max = max || 1;
    u.hp = Math.max(0, Math.min(1, max > 0 ? hp / max : 0));
    u.dead = !!dead; u.gone = !!gone;
    live[key] = true;
    return u;
  }
  if (snap.boss) {
    var bu = touch(snap.boss.key, snap.boss.glyph, snap.boss.name, snap.boss.hp, snap.boss.maxHp, snap.boss.hp <= 0, false);
    if (!bu.sprs) {
      var bs0 = makeBossSprite(snap.boss.name);
      bu.sprs = { idle0: bs0, idle1: bs0 };
      bu.sc = 4;
    }
  }
  (snap.mobs || []).forEach(function (m) {
    var u = touch(m.key, m.glyph, m.name, m.hp, m.maxHp, m.hp <= 0, false);
    if (!u.sprs) {
      var f0 = makeFoeSprite(m.name, 'idle0');
      u.sprs = { idle0: f0, idle1: makeFoeSprite(m.name, 'idle1') };
      u.sc = (f0.w > 12) ? 2.8 : 3;
      if (f0._float) u.baseAlpha = 0.85;
    }
  });
  (snap.heroes || []).forEach(function (h) {
    var u = touch(h.key, h.glyph, h.name, h.hp, h.max, h.dead, h.withdrawn);
    if (!u.sprs) {
      var mk = { legacy: !!h.legacy, pact: !!h.pact, brand: !!h.branded };
      u.sprs = {
        idle0: makeHeroSprite(h.cls, h.id, 'idle0', mk),
        idle1: makeHeroSprite(h.cls, h.id, 'idle1', mk),
        atk: makeHeroSprite(h.cls, h.id, 'atk', mk)
      };
      u.sc = 3;
    }
    u.cls = h.cls; u.marked = !!h.marked; u.pickable = !!h.pickable;
    u.stand = !!h.stand; u.state = h.state || null;
    u.tags = h.tags || [];
  });
  Object.keys(st.units).forEach(function (k) { if (!live[k]) delete st.units[k]; });
}
function posOf(u, t) {
  if (!st.snap) return null;
  var snap = st.snap, i;
  if (u.key.charAt(0) === 'h') {
    var hs = snap.heroes || [];
    for (i = 0; i < hs.length; i++) if (hs[i].key === u.key) break;
    if (i >= hs.length) return null;
    var s = heroSlots(hs.length)[i];
    return basePos(u, s.x, s.y, t);
  }
  if (snap.boss && snap.boss.key === u.key) return basePos(u, st.w / 2, st.h * 0.185, t);
  var ms = (snap.mobs || []); var mi = -1;
  for (i = 0; i < ms.length; i++) if (ms[i].key === u.key) mi = i;
  if (mi < 0) return null;
  var m2 = mobSlots(ms.length, !!snap.boss)[mi];
  return basePos(u, m2.x, m2.y, t);
}
function basePos(u, x, y, t) {
  var p = { x: x, y: y, rot: 0, alpha: 1, scale: 1 };
  if (u.dead && u.key.charAt(0) === 'h') { p.rot = 0.22; p.y += 12; p.alpha = 0.45; }
  else if (u.gone) { p.alpha = 0.55; p.x += 8; }
  else if (u.dead) { p.alpha = 0.4; p.rot = 0.12; p.y += 8; }
  if (u.dieT >= 0) {
    var dk = Math.min(1, (t * 1000 - u.dieT) / 650);
    p.rot = 0.22 * dk; p.y += 18 * dk; p.alpha = 1 - 0.55 * dk;
  }
  if (reducedMotion()) return p;
  p.y += Math.sin(t * 2.1 + u.phase) * 3;
  if (u.anim) {
    var k = (t * 1000 - u.anim.t0) / u.anim.dur;
    if (k >= 1) u.anim = null;
    else {
      var e = k < 0.35 ? (k / 0.35) : (1 - (k - 0.35) / 0.65);
      p.x += u.anim.dx * e; p.y += u.anim.dy * e;
    }
  }
  if (u.flash > 0) p.scale = 1 + 0.16 * u.flash;
  return p;
}
function unitOf(ref) {
  if (!st || !ref) return null;
  if (ref.k === 'h') return st.units['h' + ref.id];
  if (ref.uid != null) return st.units['e' + ref.uid];
  var snap = st.snap;
  if (!snap) return null;
  var pool = (snap.mobs || []).filter(function (m) { return m.hp > 0; });
  if (snap.boss && snap.boss.hp > 0) pool.push(snap.boss);
  if (!pool.length) return null;
  return st.units[pool[Math.floor(Math.random() * pool.length)].key] || null;
}

/* ============================ BATTLE: fx ============================ */
function sparks(x, y, n, color, spd) {
  if (!st) return;
  for (var i = 0; i < n; i++) {
    var a = Math.random() * 6.283, v = (0.4 + Math.random() * 0.6) * (spd || 90);
    st.parts.push({ x: x, y: y, vx: Math.cos(a) * v, vy: Math.sin(a) * v - 30,
      life: 1, decay: 2.2 + Math.random() * 1.6, size: 1.5 + Math.random() * 2.2, color: color });
  }
  if (st.parts.length > 220) st.parts.splice(0, st.parts.length - 220);
}
function motes(x, y, n, color) {
  if (!st) return;
  for (var i = 0; i < n; i++) {
    st.parts.push({ x: x + (Math.random() - 0.5) * 34, y: y + (Math.random() - 0.5) * 10,
      vx: (Math.random() - 0.5) * 12, vy: -28 - Math.random() * 26,
      life: 1, decay: 1.1, size: 1.6 + Math.random() * 1.8, color: color, soft: true });
  }
}
function num(x, y, text, color, size) {
  if (!st) return;
  st.nums.push({ x: x + (Math.random() - 0.5) * 22, y: y - 18, text: text, color: color,
    size: size || 11, t: 0, dur: 780 / ts() });
  if (st.nums.length > 40) st.nums.splice(0, st.nums.length - 40);
}
function refPos(ref) {
  if (!st || !ref) return null;
  var u = unitOf(ref);
  if (!u || !st.snap) return null;
  return posOf(u, (performance.now() - st.t0) / 1000);
}
function fxHit(d) {
  var from = unitOf(d.from), to = unitOf(d.to);
  var tp = refPos(d.to) || { x: st ? st.w / 2 : 200, y: st ? st.h * 0.4 : 150 };
  var fp = refPos(d.from);
  if (from && fp && !reducedMotion()) {
    var dx = tp.x - fp.x, dy = tp.y - fp.y, dist = Math.sqrt(dx * dx + dy * dy) || 1;
    var reach = Math.min(52, dist * 0.45);
    from.anim = { dx: dx / dist * reach, dy: dy / dist * reach, t0: nowMs(), dur: 250 / ts() };
  }
  if (to) to.flash = 1;
  var crit = /CRIT|Power|EXECUTE|Crushing|Backstab|Last Flame|Meteor/i.test(d.tag || '') || d.big;
  var col = d.to && d.to.k === 'h' ? C.red : (crit ? '#ffb254' : '#f4ead0');
  if (d.lethal) num(tp.x, tp.y, '☠', C.red, 26);
  else num(tp.x, tp.y, String(d.dmg != null ? d.dmg : ''), col, crit ? 15 : 11);
  if (!reducedMotion()) {
    sparks(tp.x, tp.y, crit ? 16 : 9, d.to && d.to.k === 'h' ? C.red : C.gold, crit ? 130 : 90);
    if (crit) st.shake = Math.max(st.shake, 6);
  }
  st.arcs.push({ x: tp.x, y: tp.y, t0: nowMs(), dur: 200 / ts(),
    a0: Math.random() * 6.283, r: crit ? 26 : 18 });
  st.rings.push({ x: tp.x, y: tp.y, t0: nowMs(), dur: (crit ? 340 : 260) / ts(),
    r0: 6, r1: crit ? 46 : 28,
    color: (d.to && d.to.k === 'h') ? C.red : C.gold });
  if (d.lethal) {
    st.pulse = Math.max(st.pulse, 0.9);
    st.rings.push({ x: tp.x, y: tp.y, t0: nowMs(), dur: 480 / ts(), r0: 8, r1: 72, color: C.red });
  }
  if (d.dead && to) {
    sparks(tp.x, tp.y, 26, '#ffd98c', 150);
    st.shake = Math.max(st.shake, 7);
    st.rings.push({ x: tp.x, y: tp.y, t0: nowMs(), dur: 380 / ts(), r0: 4, r1: 40, color: '#ffd98c' });
  }
}
function fx(type, d) {
  if (!st || st.dead) return;
  d = d || {};
  var now = performance.now();
  snd(type === 'hit' ? (d.dead ? 'kill' : (/CRIT|Power|EXECUTE/i.test(d.tag || '') || d.big ? 'crit' : 'hit'))
    : type === 'heal' ? 'heal' : type === 'burn' ? 'burn' : type === 'death' ? 'death'
    : type === 'skill' ? 'skill' : type === 'mark' ? 'mark' : type === 'shake' ? 'shake' : null);
  if (type === 'hit') { fxHit(d); return; }
  if (type === 'heal') {
    var hp0 = refPos(d.to) || { x: st.w / 2, y: st.h * 0.7 };
    if (!reducedMotion()) motes(hp0.x, hp0.y, 9, C.green);
    num(hp0.x, hp0.y, '+' + (d.amt != null ? d.amt : ''), C.green, 11);
    return;
  }
  if (type === 'burn') {
    var bp = refPos(d.to) || { x: st.w / 2, y: st.h * 0.4 };
    if (!reducedMotion()) motes(bp.x, bp.y, 6, '#e8845b');
    num(bp.x, bp.y, String(d.dmg != null ? d.dmg : ''), '#e8845b', 9);
    return;
  }
  if (type === 'skill') {
    st.banner = { text: (d.hero || '') + ' — ' + (d.name || ''), t0: now };
    return;
  }
  if (type === 'death') {
    var u0 = unitOf(d.to);
    if (u0) u0.dieT = nowMs();
    var dp = refPos(d.to);
    if (dp && !reducedMotion()) sparks(dp.x, dp.y, 22, C.red, 140);
    st.shake = Math.max(st.shake, 9);
    st.pulse = 1;
    return;
  }
  if (type === 'mark') {
    var mp = refPos(d.to);
    if (mp) { num(mp.x, mp.y, 'MARKED', C.red, 9); if (!reducedMotion()) sparks(mp.x, mp.y, 10, C.red, 70); }
    return;
  }
  if (type === 'shake') {
    if (!reducedMotion()) st.shake = Math.max(st.shake, d.mag || 5);
    return;
  }
}
function stepFxObjects(ctx, dt) {
  var i;
  for (i = st.parts.length - 1; i >= 0; i--) {
    var q = st.parts[i];
    q.life -= q.decay * dt;
    if (q.life <= 0) { st.parts.splice(i, 1); continue; }
    q.x += q.vx * dt; q.y += q.vy * dt; q.vy += (q.soft ? -6 : 220) * dt;
    ctx.globalAlpha = Math.max(0, q.life);
    ctx.fillStyle = q.color;
    var ps = Math.max(1, Math.round(q.size * (q.soft ? q.life : 1)));
    ctx.fillRect(Math.round(q.x), Math.round(q.y), ps, ps);
  }
  ctx.globalAlpha = 1;
  for (i = st.nums.length - 1; i >= 0; i--) {
    var d = st.nums[i];
    d.t += dt * 1000;
    if (d.t >= d.dur) { st.nums.splice(i, 1); continue; }
    var k = d.t / d.dur;
    ctx.globalAlpha = k < 0.15 ? k / 0.15 : 1 - Math.max(0, (k - 0.55) / 0.45);
    ctx.font = d.size + 'px ' + PIXEL;
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillStyle = 'rgba(0,0,0,.6)';
    ctx.fillText(d.text, d.x + 2, d.y - k * 42 + 2);
    ctx.fillStyle = d.color;
    ctx.fillText(d.text, d.x, d.y - k * 42);
  }
  ctx.globalAlpha = 1;
}
function drawBanner(ctx, now) {
  if (!st.banner) return;
  var k = (now - st.banner.t0) / (820 / ts());
  if (k >= 1) { st.banner = null; return; }
  var a = k < 0.12 ? k / 0.12 : 1 - Math.max(0, (k - 0.7) / 0.3);
  ctx.globalAlpha = Math.max(0, Math.min(1, a));
  var bw = Math.min(st.w * 0.86, 330), bx = (st.w - bw) / 2, by = st.h * 0.565;
  ctx.fillStyle = 'rgba(7,8,12,.82)';
  roundRect(ctx, bx, by, bw, 26, 5); ctx.fill();
  ctx.strokeStyle = 'rgba(232,176,75,.55)'; ctx.lineWidth = 1;
  roundRect(ctx, bx, by, bw, 26, 5); ctx.stroke();
  ctx.font = '9px ' + PIXEL; ctx.fillStyle = C.gold;
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.fillText(st.banner.text.toUpperCase(), st.w / 2, by + 13);
  ctx.globalAlpha = 1;
}

/* ============================ BATTLE: drawing ============================ */
function glyphFig(ctx, u, p, size) {
  ctx.save();
  ctx.translate(p.x, p.y);
  ctx.rotate(p.rot);
  ctx.scale(p.scale, p.scale);
  ctx.globalAlpha = p.alpha * (u.baseAlpha || 1);
  if (u.flash > 0.03) {
    var fg = ctx.createRadialGradient(0, 0, 2, 0, 0, size * 0.85);
    fg.addColorStop(0, 'rgba(255,240,210,' + (0.5 * u.flash).toFixed(3) + ')');
    fg.addColorStop(1, 'rgba(255,240,210,0)');
    ctx.fillStyle = fg;
    ctx.beginPath(); ctx.arc(0, 0, size * 0.85, 0, 6.283); ctx.fill();
  }
  if (u.sprs) {
    ctx.imageSmoothingEnabled = false;
    var img = u.sprs[u.pose] || u.sprs.idle0;
    var w0 = img.w * u.sc, h0 = img.h * u.sc;
    ctx.drawImage(img.c, Math.round(-w0 / 2), Math.round(-h0 / 2), w0, h0);
  } else if (u.spr) {
    ctx.imageSmoothingEnabled = false;
    var w1 = u.spr.w * u.sc, h1 = u.spr.h * u.sc;
    ctx.drawImage(u.spr.c, Math.round(-w1 / 2), Math.round(-h1 / 2), w1, h1);
  } else {
    ctx.font = size + 'px serif';
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText(u.glyph, 0, 0);
  }
  ctx.restore();
}
function hpBar(ctx, x, y, w0, frac, lag, hgt) {
  hgt = hgt || 5;
  ctx.fillStyle = '#080a0e';
  roundRect(ctx, x - w0 / 2 - 1, y - 1, w0 + 2, hgt + 2, 2); ctx.fill();
  if (lag > frac) {
    ctx.fillStyle = 'rgba(240,238,230,.75)';
    roundRect(ctx, x - w0 / 2, y, w0 * lag, hgt, 2); ctx.fill();
  }
  ctx.fillStyle = frac < 0.35 ? C.red : frac < 0.6 ? '#d9a441' : C.green;
  roundRect(ctx, x - w0 / 2, y, Math.max(0.5, w0 * frac), hgt, 2); ctx.fill();
}
function roundRect(ctx, x, y, w0, h0, r) {
  r = Math.min(r, w0 / 2, h0 / 2);
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w0, y, x + w0, y + h0, r);
  ctx.arcTo(x + w0, y + h0, x, y + h0, r);
  ctx.arcTo(x, y + h0, x, y, r);
  ctx.arcTo(x, y, x + w0, y, r);
  ctx.closePath();
}
function ring(ctx, x, y, r, color, width0, pulse) {
  ctx.strokeStyle = color; ctx.lineWidth = width0;
  if (pulse) { ctx.globalAlpha = 0.55 + 0.45 * Math.sin(performance.now() / 180); }
  ctx.beginPath(); ctx.arc(x, y, r, 0, 6.283); ctx.stroke();
  ctx.globalAlpha = 1;
}
function drawTags(ctx, u, p, r) {
  ctx.font = '11px serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'alphabetic';
  var n = Math.min(3, u.tags.length);
  for (var i = 0; i < n; i++) {
    ctx.fillText(u.tags[i], p.x + (i - (n - 1) / 2) * 14, p.y - r - 4);
  }
}
function torch(ctx, x, y, t, i, dim) {
  var flick = 0.78 + 0.16 * Math.sin(t * 7.3 + i * 2.1) + 0.06 * Math.sin(t * 13.7 + i);
  var r = (dim ? 46 : 74) * flick;
  ctx.save();
  ctx.fillStyle = '#232a3a';
  ctx.fillRect(x - 3, y, 6, 16);
  var g = ctx.createRadialGradient(x, y, 2, x, y, r);
  g.addColorStop(0, 'rgba(255,196,110,' + (0.34 * flick).toFixed(3) + ')');
  g.addColorStop(0.4, 'rgba(232,140,75,' + (0.15 * flick).toFixed(3) + ')');
  g.addColorStop(1, 'rgba(232,140,75,0)');
  ctx.fillStyle = g;
  ctx.beginPath(); ctx.arc(x, y, r, 0, 6.283); ctx.fill();
  var fh = (dim ? 9 : 14) * flick;
  var g2 = ctx.createRadialGradient(x, y - fh * 0.3, 1, x, y - fh * 0.3, fh);
  g2.addColorStop(0, '#ffe9b0'); g2.addColorStop(0.55, '#e8a04b'); g2.addColorStop(1, 'rgba(224,82,99,0)');
  ctx.fillStyle = g2;
  ctx.beginPath();
  ctx.ellipse(x, y - fh * 0.3, fh * 0.34, fh * 0.72, 0, 0, 6.283);
  ctx.fill();
  var cx = Math.round(x), cy = Math.round(y);
  ctx.fillStyle = '#e8845b';
  ctx.fillRect(cx - 3, cy - Math.round(fh) - 1, 6, 3);
  ctx.fillStyle = '#e8a04b';
  ctx.fillRect(cx - 2, cy - Math.round(fh * 0.7), 4, Math.round(fh * 0.5));
  ctx.fillStyle = '#ffe9b0';
  ctx.fillRect(cx - 1, cy - Math.round(fh * 0.45), 2, Math.round(fh * 0.35));
  ctx.restore();
}
function drawRoom(ctx, t) {
  var w = st.w, h = st.h;
  var TP = torchPts();
  var bg = ctx.createLinearGradient(0, 0, 0, h);
  bg.addColorStop(0, '#0a0c12'); bg.addColorStop(0.55, C.bg1); bg.addColorStop(1, '#08090e');
  ctx.fillStyle = bg; ctx.fillRect(0, 0, w, h);
  var aw = w * 0.72, ax = (w - aw) / 2, ah = h * 0.34, ay = h * 0.06;
  ctx.fillStyle = C.wall;
  ctx.beginPath();
  ctx.moveTo(ax, ay + ah);
  ctx.lineTo(ax, ay + aw * 0.24);
  ctx.arc(w / 2, ay + aw * 0.24, aw / 2, Math.PI, 0);
  ctx.lineTo(ax + aw, ay + ah);
  ctx.closePath(); ctx.fill();
  ctx.strokeStyle = 'rgba(0,0,0,.5)'; ctx.lineWidth = 10;
  ctx.stroke();
  ctx.strokeStyle = 'rgba(38,45,61,.9)'; ctx.lineWidth = 1;
  for (var r0 = 0; r0 < 4; r0++) {
    var by = ay + aw * 0.24 + 14 + r0 * 17;
    if (by > ay + ah) break;
    ctx.beginPath(); ctx.moveTo(ax + 4, by); ctx.lineTo(ax + aw - 4, by); ctx.stroke();
  }
  ctx.fillStyle = '#0b0e15';
  ctx.fillRect(0, h * 0.56, w, h * 0.44);
  ctx.strokeStyle = 'rgba(232,176,75,.07)';
  for (var k = 0; k <= 4; k++) {
    ctx.beginPath();
    ctx.moveTo(w * k / 4, h * 0.56);
    ctx.lineTo(w * (0.5 + (k - 2) * 0.34), h);
    ctx.stroke();
  }
  ctx.strokeStyle = 'rgba(232,176,75,.16)'; ctx.lineWidth = 1;
  ctx.beginPath(); ctx.moveTo(0, h * 0.56); ctx.lineTo(w, h * 0.56); ctx.stroke();
  var dim = st.snap && st.snap.ruleTint === 'darkness';
  for (var ti = 0; ti < TP.length; ti++) torch(ctx, TP[ti][0], TP[ti][1], t, ti, dim);
  if (!reducedMotion()) {
    ctx.fillStyle = 'rgba(139,148,167,.045)';
    for (var f = 0; f < 3; f++) {
      var fx0 = (w * (0.2 + 0.3 * f) + Math.sin(t * 0.23 + f * 2) * 40 + w) % w;
      ctx.beginPath();
      ctx.ellipse(fx0, h * (0.5 + 0.12 * f), 70, 14, 0, 0, 6.283);
      ctx.fill();
    }
  }
}
function drawTint(ctx) {
  var rule = st.snap && st.snap.ruleTint;
  if (rule === 'darkness') { ctx.fillStyle = 'rgba(8,12,30,.42)'; ctx.fillRect(0, 0, st.w, st.h); }
  else if (rule === 'bloodmoon') { ctx.fillStyle = 'rgba(160,32,52,.16)'; ctx.fillRect(0, 0, st.w, st.h); }
  else if (rule === 'betrayal') { ctx.fillStyle = 'rgba(40,92,54,.14)'; ctx.fillRect(0, 0, st.w, st.h); }
  var v = ctx.createRadialGradient(st.w / 2, st.h * 0.46, st.h * 0.32, st.w / 2, st.h * 0.46, st.h * 0.78);
  v.addColorStop(0, 'rgba(0,0,0,0)'); v.addColorStop(1, 'rgba(0,0,0,.5)');
  ctx.fillStyle = v; ctx.fillRect(0, 0, st.w, st.h);
  if (st.pulse > 0) {
    ctx.fillStyle = 'rgba(224,82,99,' + (0.22 * st.pulse).toFixed(3) + ')';
    ctx.fillRect(0, 0, st.w, st.h);
  }
}
function drawBoss(ctx, t) {
  var snap = st.snap; if (!snap || !snap.boss) return;
  var u = st.units[snap.boss.key]; if (!u) return;
  var p = posOf(u, t);
  var size = Math.min(92, st.w * 0.23);
  ctx.font = '9px ' + PIXEL; ctx.fillStyle = C.txt;
  ctx.textAlign = 'center'; ctx.textBaseline = 'alphabetic';
  ctx.fillText(u.name.toUpperCase(), st.w / 2, 22);
  var bw = st.w * 0.74;
  hpBar(ctx, st.w / 2, 30, bw, u.disp, u.lag, 9);
  ctx.font = '9px Georgia'; ctx.fillStyle = C.dim;
  ctx.fillText(Math.round(u.disp * u.max) + ' / ' + u.max, st.w / 2, 49);
  if (!u.dead) {
    var auraP = 0.5 + 0.5 * Math.sin(performance.now() / 300);
    var ag = ctx.createRadialGradient(p.x, p.y, 8, p.x, p.y, 66);
    ag.addColorStop(0, 'rgba(224,82,99,' + (0.1 + 0.06 * auraP).toFixed(3) + ')');
    ag.addColorStop(1, 'rgba(224,82,99,0)');
    ctx.fillStyle = ag;
    ctx.beginPath(); ctx.arc(p.x, p.y, 66, 0, 6.283); ctx.fill();
  }
  shadow(ctx, p.x, p.y + size * 0.62, size * 0.52, shadowDir(p.x));
  if (u.dead) { ctx.globalAlpha = 0.5; }
  glyphFig(ctx, u, p, size);
  ctx.globalAlpha = 1;
}
function drawMob(ctx, t, m, i, n) {
  var u = st.units[m.key]; if (!u) return;
  var p = posOf(u, t);
  var size = 38;
  shadow(ctx, p.x, p.y + 26, 22, shadowDir(p.x));
  if (m.elite) ring(ctx, p.x, p.y, 27, C.gold, 1.5, false);
  glyphFig(ctx, u, p, size);
  if (!u.dead && u.tags && u.tags.indexOf('🛡') >= 0) barrierShimmer(ctx, p, u.phase, false);
  ctx.font = '6px ' + PIXEL; ctx.fillStyle = u.dead ? C.dim : C.txt;
  ctx.textAlign = 'center'; ctx.textBaseline = 'alphabetic';
  var nm = u.name.length > 14 ? u.name.slice(0, 13) + '.' : u.name;
  ctx.fillText(nm.toUpperCase(), p.x, p.y + 42);
  if (!u.dead) hpBar(ctx, p.x, p.y + 46, 46, u.disp, u.lag, 4);
  if (u.tags && u.tags.length) drawTags(ctx, u, p, 30);
}
function drawHero(ctx, t, h, i, n) {
  var u = st.units[h.key]; if (!u) return;
  var p = posOf(u, t);
  var size = 46;
  shadow(ctx, p.x, p.y + 32, 25, shadowDir(p.x));
  if (u.pickable) ring(ctx, p.x, p.y, 32, C.blue, 2, true);
  if (u.marked) ring(ctx, p.x, p.y, 34, C.red, 2, true);
  if (u.stand) { ring(ctx, p.x, p.y, 30, C.gold, 2, true); ring(ctx, p.x, p.y, 36, C.gold, 1, false); }
  glyphFig(ctx, u, p, size);
  ctx.font = '7px ' + PIXEL; ctx.fillStyle = u.dead ? C.dim : C.txt;
  ctx.textAlign = 'center'; ctx.textBaseline = 'alphabetic';
  ctx.fillText(u.name.toUpperCase(), p.x, p.y + 48);
  ctx.fillStyle = C.cls[u.cls] || C.dim;
  ctx.fillRect(p.x - 22, p.y + 52, 44, 2);
  if (!u.dead && !u.gone) {
    hpBar(ctx, p.x, p.y + 57, 54, u.disp, u.lag, 5);
    ctx.font = '8.5px Georgia'; ctx.fillStyle = C.dim;
    ctx.fillText(Math.round(u.disp * u.max) + '/' + u.max, p.x, p.y + 69);
  }
  if (u.state === 'Panic') { ctx.font = '8px Georgia'; ctx.fillStyle = C.red; ctx.fillText('PANIC', p.x, p.y - 34); }
  else if (u.state === 'Focused') { ctx.font = '8px Georgia'; ctx.fillStyle = C.green; ctx.fillText('FOCUSED', p.x, p.y - 34); }
  if (!h.dead && !h.withdrawn && u.tags && u.tags.indexOf('🛡') >= 0) barrierShimmer(ctx, p, u.phase, true);
  if (u.tags && u.tags.length) drawTags(ctx, u, p, 32);
}

/* ============================ BATTLE: frame + attach ============================ */
function frame(now) {
  if (!st || st.dead) return;
  try {
    var ctx = st.ctx, t = (now - st.t0) / 1000;
    var dt = Math.min(0.05, (now - (st.last || now)) / 1000);
    st.last = now;
    var snap = st.snap;
    ctx.setTransform(st.dpr, 0, 0, st.dpr, 0, 0);
    ctx.imageSmoothingEnabled = false;
    var sx = 0, sy = 0;
    if (st.shake > 0.3 && !reducedMotion()) {
      sx = (Math.random() - 0.5) * 2 * st.shake; sy = (Math.random() - 0.5) * 2 * st.shake;
      st.shake *= Math.pow(0.0025, dt);
      if (st.shake < 0.3) st.shake = 0;
    }
    ctx.translate(sx, sy);
    drawRoom(ctx, t);
    if (snap) {
      var i;
      for (i = 0; i < (snap.mobs || []).length; i++) drawMob(ctx, t, snap.mobs[i], i, snap.mobs.length);
      drawBoss(ctx, t);
      for (i = 0; i < (snap.heroes || []).length; i++) drawHero(ctx, t, snap.heroes[i], i, snap.heroes.length);
    }
    spawnAmbient(dt);
    Object.keys(st.units).forEach(function (k) {
      var u = st.units[k];
      u.disp += (u.hp - u.disp) * Math.min(1, dt * 9);
      u.lag += (u.disp - u.lag) * Math.min(1, dt * 3.2);
      if (u.flash > 0) u.flash = Math.max(0, u.flash - dt * 4.5);
      if (u.intro > 0) u.intro = Math.min(1, u.intro + dt * 3);
      u.pose = (u.anim && u.sprs && u.sprs.atk) ? 'atk'
        : 'idle' + ((Math.floor(t * 2.2 + u.phase) % 2) ? '1' : '0');
    });
    stepFxObjects(ctx, dt);
    drawStrikes(ctx);
    lighting(ctx, t);
    drawTint(ctx);
    drawBanner(ctx, now);
    if (st.pulse > 0) st.pulse = Math.max(0, st.pulse - dt * 1.4);
    if (st.fade < 1) {
      st.fade = Math.min(1, st.fade + dt * 2.4);
      ctx.setTransform(st.dpr, 0, 0, st.dpr, 0, 0);
      ctx.fillStyle = 'rgba(7,8,12,' + (1 - st.fade).toFixed(3) + ')';
      ctx.fillRect(0, 0, st.w, st.h);
    }
  } catch (e) { /* never let the renderer kill the battle */ }
  if (st && !st.dead) st.raf = requestAnimationFrame(frame);
}
function onTap(ev) {
  if (!st || !st.snap || typeof st.tapCb !== 'function') return;
  var r;
  try { r = st.canvas.getBoundingClientRect(); } catch (e) { return; }
  var cx = (ev.clientX != null ? ev.clientX : 0) - r.left;
  var cy = (ev.clientY != null ? ev.clientY : 0) - r.top;
  var hs = st.snap.heroes || [];
  var slots = heroSlots(hs.length);
  for (var i = 0; i < hs.length; i++) {
    if (Math.abs(cx - slots[i].x) < 40 && Math.abs(cy - slots[i].y) < 48) {
      try { st.tapCb(hs[i].id); } catch (e) { /* combat guards */ }
      return;
    }
  }
}
function attach(root) {
  if (!HAS_DOM || !HAS_RAF || !root) return null;
  injectStyle();
  var canvas = document.createElement('canvas');
  if (!canvas.getContext) return null;
  var ctx;
  try { ctx = canvas.getContext('2d'); } catch (e) { return null; }
  if (!ctx) return null;
  try {
    root.innerHTML = '';
    var top = document.createElement('div'); top.className = 'cb-top';
    var floor = document.createElement('div'); floor.className = 'cb-floor'; floor.id = 'cb-floor';
    var round = document.createElement('div'); round.className = 'cb-round'; round.id = 'cb-round';
    top.appendChild(floor); top.appendChild(round);
    canvas.id = 'cb-canvas';
    var logWrap = document.createElement('div'); logWrap.className = 'cb-logwrap collapsed'; logWrap.id = 'cb-logwrap';
    var logBtn = document.createElement('button'); logBtn.type = 'button';
    logBtn.className = 'cb-logtoggle'; logBtn.id = 'cb-logtoggle'; logBtn.textContent = 'battle log ▾';
    var log = document.createElement('div'); log.className = 'cb-log'; log.id = 'cb-log';
    logWrap.appendChild(logBtn); logWrap.appendChild(log);
    var bar = document.createElement('div'); bar.className = 'cb-barwrap'; bar.id = 'cb-bar';
    root.appendChild(top); root.appendChild(canvas);
    root.appendChild(logWrap); root.appendChild(bar);
    st = {
      root: root, canvas: canvas, ctx: ctx,
      floor: floor, round: round, log: log, logWrap: logWrap, logBtn: logBtn, bar: bar,
      units: {}, parts: [], nums: [], banner: null, shake: 0, pulse: 0,
      arcs: [], rings: [], lc: null, lg: null, embAcc: 0,
      snap: null, tapCb: null, t0: performance.now(), last: 0, fade: 0,
      raf: 0, dpr: 1, w: 430, h: 460, dead: false
    };
    canvas.addEventListener('click', onTap);
    if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
      window.addEventListener('resize', resize);
    }
    resize();
    st.raf = requestAnimationFrame(frame);
  } catch (e) { detach(); return null; }
  api = {
    floor: floor, round: round, log: log, logWrap: logWrap, logBtn: logBtn, bar: bar,
    sync: function (snap) { if (st && !st.dead && snap) { st.snap = snap; mergeUnits(snap); } },
    fx: fx,
    onHeroTap: function (fn) { if (st) st.tapCb = fn; },
    detach: detach
  };
  return api;
}
function detach() {
  if (!st) return;
  st.dead = true;
  try { if (st.raf) cancelAnimationFrame(st.raf); } catch (e) { /* ignore */ }
  try { st.canvas.removeEventListener('click', onTap); } catch (e) { /* ignore */ }
  try { if (typeof window !== 'undefined' && typeof window.removeEventListener === 'function') window.removeEventListener('resize', resize); } catch (e) { /* ignore */ }
  st = null; api = null;
}
var urlCache = {};
function heroSpriteURL(cls, id, marks) {
  var mk = (typeof marks === 'object' && marks) || {};
  var k = String(cls) + '|' + id + '|' + (mk.legacy ? 'L' : '') + (mk.pact ? 'P' : '') + (mk.brand ? 'B' : '');
  if (k in urlCache) return urlCache[k];
  urlCache[k] = '';
  try {
    var spr = makeHeroSprite(cls, id, 'idle0', mk);
    var sc = 4, c2 = document.createElement('canvas');
    c2.width = spr.w * sc; c2.height = spr.h * sc;
    var g2 = c2.getContext('2d');
    if (!g2) return urlCache[k];
    g2.imageSmoothingEnabled = false;
    g2.drawImage(spr.c, 0, 0, c2.width, c2.height);
    urlCache[k] = c2.toDataURL();
  } catch (e) { urlCache[k] = ''; }
  return urlCache[k];
}

/* ============================ LOBBY: hero life ============================ */
var lb = null;   // lobby scene state (independent of the battle's st)

function lbZones(w, h) {
  return {
    tower: { x: w * 0.50, y: h * 0.300, lab: 'THE TOWER' },
    fire:  { x: w * 0.50, y: h * 0.660, lab: 'THE FIRE' },
    rest:  { x: w * 0.78, y: h * 0.830, lab: 'REST' },
    train: { x: w * 0.24, y: h * 0.830, lab: 'TRAINING' },
    work:  { x: w * 0.81, y: h * 0.510, lab: 'WORKSHOP' },
    mem:   { x: w * 0.15, y: h * 0.520, lab: 'MEMORIAL' }
  };
}
var LB_ACT = {
  rest: 'Resting', train: 'Training', work: 'Maintaining gear',
  mem: 'Mourning', fire: 'By the fire', social: 'Talking', wander: 'Walking'
};
function lbChooseActivity(u, hero) {
  var hpPct = hero.maxHp ? (hero.hp / hero.maxHp) : 1;
  if (hpPct < 0.45 || (hero.fear || 0) > 65) return 'rest';
  if ((hero.grieving || 0) > 0) return (Math.random() < 0.5) ? 'mem' : 'rest';
  var r = Math.random();
  if (r < 0.22) return 'train';
  if (r < 0.40) return 'work';
  if (r < 0.62) return 'fire';
  if (r < 0.78) return 'social';
  return 'wander';
}
function lbFindSpot(ax, ay, self) {
  var cands = [], i, j;
  for (i = -2; i <= 2; i++) {
    for (j = -1; j <= 1; j++) {
      cands.push([ax + i * 22, ay + j * 13 + (Math.random() - 0.5) * 6]);
    }
  }
  var ok = cands.filter(function (c) {
    var crowded = false;
    Object.keys(lb.units).forEach(function (k) {
      var o = lb.units[k];
      if (o === self) return;
      if (Math.abs(o.tx - c[0]) < 34 && Math.abs(o.ty - c[1]) < 24) crowded = true;
      if (Math.abs(o.x - c[0]) < 32 && Math.abs(o.y - c[1]) < 24) crowded = true;
    });
    return !crowded;
  });
  var pickFrom = ok.length ? ok : cands;
  var c = pickFrom[Math.floor(Math.random() * pickFrom.length)];
  return { x: c[0], y: c[1] };
}
function lbTickUnit(u, dt, hero, Z) {
  /* V0.26: the PARTY is staged — a tight intentional line in the foreground.
     They breathe, shuffle a step; they do not wander the village. */
  if (u.pinned) {
    if (u.mode === 'walk') {
      var pdx = u.tx - u.x;
      u.x += Math.sign(pdx) * 14 * dt;
      if (Math.abs(pdx) < 1) { u.x = u.tx; u.mode = 'stand'; u.wait = 3 + Math.random() * 5; }
      return;
    }
    u.wait -= dt;
    if (u.wait > 0) return;
    if (Math.random() < 0.35) {
      u.tx = u.hx + (Math.random() - 0.5) * 10;
      u.mode = 'walk';
    } else {
      u.mode = 'stand';
    }
    u.wait = 3 + Math.random() * 5;
    return;
  }
  if (u.mode === 'walk') {
    var dx = u.tx - u.x, dy = u.ty - u.y, d = Math.sqrt(dx * dx + dy * dy);
    if (d < 3) {
      u.mode = (u.act === 'rest') ? 'sit' : 'stand';
      u.wait = 6 + Math.random() * 8;
      u.swingT = 0.6 + Math.random();
    } else { u.x += (dx / d) * 17 * dt; u.y += (dy / d) * 17 * dt; }
    return;
  }
  if (u.act === 'train' || u.act === 'work') {
    u.swingT -= dt;
    if (u.swingT <= 0) {
      u.swing = 0.001;
      u.swingT = 1.4 + Math.random() * 1.4;
      var px = (u.act === 'train') ? Z.train.x + 10 : Z.work.x - 8;
      var py = (u.act === 'train') ? Z.train.y - 6 : Z.work.y - 6;
      for (var sp = 0; sp < 3; sp++) {
        lb.parts.push({ x: px + (Math.random() - 0.5) * 6, y: py + (Math.random() - 0.5) * 6,
          vx: (Math.random() - 0.5) * 40, vy: -30 - Math.random() * 20,
          life: 1, decay: 3, size: 1.5, color: (u.act === 'work') ? '#ffd98c' : '#c9b491', soft: false });
      }
    }
  }
  if (u.swing > 0) { u.swing += dt; if (u.swing > 0.32) u.swing = 0; }
  u.wait -= dt;
  if (u.wait > 0) return;
  u.act = lbChooseActivity(u, hero);
  var Z2 = Z[u.act === 'wander' ? 'fire' : (u.act === 'social' ? 'fire' : u.act)];
  if (u.act === 'social') {
    var ids = Object.keys(lb.units);
    var other = ids.length > 1 ? lb.units[ids[Math.floor(Math.random() * ids.length)]] : null;
    if (other && other !== u) {
      var sx = other.x + (other.x > Z.fire.x ? 26 : -26);
      u.tx = sx; u.ty = other.y + (Math.random() - 0.5) * 6;
      u.mode = 'walk';
      u.wait = 5 + Math.random() * 5;
      return;
    }
  }
  var spot = lbFindSpot(Z2.x, Z2.y + (u.act === 'rest' ? 4 : 0), u);
  u.tx = spot.x; u.ty = spot.y;
  u.mode = 'walk';
  u.wait = 4 + Math.random() * 8;
}
function lbDrawFig(ctx, u, t) {
  var spr = (u.swing > 0) ? u.sprs.atk
    : (u.mode === 'walk')
      ? u.sprs['idle' + (Math.floor(t * 5 + u.phase) % 2 ? 1 : 0)]
      : u.sprs.idle0;
  var y = u.y + (u.mode === 'sit' ? 5 : 0);
  if (u.act === 'mem' && u.mode !== 'walk') y += 2 + Math.max(0, Math.sin(t * 0.8 + u.phase)) * 2;
  else y += Math.sin(t * 2 + u.phase) * 1.5;
  ctx.save();
  ctx.globalAlpha = u.alpha || 1;
  ctx.fillStyle = 'rgba(0,0,0,.4)';
  ctx.beginPath(); ctx.ellipse(u.x, u.y + 22, 14, 4, 0, 0, 6.283); ctx.fill();
  if (lb && lb.sel === u) {
    ctx.strokeStyle = C.gold; ctx.lineWidth = 2;
    ctx.globalAlpha = 0.55 + 0.45 * Math.sin(t * 6);
    ctx.beginPath(); ctx.arc(u.x, y - 6, 26, 0, 6.283); ctx.stroke();
    ctx.globalAlpha = u.alpha || 1;
  }
  var w0 = spr.w * u.sc, h0 = spr.h * u.sc;
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(spr.c, Math.round(u.x - w0 / 2), Math.round(y - h0 / 2), w0, h0);
  if (u.act === 'social' && u.mode !== 'walk' && Math.floor(t * 2 + u.phase) % 2 === 0) {
    ctx.fillStyle = 'rgba(215,220,230,.8)';
    ctx.fillRect(u.x + 10, y - 26, 2, 2);
    ctx.fillRect(u.x + 14, y - 28, 2, 2);
    ctx.fillRect(u.x + 18, y - 26, 2, 2);
  }
  ctx.restore();
}

/* ---- village props (pixel rects; the world explains itself) ----
   V0.18b: three depth rows around the road — BACK (huts/flanks by the
   tower), MID (memorial grove left, workshop+storage right, well), FRONT
   (fire plaza, crates, rack) and BOTTOM (training, rest, wagon, trees). */
function lbDrawProps(ctx, Z, t, memCount) {
  var w = lb.w, h = lb.h, baseY = Z.tower.y;
  function hut(x, y, fw, fh, lit) {
    /* V0.19 chunky: 3-tone roof bands, 2-tone planks, framed window, chimney */
    var wxm = x + fw / 2;
    /* roof: dark under-eave → mid → ridge light, with an outline edge */
    ctx.fillStyle = '#1c1610';
    ctx.beginPath();
    ctx.moveTo(x - 6, y - fh); ctx.lineTo(wxm, y - fh - 14); ctx.lineTo(x + fw + 6, y - fh);
    ctx.closePath(); ctx.fill();
    ctx.fillStyle = '#3a2d20';
    ctx.beginPath();
    ctx.moveTo(x - 4, y - fh); ctx.lineTo(wxm, y - fh - 12); ctx.lineTo(x + fw + 4, y - fh);
    ctx.closePath(); ctx.fill();
    ctx.fillStyle = '#4d3c2a';
    ctx.beginPath();
    ctx.moveTo(x + 3, y - fh - 2); ctx.lineTo(wxm, y - fh - 12); ctx.lineTo(x + fw - 3, y - fh - 2);
    ctx.closePath(); ctx.fill();
    ctx.strokeStyle = '#5a4732'; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(x - 2, y - fh - 1); ctx.lineTo(wxm, y - fh - 11); ctx.lineTo(x + fw + 2, y - fh - 1); ctx.stroke();
    /* chimney */
    R(ctx, x + fw - 12, y - fh - 10, 6, 8, '#3a332c');
    R(ctx, x + fw - 12, y - fh - 10, 6, 2, '#4a4440');
    /* wall planks, 2-tone + seams */
    R(ctx, x, y - fh, fw, fh, '#4a3a28');
    R(ctx, x, y - fh, fw, 2, '#5a4732');                     // top light
    R(ctx, x, y - 3, fw, 3, '#332818');                      // ground shadow
    for (var p = 5; p < fw; p += 7) R(ctx, x + p, y - fh + 3, 1, fh - 6, '#3a2c1e');
    /* door */
    R(ctx, x + 5, y - fh + 6, 8, fh - 6, '#241b12');
    R(ctx, x + 6, y - fh + 7, 6, fh - 8, '#31251a');
    R(ctx, x + 11, y - fh / 2, 1, 1, '#c99a3f');
    /* window: dark frame + warm panes + mullion cross */
    R(ctx, x + fw - 14, y - fh + 5, 9, 9, '#1c1610');
    if (lit) {
      var fl2 = 0.75 + 0.25 * Math.sin(t * 5 + x);
      R(ctx, x + fw - 13, y - fh + 6, 7, 7, 'rgba(240,170,80,' + fl2.toFixed(2) + ')');
      R(ctx, x + fw - 10, y - fh + 6, 1, 7, '#1c1610');
      R(ctx, x + fw - 13, y - fh + 9, 7, 1, '#1c1610');
      R(ctx, x + fw - 12, y - fh + 7, 1, 1, 'rgba(255,230,170,' + fl2.toFixed(2) + ')');
      var wg = ctx.createRadialGradient(x + fw - 10, y - fh + 9, 2, x + fw - 10, y - fh + 9, 20);
      wg.addColorStop(0, 'rgba(232,160,75,.22)'); wg.addColorStop(1, 'rgba(232,160,75,0)');
      ctx.fillStyle = wg;
      ctx.beginPath(); ctx.arc(x + fw - 10, y - fh + 9, 20, 0, 6.283); ctx.fill();
    } else {
      R(ctx, x + fw - 13, y - fh + 6, 7, 7, '#241b12');
    }
  }
  function tree(x, y, s) {
    R(ctx, x - 1, y - 10 * s, 3, 10 * s, '#3a2f22');
    R(ctx, x - 7 * s, y - 16 * s, 15 * s, 7 * s, '#223526');
    R(ctx, x - 5 * s, y - 21 * s, 11 * s, 6 * s, '#2b4230');
    R(ctx, x - 3 * s, y - 24 * s, 7 * s, 4 * s, '#253a2a');
  }
  function fence(x, y, n) {
    for (var fi = 0; fi < n; fi++) {
      R(ctx, x + fi * 9, y - 8, 2, 8, '#4a3a28');
      R(ctx, x + fi * 9, y - 5, 8, 1, '#3c2f20');
    }
    R(ctx, x - 1, y - 7, n * 9, 1, '#54402a');
  }

  /* BACK ROW — huts flanking the tower's base, dark trees behind them */
  tree(w * 0.015, baseY + 10, 1.15);
  tree(w * 0.985, baseY + 10, 1.15);
  hut(w * 0.045, baseY + 14, 44, 24, true);          // left hut
  hut(w * 0.955 - 46, baseY + 16, 46, 24, true);     // right hut
  fence(w * 0.045, baseY + 40, 3);
  fence(w * 0.955 - 30, baseY + 42, 3);

  /* MID ROW — MEMORIAL GROVE (left): trees shade the stones */
  tree(Z.mem.x - 26, Z.mem.y + 6, 0.9);
  tree(Z.mem.x + 26, Z.mem.y + 6, 0.9);
  var mi;
  for (mi = 0; mi < 3; mi++) {
    R(ctx, Z.mem.x - 8 + mi * 8, Z.mem.y + 4, 5, 10, mi === 1 ? '#6b737e' : '#5a616b');
    R(ctx, Z.mem.x - 8 + mi * 8, Z.mem.y + 4, 5, 2, '#7a828c');
    R(ctx, Z.mem.x - 9 + mi * 8, Z.mem.y + 14, 7, 2, '#39424c');
  }
  /* MID ROW — WORKSHOP + STORAGE (right): lean-to, anvil, crates, barrels */
  var wx0 = Math.round(Z.work.x), wy0 = Math.round(Z.work.y);
  R(ctx, wx0 - 16, wy0 - 28, 34, 2, '#3c2f20');
  R(ctx, wx0 - 16, wy0 - 28, 2, 14, '#3c2f20');
  R(ctx, wx0 + 16, wy0 - 28, 2, 18, '#3c2f20');
  R(ctx, wx0 - 8, wy0 - 12, 18, 4, MET_L);
  R(ctx, wx0 - 3, wy0 - 8, 8, 5, MET_D);
  R(ctx, wx0 - 6, wy0 - 3, 14, 3, '#3a3326');
  R(ctx, wx0 + 10, wy0 - 4, 2, 8, WOOD);
  R(ctx, wx0 + 9, wy0 - 6, 4, 3, MET_L);
  R(ctx, wx0 - 24, wy0 - 2, 11, 11, '#5a4732');       // crate stack
  R(ctx, wx0 - 23, wy0 - 13, 11, 11, '#4a3a28');
  R(ctx, wx0 + 20, wy0 + 6, 8, 10, '#54402a');        // barrel
  R(ctx, wx0 + 20, wy0 + 8, 8, 2, '#3c2f20');
  /* MID ROW — the WELL just left of the road */
  var wlX = Math.round(w * 0.36), wlY = Math.round(h * 0.46);
  R(ctx, wlX - 9, wlY - 8, 18, 8, '#4a525c');
  R(ctx, wlX - 9, wlY - 8, 18, 2, '#5a636e');
  R(ctx, wlX - 8, wlY - 4, 16, 3, '#0a0e13');
  R(ctx, wlX - 10, wlY - 20, 2, 12, '#3c2f20');
  R(ctx, wlX + 8, wlY - 20, 2, 12, '#3c2f20');
  R(ctx, wlX - 12, wlY - 22, 24, 2, '#3c2f20');

  /* FRONT ROW — plaza benches + weapon rack + wood pile near the fire */
  var fz = Z.fire;
  R(ctx, fz.x - 44, fz.y + 10, 16, 3, '#54402a');     // bench L
  R(ctx, fz.x - 44, fz.y + 13, 2, 4, '#3c2f20');
  R(ctx, fz.x - 31, fz.y + 13, 2, 4, '#3c2f20');
  R(ctx, fz.x + 30, fz.y + 10, 16, 3, '#54402a');     // bench R
  R(ctx, fz.x + 30, fz.y + 13, 2, 4, '#3c2f20');
  R(ctx, fz.x + 43, fz.y + 13, 2, 4, '#3c2f20');
  R(ctx, fz.x - 60, fz.y - 4, 3, 16, '#3c2f20');      // weapon rack
  R(ctx, fz.x - 60, fz.y - 6, 14, 2, '#54402a');
  R(ctx, fz.x - 56, fz.y - 4, 2, 10, MET_L);
  R(ctx, fz.x - 52, fz.y - 3, 2, 9, '#8a8f99');
  R(ctx, fz.x + 52, fz.y + 2, 14, 4, '#4a3a28');      // wood pile
  R(ctx, fz.x + 52, fz.y - 2, 11, 4, '#54402a');

  /* BOTTOM ROW — TRAINING (lower-left), REST (lower-right) */
  var dx0 = Math.round(Z.train.x), dy0 = Math.round(Z.train.y);
  R(ctx, dx0 - 1, dy0 - 20, 3, 22, WOOD);
  R(ctx, dx0 - 7, dy0 - 14, 15, 2, WOOD);
  R(ctx, dx0 - 3, dy0 - 24, 7, 5, '#a8865a');
  R(ctx, dx0 - 5, dy0, 11, 3, '#3a3326');
  fence(dx0 + 14, dy0 + 4, 3);
  var rx0 = Math.round(Z.rest.x), ry0 = Math.round(Z.rest.y);
  R(ctx, rx0 - 24, ry0 - 18, 48, 2, '#3c2f20');
  R(ctx, rx0 - 24, ry0 - 18, 2, 20, '#3c2f20');
  R(ctx, rx0 + 22, ry0 - 18, 2, 20, '#3c2f20');
  R(ctx, rx0 - 20, ry0 - 4, 18, 6, '#5c4a3d');
  R(ctx, rx0 - 20, ry0 - 4, 4, 6, '#8b94a7');
  R(ctx, rx0 + 2, ry0 - 4, 18, 6, '#3d4a5c');
  R(ctx, rx0 + 2, ry0 - 4, 4, 6, '#8b94a7');
  /* the wagon at the village bottom edge + frame trees/bushes */
  R(ctx, w * 0.06, h * 0.965, 26, 6, '#54402a');
  R(ctx, w * 0.06 + 3, h * 0.958, 20, 2, '#3c2f20');
  ctx.fillStyle = '#3c2f20';
  ctx.beginPath(); ctx.arc(w * 0.06 + 6, h * 0.975, 3, 0, 6.283); ctx.fill();
  ctx.beginPath(); ctx.arc(w * 0.06 + 20, h * 0.975, 3, 0, 6.283); ctx.fill();
  tree(w * 0.02, h * 0.92, 1.25);
  tree(w * 0.98, h * 0.90, 1.3);
  tree(w * 0.30, h * 0.985, 0.95);
  tree(w * 0.70, h * 0.99, 0.9);
  R(ctx, w * 0.46, h * 0.94, 14, 5, '#223526');
  R(ctx, w * 0.56, h * 0.91, 10, 4, '#2b4230');
  R(ctx, w * 0.12, h * 0.70, 12, 4, '#223526');
  R(ctx, w * 0.88, h * 0.68, 12, 4, '#2b4230');

  /* quiet captions */
  ctx.font = '6px ' + PIXEL;
  ctx.fillStyle = 'rgba(139,148,167,.7)';
  ctx.textAlign = 'center';
  ctx.fillText('TRAINING', Z.train.x, Z.train.y + 20);
  ctx.fillText('WORKSHOP', Z.work.x, Z.work.y + 18);
  ctx.fillText('REST', Z.rest.x, Z.rest.y + 16);
  ctx.fillText('MEMORIAL', Z.mem.x, Z.mem.y + 26);
  ctx.fillStyle = 'rgba(215,220,230,.85)';
  ctx.fillText('▸ THE TOWER', Z.tower.x, Z.tower.y + 20);
}

function lbFrame(now) {
  if (!lb || lb.dead) return;
  try {
    if (!lb.canvas.isConnected) { lb.dead = true; return; }   // lobby left the DOM
    var ctx = lb.ctx, t = (now - lb.t0) / 1000;
    var dt = Math.min(0.05, (now - (lb.last || now)) / 1000);
    lb.last = now;
    var w = lb.w, h = lb.h;
    var S = (typeof IT !== 'undefined' && IT.S) ? IT.S : null;

    /* ============ V0.18b: THE VILLAGE IS THE STAGE ============
       Tower = landmark high-center (gate at h*0.30, body above off-frame);
       village fills the lower ~70% with depth rows: back huts / mid grove-
       workshop / foreground fire plaza / bottom training+rest. The road
       runs straight from the plaza INTO the gate — everything converges. */
    var Z = lbZones(w, h);
    var baseY = Z.tower.y;                    // tower base line (high)
    var floorTop = baseY - 4;
    ctx.setTransform(lb.dpr, 0, 0, lb.dpr, 0, 0);
    ctx.imageSmoothingEnabled = false;

    /* ---- V0.27 MORNING: dawn gold behind the Tower ---- */
    var bg = ctx.createLinearGradient(0, 0, 0, h);
    bg.addColorStop(0, '#7a8ba0'); bg.addColorStop(0.3, '#a09a96');
    bg.addColorStop(0.55, '#c4a67e'); bg.addColorStop(0.8, '#dcb87e'); bg.addColorStop(1, '#b89a6e');
    ctx.fillStyle = bg; ctx.fillRect(0, 0, w, h);
    /* the low sun, rising behind the Tower's shoulder */
    var sunX = w / 2, sunY = baseY - 40;
    var sun = ctx.createRadialGradient(sunX, sunY, 6, sunX, sunY, w * 0.62);
    sun.addColorStop(0, 'rgba(255,214,150,.55)');
    sun.addColorStop(0.25, 'rgba(255,190,120,.22)');
    sun.addColorStop(1, 'rgba(255,190,120,0)');
    ctx.fillStyle = sun; ctx.fillRect(0, 0, w, h);
    /* thin dawn clouds */
    ctx.fillStyle = 'rgba(255,220,190,.16)';
    for (var cl = 0; cl < 3; cl++) {
      var cy2 = baseY * (0.18 + cl * 0.16);
      ctx.beginPath();
      ctx.ellipse(((cl * 137) % w), cy2, 70 - cl * 12, 5, 0, 0, 6.283);
      ctx.fill();
    }

    /* ---- THE TOWER — landmark, not landlord: base+gate read clearly ---- */
    var TX = w / 2, tw0 = w * 0.185;
    (function tower() {
      var top = -20, by = baseY + 8;
      var tg = ctx.createLinearGradient(TX - tw0, 0, TX + tw0, 0);
      tg.addColorStop(0, '#1a2027'); tg.addColorStop(0.5, '#2b3440'); tg.addColorStop(1, '#161b21');
      ctx.fillStyle = tg;
      ctx.beginPath();
      ctx.moveTo(TX - tw0, by);
      ctx.lineTo(TX - tw0 * 0.74, top);
      ctx.lineTo(TX + tw0 * 0.74, top);
      ctx.lineTo(TX + tw0, by);
      ctx.closePath(); ctx.fill();
      ctx.strokeStyle = 'rgba(10,14,18,.55)'; ctx.lineWidth = 1;
      for (var ty = by - 12; ty > top; ty -= 12) {
        var k = (by - ty) / (by - top), hw = tw0 * (1 - 0.26 * k);
        ctx.beginPath(); ctx.moveTo(TX - hw, ty); ctx.lineTo(TX + hw, ty); ctx.stroke();
        /* chunky banding: every other course a shade darker, block seams */
        if (Math.round(ty / 12) % 2 === 0) {
          var kx = (by - ty) / (by - top), hwB = tw0 * (1 - 0.26 * kx);
          ctx.fillStyle = 'rgba(14,19,24,.4)';
          ctx.fillRect(TX - hwB, ty - 12, hwB * 2, 12);
        }
      }
      /* rim light on the moon side (left), deep shade right */
      ctx.fillStyle = 'rgba(110,135,160,.30)';
      ctx.fillRect(TX - tw0 + 2, top + 60, 3, by - top - 100);
      ctx.fillRect(TX - tw0 + 5, top + 60, 1, by - top - 100);
      ctx.fillStyle = 'rgba(8,11,15,.5)';
      ctx.fillRect(TX + tw0 - 5, top + 60, 3, by - top - 100);
      ctx.fillStyle = '#232b34';
      ctx.fillRect(TX - tw0 - 7, by - 36, 7, 36);
      ctx.fillRect(TX + tw0, by - 36, 7, 36);
      ctx.fillStyle = '#0a0e13';
      for (var wi = 0; wi < 4; wi++) {
        var wy = by - 34 - wi * 26, k2 = (by - wy) / (by - top);
        var hw2 = tw0 * (1 - 0.26 * k2);
        ctx.fillRect(TX - hw2 * 0.42 - 1, wy, 2, 4);
        ctx.fillRect(TX + hw2 * 0.42 - 1, wy + 10, 2, 4);
      }
      var slitGlow = 0.5 + 0.5 * Math.sin(t * 1.3);
      ctx.fillStyle = 'rgba(232,160,75,' + (0.45 + 0.3 * slitGlow).toFixed(2) + ')';
      ctx.fillRect(TX - tw0 * 0.30, by - 96, 2, 4);
      /* moss/vines reclaiming the base stones */
      ctx.fillStyle = 'rgba(45,64,48,.8)';
      ctx.fillRect(TX - tw0 + 3, by - 14, 4, 3); ctx.fillRect(TX - tw0 + 8, by - 22, 3, 3);
      ctx.fillRect(TX + tw0 - 7, by - 18, 4, 3); ctx.fillRect(TX + tw0 - 11, by - 10, 3, 3);
      /* THE GATE — where every road leads */
      var ex = TX, ey = by + 4, ew = 17, eh = 30;
      ctx.fillStyle = '#06080c';
      ctx.beginPath();
      ctx.moveTo(ex - ew, ey);
      ctx.lineTo(ex - ew, ey - eh + 10);
      ctx.arc(ex, ey - eh + 10, ew, Math.PI, 0);
      ctx.lineTo(ex + ew, ey);
      ctx.closePath(); ctx.fill();
      ctx.strokeStyle = '#3d4854'; ctx.lineWidth = 2; ctx.stroke();
      /* gold trim studs around the gate — the door is dressed, not decorated */
      ctx.fillStyle = '#c99a3f';
      ctx.fillRect(ex - ew - 2, ey - eh + 8, 2, 2); ctx.fillRect(ex + ew, ey - eh + 8, 2, 2);
      ctx.fillRect(ex - ew - 3, ey - 2, 2, 2); ctx.fillRect(ex + ew + 1, ey - 2, 2, 2);
      ctx.fillStyle = '#39424c';
      ctx.fillRect(ex - ew - 5, ey, ew * 2 + 10, 4);
      ctx.fillStyle = '#2c343d';
      ctx.fillRect(ex - ew - 10, ey + 4, ew * 2 + 20, 4);
      var doorG = ctx.createRadialGradient(ex, ey - 12, 2, ex, ey - 12, 30);
      doorG.addColorStop(0, 'rgba(160,190,220,.18)'); doorG.addColorStop(1, 'rgba(160,190,220,0)');
      ctx.fillStyle = doorG;
      ctx.beginPath(); ctx.arc(ex, ey - 12, 22, 0, 6.283); ctx.fill();
    })();
    /* mist takes only the tower's crown */
    var mist = ctx.createLinearGradient(0, 0, 0, baseY * 0.75);
    mist.addColorStop(0, 'rgba(240,224,196,.26)');
    mist.addColorStop(0.6, 'rgba(226,206,180,.14)');
    mist.addColorStop(1, 'rgba(226,206,180,0)');
    ctx.fillStyle = mist; ctx.fillRect(0, 0, w, baseY * 0.75);

    /* ---- village ground: green as TEXTURE, not a flat plane ---- */
    var gr = ctx.createLinearGradient(0, floorTop, 0, h);
    gr.addColorStop(0, '#54703f'); gr.addColorStop(0.5, '#628048'); gr.addColorStop(1, '#4c6a3a');
    ctx.fillStyle = gr; ctx.fillRect(0, floorTop, w, h - floorTop);
    /* irregular patches: moss lighter / olive / near-black dirt */
    var patchCols = ['rgba(96,122,74,.5)', 'rgba(118,124,80,.4)', 'rgba(52,72,44,.5)', 'rgba(88,128,92,.4)'];
    for (var gp = 0; gp < 34; gp++) {
      var px0 = ((gp * 83.7) % w), py0 = floorTop + ((gp * 47.3) % (h - floorTop));
      var pw2 = 10 + (gp * 13) % 26, ph2 = 4 + (gp * 7) % 8;
      ctx.fillStyle = patchCols[gp % 4];
      ctx.beginPath(); ctx.ellipse(px0, py0, pw2 / 2, ph2 / 2, 0, 0, 6.283); ctx.fill();
    }
    /* grass tufts everywhere */
    ctx.fillStyle = 'rgba(120,150,96,.5)';
    for (var gt = 0; gt < 70; gt++) {
      var gx = (gt * 61.7) % w, gy = floorTop + 6 + ((gt * 37.9) % (h - floorTop - 10));
      if (Math.abs(gx - TX) < 22 && gy < baseY + 40) continue;   // keep the gate's steps clear
      ctx.fillRect(Math.round(gx), Math.round(gy), 3, 1);
      ctx.fillRect(Math.round(gx) + 1, Math.round(gy) - 1, 1, 2);
    }
    /* dirt worn bare around the facilities and the road edge */
    ctx.fillStyle = 'rgba(58,53,40,.45)';
    ctx.beginPath(); ctx.ellipse(w * 0.24, h * 0.85, 34, 8, 0, 0, 6.283); ctx.fill();
    ctx.beginPath(); ctx.ellipse(w * 0.78, h * 0.85, 34, 8, 0, 0, 6.283); ctx.fill();
    ctx.beginPath(); ctx.ellipse(Z.mem.x, Z.mem.y + 8, 30, 8, 0, 0, 6.283); ctx.fill();

    /* ---- THE ROAD: plaza → gate, straight up the middle ---- */
    ctx.fillStyle = '#3c352a';
    ctx.beginPath();
    ctx.moveTo(TX - 24, baseY + 10);
    ctx.lineTo(TX + 24, baseY + 10);
    ctx.lineTo(TX + 52, h);
    ctx.lineTo(TX - 52, h);
    ctx.closePath(); ctx.fill();
    ctx.fillStyle = '#4a4234';
    for (var ps = 0; ps < 9; ps++) {
      var ry = baseY + 14 + ps * ((h - baseY - 16) / 9);
      var rk = (ry - baseY) / (h - baseY);
      var rhw = 22 + rk * 30;
      ctx.fillRect(Math.round(TX - rhw + (ps % 2) * 6), Math.round(ry), 12, 3);
      ctx.fillRect(Math.round(TX + rhw - 12 - (ps % 2) * 6), Math.round(ry + 4), 12, 3);
    }
    /* lantern posts flanking the road — the way is lit, the door is not */
    function lanternPost(lx, ly) {
      R(ctx, Math.round(lx), Math.round(ly - 16), 2, 16, '#3c2f20');
      var lf = 0.7 + 0.3 * Math.sin(t * 4 + lx);
      R(ctx, Math.round(lx) - 2, Math.round(ly) - 22, 6, 6, 'rgba(232,160,75,' + lf.toFixed(2) + ')');
      var lg2 = ctx.createRadialGradient(lx, ly - 19, 1, lx, ly - 19, 14);
      lg2.addColorStop(0, 'rgba(232,160,75,' + (0.25 * lf).toFixed(2) + ')');
      lg2.addColorStop(1, 'rgba(232,160,75,0)');
      ctx.fillStyle = lg2;
      ctx.beginPath(); ctx.arc(lx, ly - 19, 14, 0, 6.283); ctx.fill();
    }
    lanternPost(TX - 34, baseY + 26);
    lanternPost(TX + 34, baseY + 26);
    lanternPost(TX - 58, h * 0.80);
    lanternPost(TX + 58, h * 0.80);

    /* ---- village props (huts, fences, trees, graves, labels) ---- */
    lbDrawProps(ctx, Z, t, (S && S.memorial || []).length);

    /* ---- candles for the fallen: the MEMORIAL zone (newest lowest) ---- */
    var mem = (S && Array.isArray(S.memorial)) ? S.memorial.slice(-6).reverse() : [];
    ctx.textAlign = 'center';
    mem.forEach(function (m, i) {
      var cx = Z.mem.x + 12 - (i % 2) * 24;
      var cy = Z.mem.y - Math.floor(i / 2) * 16;
      var fl = 0.7 + 0.3 * Math.sin(t * 6 + i * 2.4);
      var fresh = (i === 0) ? 1 : 0.55;
      var g = ctx.createRadialGradient(cx, cy - 4, 1, cx, cy - 4, 22 * fl * fresh + 8);
      g.addColorStop(0, 'rgba(232,176,75,' + (0.22 * fl * fresh).toFixed(3) + ')');
      g.addColorStop(1, 'rgba(232,176,75,0)');
      ctx.fillStyle = g;
      ctx.beginPath(); ctx.arc(cx, cy - 4, 26, 0, 6.283); ctx.fill();
      ctx.fillStyle = '#d8d4c8'; ctx.fillRect(cx - 1, cy - 3, 2, 7);       // candle
      ctx.fillStyle = i === 0 ? '#ffe9b0' : '#e8a04b';
      ctx.fillRect(cx - 1, cy - 6 - (fresh > 0.9 ? 1 : 0), 2, 3);          // flame
    });
    if ((S && S.memorial || []).length > 6) {
      ctx.font = '6px ' + PIXEL; ctx.fillStyle = C.dim;
      ctx.fillText('🪦 ' + S.memorial.length, Z.mem.x, Z.mem.y - 52);
    }

    /* ---- firepit (the plaza landmark) ---- */
    var fx = Z.fire.x, fy = Z.fire.y + 6;
    ctx.fillStyle = '#232a3a';
    for (var sAng = 0; sAng < 8; sAng++) {
      var a2 = sAng / 8 * 6.283;
      ctx.beginPath();
      ctx.ellipse(fx + Math.cos(a2) * 20, fy + Math.sin(a2) * 7, 5, 3.4, 0, 0, 6.283);
      ctx.fill();
    }
    var ffh = 15 + 4 * Math.sin(t * 8.3) + 2 * Math.sin(t * 13.1);
    var fg = ctx.createRadialGradient(fx, fy - 5, 2, fx, fy - 5, ffh + 12);
    fg.addColorStop(0, '#ffe9b0'); fg.addColorStop(0.5, '#e8a04b'); fg.addColorStop(1, 'rgba(224,82,99,0)');
    ctx.fillStyle = fg;
    ctx.beginPath(); ctx.ellipse(fx, fy - 5, 8, ffh * 0.8, 0, 0, 6.283); ctx.fill();
    ctx.fillStyle = '#e8845b'; ctx.fillRect(fx - 3, fy - 9, 6, 3);
    ctx.fillStyle = '#ffe9b0'; ctx.fillRect(fx - 1, fy - 6, 2, 3);
    /* embers off the fire + chimney smoke off both huts (people live here) */
    lb.emb = (lb.emb || 0) + dt;
    while (lb.emb > 0.3) {
      lb.emb -= 0.3;
      lb.parts.push({ x: fx + (Math.random() - 0.5) * 12, y: fy - 8,
        vx: (Math.random() - 0.5) * 8, vy: -20 - Math.random() * 14,
        life: 1, decay: 0.8, size: 1.3 + Math.random(),
        color: Math.random() < 0.5 ? '#e8a04b' : '#ffb254', soft: true });
      if (Math.random() < 0.35) {
        var hx2 = (Math.random() < 0.5) ? (w * 0.045 + 22) : (w * 0.955 - 23);
        lb.parts.push({ x: hx2, y: baseY - 22, vx: (Math.random() - 0.5) * 6,
          vy: -7 - Math.random() * 5, life: 1, decay: 0.35,
          size: 2 + Math.random() * 2, color: 'rgba(120,128,138,.28)', soft: true });
      }
    }

    /* ---- heroes: THE PARTY is staged center-foreground; the bench lives
       small and dim in the village (V0.26 — party presentation only) ---- */
    if (S) {
      var party = (S.party || []).map(function (id) {
        return (S.heroes || []).filter(function (x) { return x.id === id; })[0] || null;
      }).filter(Boolean);
      var bench = (S.heroes || []).filter(function (x) { return (S.party || []).indexOf(x.id) < 0; })
        .sort(function (a, b) { return (b.lvl || 1) - (a.lvl || 1); }).slice(0, 4);
      var actors = party.concat(bench);

      /* the staging ground: stone slabs + a warm pool — this spot is theirs */
      var stageY = fy + 34;
      if (party.length) {
        ctx.fillStyle = 'rgba(92,86,66,.6)';
        for (var si = 0; si < party.length; si++) {
          var sx2 = fx + (si - (party.length - 1) / 2) * 64;
          roundRect(ctx, sx2 - 27, stageY + 16, 54, 14, 4); ctx.fill();
        }
        var pg = ctx.createRadialGradient(fx, stageY + 8, 8, fx, stageY + 8, 100);
        pg.addColorStop(0, 'rgba(232,170,90,.14)');
        pg.addColorStop(1, 'rgba(232,170,90,0)');
        ctx.fillStyle = pg;
        ctx.beginPath(); ctx.arc(fx, stageY + 8, 100, 0, 6.283); ctx.fill();
      }

      actors.forEach(function (hero) {
        var inParty = (S.party || []).indexOf(hero.id) >= 0;
        var u = lb.units['u' + hero.id];
        if (!u) {
          var mk1 = { legacy: !!hero.legacy, pact: !!hero.pact, brand: !!hero.branded };
          if (inParty) {
            /* party walks IN to their stage slot */
            var slotX = fx + (party.indexOf(hero) - (party.length - 1) / 2) * 64;
            u = lb.units['u' + hero.id] = {
              id: hero.id, name: hero.name, inParty: true, pinned: true,
              alpha: 1, sc: 5.5,
              sprs: { idle0: makeHeroSprite(hero.cls, hero.id, 'idle0', mk1),
                      idle1: makeHeroSprite(hero.cls, hero.id, 'idle1', mk1),
                      atk: makeHeroSprite(hero.cls, hero.id, 'atk', mk1) },
              x: slotX, y: stageY - 34, tx: slotX, ty: stageY,
              act: 'fire', swing: 0, swingT: 1,
              mode: 'walk', wait: Math.random() * 3, phase: Math.random() * 6.28
            };
          } else {
            var sp0 = lbFindSpot(Z.fire.x, Z.fire.y, null);
            u = lb.units['u' + hero.id] = {
              id: hero.id, name: hero.name, inParty: false,
              alpha: 0.55, sc: 3.4,        /* bench = peripheral */
              sprs: { idle0: makeHeroSprite(hero.cls, hero.id, 'idle0', mk1),
                      idle1: makeHeroSprite(hero.cls, hero.id, 'idle1', mk1),
                      atk: makeHeroSprite(hero.cls, hero.id, 'atk', mk1) },
              x: sp0.x, y: sp0.y - 24,
              tx: sp0.x, ty: sp0.y, act: 'fire', swing: 0, swingT: 1,
              mode: 'walk', wait: Math.random() * 6, phase: Math.random() * 6.28
            };
          }
        }
        if (inParty) {   /* keep the slot true if the party order changed */
          u.pinned = true;
          u.hx = fx + (party.indexOf(hero) - (party.length - 1) / 2) * 64;
          u.hy = stageY + (party.indexOf(hero) === 1 ? 5 : 0);
        } else {
          u.pinned = false;
          u.inParty = false;
        }
        lbTickUnit(u, dt, hero, Z);
        lbDrawFig(ctx, u, t);
        if (inParty) {   /* the party wears their names */
          ctx.font = '7px ' + PIXEL;
          ctx.fillStyle = u === lb.sel ? C.gold : '#f0ead8';
          ctx.fillText(u.name.toUpperCase(), u.x, u.y + 38);
        }
      });
      /* drop units that left the roster */
      var live2 = {};
      actors.forEach(function (x) { live2['u' + x.id] = 1; });
      Object.keys(lb.units).forEach(function (k2) { if (!live2[k2]) delete lb.units[k2]; });
    }

    /* ---- particles ---- */
    for (var pi = lb.parts.length - 1; pi >= 0; pi--) {
      var q = lb.parts[pi];
      q.life -= q.decay * dt;
      if (q.life <= 0) { lb.parts.splice(pi, 1); continue; }
      q.x += q.vx * dt; q.y += q.vy * dt; q.vy -= 4 * dt;
      ctx.globalAlpha = Math.max(0, q.life);
      ctx.fillStyle = q.color;
      ctx.fillRect(Math.round(q.x), Math.round(q.y), Math.max(1, Math.round(q.size)), Math.max(1, Math.round(q.size)));
    }
    ctx.globalAlpha = 1;

    /* ---- lighting: dark blanket, holes at fire + torches ---- */
    if (!lb.lc || lb.lc.width !== lb.canvas.width) {
      lb.lc = document.createElement('canvas');
      lb.lc.width = lb.canvas.width; lb.lc.height = lb.canvas.height;
      lb.lg = lb.lc.getContext('2d');
    }
    var lg = lb.lg;
    if (lg) {
      lg.setTransform(lb.dpr, 0, 0, lb.dpr, 0, 0);
      lg.globalCompositeOperation = 'source-over';
      lg.clearRect(0, 0, w, h);
      lg.fillStyle = 'rgba(40,34,20,.06)';
      lg.fillRect(0, 0, w, h);
      lg.globalCompositeOperation = 'destination-out';
      var fireFl = 0.85 + 0.15 * Math.sin(t * 8.3);
      var baseY2 = Z.tower.y;
      /* warm life: the fire, both hut windows, the memorial candles */
      var holes = [
        [fx, fy - 4, (w * 0.40) * fireFl, 0.95],
        [w * 0.045 + 22, baseY2 + 2, 56, 0.8],          // left hut window
        [w * 0.955 - 23, baseY2 + 4, 56, 0.8],          // right hut window
        [Z.mem.x, Z.mem.y, 46, 0.7],                    // memorial candles
        [TX - 34, baseY2 + 8, 30, 0.6], [TX + 34, baseY2 + 8, 30, 0.6],   // road lanterns
        [TX - 58, h * 0.79, 26, 0.55], [TX + 58, h * 0.79, 26, 0.55]
      ];
      for (var hi = 0; hi < holes.length; hi++) {
        var HH = holes[hi];
        var hg = lg.createRadialGradient(HH[0], HH[1], 2, HH[0], HH[1], HH[2]);
        hg.addColorStop(0, 'rgba(0,0,0,' + HH[3] + ')');
        hg.addColorStop(1, 'rgba(0,0,0,0)');
        lg.fillStyle = hg;
        lg.beginPath(); lg.arc(HH[0], HH[1], HH[2], 0, 6.283); lg.fill();
      }
      ctx.drawImage(lb.lc, 0, 0, w, h);
      ctx.globalCompositeOperation = 'lighter';
      var wg = ctx.createRadialGradient(fx, fy - 4, 2, fx, fy - 4, w * 0.4 * fireFl);
      wg.addColorStop(0, 'rgba(232,150,70,.12)'); wg.addColorStop(1, 'rgba(0,0,0,0)');
      ctx.fillStyle = wg;
      ctx.beginPath(); ctx.arc(fx, fy - 4, w * 0.42, 0, 6.283); ctx.fill();
      ctx.globalCompositeOperation = 'source-over';
    }
    /* vignette */
    var vg = ctx.createRadialGradient(w / 2, h * 0.5, h * 0.4, w / 2, h * 0.5, h * 0.85);
    vg.addColorStop(0, 'rgba(0,0,0,0)'); vg.addColorStop(1, 'rgba(40,32,20,.14)');
    ctx.fillStyle = vg; ctx.fillRect(0, 0, w, h);
    if (lb.fade < 1) {
      lb.fade = Math.min(1, lb.fade + dt * 2);
      ctx.fillStyle = 'rgba(26,24,20,' + (1 - lb.fade).toFixed(3) + ')';
      ctx.fillRect(0, 0, w, h);
    }
  } catch (e) {
    if (!lb.loggedErr) { lb.loggedErr = 1; try { console.error('[lobby scene]', e); } catch (e2) { /* ignore */ } }
  }
  if (lb && !lb.dead) lb.raf = requestAnimationFrame(lbFrame);
}

function lobbyTap(ev) {
  if (!lb) return;
  var r;
  try { r = lb.canvas.getBoundingClientRect(); } catch (e) { return; }
  var cx = (ev.clientX != null ? ev.clientX : 0) - r.left;
  var cy = (ev.clientY != null ? ev.clientY : 0) - r.top;
  /* body-box hit: the torso is the target (16x26 around center-feet),
     nearest wins — bodies no longer stack so this reads who you meant */
  var best = null, bd = 1e9;
  Object.keys(lb.units).forEach(function (k) {
    var u = lb.units[k];
    var dx = Math.abs(cx - u.x), dy = Math.abs(cy - (u.y - 6));
    if (dx > 17 || dy > 26) return;
    var d = dx + dy * 0.6;
    if (d < bd) { bd = d; best = u; }
  });
  lb.sel = best || null;
  if (best && typeof lb.onTap === 'function') {
    try { lb.onTap(best.id, LB_ACT[best.act] || 'Loitering'); } catch (e) { /* drawer is DOM */ }
    return;
  }
  /* no figure hit — the ZONE under the tap is the context menu */
  if (!best && typeof lb.onZone === 'function') {
    var Z = lbZones(lb.w, lb.h), zn = null, zd = 1e9;
    Object.keys(Z).forEach(function (k) {
      var dx = cx - Z[k].x, dy = cy - Z[k].y, d = Math.sqrt(dx * dx + dy * dy);
      if (d < 52 && d < zd) { zd = d; zn = k; }
    });
    if (zn) { try { lb.onZone(zn); } catch (e) { /* ignore */ } }
  }
}

function lobbyResize() {
  /* rotation / Safari toolbar / hero drawer changed the box — re-measure */
  if (!lb || lb.dead || !lb.canvas.parentElement) return;
  try {
    var root = lb.canvas.parentElement;
    var w = Math.min(430, root.clientWidth || lb.w);
    var ch = root.clientHeight || 0;
    var h = (ch > 240) ? ch : lb.h;
    if (w === lb.w && h === lb.h) return;
    lb.w = w; lb.h = h;
    lb.dpr = Math.max(1, Math.min(3, (typeof devicePixelRatio === 'number') ? devicePixelRatio : 1));
    lb.canvas.width = Math.round(w * lb.dpr); lb.canvas.height = Math.round(h * lb.dpr);
    lb.canvas.style.height = h + 'px';
    lb.units = {};   /* px slot positions are stale — heroes re-walk to new spots */
  } catch (e) { /* keep last size */ }
}
function lobbyAttach(root, onTap, onZone) {
  if (!HAS_DOM || !HAS_RAF || !root) return false;
  try {
    var canvas = document.createElement('canvas');
    if (!canvas.getContext) return false;
    root.innerHTML = '';
    root.appendChild(canvas);
    var w = Math.min(430, root.clientWidth || root.offsetWidth || 430);
    /* V0.16: the hall fills the viewport — CSS sets the height, we honor it */
    var ch = root.clientHeight || 0;
    var h = (ch > 240) ? ch : Math.max(280, Math.min(370, Math.round(w * 0.80)));
    var dpr = Math.max(1, Math.min(3, (typeof devicePixelRatio === 'number') ? devicePixelRatio : 1));
    lb = { canvas: canvas, ctx: canvas.getContext('2d'), units: {}, parts: [],
      t0: performance.now(), last: 0, raf: 0, dpr: dpr, w: w, h: h,
      dead: false, fade: 0, emb: 0, lc: null, lg: null, sel: null,
      onTap: onTap, onZone: onZone };
    canvas.width = Math.round(w * dpr); canvas.height = Math.round(h * dpr);
    canvas.style.height = h + 'px';
    canvas.addEventListener('click', lobbyTap);
    window.addEventListener('resize', lobbyResize);
    lb.raf = requestAnimationFrame(lbFrame);
    return true;
  } catch (e) { lb = null; return false; }
}
function lobbyDetach() {
  if (!lb) return;
  lb.dead = true;
  try { if (lb.raf) cancelAnimationFrame(lb.raf); } catch (e) { /* ignore */ }
  try { lb.canvas.removeEventListener('click', lobbyTap); } catch (e) { /* ignore */ }
  try { window.removeEventListener('resize', lobbyResize); } catch (e) { /* ignore */ }
  lb = null;
}

/* ============================ V0.20: DUNGEON SCENES ============================
   The expedition layer between MAP and everything else: the party WALKS INTO
   the node. One room canvas — a shell whose palette is seeded by the FLOOR
   (room-to-room continuity: same walls, same torches, deeper = darker), a
   prop for the node type, dread atmospherics (fog → eyes → red air), and
   the three heroes entering in formation with live status over their heads
   (🩸 wounded, 😨 afraid). Auto-directed: the Master decides, the party
   walks. onArrived fires once when the formation settles — that's when the
   decision buttons belong on screen. */
var dn = null;

/* room shell palettes — continuity within a floor, shift between floors */
var DN_PALS = [
  { wall: '#3a3128', wallD: '#2a231c', wallL: '#4c4136', floor: '#2c2620' },  // earthy stone
  { wall: '#333b44', wallD: '#242b32', wallL: '#46525c', floor: '#232830' },  // cold keep
  { wall: '#333a2e', wallD: '#242a20', wallL: '#47513c', floor: '#232819' }   // mossy deep
];
function dungeonFrame(now) {
  if (!dn || dn.dead) return;
  try {
    if (!dn.canvas.isConnected) { dn.dead = true; return; }
    var ctx = dn.ctx, t = (now - dn.t0) / 1000;
    var dt = Math.min(0.05, (now - (dn.last || now)) / 1000);
    dn.last = now;
    var w = dn.w, h = dn.h, P = dn.pal, S = (typeof IT !== 'undefined' && IT.S) ? IT.S : null;

    ctx.setTransform(dn.dpr, 0, 0, dn.dpr, 0, 0);
    ctx.imageSmoothingEnabled = false;

    /* ---- the room shell (same floor → same bones) ---- */
    var bg = ctx.createLinearGradient(0, 0, 0, h);
    bg.addColorStop(0, '#0a0c10'); bg.addColorStop(1, '#07080c');
    ctx.fillStyle = bg; ctx.fillRect(0, 0, w, h);
    /* back wall — chunky course bands like the tower */
    var wallB = h * 0.62;
    for (var b = 0; b < 5; b++) {
      ctx.fillStyle = (b % 2 === 0) ? P.wall : P.wallD;
      ctx.fillRect(w * 0.06, wallB - 20 - b * 18, w * 0.88, 18);
      ctx.fillStyle = 'rgba(255,255,255,.04)';
      ctx.fillRect(w * 0.06, wallB - 20 - b * 18, w * 0.88, 2);
    }
    ctx.fillStyle = P.wallL;
    ctx.fillRect(w * 0.06, wallB - 110, w * 0.88, 2);
    /* side walls in perspective */
    ctx.fillStyle = P.wallD;
    ctx.beginPath();
    ctx.moveTo(0, 0); ctx.lineTo(w * 0.06, wallB - 110); ctx.lineTo(w * 0.06, h); ctx.lineTo(0, h);
    ctx.closePath(); ctx.fill();
    ctx.beginPath();
    ctx.moveTo(w, 0); ctx.lineTo(w * 0.94, wallB - 110); ctx.lineTo(w * 0.94, h); ctx.lineTo(w, h);
    ctx.closePath(); ctx.fill();
    /* floor */
    var fl = ctx.createLinearGradient(0, wallB - 20, 0, h);
    fl.addColorStop(0, P.floor); fl.addColorStop(1, shade(P.floor, -0.4));
    ctx.fillStyle = fl; ctx.fillRect(w * 0.06, wallB - 20, w * 0.88, h - wallB + 20);
    ctx.strokeStyle = 'rgba(0,0,0,.35)'; ctx.lineWidth = 1;
    for (var fx2 = 0; fx2 < 4; fx2++) {
      var fy2 = wallB - 16 + fx2 * 14;
      ctx.beginPath(); ctx.moveTo(w * 0.10 - fx2 * 6, fy2); ctx.lineTo(w * 0.90 + fx2 * 6, fy2); ctx.stroke();
    }
    /* V0.31: a worn inlay runs from under the party's feet to the door —
       the room itself points at what's next */
    var cx = w / 2;   /* was declared below its first use — inlay never drew */
    ctx.fillStyle = 'rgba(120,124,120,.10)';
    ctx.beginPath();
    ctx.moveTo(cx - 30, wallB - 18);
    ctx.lineTo(cx + 30, wallB - 18);
    ctx.lineTo(cx + 78, h);
    ctx.lineTo(cx - 78, h);
    ctx.closePath(); ctx.fill();
    ctx.strokeStyle = 'rgba(150,150,140,.12)'; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(cx - 30, wallB - 18); ctx.lineTo(cx - 78, h); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(cx + 30, wallB - 18); ctx.lineTo(cx + 78, h); ctx.stroke();

    /* ---- the far end: what KIND of room is this? ---- */
    var cy = wallB - 24;
    if (dn.room === 'corridor' || dn.room === 'combat') {
      /* a deeper dark doorway ahead */
      ctx.fillStyle = '#05070a';
      ctx.fillRect(cx - 26, cy - 54, 52, 54);
      ctx.strokeStyle = P.wallL; ctx.lineWidth = 2;
      ctx.strokeRect(cx - 26, cy - 54, 52, 54);
    }
    if (dn.room === 'boss') {
      ctx.fillStyle = '#05070a';
      ctx.beginPath();
      ctx.moveTo(cx - 40, cy); ctx.lineTo(cx - 40, cy - 50);
      ctx.arc(cx, cy - 50, 40, Math.PI, 0); ctx.lineTo(cx + 40, cy);
      ctx.closePath(); ctx.fill();
      ctx.strokeStyle = '#c99a3f'; ctx.lineWidth = 2; ctx.stroke();
    }
    if (dn.room === 'treasure') {
      /* chunky chest: 3-tone wood, gold bands, rim light */
      R(ctx, cx - 16, cy - 18, 32, 18, '#5a4732');
      R(ctx, cx - 16, cy - 18, 32, 3, '#6b5138');
      R(ctx, cx - 16, cy - 24, 32, 7, '#4a3a28');
      R(ctx, cx - 16, cy - 24, 32, 2, '#6b5138');
      R(ctx, cx - 3, cy - 18, 6, 8, '#c99a3f');
      R(ctx, cx - 3, cy - 18, 2, 3, '#e8c56b');
      R(ctx, cx - 16, cy - 12, 32, 2, '#8a6a44');
    }
    if (dn.room === 'event') {
      /* a leaning shrine stone with a cold gem */
      R(ctx, cx - 10, cy - 26, 20, 26, P.wall);
      R(ctx, cx - 10, cy - 26, 20, 2, P.wallL);
      R(ctx, cx - 2, cy - 18, 5, 5, '#5fd4e0');
      R(ctx, cx - 2, cy - 18, 2, 2, '#bdf3f8');
    }
    if (dn.room === 'rest') {
      /* an unlit firepit waiting for them */
      ctx.fillStyle = '#3a332c';
      for (var ra = 0; ra < 7; ra++) {
        var aang = ra / 7 * 6.283;
        ctx.beginPath();
        ctx.ellipse(cx + Math.cos(aang) * 16, cy + Math.sin(aang) * 5, 4, 3, 0, 0, 6.283);
        ctx.fill();
      }
      R(ctx, cx - 7, cy - 3, 14, 3, '#4a3a28');
    }
    if (dn.room === 'remains') {
      R(ctx, cx - 12, cy - 8, 24, 8, '#5a616b');
      R(ctx, cx - 12, cy - 8, 24, 2, '#7a828c');
      R(ctx, cx - 14, cy, 28, 3, '#39424c');
      R(ctx, cx - 2, cy - 16, 4, 8, '#8b94a7');   // sword planted
      R(ctx, cx - 4, cy - 18, 8, 2, '#c9ccd6');
    }
    /* the sigil over the gate: calm = cold ember, panic = bleeding red */
    var sigC = (dn.dreadTier === 'panic') ? [224, 82, 99] :
               (dn.dreadTier === 'dread') ? [224, 132, 59] : [95, 180, 210];
    var sigA = 0.22 + 0.12 * Math.sin(t * 1.6);
    ctx.strokeStyle = 'rgba(' + sigC[0] + ',' + sigC[1] + ',' + sigC[2] + ',' + sigA.toFixed(2) + ')';
    ctx.lineWidth = 1;
    ctx.beginPath(); ctx.arc(cx, wallB - 86, 9, 0, 6.283); ctx.stroke();
    ctx.beginPath(); ctx.arc(cx, wallB - 86, 4, 0, 6.283); ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(cx - 12, wallB - 86); ctx.lineTo(cx + 12, wallB - 86);
    ctx.moveTo(cx, wallB - 98); ctx.lineTo(cx, wallB - 74);
    ctx.stroke();
    torch(ctx, w * 0.13, wallB - 78, t, 0, dn.dreadTier === 'panic');
    torch(ctx, w * 0.87, wallB - 78, t, 1, dn.dreadTier === 'panic');

    /* ---- dread atmospherics: the Tower's mood ---- */
    var tier = dn.dreadTier;
    if (tier !== 'calm') {
      ctx.fillStyle = tier === 'panic' ? 'rgba(120,20,30,.14)' : 'rgba(90,110,130,.10)';
      ctx.fillRect(0, 0, w, h);
    }
    if (tier === 'uneasy' || tier === 'dread' || tier === 'panic') {
      /* ground fog */
      ctx.fillStyle = 'rgba(140,150,160,.07)';
      for (var fg2 = 0; fg2 < 3; fg2++) {
        var fogX = (w * (0.2 + 0.3 * fg2) + Math.sin(t * 0.4 + fg2) * 30 + w) % w;
        ctx.beginPath();
        ctx.ellipse(fogX, h * 0.78, 80, 12, 0, 0, 6.283);
        ctx.fill();
      }
    }
    if (tier === 'dread' || tier === 'panic') {
      /* eyes in the far doorway */
      var blink = Math.sin(t * 2.2) > -0.3;
      if (blink && dn.room !== 'boss') {
        ctx.fillStyle = '#c23a4a';
        ctx.fillRect(cx - 14, cy - 38, 3, 2); ctx.fillRect(cx + 11, cy - 38, 3, 2);
      }
    }
    /* faint drifting motes — the air itself is present */
    if (Math.random() < 0.05) dn.parts.push({ x: Math.random() * w, y: wallB - 40,
      vx: (Math.random() - 0.5) * 4, vy: -4 - Math.random() * 4,
      life: 1, decay: 0.25, size: 1, color: 'rgba(170,180,190,.16)', soft: true });
    if (tier === 'panic') {
      /* dust sifting from the ceiling */
      if (Math.random() < 0.1) dn.parts.push({ x: Math.random() * w, y: wallB - 110,
        vx: (Math.random() - 0.5) * 6, vy: 12 + Math.random() * 10,
        life: 1, decay: 0.8, size: 1.2, color: 'rgba(160,140,120,.4)', soft: true });
    }

    /* ---- the party walks in ---- */
    var allArrived = true;
    dn.units.forEach(function (u, i) {
      if (u.mode === 'walk') {
        var dx = u.tx - u.x;
        u.x += Math.sign(dx) * 130 * dt;
        if (Math.abs(dx) < 2) { u.x = u.tx; u.mode = 'stand'; }
        else allArrived = false;
      }
      var bob = (u.mode === 'walk') ? Math.sin(t * 9 + i) * 2 : Math.sin(t * 2 + i) * 1.2;
      var spr = u.sprs[(u.mode === 'walk') ? ('idle' + (Math.floor(t * 6 + i) % 2)) : 'idle0'];
      var w0 = spr.w * 3.4, h0 = spr.h * 3.4;
      /* V0.31: contact shadow AT the feet line — soft two-layer, the ground
         holds them instead of them floating over a blob */
      ctx.fillStyle = 'rgba(0,0,0,.16)';
      ctx.beginPath(); ctx.ellipse(u.x, u.y + h0 / 2 + 1, w0 * 0.36, 3.5, 0, 0, 6.283); ctx.fill();
      ctx.fillStyle = 'rgba(0,0,0,.32)';
      ctx.beginPath(); ctx.ellipse(u.x, u.y + h0 / 2 + 1, w0 * 0.22, 2.2, 0, 0, 6.283); ctx.fill();
      ctx.drawImage(spr.c, Math.round(u.x - w0 / 2), Math.round(u.y - h0 / 2 + bob), w0, h0);
      /* names + live condition over their heads */
      ctx.font = '6px ' + PIXEL; ctx.textAlign = 'center';
      ctx.fillStyle = '#d7dce6';
      ctx.fillText(u.name.toUpperCase(), u.x, u.y - 34 + bob);
      if (u.lowHp) { ctx.font = '9px serif'; ctx.fillText('🩸', u.x - 14, u.y - 22 + bob); }
      if (u.afraid) { ctx.font = '9px serif'; ctx.fillText('😨', u.x + 14, u.y - 22 + bob); }
    });

    /* particles */
    for (var pi2 = dn.parts.length - 1; pi2 >= 0; pi2--) {
      var q = dn.parts[pi2];
      q.life -= q.decay * dt;
      if (q.life <= 0) { dn.parts.splice(pi2, 1); continue; }
      q.x += q.vx * dt; q.y += q.vy * dt;
      ctx.globalAlpha = Math.max(0, q.life);
      ctx.fillStyle = q.color;
      ctx.fillRect(Math.round(q.x), Math.round(q.y), 2, 2);
    }
    ctx.globalAlpha = 1;

    /* darkness + light pockets (torch-side + party) */
    if (!dn.lc || dn.lc.width !== dn.canvas.width) {
      dn.lc = document.createElement('canvas');
      dn.lc.width = dn.canvas.width; dn.lc.height = dn.canvas.height;
      dn.lg = dn.lc.getContext('2d');
    }
    var lg = dn.lg;
    if (lg) {
      lg.setTransform(dn.dpr, 0, 0, dn.dpr, 0, 0);
      lg.globalCompositeOperation = 'source-over';
      lg.clearRect(0, 0, w, h);
      lg.fillStyle = 'rgba(2,4,9,.55)';
      lg.fillRect(0, 0, w, h);
      lg.globalCompositeOperation = 'destination-out';
      var lights = [
        [w * 0.13, wallB - 78, 80, 0.9], [w * 0.87, wallB - 78, 80, 0.9],
        [w / 2, h * 0.72, 110, 0.75]
      ];
      for (var li = 0; li < lights.length; li++) {
        var HH = lights[li];
        var hg = lg.createRadialGradient(HH[0], HH[1], 2, HH[0], HH[1], HH[2]);
        hg.addColorStop(0, 'rgba(0,0,0,' + HH[3] + ')');
        hg.addColorStop(1, 'rgba(0,0,0,0)');
        lg.fillStyle = hg;
        lg.beginPath(); lg.arc(HH[0], HH[1], HH[2], 0, 6.283); lg.fill();
      }
      ctx.drawImage(dn.lc, 0, 0, w, h);
    }
    /* vignette */
    var vg = ctx.createRadialGradient(w / 2, h * 0.5, h * 0.36, w / 2, h * 0.5, h * 0.85);
    vg.addColorStop(0, 'rgba(0,0,0,0)'); vg.addColorStop(1, 'rgba(0,0,0,.55)');
    ctx.fillStyle = vg; ctx.fillRect(0, 0, w, h);
    if (dn.fade < 1) {
      dn.fade = Math.min(1, dn.fade + dt * 2);
      ctx.fillStyle = 'rgba(5,6,10,' + (1 - dn.fade).toFixed(3) + ')';
      ctx.fillRect(0, 0, w, h);
    }
    if (allArrived && !dn.arrived) {
      dn.arrived = true;
      if (typeof dn.onArrived === 'function') { try { dn.onArrived(); } catch (e) { /* DOM */ } }
    }
  } catch (e) { /* never kill the expedition over presentation */ }
  if (dn && !dn.dead) dn.raf = requestAnimationFrame(dungeonFrame);
}

function dungeonResize() {
  if (!dn || dn.dead || !dn.canvas.parentElement) return;
  try {
    var root = dn.canvas.parentElement;
    var w = Math.min(430, root.clientWidth || dn.w);
    var ch = root.clientHeight || 0;
    var h = (ch > 0) ? Math.max(160, Math.min(440, ch)) : dn.h;
    if (w === dn.w && h === dn.h) return;
    dn.w = w; dn.h = h;
    dn.dpr = Math.max(1, Math.min(3, (typeof devicePixelRatio === 'number') ? devicePixelRatio : 1));
    dn.canvas.width = Math.round(w * dn.dpr); dn.canvas.height = Math.round(h * dn.dpr);
    dn.canvas.style.height = h + 'px';
    dn.units.forEach(function (u, i) {
      u.tx = w / 2 - 64 + i * 64;
      if (u.mode !== 'walk') u.y = h * 0.74 - i * 6;
    });
  } catch (e) { /* keep last size */ }
}
function dungeonAttach(root, opts) {
  if (!HAS_DOM || !HAS_RAF || !root || !opts) return false;
  try {
    var canvas = document.createElement('canvas');
    if (!canvas.getContext) return false;
    root.innerHTML = '';
    root.appendChild(canvas);
    var w = Math.min(430, root.clientWidth || root.offsetWidth || 430);
    var ch = root.clientHeight || 0;
    /* ponytail: honor the real box height — the old >240 guard forced a 230px
       canvas into a ~120px SE pane, hiding the whole walk-in behind the clip */
    var h = (ch > 0) ? Math.max(160, Math.min(440, ch)) : Math.max(230, Math.min(300, Math.round(w * 0.62)));
    var dpr = Math.max(1, Math.min(3, (typeof devicePixelRatio === 'number') ? devicePixelRatio : 1));
    var rng = mulberry((opts.floor || 1) * 1013 + 7);
    var pal = DN_PALS[Math.floor(rng() * DN_PALS.length)];
    var units = (opts.party || []).slice(0, 3).map(function (hero, i) {
      var mk = { legacy: !!hero.legacy, pact: !!hero.pact, brand: !!hero.branded };
      return {
        name: hero.name,
        sprs: { idle0: makeHeroSprite(hero.cls, hero.id, 'idle0', mk),
                idle1: makeHeroSprite(hero.cls, hero.id, 'idle1', mk) },
        x: -22 - i * 16, y: h * 0.74 - i * 6,
        tx: w / 2 - 64 + i * 64, mode: 'walk',
        lowHp: hero.maxHp ? (hero.hp / hero.maxHp) < 0.4 : false,
        afraid: (hero.fear || 0) > 60
      };
    });
    dn = { canvas: canvas, ctx: canvas.getContext('2d'), units: units, parts: [],
      room: opts.room || 'corridor', pal: pal,
      dreadTier: opts.dreadTier || 'calm',
      t0: performance.now(), last: 0, raf: 0, dpr: dpr, w: w, h: h,
      dead: false, fade: 0, arrived: false,
      onArrived: opts.onArrived, lc: null, lg: null };
    if (!units.length) { dn.arrived = true; }   /* nothing to walk — decide now */
    canvas.width = Math.round(w * dpr); canvas.height = Math.round(h * dpr);
    canvas.style.height = h + 'px';
    window.addEventListener('resize', dungeonResize);
    dn.raf = requestAnimationFrame(dungeonFrame);
    return true;
  } catch (e) { dn = null; return false; }
}
function dungeonDetach() {
  if (!dn) return;
  dn.dead = true;
  try { if (dn.raf) cancelAnimationFrame(dn.raf); } catch (e) { /* ignore */ }
  try { window.removeEventListener('resize', dungeonResize); } catch (e) { /* ignore */ }
  dn = null;
}

return { attach: attach, heroSpriteURL: heroSpriteURL,
         lobbyAttach: lobbyAttach, lobbyDetach: lobbyDetach,
         dungeonAttach: dungeonAttach, dungeonDetach: dungeonDetach };

})();
