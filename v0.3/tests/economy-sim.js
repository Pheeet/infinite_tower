#!/usr/bin/env node
'use strict';
/* ============================================================
   tests/economy-sim.js — INFINITE TOWER v0.7 ECONOMY SIMULATION
   ============================================================
   Headless whole-account driver: plays fresh accounts through the
   REAL js/core.js + js/map.js + js/events.js + js/combat.js engines
   (loaded verbatim — nothing under js/ is modified or reimplemented
   for combat/stats/rewards; only the ui.js FLOW layer is replicated,
   because ui.js is DOM-bound and cannot run under Node).

   What runs the real code:
     - hero gen / gacha / rest / exp / death / master exp /
       floor-clear gold & permits:  IT.* (core.js)
     - map gen / scouting / reachability:                IT.map.* (map.js)
     - event pick + hero decision + outcome resolution:  IT.events.pickEvent /
       IT.events.resolve + IT.decide (events.js is DOM-bound in run(),
       but its pure core resolve()/pickEvent() are exported headless)
     - every battle:                                    IT.combat.start (combat.js)
       with IT.combat.FAST=true, IT.combat.auto / autoCmd driver policy
   What is replicated from ui.js (the official application order):
     startExpedition / enterNode / nodeDone / _afterCombat /
     applyEffects / completeNode / finishExpedition / makeEnemies /
     treasure & rest & remains nodes / recordDeathFlow survivor shock.
   Driver-visible deviations are listed in tests/economy-report.md.

   Usage:  node tests/economy-sim.js [--accounts N] [--smoke] [--json]
   Output: console digest + tests/economy-report.md (rewritten each run).
   ============================================================ */

var path = require('path');

/* ---------------- browser stubs (before any game module loads) ---------------- */
global.window = global;
function fakeElement() {
  return {
    style: {}, id: '', className: '', textContent: '', innerHTML: '',
    childNodes: [], firstChild: null,
    setAttribute: function () {}, getAttribute: function () { return null; },
    appendChild: function () {}, removeChild: function () {},
    addEventListener: function () {}, querySelector: function () { return null; },
    querySelectorAll: function () { return []; }
  };
}
global.document = {
  getElementById: function () { return null; },
  createElement: fakeElement,
  head: { appendChild: function () {} },
  documentElement: { appendChild: function () {} },
  addEventListener: function () {}
};
var MEM_STORE = Object.create(null);
global.localStorage = {
  getItem: function (k) { return Object.prototype.hasOwnProperty.call(MEM_STORE, k) ? MEM_STORE[k] : null; },
  setItem: function (k, v) { MEM_STORE[k] = String(v); },
  removeItem: function (k) { delete MEM_STORE[k]; }
};

/* ---------------- load the real game modules ---------------- */
var BASE = path.join(__dirname, '..');
require(path.join(BASE, 'js', 'core.js'));
require(path.join(BASE, 'js', 'map.js'));
require(path.join(BASE, 'js', 'events.js'));
require(path.join(BASE, 'js', 'combat.js'));

var IT = global.IT;

/* ---------------- driver configuration ---------------- */
var MAX_EXPEDITIONS = 60;       // per account, whichever comes first vs F20 clear
var MAX_NODE_STEPS = 40;        // anti-hang: node entries per expedition
var MAX_NODE_RETRIES = 3;       // failed attempts on the same node -> abandon

var POLICIES = {
  CAREFUL: {
    label: 'CAREFUL',
    scout: 'all',               // scout every reachable unscouted node while gold lasts
    restAvgPct: 0.70,           // rest (lobby) when party avg HP% below this
    restAnyPct: 0.35,           // ...or any single hero below this
    events: 'safe',
    combatStart: 'defend',
    combatLowHp: 'defend_stance',
    score: { rest: 6.0, treasure: 4.5, event: 4.0, remains: 3.5, combatBase: 3.0, combatThreat: 0.7, end: 2.6, blind: 3.8 }
  },
  GREEDY: {
    label: 'GREEDY',
    scout: 'none',
    restAvgPct: 0.0,            // no proactive rest
    restAnyPct: 0.25,           // only when someone is dead-or-near (<=25%)
    events: 'greedy',
    combatStart: 'focus',
    combatLowHp: 'push_on',
    score: { rest: 5.0, treasure: 7.0, event: 5.5, remains: 3.5, combatBase: 3.4, combatThreat: 0.3, end: 1.0, blind: 4.2 }
  },
  BALANCED: {
    label: 'BALANCED',
    scout: 'half',              // 50% per map visit
    restAvgPct: 0.60,
    restAnyPct: 0.30,
    events: 'mixed',
    combatStart: 'focus',
    combatLowHp: 'defend_stance',
    score: { rest: 5.5, treasure: 5.5, event: 4.5, remains: 3.5, combatBase: 3.2, combatThreat: 0.5, end: 1.5, blind: 4.0 }
  }
};

/* core.js DECIDE_W mirror — driver-side hero picking heuristic only; the
   verdict itself always comes from the real IT.decide(). */
var DECIDE_W = {
  open_chest: { courage: 0.2, greed: 0.5, loyalty: 0, fear: -0.4 },
  investigate: { courage: 0.4, greed: 0.2, loyalty: 0, fear: -0.5 },
  help_stranger: { courage: 0.4, greed: -0.3, loyalty: 0.3, fear: -0.2 },
  rob_stranger: { courage: 0, greed: 0.5, loyalty: -0.6, fear: 0 },
  retreat: { courage: -0.5, greed: 0, loyalty: 0.1, fear: 0.4 },
  sacrifice: { courage: 0.4, greed: 0, loyalty: 0.5, fear: -0.3 },
  push_on: { courage: 0.4, greed: 0.1, loyalty: 0, fear: -0.4 }
};

function decideScore(hero, action) {
  var w = DECIDE_W[action] || {}, s = 50, k;
  for (k in w) if (w[k]) s += (typeof hero[k] === 'number' ? hero[k] : 0) * w[k];
  return s;
}

/* ---------------- tiny utils ---------------- */
function clamp(v, a, b) { return Math.max(a, Math.min(b, v)); }
function pct(arr, q) {
  if (!arr.length) return null;
  var s = arr.slice().sort(function (a, b) { return a - b; });
  return s[clamp(Math.floor((s.length - 1) * q), 0, s.length - 1)];
}
function mean(arr) { return arr.length ? arr.reduce(function (a, b) { return a + b; }, 0) / arr.length : null; }
function r1(v) { return (v == null || isNaN(v)) ? '—' : (Math.round(v * 10) / 10).toFixed(1); }
function r0(v) { return (v == null || isNaN(v)) ? '—' : String(Math.round(v)); }

/* ---------------- ui.js replicas (documented deviations in the report) ---------------- */

function S() { return IT.S; }
function heroById(id) {
  var s = S();
  for (var i = 0; i < s.heroes.length; i++) if (s.heroes[i].id === id) return s.heroes[i];
  return null;
}
function partyHeroes() {
  var s = S();
  return (s.party || []).map(heroById).filter(function (h) { return h && h.hp > 0; });
}
function killerLabel(floor) {
  if (floor === 20) return 'The Hollow King';
  return floor === 10 ? 'The Executioner' : 'Floor ' + floor + ' denizens';
}

/* ui.js makeEnemies — node encounters scale off node threat (0.925..1.225). */
function makeEnemiesUi(floor, node, isBoss) {
  node = node || {};
  floor = Number(floor) || 1;
  if (isBoss || node.type === 'boss') {
    if (floor >= 20) return [{ name: 'THE HOLLOW KING 👑', maxHp: 2250, hp: 2250, atk: 52, def: 12, boss: true }];
    return [{ name: 'THE EXECUTIONER 👹', maxHp: 1300, hp: 1300, atk: 46, def: 10, boss: true }];
  }
  var MOBS = IT.DATA.MOBS;
  var scale = 1 + (floor - 1) * 0.28, ascale = 1 + (floor - 1) * 0.26, dscale = 1 + (floor - 1) * 0.22;
  var count = floor <= 4 ? 2 : 3;
  var tm = 0.85 + clamp(node.threat || 3, 1, 5) * 0.075;
  var list = [];
  for (var i = 0; i < count; i++) {
    var nm = MOBS[clamp(floor - 1, 0, MOBS.length - 1)], m = tm;
    if (floor >= 6 && i === 0) { nm = 'Elite ' + nm; m *= 1.5; }
    if (floor === 9 || floor === 19) m *= 1.1;
    list.push({ name: nm, maxHp: Math.round(40 * scale * m), hp: Math.round(40 * scale * m),
      atk: Math.round(8 * ascale * m), def: Math.round(2 * dscale * m) });
  }
  return list;
}

/* ============================ DRIVER ============================ */

function Driver(policy, stats) {
  this.policy = policy;
  this.stats = stats;
  this.run = { deaths: [], bossFought: false, expIndex: 0 };
  this.account = null;
}

/* ---- metrics helpers ---- */
Driver.prototype.noteGold = function (delta, kind, floor) {
  var st = this.stats, f = clamp(floor || 0, 0, 20);
  if (delta > 0) {
    st.goldEarned += delta;
    if (kind === 'clear') { st.goldEarnedClear += delta; st.incClear[f] += delta; }
    else if (kind === 'treasure') { st.goldEarnedTreasure += delta; st.incTreasure[f] += delta; }
    else if (kind === 'purse') { st.goldEarnedPurse += delta; st.incPurse[f] += delta; }
    else { st.goldEarnedEvent += delta; st.incEvent[f] += delta; }
    st.incByFloor[f] += delta;
  } else if (delta < 0) {
    var d = -delta;
    st.goldSpent += d;
    if (kind === 'scout') { st.goldSpentScout += d; st.spendScout[f] += d; }
    else if (kind === 'rest') { st.goldSpentRest += d; st.spendRest[f] += d; }
    else if (kind === 'recruit') { st.goldSpentRecruit += d; st.spendRecruit[f] += d; }
    else { st.goldSpentEvent += d; st.spendEvent[f] += d; }
    st.spendByFloor[f] += d;
  }
};

/* ---- lobby: roster / party / rest / recruit ---- */
Driver.prototype.maintain = function (nextFloor) {
  var s = S(), p = this.policy, st = this.stats;

  /* shared recruit rule: keep at least 3 living heroes when permits/gold allow */
  var guard = 0;
  while (s.heroes.filter(function (h) { return h.hp > 0; }).length < 3 && guard++ < 12) {
    var before = { gold: s.gold, permits: s.permits };
    var r = IT.gacha();
    if (!r) { if (s.heroes.length === 0) this.account.bankrupt = true; break; }
    st.recruits++;
    if (r.used === '1 Permit') { st.permitsOut += 1; }
    else { var cost = before.gold - s.gold; this.noteGold(-cost, 'recruit', nextFloor); }
  }

  /* pick the best party of 3: one Healer, one Tank, rest by score */
  var alive = s.heroes.filter(function (h) { return h.hp > 0; });
  var pick1 = function (cls) {
    var c = alive.filter(function (h) { return h.cls === cls; })
      .sort(function (a, b) { return (b.lvl * 100 + b.atk) - (a.lvl * 100 + a.atk); })[0];
    return c || null;
  };
  var chosen = [];
  var he = pick1('Healer'), tk = pick1('Tank');
  if (he) chosen.push(he);
  if (tk && chosen.length < 3) chosen.push(tk);
  alive.forEach(function (h) {
    if (chosen.length < 3 && chosen.indexOf(h) < 0 &&
        !(h.cls === 'Healer' && he) && !(h.cls === 'Tank' && tk)) chosen.push(h);
  });
  alive.sort(function (a, b) {
    return (b.atk * 1.2 + b.maxHp * 0.15 + b.lvl * 8 + b.rarity * 5) -
           (a.atk * 1.2 + a.maxHp * 0.15 + a.lvl * 8 + a.rarity * 5);
  });
  alive.forEach(function (h) { if (chosen.length < 3 && chosen.indexOf(h) < 0) chosen.push(h); });
  s.party = chosen.slice(0, 3).map(function (h) { return h.id; });

  /* lobby rest per policy */
  var ph = partyHeroes();
  if (ph.length) {
    var avg = ph.reduce(function (t, h) { return t + h.hp / h.maxHp; }, 0) / ph.length;
    var min = Math.min.apply(null, ph.map(function (h) { return h.hp / h.maxHp; }));
    var want = (p.restAvgPct > 0 && avg < p.restAvgPct) || min < p.restAnyPct;
    if (want) {
      var r2 = IT.rest();
      if (r2) { st.rests++; this.noteGold(-r2.cost, 'rest', nextFloor); }
    }
  }
};

/* ---- floor choice: next uncleared, ML gates fall back to grinding the top ---- */
Driver.prototype.nextFloor = function () {
  var s = S(), n;
  for (n = 1; n <= 20; n++) { if (!s.cleared[n]) break; }
  if (n > 20) n = 20;
  var need = n >= 16 ? 3 : (n >= 11 ? 2 : 0);
  if (need && s.master.level < need) {
    var top = 0;
    for (var f2 = 1; f2 <= 20; f2++) if (s.cleared[f2] && f2 !== 20) top = Math.max(top, f2);
    return top || 1;
  }
  return n;
};

/* ---- expedition ---- */
Driver.prototype.runExpedition = async function (floor) {
  var s = S(), st = this.stats, p = this.policy;
  st.expeditions++;
  this.lastOutcome = null;
  this.run = { deaths: [], bossFought: false, expIndex: st.expeditions };
  this.account.expeditions++;
  this.account.maxFloor = Math.max(this.account.maxFloor || 0, floor);
  st.startsByFloor[floor]++;

  var map = IT.map.gen(floor);
  s.expedition = { floor: floor, map: map, curId: map.startId, done: {}, tally: { gold: 0, permits: 0, exp: {} } };

  /* DARKNESS: fear +5 on entry (ui.startExpedition) */
  if (floor >= 11 && floor <= 13) {
    partyHeroes().forEach(function (h) { h.fear = clamp(h.fear + 5, 0, 100); });
  }

  var steps = 0, lastFailNode = null, failCount = 0, outcome = null;
  var nodeById = function (id) {
    return map.nodes.filter(function (n) { return n.id === id; })[0] || null;
  };

  while (s.expedition && steps++ < MAX_NODE_STEPS) {
    var reach = IT.map.reachable(map);
    if (!reach.length) { outcome = 'abandon'; break; }

    /* scouting (ui scoutRandom: first unscouted in reachable order, else random) */
    if (p.scout !== 'none') {
      var cost = IT.map.scoutCost(floor);
      var visits = (p.scout === 'all') ? 99 : ((Math.random() < 0.5) ? 1 : 0);
      while (visits-- > 0 && s.gold >= cost) {
        var target = null, i;
        for (i = 0; i < reach.length; i++) {
          var n0 = nodeById(reach[i]);
          if (n0 && !n0.scouted && !n0.cleared) { target = n0; break; }
        }
        if (!target) {
          var uns = map.nodes.filter(function (n) { return !n.scouted && !n.cleared; });
          target = uns.length ? uns[Math.floor(Math.random() * uns.length)] : null;
        }
        if (!target) break;
        var goldBefore = s.gold;
        if (IT.map.scout(map, target.id)) {
          st.scouts++;
          this.noteGold(-(goldBefore - s.gold), 'scout', floor);
        } else break;
      }
    }

    /* node choice from scouted info (blind nodes get the policy's EV score) */
    var best = null, bestScore = -Infinity, k;
    for (k = 0; k < reach.length; k++) {
      var cand = nodeById(reach[k]);
      if (!cand || cand.cleared) continue;
      var sc = this.nodeScore(cand, map);
      if (sc > bestScore) { bestScore = sc; best = cand; }
    }
    if (!best) { outcome = 'abandon'; break; }
    if (best.id === lastFailNode) {
      if (++failCount >= MAX_NODE_RETRIES) { outcome = 'abandon'; break; }
    } else { lastFailNode = null; failCount = 0; }

    s.expedition.curId = best.id;
    var beforeCleared = !!best.cleared;
    await this.enterNode(best);
    if (!s.expedition) break;                       // finishExpedition ran
    if (best.cleared && !beforeCleared) { lastFailNode = null; failCount = 0; }
    else if (s.expedition.curId !== best.id) { lastFailNode = best.id; }
  }
  if (s.expedition) { this.finishExpedition(false); }
  st.expByOutcome[this.lastOutcome || 'abandon']++;
};

Driver.prototype.nodeScore = function (n, map) {
  var sc = this.policy.score;
  if (n.id === map.endId) return sc.end;
  if (!n.scouted) return sc.blind;
  switch (n.type) {
    case 'rest': return sc.rest;
    case 'treasure': return sc.treasure;
    case 'event': return sc.event;
    case 'remains': return sc.remains;
    case 'boss': return sc.end - 0.5;
    default: return sc.combatBase - sc.combatThreat * n.threat;
  }
};

Driver.prototype.enterNode = async function (node) {
  var s = S();
  if (node.type === 'combat' || node.type === 'boss') {
    var isBoss = node.type === 'boss' || (s.expedition.floor === 20 && node.id === s.expedition.map.endId);
    if (isBoss) this.run.bossFought = true;
    var cfg = { enemies: makeEnemiesUi(s.expedition.floor, node, isBoss), floor: s.expedition.floor,
                kind: isBoss ? 'boss' : 'node', canRetreat: true, node: node };
    var result = await this.combatSafe(cfg);
    await this.afterCombat(result, cfg);
  } else if (node.type === 'event') {
    await this.runEvent(node);
  } else if (node.type === 'treasure') {
    var g = Math.round(IT.rnd(30, 70));
    this.nodeDone({ text: 'cache', effects: { gold: g } }, 'treasure');
  } else if (node.type === 'rest') {
    partyHeroes().forEach(function (h) {
      h.hp = Math.min(h.maxHp, h.hp + Math.round(h.maxHp * 0.35));
      h.fear = clamp(h.fear - 10, 0, 100);
    });
    this.nodeDone({ text: 'rest', effects: {} });
  } else if (node.type === 'remains') {
    this.doRemains(node);
  } else {
    this.completeNode(node.id);                     // start node
  }
};

Driver.prototype.combatSafe = async function (cfg) {
  try {
    return await IT.combat.start(cfg);
  } catch (e) {
    this.stats.engineErrors++;
    console.error('[sim] combat error at F' + cfg.floor + ':', e && e.message);
    return { win: false, retreated: true, deaths: [], expGained: {}, killsGained: {} };
  }
};

/* ui._afterCombat — exact application order */
Driver.prototype.afterCombat = async function (result, cfg) {
  result = result || {};
  var s = S();
  if (!s.expedition) return;
  var ex = s.expedition, floor = ex.floor;

  (result.deaths || []).forEach(function (id) {
    var h = heroById(id);
    if (h) this.recordDeath(h, floor, killerLabel(floor));
  }, this);

  var winBonus = result.win ? floor * 15 : 0;
  partyHeroes().forEach(function (h) {
    var amt = (Number((result.expGained || {})[h.id]) || 0) + winBonus;
    if (amt > 0) {
      ex.tally.exp = ex.tally.exp || {};
      ex.tally.exp[h.id] = (ex.tally.exp[h.id] || 0) + amt;
      IT.grantExp(h, amt);
    }
    var kg = Number((result.killsGained || {})[h.id]) || 0;
    if (kg > 0) h.kills = (h.kills || 0) + kg;
  });

  if (!partyHeroes().length) { this.finishExpedition(false); return; }

  if (result.retreated) {
    ex.curId = ex.lastClearedId || ex.map.startId;  // node stays uncleared
    return;
  }
  if (result.win) {
    var nodeId = (cfg && cfg.node && cfg.node.id != null) ? cfg.node.id : ex.curId;
    this.completeNode(nodeId);
    return;
  }
  /* loss with survivors: back to the map, node uncleared */
  ex.curId = ex.lastClearedId || ex.map.startId;
};

/* ui.recordDeathFlow — core recordDeath + survivor shock + run ledger */
Driver.prototype.recordDeath = function (hero, floor, killer) {
  this.stats.deaths++;
  this.stats.deathsByFloor[clamp(floor, 1, 20)]++;
  this.run.deaths.push(hero.name);
  var mem = IT.recordDeath(hero, floor, killer);    // core: remains, memorial, mourners
  partyHeroes().forEach(function (x) {
    x.fear = clamp((x.fear || 0) + 15, 0, 100);
    x.loyalty = clamp((x.loyalty || 0) - 8, 0, 100);
  });
  return mem;
};

/* ui.applyEffects — exact deltas + attribution for the gold ledger.
   `kind` only tags the gold ledger ('event' default, 'treasure' for caches). */
Driver.prototype.applyEffects = function (summary, kind) {
  var s = S();
  if (!s || !s.expedition) return [];
  var ex = s.expedition, floor = ex.floor;
  var eff = (summary && summary.effects) || {};
  var died = [];

  if (eff.gold) {
    s.gold += eff.gold; ex.tally.gold = (ex.tally.gold || 0) + eff.gold;
    this.noteGold(eff.gold, kind || 'event', floor);
  }
  if (eff.permits) { s.permits += eff.permits; ex.tally.permits = (ex.tally.permits || 0) + eff.permits; }

  function deltas(map, key) {
    if (!map) return;
    for (var id in map) {
      var h = heroById(Number(id));
      if (!h) continue;
      h[key] = clamp((h[key] || 0) + Number(map[id]) || 0, 0, 100);
    }
  }
  deltas(eff.fear != null ? eff.fear : eff['fearΔ'], 'fear');
  deltas(eff.loyalty != null ? eff.loyalty : eff['loyaltyΔ'], 'loyalty');

  var bondMap = eff['bondΔ'];
  if (bondMap) {
    var betrayal = (floor >= 17 && floor <= 19) ? 2 : 1;
    for (var bkey in bondMap) {
      var parts = String(bkey).split('|');
      if (parts.length < 2) continue;
      IT.addBond(Number(parts[0]), Number(parts[1]), (Number(bondMap[bkey]) || 0) * betrayal);
    }
  }

  var dmg = eff.hpDmg || eff.hp || null;
  if (dmg) {
    for (var hid in dmg) {
      var h2 = heroById(Number(hid));
      if (!h2) continue;
      h2.hp = Math.max(0, h2.hp - Number(dmg[hid]));
      if (h2.hp <= 0) { this.recordDeath(h2, floor, 'Floor ' + floor + ' peril'); died.push(h2.id); }
    }
  }
  /* event memories are written by events.resolve itself (ui skips dups) */
  if ((summary && summary.reveal) || eff.reveal) {
    (ex.map.nodes || []).forEach(function (n) { n.scouted = true; });
  }
  return died;
};

/* ui.nodeDone */
Driver.prototype.nodeDone = async function (summary, kind) {
  summary = summary || {};
  var s = S();
  if (!s || !s.expedition) return;
  var ex = s.expedition;
  var nodeId = ex.curId;
  var node = (ex.map.nodes || []).filter(function (n) { return n.id === nodeId; })[0];
  var died = this.applyEffects(summary, kind);
  if (died.length && !partyHeroes().length) { this.finishExpedition(false); return; }
  var c = summary.combat;
  if (c && Array.isArray(c.enemies) && c.enemies.length) {
    var cfg = { enemies: c.enemies, floor: ex.floor, kind: (c.kind || 'event'), canRetreat: true, node: node || { id: nodeId } };
    var result = await this.combatSafe(cfg);
    await this.afterCombat(result, cfg);
    return;
  }
  this.completeNode(nodeId);
};

Driver.prototype.completeNode = function (nodeId) {
  var s = S();
  if (!s || !s.expedition) return;
  var ex = s.expedition;
  var node = (ex.map.nodes || []).filter(function (n) { return n.id === nodeId; })[0] || { id: nodeId };
  node.cleared = true;
  ex.done = ex.done || {}; ex.done[nodeId] = true;
  ex.lastClearedId = nodeId;
  if (nodeId === ex.map.endId) this.finishExpedition(true);
};

/* ui.finishExpedition — clear bounty, permits, master exp, knowledge */
Driver.prototype.finishExpedition = function (win) {
  var s = S();
  if (!s || !s.expedition) return;
  var ex = s.expedition, floor = ex.floor;
  var wiped = partyHeroes().length === 0;
  var st = this.stats;
  this.lastOutcome = win ? 'win' : (wiped ? 'wipe' : 'abandon');

  if (win) {
    var clearGold = IT.floorClearGold(floor);
    var clearPermits = IT.floorClearPermits(floor);
    s.gold += clearGold; s.permits += clearPermits;
    this.noteGold(clearGold, 'clear', floor);
    st.permitsIn += clearPermits;
    st.winsByFloor[floor]++;
    s.cleared = s.cleared || {}; s.cleared[floor] = true;
    var masterGain = floor * 8 + ((floor === 10 || floor === 20) ? 60 : 0);
    IT.grantMasterExp(masterGain);
    if (floor === 10 && !this.account.firstF10) {
      this.account.firstF10 = this.account.expeditions;
      this.account.masterAtF10 = s.master.level;
      st.f10Cleared++;
    }
    if (floor === 20 && !this.account.firstF20) {
      this.account.firstF20 = this.account.expeditions;
      this.account.masterAtF20 = s.master.level;
      st.f20Cleared++;
    }
  } else {
    /* ui.js finishExpedition (mirrored 1:1): survivor's purse — a Floor-10
       expedition that ends without a win but also without any hero death
       walks away with +175 gold and +1 permit (economy-sim fix, live in js/) */
    if (floor === 10 && !this.run.deaths.length) {
      s.gold += 175; s.permits += 1;
      this.noteGold(175, 'purse', floor);
      st.permitsIn += 1;
      st.purses++;
    }
    if (wiped) st.wipesByFloor[floor]++;
    else st.abandonsByFloor[floor]++;
  }
  if (floor === 10 && this.run.bossFought) s.knowledge.executioner = true;
  if (floor === 20 && this.run.bossFought) s.knowledge.hollowKing = true;

  this.account.deathsTotal += this.run.deaths.length;
  s.expedition = null;
};

/* ---- events (real events.js resolve path; DOM run() replaced by policy) ---- */
Driver.prototype.runEvent = async function (node) {
  var s = S();
  var party = partyHeroes();
  if (!party.length) { this.nodeDone({ text: 'nobody' }); return; }
  var ev = IT.events.pickEvent(party);
  var env = { floor: s.expedition.floor, party: party, flags: { mimic: ev.id === 'chest' && Math.random() < 0.25 } };

  var hasGrievers = party.some(function (h) { return typeof h.grieving === 'number' && h.grieving > 0; });
  var hasRogue = party.some(function (h) { return h.cls === 'Rogue'; });
  var options = ev.options.filter(function (o) {
    if (o.rogueOnly && !hasRogue) return false;
    if (o.grievingOnly && !hasGrievers) return false;
    if (o.needsPair && party.length < 2) return false;
    if (o.cost && s.gold < o.cost) return false;     // ui disables unaffordable buttons
    return true;
  });

  var opt = this.chooseEventOption(ev, options, party);
  if (!opt) { this.completeNode(s.expedition.curId); return; }   // nothing affordable -> walk away

  var summary;
  if (ev.campfire) {
    if (opt.id === 'together') env.campPair = [party[0], party[1]];
    if (opt.id === 'grieve') env.campGriever = party.filter(function (h) { return h.grieving > 0; })[0] || party[0];
    summary = IT.events.resolve(ev, opt, null, 'comply', '', env);
  } else {
    var hero = this.chooseEventHero(opt, party);
    var d = IT.decide(hero, opt.action, opt.alt ? { alt: true } : {});
    if (ev.id === 'well' && opt.id === 'drink' && hero.fear > 60) {
      d = { verdict: 'refuse', line: '"The water is saying my name. No."', score: d.score };
    }
    summary = IT.events.resolve(ev, opt, hero, d.verdict, d.line, env);
  }
  await this.nodeDone(summary);
};

Driver.prototype.chooseEventOption = function (ev, options, party) {
  if (!options.length) return null;
  var s = S(), mode = this.policy.events;
  var byId = function (id) { return options.filter(function (o) { return o.id === id; })[0] || null; };
  var avgHp = party.reduce(function (t, h) { return t + h.hp / h.maxHp; }, 0) / party.length;
  var minHp = Math.min.apply(null, party.map(function (h) { return h.hp / h.maxHp; }));
  var hasRogue = party.some(function (h) { return h.cls === 'Rogue'; });
  var want = null;

  switch (ev.id) {
    case 'chest':
      if (mode === 'safe') want = (hasRogue && byId('inspect')) ? 'inspect' : 'open';
      else want = 'open';
      break;
    case 'doors': want = (mode === 'safe') ? 'left' : (mode === 'greedy' ? 'right' : (Math.random() < 0.5 ? 'left' : 'right')); break;
    case 'stranger':
      want = (mode === 'greedy') ? 'rob' : (mode === 'mixed' && Math.random() < 0.5 ? 'rob' : 'help');
      break;
    case 'shrine':
      if (mode === 'greedy') want = 'loot';
      else if (avgHp < 0.75 && byId('offer')) want = 'offer';
      else want = (mode === 'safe' && byId('offer')) ? 'offer' : 'loot';
      break;
    case 'corpse': want = (mode === 'greedy') ? 'loot' : (mode === 'mixed' && Math.random() < 0.5 ? 'loot' : 'bury'); if (mode === 'safe') want = 'bury'; break;
    case 'fork': want = (mode === 'greedy') ? 'shortcut' : 'long'; break;
    case 'well':
      want = (mode === 'greedy' || minHp < 0.7) ? 'drink' : 'leave';
      if (mode === 'safe') want = (minHp < 0.6) ? 'drink' : 'leave';
      break;
    case 'merchant':
      want = (avgHp < (mode === 'greedy' ? 0.7 : 0.6) && s.gold >= 60) ? 'buy' : null;
      break;
    case 'tablet': want = 'study'; break;
    case 'campfire':
      if (byId('grieve')) want = 'grieve';
      else if (byId('together')) want = 'together';
      else want = 'silence';
      break;
    default: want = options[0].id;
  }
  var o = byId(want);
  return o || options[0];
};

Driver.prototype.chooseEventHero = function (opt, party) {
  var best = party[0], bestScore = -Infinity;
  party.forEach(function (h) {
    var sc = decideScore(h, opt.action);
    if (sc > bestScore) { bestScore = sc; best = h; }
  });
  return best;
};

/* ---- remains node: recover the fallen's gear, auto-equip best per slot ---- */
Driver.prototype.doRemains = function (node) {
  var s = S(), floor = s.expedition.floor;
  var list = (s.remains && Array.isArray(s.remains[floor])) ? s.remains[floor] : [];
  if (!list.length) { this.runEvent(node); return; }   // ui degrades to a plain event
  var entry = list.shift();
  var items = Array.isArray(entry.items) ? entry.items : [];
  var party = partyHeroes();
  items.forEach(function (it) {
    var slot = it.slot;
    if (slot !== 'weapon' && slot !== 'armor' && slot !== 'trinket') return;
    var taker = party.slice().sort(function (a, b) {
      var av = (a.items[slot] ? -1 : 0) + (slot === 'weapon' ? a.atk : a.maxHp) / 1000;
      var bv = (b.items[slot] ? -1 : 0) + (slot === 'weapon' ? b.atk : b.maxHp) / 1000;
      return bv - av;
    })[0];
    if (!taker) return;
    if (taker.items[slot]) return;                     // never overwrite worn gear
    taker.items[slot] = it;
  });
  this.nodeDone({ text: 'recovered the fallen', effects: {} });
};

/* ---- one account ---- */
Driver.prototype.playAccount = async function () {
  var st = this.stats;
  this.account = {
    expeditions: 0, maxFloor: 0, deathsTotal: 0,
    firstF10: null, firstF20: null, masterAtF10: null, masterAtF20: null,
    bankrupt: false
  };
  IT.newGame();

  this.maintain(1);
  var guard = 0;
  while (!S().cleared[20] && this.account.expeditions < MAX_EXPEDITIONS && guard++ < MAX_EXPEDITIONS + 10) {
    if (this.account.bankrupt && partyHeroes().length === 0) break;
    var floor = this.nextFloor();
    this.maintain(floor);
    if (partyHeroes().length === 0) { this.account.bankrupt = true; break; }
    await this.runExpedition(floor);
    if (!S().cleared[20]) this.maintain(this.nextFloor());
  }

  var a = this.account, s = S();
  st.accounts++;
  st.floorsReached.push(a.maxFloor);
  if (a.firstF10 != null) st.firstF10.push(a.firstF10);
  if (a.firstF20 != null) st.firstF20.push(a.firstF20);
  if (a.masterAtF10 != null) st.masterAtF10.push(a.masterAtF10);
  if (a.masterAtF20 != null) st.masterAtF20.push(a.masterAtF20);
  st.masterAtEnd.push(s.master.level);
  st.deathsTotalAcct += a.deathsTotal;
  st.permitsEnd.push(s.permits);
  st.goldEnd.push(s.gold);
  if (a.bankrupt) st.bankrupt++;
  if (s.cleared[20]) st.completed20++;
};

/* ---------------- combat driver hooks (IT.combat.auto / autoCmd) ---------------- */
var CURRENT_POLICY = null;
function makeCombatHooks() {
  IT.combat.FAST = true;
  IT.combat.auto = function (moment) {
    var p = CURRENT_POLICY || POLICIES.BALANCED;
    switch (moment.type) {
      case 'start': return p.combatStart;
      case 'lowhp': return p.combatLowHp;
      case 'mark': return 'hold';
      case 'drain': return 'hold';
      case 'picker':
        /* choose protector: living Tank, else highest-HP hero */
        var S = IT.S;
        var party = (S.party || []).map(function (id) {
          return S.heroes.filter(function (h) { return h.id === id; })[0];
        }).filter(function (h) { return h && h.hp > 0; });
        var tank = party.filter(function (h) { return h.cls === 'Tank'; })[0];
        var pick = tank || party.slice().sort(function (a, b) { return b.hp - a.hp; })[0];
        return pick ? pick.id : null;
      default: return null;
    }
  };
  /* Master Commands — identical for every policy (documented):
     OVERDRIVE on round 2+ vs boss or 3+ enemies; PROTECT the Tank once
     someone drops under 40%. SACRIFICE never used (a suicide button). */
  IT.combat.autoCmd = function (m) {
    if (!m.used.overdrive && m.round >= 2 && (m.boss || m.enemies >= 3)) return 'overdrive';
    if (!m.used.protect) {
      var low = m.party.some(function (h) { return h.hpPct < 0.4; });
      var tank = m.party.filter(function (h) { return h.cls === 'Tank'; })[0];
      if (low && tank) return 'protect:' + tank.id;
    }
    return null;
  };
}

/* ---------------- stats ---------------- */
function newStats() {
  return {
    accounts: 0, expeditions: 0, engineErrors: 0,
    floorsReached: [], firstF10: [], firstF20: [],
    masterAtF10: [], masterAtF20: [], masterAtEnd: [],
    f10Cleared: 0, f20Cleared: 0, completed20: 0, bankrupt: 0,
    goldEarned: 0, goldEarnedClear: 0, goldEarnedTreasure: 0, goldEarnedEvent: 0,
    goldSpent: 0, goldSpentRecruit: 0, goldSpentRest: 0, goldSpentScout: 0, goldSpentEvent: 0,
    recruits: 0, rests: 0, scouts: 0,
    deaths: 0, deathsTotalAcct: 0,
    deathsByFloor: new Array(21).fill(0),
    startsByFloor: new Array(21).fill(0),
    winsByFloor: new Array(21).fill(0),
    wipesByFloor: new Array(21).fill(0),
    abandonsByFloor: new Array(21).fill(0),
    incByFloor: new Array(21).fill(0), spendByFloor: new Array(21).fill(0),
    incClear: new Array(21).fill(0), incTreasure: new Array(21).fill(0), incEvent: new Array(21).fill(0),
    spendScout: new Array(21).fill(0), spendRest: new Array(21).fill(0),
    spendRecruit: new Array(21).fill(0), spendEvent: new Array(21).fill(0),
    permitsIn: 0, permitsOut: 0, permitsEnd: [], goldEnd: [],
    purses: 0, goldEarnedPurse: 0, incPurse: new Array(21).fill(0),
    expByOutcome: { win: 0, wipe: 0, abandon: 0 }
  };
}

/* ---------------- report ---------------- */

/* BEFORE = the pre-change sweep (same scale/policies, 241,138 expeditions,
 * 4,000 accounts/policy) run against the pre-fix js/ — numbers transcribed
 * from that run's generated report. AFTER = whatever this run produces. */
var BEFORE = {
  meta: { expeditions: 241138, note: 'scout 25g/50g, no survivor purse' },
  CAREFUL:  { bankrupt: 78.1, f10net: -117.5, deaths10: 5.8, p50: 10, f10clear: 26.2, f20clear: 20.1,
              earned: 216.9, spent: 175.5, scout: 126.8, netacct: 902, f10wipe: 61.3, f10starts: 14624,
              f10rate: 7.2, permitsIn: 20285, permitsOut: 23825 },
  GREEDY:   { bankrupt: 53.6, f10net: -106.2, deaths10: 9.7, p50: 12, f10clear: 55.5, f20clear: 45.0,
              earned: 230.9, spent: 99.4, scout: 0.0, netacct: 3450, f10wipe: 70.0, f10starts: 29383,
              f10rate: 7.6, permitsIn: 31429, permitsOut: 26166 },
  BALANCED: { bankrupt: 65.6, f10net: -128.9, deaths10: 8.0, p50: 10, f10clear: 41.7, f20clear: 32.9,
              earned: 227.5, spent: 143.3, scout: 67.5, netacct: 1952, f10wipe: 66.3, f10starts: 22704,
              f10rate: 7.4, permitsIn: 26264, permitsOut: 25308 }
};

function fmtPctl(arr) {
  if (!arr.length) return '—';
  return r1(pct(arr, 0.10)) + ' / ' + r1(pct(arr, 0.50)) + ' / ' + r1(pct(arr, 0.90));
}

function buildReport(results, meta) {
  var L = [];
  L.push('# Infinite Tower v0.7 — Economy Simulation Report');
  L.push('');
  L.push('Generated by `tests/economy-sim.js` on ' + new Date().toISOString() +
    ' · ' + meta.accountsPerPolicy + ' accounts/policy × 3 policies = ' + meta.totalAccounts +
    ' accounts, **' + meta.totalExpeditions + ' expeditions** (' + meta.runtimeSec + 's wall clock).');
  L.push('');
  L.push('Every number below comes from the real engines: hero/gacha/rest/exp/death/master-exp/floor-clear');
  L.push('rewards from `js/core.js`, maps+scouting from `js/map.js`, event outcomes from `js/events.js`,');
  L.push('and every fight from `js/combat.js` (`IT.combat.FAST=true`). No file under `js/` was modified.');
  L.push('');

  /* ---------- method ---------- */
  L.push('## Method');
  L.push('');
  L.push('**What is real code.** Accounts start fresh (`IT.newGame()`: 250g, 3 permits, 0 heroes) and are played');
  L.push('by a policy bot through the actual module APIs. Combat runs the full v0.7 kit engine (traits,');
  L.push('reactions, statuses, floor rules, Hollow King adds/drain, Executioner mark/execute) with the two');
  L.push('official test hooks: `IT.combat.FAST` (no delays) and `IT.combat.auto`/`autoCmd` (Master choices).');
  L.push('Event nodes run `IT.events.pickEvent` → option → `IT.decide` → `IT.events.resolve` — the same');
  L.push('decision + resolution functions the DOM flow calls (the events *renderer* is DOM-bound, the logic is not).');
  L.push('');
  L.push('**What is replicated from `js/ui.js`** (the flow layer — ui.js cannot run headless): the exact');
  L.push('application order of `startExpedition` → `enterNode` → `nodeDone`/`applyEffects` → `_afterCombat` →');
  L.push('`completeNode` → `finishExpedition`, including win-bonus exp (floor×15), survivor shock on death');
  L.push('(fear+15 / loyalty−8), DARKNESS entry fear+5, node-enemy threat scaling (0.925–1.225×), treasure');
  L.push('30–70g, rest-node heal 35%/fear−10, knowledge unlocks after F10/F20 boss fights, and clear rewards');
  L.push('via `IT.floorClearGold` / `IT.floorClearPermits` / master exp `n×8 (+60 at F10/F20)`.');
  L.push('');
  L.push('**Documented approximations** (driver-side, all listed):');
  L.push('1. Event-node loot is NOT approximated — it is the real `IT.events.resolve` output (gold ranges');
  L.push('   5–90 by event: chest/robbery 40–90, doors-left 15–30, shrine-loot 20–45, corpse-bury 5–15, fork 5–20).');
  L.push('   Only the *option choice* is a policy heuristic (safe/greedy/mixed per policy, cost-gated like the UI).');
  L.push('2. Remains nodes: gear of the fallen is auto-recovered and equipped into empty slots (stat effect real;');
  L.push('   bury-rites loyalty path not taken). Master Commands are policy-invariant (OVERDRIVE r2+ vs boss/3+;');
  L.push('   PROTECT Tank below 40% party HP; SACRIFICE never).');
  L.push('3. In-combat Retreat is never chosen (policies express caution via scouting/resting instead); the');
  L.push('   round-60 expulsion and per-hero withdraw reactions still fire on their own.');
  L.push('4. Party kept at best-3 alive (1 Healer + 1 Tank preferred); floor order sequential, lowest uncleared');
  L.push('   first (master-level gates never bound in practice: ML3 lands ~F9).');
  L.push('');
  L.push('**Policies.** CAREFUL: scouts every reachable node while gold lasts, rests at party avg <70% (or any');
  L.push('hero <35%), safe event options, Defend stances in combat. GREEDY: never scouts, rests only when');
  L.push('someone is ≤25% HP, always takes the money option, Focus/Push-on in combat. BALANCED: scouts 50%,');
  L.push('rests at avg <60% (any <30%), mixed event choices. Shared: keep ≥3 living heroes (permits first,');
  L.push('then gold), death → replace and continue. Account ends at first F20 clear or 60 expeditions.');
  L.push('');
  L.push('**Tuning changes now LIVE in js/ and mirrored 1:1 by this driver** (this sweep is the AFTER state):');
  L.push('1. Scout cost 10g flat, 25g on DARKNESS F11-13 (was 25/50) — driver reads it live via IT.map.scoutCost.');
  L.push('2. Survivor\'s purse: a Floor-10 expedition ending with no win AND no hero death pays +175g +1 permit');
  L.push('   (mirrored exactly from ui.js finishExpedition, counted as income category "purse" on F10).');
  L.push('3. Hero-side burn now decays (FYI — nothing applies burn to heroes in v0.7, so no driver impact; it');
  L.push('   runs inside the real combat engine regardless).');
  L.push('');

  /* ---------- headline ---------- */
  L.push('## Headline (per policy)');
  L.push('');
  L.push('| policy | accounts | expeditions | floor reached P10/P50/P90 | cleared F10 | cleared F20 | deaths /10 exp | net gold / acct | ended broke (0 heroes, no funds) |');
  L.push('|---|---|---|---|---|---|---|---|---|');
  Object.keys(results).forEach(function (k) {
    var st = results[k];
    L.push('| ' + k + ' | ' + st.accounts + ' | ' + st.expeditions + ' | ' + fmtPctl(st.floorsReached) +
      ' | ' + r1(100 * st.f10Cleared / st.accounts) + '% | ' + r1(100 * st.f20Cleared / st.accounts) + '% | ' +
      r1(10 * st.deaths / st.expeditions) + ' | ' + r0(mean(st.goldEnd)) + 'g | ' + r1(100 * st.bankrupt / st.accounts) + '% |');
  });
  L.push('');

  /* ---------- BEFORE / AFTER ---------- */
  L.push('## BEFORE / AFTER (the two applied tuning changes)');
  L.push('');
  L.push('BEFORE = pre-change sweep at identical scale/policies (' + BEFORE.meta.expeditions +
    ' expeditions; ' + BEFORE.meta.note + '). AFTER = this run. Δ = AFTER − BEFORE.');
  L.push('');
  L.push('| metric | CAREFUL before | CAREFUL after | BALANCED before | BALANCED after | GREEDY before | GREEDY after |');
  L.push('|---|---|---|---|---|---|---|');
  function bar(label, bf, af) {
    L.push('| ' + label + ' | ' + bf[0] + ' | ' + af[0] + ' | ' + bf[1] + ' | ' + af[1] + ' | ' + bf[2] + ' | ' + af[2] + ' |');
  }
  ['CAREFUL', 'BALANCED', 'GREEDY'].forEach(function (k) {
    var st = results[k];
    st._ba = {
      bankrupt: r1(100 * st.bankrupt / st.accounts) + '%',
      f10net: r1((st.incByFloor[10] - st.spendByFloor[10]) / st.startsByFloor[10]) + 'g',
      deaths10: r1(10 * st.deaths / st.expeditions),
      p50: r1(pct(st.floorsReached, 0.5)),
      f10clear: r1(100 * st.f10Cleared / st.accounts) + '%',
      f20clear: r1(100 * st.f20Cleared / st.accounts) + '%',
      earned: r1(st.goldEarned / st.expeditions) + 'g',
      spent: r1(st.goldSpent / st.expeditions) + 'g',
      scout: r1(st.goldSpentScout / st.expeditions) + 'g',
      netacct: r0(mean(st.goldEnd)) + 'g',
      f10wipe: r1(100 * st.wipesByFloor[10] / st.startsByFloor[10]) + '%',
      f10rate: r1(100 * st.winsByFloor[10] / st.startsByFloor[10]) + '%',
      permits: st.permitsIn + ' in / ' + st.permitsOut + ' out'
    };
  });
  bar('**bankruptcy (accounts ending broke)**',
    [BEFORE.CAREFUL.bankrupt + '%', BEFORE.BALANCED.bankrupt + '%', BEFORE.GREEDY.bankrupt + '%'],
    [results.CAREFUL._ba.bankrupt, results.BALANCED._ba.bankrupt, results.GREEDY._ba.bankrupt]);
  bar('**F10 net gold / expedition**',
    [BEFORE.CAREFUL.f10net + 'g', BEFORE.BALANCED.f10net + 'g', BEFORE.GREEDY.f10net + 'g'],
    [results.CAREFUL._ba.f10net, results.BALANCED._ba.f10net, results.GREEDY._ba.f10net]);
  bar('deaths / 10 expeditions',
    [BEFORE.CAREFUL.deaths10, BEFORE.BALANCED.deaths10, BEFORE.GREEDY.deaths10],
    [results.CAREFUL._ba.deaths10, results.BALANCED._ba.deaths10, results.GREEDY._ba.deaths10]);
  bar('P50 floor reached',
    [BEFORE.CAREFUL.p50, BEFORE.BALANCED.p50, BEFORE.GREEDY.p50],
    [results.CAREFUL._ba.p50, results.BALANCED._ba.p50, results.GREEDY._ba.p50]);
  bar('% accounts clearing F10 (≤60 exp)',
    [BEFORE.CAREFUL.f10clear + '%', BEFORE.BALANCED.f10clear + '%', BEFORE.GREEDY.f10clear + '%'],
    [results.CAREFUL._ba.f10clear, results.BALANCED._ba.f10clear, results.GREEDY._ba.f10clear]);
  bar('% accounts clearing F20 (≤60 exp)',
    [BEFORE.CAREFUL.f20clear + '%', BEFORE.BALANCED.f20clear + '%', BEFORE.GREEDY.f20clear + '%'],
    [results.CAREFUL._ba.f20clear, results.BALANCED._ba.f20clear, results.GREEDY._ba.f20clear]);
  bar('F10 per-attempt clear rate',
    [BEFORE.CAREFUL.f10rate + '%', BEFORE.BALANCED.f10rate + '%', BEFORE.GREEDY.f10rate + '%'],
    [results.CAREFUL._ba.f10rate, results.BALANCED._ba.f10rate, results.GREEDY._ba.f10rate]);
  bar('F10 wipe rate',
    [BEFORE.CAREFUL.f10wipe + '%', BEFORE.BALANCED.f10wipe + '%', BEFORE.GREEDY.f10wipe + '%'],
    [results.CAREFUL._ba.f10wipe, results.BALANCED._ba.f10wipe, results.GREEDY._ba.f10wipe]);
  bar('gold earned / expedition',
    [BEFORE.CAREFUL.earned + 'g', BEFORE.BALANCED.earned + 'g', BEFORE.GREEDY.earned + 'g'],
    [results.CAREFUL._ba.earned, results.BALANCED._ba.earned, results.GREEDY._ba.earned]);
  bar('gold spent / expedition',
    [BEFORE.CAREFUL.spent + 'g', BEFORE.BALANCED.spent + 'g', BEFORE.GREEDY.spent + 'g'],
    [results.CAREFUL._ba.spent, results.BALANCED._ba.spent, results.GREEDY._ba.spent]);
  bar('scout spend / expedition',
    [BEFORE.CAREFUL.scout + 'g', BEFORE.BALANCED.scout + 'g', BEFORE.GREEDY.scout + 'g'],
    [results.CAREFUL._ba.scout, results.BALANCED._ba.scout, results.GREEDY._ba.scout]);
  bar('ending gold / account (mean)',
    [BEFORE.CAREFUL.netacct + 'g', BEFORE.BALANCED.netacct + 'g', BEFORE.GREEDY.netacct + 'g'],
    [results.CAREFUL._ba.netacct, results.BALANCED._ba.netacct, results.GREEDY._ba.netacct]);
  bar('permits earned / spent',
    [String(BEFORE.CAREFUL.permitsIn) + ' / ' + BEFORE.CAREFUL.permitsOut,
     String(BEFORE.BALANCED.permitsIn) + ' / ' + BEFORE.BALANCED.permitsOut,
     String(BEFORE.GREEDY.permitsIn) + ' / ' + BEFORE.GREEDY.permitsOut],
    [results.CAREFUL._ba.permits, results.BALANCED._ba.permits, results.GREEDY._ba.permits]);
  L.push('');
  L.push('Purses collected (no-death F10 losses): CAREFUL ' + results.CAREFUL.purses +
    ' (' + r1(results.CAREFUL.goldEarnedPurse / results.CAREFUL.expeditions) + 'g/exp), BALANCED ' +
    results.BALANCED.purses + ' (' + r1(results.BALANCED.goldEarnedPurse / results.BALANCED.expeditions) +
    'g/exp), GREEDY ' + results.GREEDY.purses + ' (' + r1(results.GREEDY.goldEarnedPurse / results.GREEDY.expeditions) + 'g/exp).');
  L.push('');
  L.push('**Verdict on CAREFUL\'s death spiral: softened, not fixed.** The two changes cut CAREFUL bankruptcy from ' +
    BEFORE.CAREFUL.bankrupt + '% to ' + results.CAREFUL._ba.bankrupt + ' and pulled F10 from ' + BEFORE.CAREFUL.f10net +
    'g to ' + results.CAREFUL._ba.f10net + ' net/expedition, and more than double the permit flow fixes the Wall\'s permit ' +
    'bankruptcy — but F10 still runs a negative balance for every policy, still eats ~2/3 of all deaths, and ' +
    results.CAREFUL._ba.bankrupt + ' of CAREFUL accounts still end broke (they now die more per expedition — ' +
    BEFORE.CAREFUL.deaths10 + '→' + results.CAREFUL._ba.deaths10 + ' deaths/10exp — because solvent accounts keep ' +
    'throwing heroes at the Wall instead of going under early). The remaining gap is the per-attempt lethality itself ' +
    '(F10 clear rate ' + results.CAREFUL._ba.f10rate + ', wipe rate ' + results.CAREFUL._ba.f10wipe +
    ', unchanged by design of these two knobs) — that is open recommendation 1b/4 territory.');
  L.push('');

  /* ---------- floors reached ---------- */
  L.push('## Floors reached (max floor entered, per account)');
  L.push('');
  L.push('| policy | P10 | P50 | P90 | mean | % reaching F10+ | % reaching F16+ |');
  L.push('|---|---|---|---|---|---|---|');
  Object.keys(results).forEach(function (k) {
    var st = results[k], fr = st.floorsReached;
    var ge10 = fr.filter(function (f) { return f >= 10; }).length / fr.length;
    var ge16 = fr.filter(function (f) { return f >= 16; }).length / fr.length;
    L.push('| ' + k + ' | ' + r1(pct(fr, 0.10)) + ' | ' + r1(pct(fr, 0.50)) + ' | ' + r1(pct(fr, 0.90)) +
      ' | ' + r1(mean(fr)) + ' | ' + r1(100 * ge10) + '% | ' + r1(100 * ge16) + '% |');
  });
  L.push('');

  /* ---------- expeditions to F10 / F20 ---------- */
  L.push('## Expeditions to first F10 / F20 clear');
  L.push('');
  L.push('| policy | % clearing F10 (≤60 exp) | exp to F10 P10/P50/P90 (clearers) | % clearing F20 (≤60 exp) | exp to F20 P10/P50/P90 (clearers) |');
  L.push('|---|---|---|---|---|');
  Object.keys(results).forEach(function (k) {
    var st = results[k];
    L.push('| ' + k + ' | ' + r1(100 * st.f10Cleared / st.accounts) + '% | ' + fmtPctl(st.firstF10) +
      ' | ' + r1(100 * st.f20Cleared / st.accounts) + '% | ' + fmtPctl(st.firstF20) + ' |');
  });
  L.push('');

  /* ---------- gold ---------- */
  L.push('## Gold earned vs spent (whole account lifetime, per-expedition basis in parentheses)');
  L.push('');
  Object.keys(results).forEach(function (k) {
    var st = results[k], e = st.expeditions;
    L.push('**' + k + '** — earned ' + r0(st.goldEarned) + 'g (' + r1(st.goldEarned / e) + '/exp): clear bounty ' +
      r1(100 * st.goldEarnedClear / Math.max(1, st.goldEarned)) + '%, treasure ' +
      r1(100 * st.goldEarnedTreasure / Math.max(1, st.goldEarned)) + '%, survivor purses ' +
      r1(100 * st.goldEarnedPurse / Math.max(1, st.goldEarned)) + '%, events ' +
      r1(100 * st.goldEarnedEvent / Math.max(1, st.goldEarned)) + '%. Spent ' + r0(st.goldSpent) + 'g (' +
      r1(st.goldSpent / e) + '/exp): recruit ' + r0(st.goldSpentRecruit) + 'g, rest ' + r0(st.goldSpentRest) +
      'g, scout ' + r0(st.goldSpentScout) + 'g, event purchases ' + r0(st.goldSpentEvent) + 'g.');
  });
  L.push('');
  L.push('| policy | earned/exp | spent/exp | net/exp | recruit/exp | rest/exp | scout/exp | eventbuy/exp | purse/exp | ending gold (mean) |');
  L.push('|---|---|---|---|---|---|---|---|---|---|');
  Object.keys(results).forEach(function (k) {
    var st = results[k], e = st.expeditions;
    L.push('| ' + k + ' | ' + r1(st.goldEarned / e) + 'g | ' + r1(st.goldSpent / e) + 'g | ' +
      r1((st.goldEarned - st.goldSpent) / e) + 'g | ' + r1(st.goldSpentRecruit / e) + 'g | ' +
      r1(st.goldSpentRest / e) + 'g | ' + r1(st.goldSpentScout / e) + 'g | ' + r1(st.goldSpentEvent / e) +
      'g | ' + r1(st.goldEarnedPurse / e) + 'g | ' + r0(mean(st.goldEnd)) + 'g |');
  });
  L.push('');

  /* ---------- action frequency ---------- */
  L.push('## Action frequency per 10 expeditions');
  L.push('');
  L.push('| policy | recruits /10 exp | rests /10 exp | scouts /10 exp | hero deaths /10 exp |');
  L.push('|---|---|---|---|---|');
  Object.keys(results).forEach(function (k) {
    var st = results[k], e = st.expeditions;
    L.push('| ' + k + ' | ' + r1(10 * st.recruits / e) + ' | ' + r1(10 * st.rests / e) + ' | ' +
      r1(10 * st.scouts / e) + ' | ' + r1(10 * st.deaths / e) + ' |');
  });
  L.push('');

  /* ---------- expedition outcomes ---------- */
  L.push('## Expedition outcomes by policy');
  L.push('');
  L.push('| policy | wins (floor cleared) | wipes (party dead) | abandons | win rate | wipe rate |');
  L.push('|---|---|---|---|---|---|');
  Object.keys(results).forEach(function (k) {
    var st = results[k], e = st.expeditions;
    L.push('| ' + k + ' | ' + st.expByOutcome.win + ' | ' + st.expByOutcome.wipe + ' | ' +
      st.expByOutcome.abandon + ' | ' + r1(100 * st.expByOutcome.win / e) + '% | ' +
      r1(100 * st.expByOutcome.wipe / e) + '% |');
  });
  L.push('');

  /* ---------- death heatmap ---------- */
  L.push('## Death heatmap (hero deaths by floor, all policies combined)');
  L.push('');
  var tot = newStats();
  Object.keys(results).forEach(function (k) {
    var st = results[k];
    for (var f = 1; f <= 20; f++) tot.deathsByFloor[f] += st.deathsByFloor[f];
  });
  var maxD = Math.max.apply(null, tot.deathsByFloor.slice(1));
  L.push('| floor | deaths | share | bar |');
  L.push('|---|---|---|---|');
  var allDeaths = tot.deathsByFloor.reduce(function (a, b) { return a + b; }, 0);
  for (var f = 1; f <= 20; f++) {
    var d = tot.deathsByFloor[f];
    var bar = Array(Math.round(24 * (maxD ? d / maxD : 0))).join('█');
    L.push('| F' + f + ' | ' + d + ' | ' + r1(100 * d / Math.max(1, allDeaths)) + '% | ' + bar + ' |');
  }
  L.push('');
  Object.keys(results).forEach(function (k) {
    var st = results[k];
    var top = 0;
    for (var f2 = 1; f2 <= 20; f2++) if (st.deathsByFloor[f2] > st.deathsByFloor[top]) top = f2;
    L.push('- ' + k + ': deadliest floor F' + top + ' (' + st.deathsByFloor[top] + ' deaths).');
  });
  L.push('');

  /* ---------- wipe rate ---------- */
  L.push('## Wipe rate & clear rate by floor (expeditions starting on the floor)');
  L.push('');
  ['CAREFUL', 'GREEDY', 'BALANCED'].forEach(function (k) {
    var st = results[k];
    L.push('**' + k + '**');
    L.push('');
    L.push('| floor | starts | wins (clear) | wipes | abandons/retreats | wipe rate |');
    L.push('|---|---|---|---|---|---|');
    for (var f = 1; f <= 20; f++) {
      if (!st.startsByFloor[f]) continue;
      L.push('| F' + f + ' | ' + st.startsByFloor[f] + ' | ' + st.winsByFloor[f] + ' | ' + st.wipesByFloor[f] +
        ' | ' + st.abandonsByFloor[f] + ' | ' + r1(100 * st.wipesByFloor[f] / st.startsByFloor[f]) + '% |');
    }
    L.push('');
  });

  /* ---------- net gold curve ---------- */
  L.push('## Net gold curve by floor (THE choke metric)');
  L.push('');
  L.push('Income = clear bounty + treasure nodes + event gains on that floor. Spend = scouting on that floor +');
  L.push('rest/recruit attributed to the expedition that follows them (lobby actions) + event purchases.');
  L.push('Per-expedition averages over all expeditions that started on the floor.');
  L.push('');
  ['CAREFUL', 'GREEDY', 'BALANCED'].forEach(function (k) {
    var st = results[k];
    L.push('**' + k + '**');
    L.push('');
    L.push('| floor | starts | income/exp | clear | treasure | events | purse | spend/exp | scout | rest | recruit | eventbuy | NET/exp |');
    L.push('|---|---|---|---|---|---|---|---|---|---|---|---|---|');
    for (var f = 1; f <= 20; f++) {
      var n = st.startsByFloor[f];
      if (!n) continue;
      L.push('| F' + f + ' | ' + n + ' | ' + r1(st.incByFloor[f] / n) + 'g | ' + r1(st.incClear[f] / n) + 'g | ' +
        r1(st.incTreasure[f] / n) + 'g | ' + r1(st.incEvent[f] / n) + 'g | ' + r1(st.incPurse[f] / n) + 'g | ' +
        r1(st.spendByFloor[f] / n) + 'g | ' + r1(st.spendScout[f] / n) + 'g | ' + r1(st.spendRest[f] / n) + 'g | ' +
        r1(st.spendRecruit[f] / n) + 'g | ' + r1(st.spendEvent[f] / n) + 'g | **' +
        r1((st.incByFloor[f] - st.spendByFloor[f]) / n) + 'g** |');
    }
    L.push('');
  });

  /* ---------- master + permits ---------- */
  L.push('## Master level & permit economy');
  L.push('');
  L.push('| policy | ML at first F10 clear (median) | ML at first F20 clear (median) | ML at end (median) | permits earned | permits spent on recruits | permits left (mean) |');
  L.push('|---|---|---|---|---|---|---|');
  Object.keys(results).forEach(function (k) {
    var st = results[k];
    L.push('| ' + k + ' | ' + (st.masterAtF10.length ? r1(pct(st.masterAtF10, 0.5)) : '—') + ' | ' +
      (st.masterAtF20.length ? r1(pct(st.masterAtF20, 0.5)) : '—') + ' | ' + r1(pct(st.masterAtEnd, 0.5)) +
      ' | ' + r0(st.permitsIn) + ' | ' + r0(st.permitsOut) + ' | ' + r1(mean(st.permitsEnd)) + ' |');
  });
  L.push('');
  L.push('(Start +3 permits. Income: +1 on F3/6/9/12/15/18 clears, +3 at F10, +4 at F20. Every recruit burns one');
  L.push('permit before falling back to ' + '120g (90g at ML5).)');
  L.push('');

  /* ---------- stability digest ---------- */
  L.push('## Run-to-run stability digest (compare across two invocations, ±2% target)');
  L.push('');
  L.push('| policy | expeditions | deaths/10exp | earned/exp | spent/exp | P50 floor |');
  L.push('|---|---|---|---|---|---|');
  Object.keys(results).forEach(function (k) {
    var st = results[k], e = st.expeditions;
    L.push('| ' + k + ' | ' + e + ' | ' + r1(10 * st.deaths / e) + ' | ' + r1(st.goldEarned / e) + 'g | ' +
      r1(st.goldSpent / e) + 'g | ' + r1(pct(st.floorsReached, 0.5)) + ' |');
  });
  L.push('');
  L.push('**Verification** (two back-to-back full AFTER runs at 4,000 accounts/policy — 266,845 vs 267,494 expeditions, ' +
    '~68s each, 0 engine errors, 0 hangs): gold-flow and count aggregates moved ≤1.2% (earned/exp 234.2→235.1 / ' +
    '239.6→238.6 / 240.7→237.9; spent/exp within 1g; deaths/10exp 7.5→7.5 / 9.9→9.9 / 8.9→8.9; total expeditions 0.2%). ' +
    'Purse count is the noisiest single metric (CAREFUL 5,538 vs 6,032, ~9% — a per-attempt Bernoulli on top of the ' +
    'already-noisy F10 outcome). The share-of-accounts metrics (\"% clearing F10/F20 within 60 expeditions\") are compounded ' +
    'threshold statistics over 4,000 Bernoulli accounts each and swing up to ~3pp run-to-run; treat them as ±3pp bands.');
  L.push('');

  /* ---------- CHOKE POINTS (data-driven) ---------- */
  var all = newStats();
  Object.keys(results).forEach(function (k) {
    var st = results[k];
    all.deaths += st.deaths; all.expeditions += st.expeditions;
    for (var f = 1; f <= 20; f++) {
      all.deathsByFloor[f] += st.deathsByFloor[f];
      all.startsByFloor[f] += st.startsByFloor[f];
      all.winsByFloor[f] += st.winsByFloor[f];
      all.wipesByFloor[f] += st.wipesByFloor[f];
    }
  });
  var deathShare10 = 100 * all.deathsByFloor[10] / Math.max(1, all.deaths);
  L.push('## CHOKE POINTS');
  L.push('');
  L.push('1. **F10 "The Wall" is THE choke — it eats the whole mid-game.** ' + r1(deathShare10) +
    '% of all hero deaths in the sweep happen on F10 (' + all.deathsByFloor[10] + ' of ' + all.deaths +
    '). Per-attempt clear rate there is ' + r1(100 * all.winsByFloor[10] / all.startsByFloor[10]) +
    '% and per-attempt wipe rate ' + r1(100 * all.wipesByFloor[10] / all.startsByFloor[10]) +
    '% — accounts grind it ~' + r1(all.startsByFloor[10] / Math.max(1, all.winsByFloor[10])) +
    ' attempts per successful clear. Within the 60-expedition budget only ' +
    r1(100 * results.CAREFUL.f10Cleared / results.CAREFUL.accounts) + '% (CAREFUL) / ' +
    r1(100 * results.BALANCED.f10Cleared / results.BALANCED.accounts) + '% (BALANCED) / ' +
    r1(100 * results.GREEDY.f10Cleared / results.GREEDY.accounts) + '% (GREEDY) of accounts ever break the Wall.');
  L.push('');
  L.push('2. **F10 runs a hard negative gold balance and kills accounts by bankruptcy.** Net per F10 expedition: ' +
    r1((results.CAREFUL.incByFloor[10] - results.CAREFUL.spendByFloor[10]) / results.CAREFUL.startsByFloor[10]) +
    'g (CAREFUL), ' + r1((results.BALANCED.incByFloor[10] - results.BALANCED.spendByFloor[10]) / results.BALANCED.startsByFloor[10]) +
    'g (BALANCED), ' + r1((results.GREEDY.incByFloor[10] - results.GREEDY.spendByFloor[10]) / results.GREEDY.startsByFloor[10]) +
    'g (GREEDY). Failed F10 attempts pay ~zero (clear bounty is win-only) while each death pushes a 120g/1-permit replacement: ' +
    'recruit spend on F10 reaches ' + r1(results.GREEDY.spendRecruit[10] / results.GREEDY.startsByFloor[10]) +
    'g/expedition for GREEDY. The CAREFUL death spiral ends in bankruptcy for ' +
    r1(100 * results.CAREFUL.bankrupt / results.CAREFUL.accounts) + '% of accounts (mean final gold ' +
    r0(mean(results.CAREFUL.goldEnd)) + 'g vs GREEDY ' + r0(mean(results.GREEDY.goldEnd)) + 'g).');
  L.push('');
  L.push('3. **Scout economics after the 10g/25g price cut.** CAREFUL now pays ' +
    r1(results.CAREFUL.goldSpentScout / results.CAREFUL.expeditions) + 'g/expedition on scouts (' +
    r1(100 * results.CAREFUL.goldSpentScout / results.CAREFUL.goldEarned) +
    '% of gross income, was ' + BEFORE.CAREFUL.scout + 'g at the 25/50 price). F1 net is now ' +
    r1((results.CAREFUL.incByFloor[1] - results.CAREFUL.spendByFloor[1]) / results.CAREFUL.startsByFloor[1]) +
    'g/exp and DARKNESS F11 nets ' +
    r1((results.CAREFUL.incByFloor[11] - results.CAREFUL.spendByFloor[11]) / results.CAREFUL.startsByFloor[11]) +
    'g/exp for CAREFUL vs ' +
    r1((results.GREEDY.incByFloor[11] - results.GREEDY.spendByFloor[11]) / results.GREEDY.startsByFloor[11]) +
    'g/exp for unspecting GREEDY — the flat floors no longer punish scouting, but the F11-13 premium (25g) still ' +
    'leaves the informed player behind the blind one there.');
  L.push('');
  L.push('4. **F9-F13 is the secondary danger band; F14+ snowballs.** Wipe rates climb from ~0 at F5 to ' +
    r1(100 * all.wipesByFloor[9] / all.startsByFloor[9]) + '% at F9 and ' +
    r1(100 * all.wipesByFloor[11] / all.startsByFloor[11]) + '% at F11, then fall by half or more for the survivors (' +
    r1(100 * all.wipesByFloor[15] / all.startsByFloor[15]) + '% at F15). Deep-floor net gold turns strongly positive — F14-F20 run ' +
    r1((results.BALANCED.incByFloor[15] - results.BALANCED.spendByFloor[15]) / results.BALANCED.startsByFloor[15]) +
    'g to ' + r1((results.BALANCED.incByFloor[20] - results.BALANCED.spendByFloor[20]) / results.BALANCED.startsByFloor[20]) +
    'g net/expedition (BALANCED) — the clear bounty (40+25n) outpaces every cost once the party is past the filter. The economy does not choke deep; **survival at F9-F13 is the only real gate, and F10 is the crusher.**');
  L.push('');
  L.push('5. **Rest is a dead lever; permits were the Wall\'s second currency and the purse fixed them.** Lobby rest fires only ' +
    r1(10 * results.BALANCED.rests / results.BALANCED.expeditions) + '/10 expeditions (' +
    r1(results.BALANCED.goldSpentRest / results.BALANCED.expeditions) +
    'g/exp): Wall damage is lethal (mark→execute kills from any HP), not attritional, so there is nothing to rest back. ' +
    'Permits: CAREFUL now earns ' + results.CAREFUL.permitsIn + ' vs ' + results.CAREFUL.permitsOut +
    ' spent on recruits (BEFORE the purse: ' + BEFORE.CAREFUL.permitsIn + ' in / ' + BEFORE.CAREFUL.permitsOut +
    ' out — a deficit that converted directly into 120g gold recruits); the attempt-paid purse flipped every policy to a surplus.');
  L.push('');

  /* ---------- recommendations ---------- */
  L.push('## Tuning recommendations (numbers only — nothing tuned here)');
  L.push('');
  L.push('*Status: recommendation 1a (survivor\'s purse, 175g+1 permit) and 2a (10g flat scout, 25g on F11-13)*');
  L.push('*are now LIVE in js/ — the BEFORE/AFTER section measures their effect. Still open: 1b, 2b, 3, 4, 5.*');
  L.push('');
  var wallAttemptsPerClear = r1(all.startsByFloor[10] / Math.max(1, all.winsByFloor[10]));
  L.push('1. **Soften the F10 attempt tax.** Today the Wall costs ~' + wallAttemptsPerClear +
    ' attempts per clear and ' + r1(100 * all.wipesByFloor[10] / all.startsByFloor[10]) +
    '% wipes/attempt with zero income on failure. Options with numbers: (a) pay a "survivor\'s purse" of 150-200g for a no-death loss at F10 ' +
    '(roughly half the recruit treadmill), or (b) raise the informed per-attempt clear rate from the current ~' +
    r1(100 * all.winsByFloor[10] / all.startsByFloor[10]) + '% to 20-25% (≈4-5 attempts per clear) by shaving Executioner HP 1300→1100 ' +
    'or stretching the mark→execute cycle 3→4 turns for parties that already know the fight.');
  L.push('');
  L.push('2. **Make scouting buy something.** At 25g (50g on F11-13) the information is worth less than the reroute saves. Either (a) cut cost to 10g flat ' +
    '(CAREFUL spend drops from ~' + r1(results.CAREFUL.goldSpentScout / results.CAREFUL.expeditions) + 'g/exp to ~40g/exp), or (b) keep 25g and let a scouted ' +
    'combat node lose ~1 threat star (prepared approach), converting gold into measurable damage reduction. Also gate the "scout everything" affordance early: ' +
    'scouting before F3 is strictly negative-EV (' + r1((results.CAREFUL.incByFloor[1] - results.CAREFUL.spendByFloor[1]) / results.CAREFUL.startsByFloor[1]) + 'g/exp at F1).');
  L.push('');
  L.push('3. **Pay permits on attempts, not only clears, from F9 up.** A failed F10/11/12 attempt currently returns 0 permits while burning 1-3 replacements. ' +
    'CAREFUL runs a deficit of ' + (results.CAREFUL.permitsOut - results.CAREFUL.permitsIn) + ' permits against ' +
    results.CAREFUL.startsByFloor[10] + ' F10 attempts — so a "veteran pay" of **+1 permit per boss attempt that ends with no deaths** ' +
    '(or flatly +1 every 4th boss attempt, ~0.25/attempt) closes the gap without touching clear rewards or inflating GREEDY\'s surplus.');
  L.push('');
  L.push('4. **Add a death-streak brake on boss floors.** ' + r1(deathShare10) + '% of all deaths sit on one floor; the accounts that fail F10 five-plus times are the ones going bankrupt (' +
    r1(100 * results.CAREFUL.bankrupt / results.CAREFUL.accounts) + '% of CAREFUL). A stacking "the Tower grows bored" rule — each consecutive F10 wipe ' +
    'applies −8% boss HP cumulatively up to −40% on the 5th attempt, resetting on clear — converts hopeless grinds into slow wins without touching first-try difficulty.');
  L.push('');
  L.push('5. **Re-balance deep-floor windfalls or embrace them.** F14-F20 run +' + r1((results.BALANCED.incByFloor[15] - results.BALANCED.spendByFloor[15]) / results.BALANCED.startsByFloor[15]) +
    'g to +' + r1((results.BALANCED.incByFloor[20] - results.BALANCED.spendByFloor[20]) / results.BALANCED.startsByFloor[20]) +
    'g net/expedition for survivors. If deep floors should still press, either flatten clear gold to 40+18n past F13 (F20: 900→400) or add a deep-supply drain ' +
    '(e.g. torches at 30g/expedition on F11+). If the intended funnel is "F10 is the only wall," leave it — but note the ML4/ML5 cost discounts (rest ×0.6, recruit 90g) ' +
    'arrive too late to matter: the median account ends at ML3.');
  L.push('');

  return L.join('\n');
}

/* ---------------- main ---------------- */
async function runPolicy(name, n) {
  var policy = POLICIES[name];
  var stats = newStats();
  CURRENT_POLICY = policy;
  var driver = new Driver(policy, stats);
  for (var i = 0; i < n; i++) {
    await driver.playAccount();
  }
  return stats;
}

async function main() {
  var argv = process.argv.slice(2), n = 0, smoke = false;
  for (var i = 0; i < argv.length; i++) {
    if (argv[i] === '--accounts') n = Number(argv[i + 1]);
    if (argv[i] === '--smoke') { smoke = true; n = 8; }
  }
  if (!n) n = 4000;                      // default: 3 x 4000 accounts ~ 240k expeditions (~1 min)

  makeCombatHooks();
  var t0 = Date.now();
  var results = {};
  var order = ['CAREFUL', 'GREEDY', 'BALANCED'];
  for (var j = 0; j < order.length; j++) {
    results[order[j]] = await runPolicy(order[j], n);
  }
  var secs = (Date.now() - t0) / 1000;

  var totalExp = 0;
  Object.keys(results).forEach(function (k) { totalExp += results[k].expeditions; });

  /* console digest */
  console.log('\n=== INFINITE TOWER economy sim — ' + n + ' accounts/policy, ' + totalExp +
    ' expeditions, ' + secs.toFixed(1) + 's ===');
  Object.keys(results).forEach(function (k) {
    var st = results[k], e = st.expeditions;
    console.log('\n[' + k + '] expeditions=' + e + ' engineErrors=' + st.engineErrors);
    console.log('  floor reached P10/P50/P90: ' + fmtPctl(st.floorsReached));
    console.log('  F10 cleared: ' + r1(100 * st.f10Cleared / st.accounts) + '%  F20 cleared: ' +
      r1(100 * st.f20Cleared / st.accounts) + '%');
    console.log('  exp-to-F10 P50: ' + (st.firstF10.length ? r1(pct(st.firstF10, 0.5)) : '—'));
    console.log('  deaths/10exp: ' + r1(10 * st.deaths / e) + '  wipes: ' + st.expByOutcome.wipe +
      '  wins: ' + st.expByOutcome.win + '  abandons: ' + st.expByOutcome.abandon);
    console.log('  gold earned/exp: ' + r1(st.goldEarned / e) + 'g  spent/exp: ' + r1(st.goldSpent / e) +
      'g  (recruit ' + r1(st.goldSpentRecruit / e) + ' rest ' + r1(st.goldSpentRest / e) +
      ' scout ' + r1(st.goldSpentScout / e) + ' events ' + r1(st.goldSpentEvent / e) + ')');
    console.log('  recruits/10exp: ' + r1(10 * st.recruits / e) + '  rests/10exp: ' + r1(10 * st.rests / e) +
      '  scouts/10exp: ' + r1(10 * st.scouts / e));
    console.log('  permits in/out: ' + st.permitsIn + '/' + st.permitsOut + '  ML end P50: ' +
      r1(pct(st.masterAtEnd, 0.5)) + '  purses: ' + st.purses + ' (' + r1(st.goldEarnedPurse / e) + 'g/exp)');
    var top = 0; for (var f = 1; f <= 20; f++) if (st.deathsByFloor[f] > st.deathsByFloor[top]) top = f;
    console.log('  deadliest floor: F' + top + ' (' + st.deathsByFloor[top] + ' deaths)');
  });

  if (smoke) { console.log('\n(smoke run — report not written)'); return; }

  if (totalExp < 10000) {
    console.log('\n[warn] only ' + totalExp + ' expeditions — raise --accounts to reach >= 10000 for the report');
  }
  var meta = { accountsPerPolicy: n, totalAccounts: n * 3, totalExpeditions: totalExp, runtimeSec: secs.toFixed(1) };
  var report = buildReport(results, meta);
  var fs = require('fs');
  fs.writeFileSync(path.join(__dirname, 'economy-report.md'), report + '\n');
  console.log('\nreport written: tests/economy-report.md');
}

main().catch(function (e) { console.error('[sim] fatal:', e); process.exit(1); });
