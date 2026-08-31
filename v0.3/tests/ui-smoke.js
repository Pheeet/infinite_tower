#!/usr/bin/env node
/* V0.8 AGENT-FEEL-C headless DOM smoke — no dependencies.
   Mini-DOM (regex parser + classList + listeners) good enough for
   core/map/events/combat/ui. Exercises: boot → expedition start →
   floor title card → map scene render → real node-button click fires
   enterNode → treasure / rest / remains scenes with working continue
   buttons → result screen with working Return to Lobby. */
'use strict';
var fs = require('fs'), path = require('path'), vm = require('vm');
var ROOT = '/Users/wutthipatthinluang/Documents/GameWork/infinite_tower/v0.3';

/* ---------------- mini DOM ---------------- */
function El(tag) {
  this.tagName = String(tag).toLowerCase();
  this.children = [];
  this.attrs = {};
  this.parentNode = null;
  this.listeners = {};
  this._cls = '';
  this.style = {};
  this.disabled = false;
  this.type = '';
  this.id = '';
  this.textContent = '';
}
Object.defineProperty(El, 'prototype', { value: El.prototype });
Object.defineProperty(El.prototype, 'className', {
  get: function () { return this._cls; },
  set: function (v) { this._cls = String(v || ''); }
});
Object.defineProperty(El.prototype, 'classList', {
  get: function () {
    var self = this;
    var list = {
      add: function () { for (var i = 0; i < arguments.length; i++) { var c = String(arguments[i]); if (!list.contains(c)) self._cls = (self._cls ? self._cls + ' ' : '') + c; } },
      remove: function () { for (var i = 0; i < arguments.length; i++) { var c = String(arguments[i]); var parts = self._cls.split(/\s+/).filter(function (x) { return x && x !== c; }); self._cls = parts.join(' '); } },
      contains: function (c) { return (' ' + self._cls + ' ').indexOf(' ' + c + ' ') >= 0; }
    };
    return list;
  }
});
El.prototype.setAttribute = function (k, v) { this.attrs[k] = String(v); if (k === 'id') this.id = String(v); if (k === 'class') this._cls = String(v); };
El.prototype.getAttribute = function (k) { return (k in this.attrs) ? this.attrs[k] : null; };
El.prototype.appendChild = function (c) { if (c && c.nodeType === 11) { var fragKids = c.children.slice(); for (var i = 0; i < fragKids.length; i++) this.appendChild(fragKids[i]); return c; } c.parentNode = this; this.children.push(c); return c; };
El.prototype.querySelector = function (sel) { try { return qsa(this, sel)[0] || null; } catch (e) { return null; } };
El.prototype.querySelectorAll = function (sel) { try { return qsa(this, sel); } catch (e) { return []; } };
El.prototype.removeChild = function (c) { var i = this.children.indexOf(c); if (i >= 0) this.children.splice(i, 1); c.parentNode = null; return c; };
El.prototype.addEventListener = function (t, fn) { (this.listeners[t] = this.listeners[t] || []).push(fn); };
El.prototype.fire = function (t) {
  var ls = this.listeners[t] || [];
  for (var i = 0; i < ls.length; i++) ls[i]({ type: t, target: this, preventDefault: function () {} });
  if (typeof this.onclick === 'function') this.onclick({ type: t, target: this, preventDefault: function () {} });
};
function textOf(node) { var out = node.textContent || ''; for (var i = 0; i < node.children.length; i++) out += ' ' + textOf(node.children[i]); return out; }
Object.defineProperty(El.prototype, 'innerText', { get: function () { return textOf(this); } });

var VOID = { br: 1, hr: 1, img: 1, input: 1, line: 1 };
var NODETYPE = { 1: 1, 3: 1, 11: 1 };
Object.defineProperty(El.prototype, 'nodeType', { get: function () { return 1; } });

function parseHtml(parent, html) {
  var stack = [parent];
  var re = /<\/?([-\w:]+)((?:\s+[-\w:]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s">]+))?)*)\s*(\/?)>|([^<]+)/g, m;
  while ((m = re.exec(html)) !== null) {
    if (m[4] !== undefined) { var cur = stack[stack.length - 1]; cur.textContent = (cur.textContent || '') + m[4]; continue; }
    var tag = m[1].toLowerCase(), selfClose = m[3] === '/';
    if (m[0].charAt(1) === '/') { /* closing */
      for (var s = stack.length - 1; s > 0; s--) { if (stack[s].tagName === tag) { stack.length = s; break; } }
      continue;
    }
    var el = new El(tag);
    var are = /([-\w:]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s">]+)))?/g, am;
    while ((am = are.exec(m[2] || '')) !== null) {
      var v = am[2] !== undefined ? am[2] : (am[3] !== undefined ? am[3] : am[4]);
      el.setAttribute(am[1], v === undefined ? '' : v);
    }
    stack[stack.length - 1].appendChild(el);
    if (!selfClose && !VOID[tag]) stack.push(el);
  }
}
function serialize(node) {
  var out = '';
  for (var i = 0; i < node.children.length; i++) {
    var c = node.children[i];
    out += '<' + c.tagName;
    for (var k in c.attrs) out += ' ' + k + '="' + c.attrs[k] + '"';
    if (c._cls && !('class' in c.attrs)) out += ' class="' + c._cls + '"';
    out += '>' + (c.textContent || '') + serialize(c) + '</' + c.tagName + '>';
  }
  return out;
}
Object.defineProperty(El.prototype, 'innerHTML', {
  set: function (h) { this.children = []; this.textContent = ''; this._html = String(h); parseHtml(this, this._html); },
  get: function () { return (this._html !== undefined) ? this._html : serialize(this); }
});
Object.defineProperty(El.prototype, 'outerHTML', { get: function () { return this._html || ''; } });

/* selector engine: 'tag', '.cls', '.a.b', 'tag.cls', 'tag[attr="v"]',
   ':not(.cls)' suffix, one-level descendant 'a b' */
function matches(el, parts) {
  for (var p = 0; p < parts.length; p++) {
    var sel = parts[p];
    var not = null;
    var nm = sel.match(/^(.*?):not\((\.[-\w]+)\)$/);
    if (nm) { sel = nm[1]; not = nm[2].slice(1); }
    var m = sel.match(/^([-\w]+)?((?:\.[-\w]+)*)(#[-\w]+)?(\[[-\w:]+(?:[~^$*|]?="[^"]*")?\])?$/);
    if (!m) return false;
    if (m[1] && el.tagName !== m[1].toLowerCase()) return false;
    if (m[2]) {
      var classes = m[2].split('.').filter(Boolean);
      var have = (' ' + el._cls + ' ');
      for (var i = 0; i < classes.length; i++) if (have.indexOf(' ' + classes[i] + ' ') < 0) return false;
    }
    if (m[3] && (el.attrs.id || el.id) !== m[3].slice(1)) return false;
    if (m[4]) {
      var am = m[4].match(/^\[([-\w:]+)(?:([~^$*|]?)="([^"]*)")?\]$/);
      if (!am) return false;
      if (!am[2]) { if (!(am[1] in el.attrs)) return false; }
      else if (String(el.attrs[am[1]] || '') !== am[3]) return false;
    }
    if (not && (' ' + el._cls + ' ').indexOf(' ' + not + ' ') >= 0) return false;
  }
  return true;
}
function walk(node, fn) { for (var i = 0; i < node.children.length; i++) { fn(node.children[i]); walk(node.children[i], fn); } }
function qsa(root, sel) {
  var chain = sel.trim().split(/\s+/);
  var out = [];
  walk(root, function (el) {
    /* descendant: every earlier part must match some ancestor */
    var ok = matches(el, [chain[chain.length - 1]]);
    if (ok && chain.length > 1) {
      ok = false;
      var a = el.parentNode, ci = chain.length - 2;
      while (a && ci >= 0) { if (matches(a, [chain[ci]])) ci--; a = a.parentNode; }
      if (ci < 0) ok = true;
    }
    if (ok) out.push(el);
  });
  return out;
}

var doc = {
  readyState: 'complete',
  head: new El('head'),
  body: new El('body'),
  documentElement: new El('html'),
  createElement: function (t) { return new El(t); },
  getElementById: function (id) {
    var found = null;
    walk(this.documentElement, function (el) { if (!found && (el.attrs.id === id || el.id === id)) found = el; });
    return found;
  },
  querySelector: function (sel) { try { return qsa(this.documentElement, sel)[0] || null; } catch (e) { return null; } },
  querySelectorAll: function (sel) { try { return qsa(this.documentElement, sel); } catch (e) { return []; } },
  addEventListener: function () {}
};
['hdr', 'nav', 'app', 'toasts', 'overlay'].forEach(function (id) {
  var ids = { hdr: 'header', nav: 'nav', app: 'main', toasts: 'div', overlay: 'div' };
  var el = new El(ids[id]); el.setAttribute('id', id); doc.documentElement.appendChild(el);
});
['h-gold', 'h-permit', 'h-mem'].forEach(function (id) {
  var b = new El('b'); b.setAttribute('id', id); doc.querySelector('#hdr').appendChild(b);
});
var h1 = new El('h1'); h1.innerHTML = 'INFINITE TOWER <span class="ver">v0.7</span>'; doc.querySelector('#hdr').appendChild(h1);
doc.documentElement.appendChild(doc.head); doc.documentElement.appendChild(doc.body);

global.window = global;
global.document = doc;
try { global.navigator = { userAgent: 'smoke' }; } catch (e) { /* node 22 exposes a readonly navigator; modules here never read it */ }
global.localStorage = { _s: {}, getItem: function (k) { return (k in this._s) ? this._s[k] : null; }, setItem: function (k, v) { this._s[k] = String(v); }, removeItem: function (k) { delete this._s[k]; } };
global.matchMedia = function () { return { matches: false }; };

function fireById(id) { var el = doc.getElementById(id); if (!el) throw new Error('missing #' + id); el.fire('click'); return el; }

/* ---------------- boot the game ---------------- */
['js/core.js', 'js/map.js', 'js/events.js', 'js/scene.js', 'js/combat.js', 'js/ui.js'].forEach(function (f) {
  vm.runInThisContext(fs.readFileSync(path.join(ROOT, f), 'utf8'), { filename: f });
});
var IT = global.IT;
var FAIL = [], PASS = 0;
function ok(cond, label) { if (cond) { PASS++; console.log('  ok  ' + label); } else { FAIL.push(label); console.log('  FAIL ' + label); } }

ok(!!IT.S && Array.isArray(IT.S.heroes), 'boot: state loaded (' + (IT.S.heroes.length) + ' heroes)');

/* ---------------- fabricate a party ---------------- */
IT.S.heroes = [
  { id: 101, name: 'Alder', cls: 'Warrior', lvl: 3, rarity: 2, hp: 90, maxHp: 100, atk: 20, def: 8, agi: 6, courage: 80, greed: 20, loyalty: 70, fear: 10, kills: 2, floors: 1, memories: [], items: {}, skills: [] },
  { id: 102, name: 'Brenna', cls: 'Healer', lvl: 3, rarity: 3, hp: 55, maxHp: 70, atk: 8, def: 5, agi: 9, courage: 40, greed: 10, loyalty: 80, fear: 45, kills: 0, floors: 1, memories: [], items: {}, skills: [] },
  { id: 103, name: 'Cael', cls: 'Rogue', lvl: 2, rarity: 2, hp: 48, maxHp: 60, atk: 16, def: 4, agi: 14, courage: 55, greed: 75, loyalty: 30, fear: 30, kills: 1, floors: 1, memories: [], items: {}, skills: [] }
];
IT.S.party = [101, 102, 103];
IT.S.gold = 500;

/* ---------------- expedition start → title card + map scene ---------------- */
var entered = [];
var origEnter = IT.flow.enterNode;
IT.flow.enterNode = function (id) { entered.push(id && id.id ? id.id : id); return origEnter.apply(IT.flow, arguments); };

IT.flow.startExpedition(1);
var ex = IT.S.expedition;
ok(!!ex && ex.floor === 1, 'expedition started on floor 1');

var card = doc.getElementById('floor-titlecard');
ok(!!card, 'floor title card appears on arrival');
ok(!!card && /FLOOR 1/.test(card.innerText), 'title card reads FLOOR 1');
ok(!!card && card.classList.contains('titlecard'), 'title card rides the shared .titlecard system');

var mapbox = doc.getElementById('map-box');
ok(!!mapbox && qsa(mapbox, '.mapnode').length > 0, 'map renders nodes under #map-box (' + qsa(mapbox, '.mapnode').length + ' nodes)');
ok(!!doc.querySelector('.climb-frame'), 'map framed in .climb-frame (torchlit climb)');
ok(!!doc.querySelector('.map-flavor'), 'flavor line under the map');
ok(/Something waits ahead\.|The path splits here\.|The way opens\.|The stair is close\./.test(doc.querySelector('.map-flavor').innerText), 'flavor line is one of the scene states');
var march = doc.getElementById('march-strip');
ok(!!march && qsa(march, '.hero-sprite').length === 3, 'marching strip shows 3 hero sprites');
ok(qsa(march, '.march-hp').length === 3, 'each marcher has an HP sliver');
ok(!!doc.getElementById('m-scout') && !doc.getElementById('m-scout').disabled, 'scout button present + enabled');
ok(!!doc.getElementById('m-abandon'), 'abandon button present');
ok(/SECURED/.test(doc.querySelector('.exp-tally').innerText) && /UNBANKED/.test(doc.querySelector('.exp-tally').innerText), 'tally line shows SECURED/UNBANKED (V0.10)');

/* title card removes itself after the fade */
setTimeout(function () {
  ok(!doc.getElementById('floor-titlecard'), 'title card removes itself after the beat');

  /* ---------------- click the start node (real map button → enterNode) ---------------- */
  var startBtn = qsa(mapbox, '.mapnode').filter(function (b) { return b.getAttribute('data-id') === ex.map.startId; })[0];
  ok(!!startBtn && !startBtn.disabled, 'start node button enabled');
  startBtn.fire('click');
  ok(entered.indexOf(ex.map.startId) >= 0, 'node click fired IT.flow.enterNode');
  ok(!!ex.map.nodes.filter(function (n) { return n.id === ex.map.startId; })[0].cleared, 'start node cleared → map re-rendered');

  /* ---------------- treasure scene via a real frontier click ---------------- */
  var reach = IT.map.reachable(ex.map);
  var tn = ex.map.nodes.filter(function (n) { return reach.indexOf(n.id) >= 0; })[0];
  tn.type = 'treasure'; tn.scouted = true;
  IT.ui.go('map');
  var tbtn = qsa(doc.getElementById('map-box'), '.mapnode').filter(function (b) { return b.getAttribute('data-id') === tn.id; })[0];
  ok(!!tbtn && !tbtn.disabled, 'treasure node button enabled');
  var goldBefore = IT.S.expedition.tally.gold || 0;
  tbtn.fire('click');
  ok(!!doc.querySelector('.node-scene.treasure-scene'), 'treasure renders as a scene');
  ok(!!doc.querySelector('.node-icon') && /💰/.test(doc.querySelector('.node-icon').innerText), 'treasure big-icon moment');
  ok(!!doc.querySelector('.node-prose'), 'treasure flavor prose present');
  ok(!!doc.getElementById('t-take'), 'treasure continue button present');
  var trow = IT.S.expedition.tally.gold;
  fireById('t-take');
  ok((IT.S.expedition.tally.gold || 0) > goldBefore, 't-take applies gold effect (tally ' + goldBefore + '→' + (IT.S.expedition.tally.gold || 0) + ')');
  ok(tn.cleared, 'treasure node completed');
  ok(!!doc.getElementById('map-box'), 'back on the map after treasure');

  /* ---------------- rest scene ---------------- */
  reach = IT.map.reachable(ex.map);
  var rn = ex.map.nodes.filter(function (n) { return reach.indexOf(n.id) >= 0; })[0];
  rn.type = 'rest'; rn.scouted = true;
  var hurt = IT.S.heroes.filter(function (h) { return h.id === 102; })[0];
  var hpBefore = hurt.hp;
  IT.ui.go('map');
  var rbtn = qsa(doc.getElementById('map-box'), '.mapnode').filter(function (b) { return b.getAttribute('data-id') === rn.id; })[0];
  rbtn.fire('click');
  ok(!!doc.querySelector('.node-scene.rest-scene'), 'rest renders as a scene');
  ok(/🔥/.test(doc.querySelector('.node-icon').innerText), 'rest big-icon moment (campfire)');
  ok(hurt.hp > hpBefore, 'rest heal applied at render (' + hpBefore + '→' + hurt.hp + ')');
  ok(!!doc.getElementById('r-go'), 'rest continue button present');
  fireById('r-go');
  ok(rn.cleared, 'rest node completed');

  /* ---------------- remains scene (take / bury) ---------------- */
  IT.S.remains[1] = [{ heroName: 'Doran', cls: 'Tank', lvl: 4, floor: 1, epitaph: 'He held the line past its end.', items: [{ id: 'it9', name: 'Dented Bulwark', slot: 'armor', def: 4 }] }];
  reach = IT.map.reachable(ex.map);
  var mn = ex.map.nodes.filter(function (n) { return reach.indexOf(n.id) >= 0; })[0];
  mn.type = 'remains'; mn.scouted = true;
  IT.ui.go('map');
  var mbtn = qsa(doc.getElementById('map-box'), '.mapnode').filter(function (b) { return b.getAttribute('data-id') === mn.id; })[0];
  mbtn.fire('click');
  ok(!!doc.querySelector('.node-scene.remains-scene'), 'remains renders as a scene');
  ok(/Doran/.test(doc.querySelector('.node-name').innerText), 'remains names the fallen');
  ok(/He held the line past its end\./.test(doc.querySelector('.node-quote.big').innerText), 'remains epitaph quote prominent');
  ok(!!doc.getElementById('rm-take') && !!doc.getElementById('rm-bury'), 'remains keeps both choice buttons');
  var invBefore = IT.S.inventory.length;
  fireById('rm-take');
  ok(IT.S.inventory.length === invBefore + 1, 'rm-take moves gear to the pack');
  ok(mn.cleared, 'remains node completed');

  /* ---------------- scout button still works ---------------- */
  var g1 = IT.S.gold;
  fireById('m-scout');
  ok(IT.S.gold < g1, 'scout button spends gold (' + g1 + '→' + IT.S.gold + ')');
  ok(!!doc.getElementById('map-box'), 'map re-rendered after scout');

  /* ---------------- event container (events.js internals untouched) ---------------- */
  reach = IT.map.reachable(ex.map);
  var en = ex.map.nodes.filter(function (n) { return reach.indexOf(n.id) >= 0; })[0];
  en.type = 'event'; en.scouted = true;
  IT.ui.go('map');
  qsa(doc.getElementById('map-box'), '.mapnode').filter(function (b) { return b.getAttribute('data-id') === en.id; })[0].fire('click');
  ok(!!doc.querySelector('.event-scene'), 'event screen renders as a scene');
  ok(!!doc.getElementById('event-box'), 'event container #event-box present');
  ok(/SOMETHING HAPPENS/.test(doc.querySelector('.event-scene .exp-kicker').innerText), 'event kicker present (inside the scene pane)');
  var evbox = doc.getElementById('event-box');
  var opt = qsa(evbox, '.ev-opt')[0];
  ok(!!opt, 'event option buttons rendered by events.js');
  opt.fire('click');
  /* drive events.js beat pacing (900ms timers): hero pick → verdict → continue */
  var rounds = 0;
  (function drive() {
    if (rounds++ > 6) { ok(false, 'event flow completed'); return final(); }
    var hero = qsa(evbox, '.ev-hero')[0];
    if (hero) { hero.fire('click'); return setTimeout(drive, 1100); }
    var cont = qsa(evbox, '.ev-continue')[0];
    if (cont) {
      cont.fire('click');
      ok(en.cleared || !!doc.getElementById('map-box'), 'event Continue returns to the map');
      return final();
    }
    setTimeout(drive, 1100);
  })();

  function final() {
    /* ---------------- result scene + variants ---------------- */
    IT.flow.finishExpedition(true);
    var rtc = doc.querySelector('.res-titlecard');
    ok(!!rtc, 'result title card present');
    ok(/FLOOR CLEARED/.test(rtc.innerText), 'result title reads FLOOR CLEARED');
    ok(!!doc.querySelector('.res-ledger'), 'ledger renders as parchment rows');
    ok(/Gold recovered/.test(doc.querySelector('.res-ledger').innerText), 'ledger row: gold recovered');
    ok(!!doc.getElementById('r-back'), 'result continue button present');
    var titleBeat = doc.getElementById('result-titlecard');
    ok(!!titleBeat && /FLOOR CLEARED/.test(titleBeat.innerText), 'result full-bleed title-card beat fires');
    fireById('r-back');
    ok(doc.getElementById('app').children.length > 0 && !doc.querySelector('.exp-scene'), 'r-back returns to the lobby');

    /* variants */
    IT.ui.go('result', { win: false, wiped: true, floor: 7, lootGold: 30, deaths: [{ name: 'Alder', cls: 'Warrior', lvl: 3, floor: 6, killer: 'Floor 6 denizens', epitaph: 'He went up. He did not come down.' }] });
    ok(/THE PARTY IS LOST/.test(doc.querySelector('.res-titlecard').innerText), 'wiped variant: THE PARTY IS LOST');
    ok(/He went up\. He did not come down\./.test(doc.querySelector('.rd-epi').innerText), 'death epitaph quote prominent in ledger');

    IT.ui.go('result', { win: true, wonWall: true, blind: true, floor: 10 });
    ok(/THE WALL BREAKS/.test(doc.querySelector('.res-titlecard').innerText), 'wall variant: THE WALL BREAKS');
    ok(/beaten blind/.test(doc.querySelector('.rtc-sub').innerText), 'wall variant keeps the blind note');

    IT.ui.go('result', { win: false, wiped: false, floor: 3, skillUsage: [['fireball', 4], ['heal', 2], ['strike', 7], ['guard', 1]] });
    ok(/WITHDRAWN/.test(doc.querySelector('.res-titlecard').innerText), 'withdraw variant: WITHDRAWN');
    ok(/The party leaned on/.test(doc.querySelector('.res-ledger').innerText), 'telemetry top-3 skills line kept');

    console.log('\n' + (FAIL.length ? 'SMOKE FAILED: ' + FAIL.length : 'SMOKE PASSED: ' + PASS) + (FAIL.length ? '\n  ' + FAIL.join('\n  ') : ''));
    process.exit(FAIL.length ? 1 : 0);
  }
}, 1300);
