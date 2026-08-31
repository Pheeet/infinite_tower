#!/usr/bin/env node
'use strict';
/* ============================================================================
   INFINITE TOWER — GOLDEN TEST SUITE (function-level combat math freeze)
   Engine under test: ../js/core.js + ../js/combat.js + ../js/map.js (v0.7).
   NEVER modifies engine files. Zero dependencies (node stdlib only).

   What this freezes
   -----------------
   Every case calls a named PROBE against the engine's PUBLIC surface
   (IT.*, IT.combat.*, IT.map.*) with Math.random replaced by a seeded
   mulberry32 PRNG (seed recorded per case). The probe's return value is
   deep-compared (exact) against the frozen `expect` in golden-cases.json.
   A Godot/GDScript port reproduces the same numbers by implementing:
     - the formulas documented in each case's `note`, AND
     - the same mulberry32 stream + the same Math.random consumption ORDER
       for the seeded micro-battle cases (see JSON header).

   Usage
   -----
     node tests/golden.js            run all cases, exit 1 on any fail
     node tests/golden.js --update   recompute expectations from the CURRENT
                                     engine and rewrite golden-cases.json
                                     (use after an intentional rebalance)

   Determinism
   -----------
   Math.random is swapped for mulberry32(seed) around each case and restored
   after. No other nondeterminism exists in the engine paths under test
   (Date.now() is only used for telemetry save-throttling, which has no
   effect on returned values). Battles run with IT.combat.FAST = true
   (all delays 0) in a headless DOM-less environment.
   ============================================================================ */

var fs = require('fs');
var path = require('path');
var vm = require('vm');
var crypto = require('crypto');

var ROOT = path.resolve(__dirname, '..');
var CASES_FILE = path.join(__dirname, 'golden-cases.json');
var ENGINE_FILES = ['js/core.js', 'js/combat.js', 'js/map.js'];

/* ------------------------------------------------------------------ */
/* headless browser shims                                              */
/* ------------------------------------------------------------------ */
global.window = global;
global.localStorage = {
  _s: Object.create(null),
  getItem: function (k) { return (k in this._s) ? this._s[k] : null; },
  setItem: function (k, v) { this._s[k] = String(v); },
  removeItem: function (k) { delete this._s[k]; }
};
/* no `document` on purpose: combat.js typeof-guards it (HAS_DOM=false),
   core.js never touches it. */

function loadEngine(file) {
  var src = fs.readFileSync(path.join(ROOT, file), 'utf8');
  vm.runInThisContext(src, { filename: file });
}
ENGINE_FILES.forEach(loadEngine);
var IT = global.IT;
if (!IT || !IT.combat || !IT.map) {
  console.error('[golden] FATAL: engine failed to load headless');
  process.exit(2);
}

/* ------------------------------------------------------------------ */
/* seeded RNG — the exact stream a port must reproduce                  */
/* ------------------------------------------------------------------ */
function mulberry32(a) {
  a = a >>> 0;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    var t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
var MATH_RANDOM_SENTINEL = Math.random; // never called: sentinel for restore

function seedRng(seed) { Math.random = mulberry32(seed); }
function restoreRng() { Math.random = MATH_RANDOM_SENTINEL; }

/* ------------------------------------------------------------------ */
/* helpers                                                              */
/* ------------------------------------------------------------------ */
function sha256(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(path.join(ROOT, file))).digest('hex').slice(0, 16);
}
function deepClone(v) { return JSON.parse(JSON.stringify(v)); }
function stable(v) {
  if (Array.isArray(v)) return v.map(stable);
  if (v && typeof v === 'object') {
    var o = {}, ks = Object.keys(v).sort();
    ks.forEach(function (k) { o[k] = stable(v[k]); });
    return o;
  }
  return v;
}
function deepEqual(a, b) {
  return JSON.stringify(stable(a)) === JSON.stringify(stable(b));
}

/* Build a plain hero object (same shape core.makeHero produces) from a
 * compact spec. Everything is explicit — no rolls, fully deterministic. */
function mkHero(sp, id) {
  var maxHp = sp.maxHp != null ? sp.maxHp : 100;
  var h = {
    id: id,
    name: sp.name || ('H' + id),
    cls: sp.cls || 'Warrior',
    rarity: sp.rarity || 2,
    lvl: sp.lvl || 1,
    exp: sp.exp || 0,
    maxHp: maxHp,
    hp: sp.hp != null ? sp.hp : maxHp,
    atk: sp.atk != null ? sp.atk : 20,
    def: sp.def != null ? sp.def : 0,
    agi: sp.agi != null ? sp.agi : 10,
    courage: sp.courage != null ? sp.courage : 50,
    greed: sp.greed != null ? sp.greed : 50,
    loyalty: sp.loyalty != null ? sp.loyalty : 50,
    fear: sp.fear != null ? sp.fear : 15,
    kills: 0, floors: 0,
    memories: [],
    rel: {},
    items: sp.items || { weapon: null, armor: null, trinket: null },
    grieving: sp.grieving || 0,
    skills: sp.skills || ['strike'],
    reaction: sp.reaction || 'steady',
    trait: (sp.trait === undefined) ? null : sp.trait
  };
  IT.label(h); // populate personality (pure axis math)
  return h;
}

function freshState(opts) {
  IT.newGame();
  var S = IT.S;
  opts = opts || {};
  if (opts.master) S.master = { level: opts.master, exp: 0 };
  if (opts.gold != null) S.gold = opts.gold;
  if (opts.permits != null) S.permits = opts.permits;
  if (opts.knowledge) {
    S.knowledge.executioner = !!opts.knowledge.executioner;
    S.knowledge.hollowKing = !!opts.knowledge.hollowKing;
  }
  return S;
}

/* ------------------------------------------------------------------ */
/* THE BATTLE PROBE                                                     */
/*                                                                      */
/* Runs one scripted micro-battle through the real public entry point   */
/* IT.combat.start(cfg) with FAST=true, then reads the engine's own     */
/* observables: the returned result object, IT.combat.lastUsage,        */
/* IT.combat.debug().lines (the battle log, damage numbers included),   */
/* and the live hero objects in IT.S (hp persists through the battle).  */
/* ------------------------------------------------------------------ */
var dmgRe = /^(.*?) → (.*?) for (\d+)/;
var dotRe = /sears (.*?) for (\d+)/;
var healRe = /heals (.*?) for (\d+)/;

async function battleProbe(args) {
  args = args || {};
  IT.combat.FAST = true;
  /* args.auto / args.autoCmd are choice STRINGS in the JSON; the engine hooks
   * want functions — wrap them. Reactions layer is STRIPPED by default
   * (IT.combat.REACTIONS = false, the engine's own test hook) so frozen
   * numbers isolate the system under test; reaction cases opt in with
   * reactions: true. */
  IT.combat.auto = args.auto ? function () { return args.auto; } : null;
  IT.combat.autoCmd = args.autoCmd ? function () { return args.autoCmd; } : null;
  IT.combat.REACTIONS = args.reactions === true;

  var S = freshState(args);
  var heroes = (args.heroes || []).map(function (sp, i) { return mkHero(sp, i + 1); });
  S.heroes = heroes;
  S.party = heroes.map(function (h) { return h.id; });

  /* test-supplied skill DATA rows — exactly the documented way the engine
   * consumes skills (pure data in IT.SKILLS; nothing hardcoded per id) */
  var cs = args.customSkills || {};
  Object.keys(cs).forEach(function (id) {
    IT.SKILLS[id] = Object.assign({}, cs[id], { id: id });
  });

  var enemies;
  if (args.floorEnemies) {
    enemies = IT.combat.makeEnemies(args.floorEnemies);
  } else {
    enemies = (args.enemies || [{ name: 'E1', maxHp: 100, atk: 5, def: 0 }]).map(function (e, i) {
      return {
        name: e.name || ('E' + (i + 1)), maxHp: e.maxHp || 100, atk: e.atk || 0,
        def: e.def || 0, bounty: e.bounty || 0, boss: !!e.boss, elite: !!e.elite
      };
    });
  }

  var cfg = {
    floor: args.floor || 1,
    kind: args.kind || 'node',
    canRetreat: args.canRetreat !== false,
    enemies: enemies
  };

  var result = await IT.combat.start(cfg);

  var dbg = IT.combat.debug() || {};
  var lines = (dbg.lines || []).map(function (l) { return l.t; });

  var dmgLines = [];          // "src>target=amount" per blow
  var dots = {};              // target -> [amounts] (Burn sears X for N)
  var heals = {};             // target -> [amounts] (heals X for N)
  lines.forEach(function (t) {
    var m = t.match(dmgRe);
    if (m) { dmgLines.push(m[1] + '>' + m[2] + '=' + m[3]); return; }
    m = t.match(dotRe);
    if (m) { (dots[m[1]] = dots[m[1]] || []).push(+m[2]); return; }
    m = t.match(healRe);
    if (m) { (heals[m[1]] = heals[m[1]] || []).push(+m[2]); }
  });

  var match = {};
  (args.match || []).forEach(function (sub) {
    var n = 0;
    lines.forEach(function (t) { if (t.indexOf(sub) >= 0) n++; });
    match[sub] = n;
  });

  var hpAfter = {};
  heroes.forEach(function (h) { hpAfter[h.name] = Math.max(0, Math.round(h.hp)); });

  var out = {
    round: dbg.round,
    win: !!(result && result.win),
    retreated: !!(result && result.retreated),
    deaths: (result && result.deaths) || [],
    dmg: dmgLines,
    dots: Object.keys(dots).sort().length ? dots : {},
    heals: Object.keys(heals).sort().length ? heals : {},
    lastUsage: IT.combat.lastUsage || {},
    hpAfter: hpAfter,
    match: match,
    fearAfter: (function () { var f = {}; heroes.forEach(function (h) { f[h.name] = h.fear; }); return f; })(),
    lines: args.returnLines ? lines.slice(0, 40) : undefined
  };
  if (!Object.keys(out.dots).length) delete out.dots;
  if (!Object.keys(out.heals).length) delete out.heals;
  if (out.lines === undefined) delete out.lines;
  return out;
}

/* ------------------------------------------------------------------ */
/* PURE PROBES (no battle — direct public-function calls)               */
/* ------------------------------------------------------------------ */

function probeRndSeq(a) {
  var out = [], i;
  for (i = 0; i < (a.n || 1); i++) out.push(IT.rnd(a.a, a.b));
  return { rounded: out.map(function (v) { return Math.round(v * 1e6) / 1e6; }) };
}

function probeRiSeq(a) {
  var out = [], i;
  for (i = 0; i < (a.n || 1); i++) out.push(IT.ri(a.a, a.b));
  return { values: out };
}

function probeExpNeed(a) {
  return { curve: a.lvls.map(IT.expNeed) };
}

function probeGrantExp(a) {
  var h = mkHero(a.hero, 1);
  var gained = IT.grantExp(h, a.amount);
  return {
    gained: gained, lvl: h.lvl, exp: h.exp,
    maxHp: h.maxHp, atk: h.atk, def: h.def, agi: h.agi, hp: h.hp
  };
}

function probeMasterCurve(a) {
  return { need: a.lvls.map(IT.masterExpNeed) };
}

function probeGrantMasterExp(a) {
  var S = freshState({});
  S.master = { level: a.level, exp: a.exp };
  var gained = IT.grantMasterExp(a.n);
  return { gained: gained, level: S.master.level, exp: S.master.exp };
}

function probeCostHooks(a) {
  var S = freshState({});
  S.master = { level: a.level, exp: 0 };
  return {
    level: a.level,
    rosterCap: IT.rosterCap(), recruitCost: IT.recruitCost(),
    restMult: IT.restMult(), masterExpNeed: IT.masterExpNeed(a.level)
  };
}

function probeFloorRewards(a) {
  var g = {}, p = {};
  a.floors.forEach(function (n) { g[n] = IT.floorClearGold(n); p[n] = IT.floorClearPermits(n); });
  return { gold: g, permits: p };
}

function probeScoutCost(a) {
  var c = {};
  a.floors.forEach(function (n) { c[n] = IT.map.scoutCost(n); });
  c.constant = IT.map.ScoutCost;
  return { costs: c };
}

function probeMakeEnemies(a) {
  var out = {};
  a.floors.forEach(function (n) {
    out[n] = IT.combat.makeEnemies(n).map(function (e) {
      return { name: e.name, maxHp: e.maxHp, atk: e.atk, def: e.def, bounty: e.bounty, boss: !!e.boss, elite: !!e.elite };
    });
  });
  return { floors: out };
}

function probeDecide(a) {
  var h = mkHero(a.hero, 1);
  var r = IT.decide(h, a.action, a.ctx || {});
  return { verdict: r.verdict, score: r.score }; // line text is flavor, not math
}

function probeLabel(a) {
  var h = mkHero(a.hero, 1);
  return { personality: IT.label(h) };
}

function probeReactionFor(a) {
  return { reaction: IT.reactionFor(mkHero(a.hero, 1)) };
}

function probeRest(a) {
  var S = freshState({ master: a.masterLevel });
  S.heroes = a.heroes.map(function (sp, i) { return mkHero(sp, i + 1); });
  var r = IT.rest();
  return {
    cost: r ? r.cost : null,
    hp: S.heroes.map(function (h) { return h.hp; }),
    fear: S.heroes.map(function (h) { return h.fear; }),
    gold: S.gold
  };
}

function probeBonds(a) {
  var S = freshState({});
  S.heroes = a.heroes.map(function (sp, i) { return mkHero(sp, i + 1); });
  var log = [];
  (a.ops || []).forEach(function (op) {
    if (op[0] === 'addBond') log.push(IT.addBond(op[1], op[2], op[3]));
    else if (op[0] === 'bond') log.push(IT.bond(op[1], op[2]));
  });
  return {
    log: log,
    bondedPairs: IT.bondedPairs(a.party || []).map(function (p) { return p.slice(); }),
    mourners: IT.mournersOf(a.deadId != null ? a.deadId : 1)
  };
}

function probeRollRarity(a) {
  var counts = { 1: 0, 2: 0, 3: 0, 4: 0 }, i;
  for (i = 0; i < a.n; i++) counts[IT.rollRarity()]++;
  return { n: a.n, counts: counts };
}

function probeRollTraitSeq(a) {
  var out = [], i;
  for (i = 0; i < (a.n || 1); i++) out.push(IT.rollTrait());
  return { traits: out };
}

function probeMakeHeroSeq(a) {
  freshState({});
  var out = [], i;
  for (i = 0; i < (a.n || 1); i++) {
    var h = IT.makeHero();
    out.push({
      name: h.name, cls: h.cls, rarity: h.rarity,
      maxHp: h.maxHp, atk: h.atk, def: h.def, agi: h.agi,
      courage: h.courage, greed: h.greed, loyalty: h.loyalty, fear: h.fear,
      trait: h.trait, reaction: h.reaction, personality: h.personality
    });
  }
  return { heroes: out };
}

function probeGachaFlow(a) {
  var S = freshState({ gold: a.gold, permits: a.permits, master: a.masterLevel });
  var got = [];
  for (var i = 0; i < a.n; i++) {
    var r = IT.gacha();
    if (!r) { got.push(null); continue; }
    got.push({
      name: r.hero.name, cls: r.hero.cls, rarity: r.hero.rarity,
      maxHp: r.hero.maxHp, atk: r.hero.atk, def: r.hero.def,
      trait: r.hero.trait, reaction: r.hero.reaction, used: r.used
    });
  }
  return { recruits: got, gold: S.gold, permits: S.permits, roster: S.heroes.length };
}

function probeTelemetryNormalize(a) {
  freshState({});
  var st = IT.migrateToV7({ heroes: [], telemetry: a.telemetry });
  return { telemetry: st.telemetry, ver: st.ver };
}

/* ------------------------------------------------------------------ */
/* PROBE REGISTRY                                                       */
/* ------------------------------------------------------------------ */
var PROBES = {
  battle: battleProbe,
  rnd_seq: probeRndSeq,
  ri_seq: probeRiSeq,
  exp_need: probeExpNeed,
  grant_exp: probeGrantExp,
  master_curve: probeMasterCurve,
  grant_master_exp: probeGrantMasterExp,
  cost_hooks: probeCostHooks,
  floor_rewards: probeFloorRewards,
  scout_cost: probeScoutCost,
  make_enemies: probeMakeEnemies,
  decide: probeDecide,
  label: probeLabel,
  reaction_for: probeReactionFor,
  rest: probeRest,
  bonds: probeBonds,
  roll_rarity: probeRollRarity,
  roll_trait_seq: probeRollTraitSeq,
  make_hero_seq: probeMakeHeroSeq,
  gacha_flow: probeGachaFlow,
  telemetry_normalize: probeTelemetryNormalize
};

/* ------------------------------------------------------------------ */
/* test-skill builders (pure data rows — same fields IT.SKILLS specs    */
/* use; the engine consumes them generically, no test-specific paths)   */
/* ------------------------------------------------------------------ */
function atk(power, extra) {
  return Object.assign({
    cls: '*', tier: 'basic', target: 'enemy', type: 'attack',
    power: power, cd: 0, cost: null, effects: [], condition: null, ai: 10, name: 'GS'
  }, extra || {});
}
function selfBuff(effects, extra) {
  return Object.assign({
    cls: '*', tier: 'basic', target: 'self', type: 'buff',
    power: 0, cd: 3, cost: null, effects: effects, condition: null, ai: 10, name: 'GB'
  }, extra || {});
}

/* ------------------------------------------------------------------ */
/* CASE DEFINITIONS                                                     */
/* order = documentation order; expectations are (re)generated by       */
/* --update and live in golden-cases.json                               */
/* ------------------------------------------------------------------ */
var CASES = [
/* ============================ RNG / variance ============================ */
{ id: 'rng-001', category: 'rng', fn: 'rnd_seq', seed: 7,
  args: { a: 0.85, b: 1.15, n: 8 },
  note: 'IT.rnd(0.85,1.15) = 0.85 + u*(0.30), u = mulberry32 draws. This is the rawDmg variance term v. 8 draws frozen to 1e-6.' },
{ id: 'rng-002', category: 'rng', fn: 'ri_seq', seed: 5,
  args: { a: 6, b: 14, n: 10 },
  note: 'IT.ri(6,14) = floor(6 + u*9) — the fallen-item stat roller. Bounds 6..14; draws frozen.' },
{ id: 'rng-003', category: 'rng', fn: 'rnd_seq', seed: 101,
  args: { a: 0, b: 1, n: 6 },
  note: 'Raw mulberry32(seed=101) unit interval draws — the PRNG curve itself. A port must reproduce these exactly to pass any seeded case.' },

/* ============================ rawDmg (via battle) ============================ */
{ id: 'rawdmg-001', category: 'rawdmg', fn: 'battle', seed: 11,
  args: { heroes: [{ name: 'A', cls: 'Warrior', atk: 100, def: 0, hp: 200, maxHp: 200, skills: ['gs'] }],
    enemies: [{ name: 'E1', maxHp: 120, atk: 0, def: 0 }],
    customSkills: { gs: atk(1.0) } },
  note: 'rawDmg(atk=100, mult=1.0, def=0) = max(1, round(100*v - 0)), v=rnd(0.85,1.15) (2nd Math.random draw: 1st is pickSkill jitter). Enemy hp 120 needs 2 hits.' },
{ id: 'rawdmg-002', category: 'rawdmg', fn: 'battle', seed: 12,
  args: { heroes: [{ name: 'A', atk: 40, def: 0, hp: 200, maxHp: 200, skills: ['gs'] }],
    enemies: [{ name: 'E1', maxHp: 60, atk: 0, def: 4 }],
    customSkills: { gs: atk(0.75) } },
  note: 'mult=0.75 with def 4: round(40*0.75*v - 4*0.6) = round(30v - 2.4). Strike-spec multiplier path.' },
{ id: 'rawdmg-003', category: 'rawdmg', fn: 'battle', seed: 13,
  args: { heroes: [{ name: 'A', atk: 5, def: 0, hp: 100, maxHp: 100, skills: ['gs'] }],
    enemies: [{ name: 'E1', maxHp: 3, atk: 0, def: 50 }],
    customSkills: { gs: atk(0.75) } },
  note: 'def > atk floor: 5*0.75*v - 50*0.6 is deeply negative -> max(1, ...) = 1 every hit.' },
{ id: 'rawdmg-004', category: 'rawdmg', fn: 'battle', seed: 14,
  args: { heroes: [{ name: 'A', atk: 100, def: 0, hp: 400, maxHp: 400, skills: ['gs'] }],
    enemies: [{ name: 'E1', maxHp: 300, atk: 0, def: 40 }],
    customSkills: { gs: atk(1.0) } },
  note: 'heavy def subtraction: round(100v - 24), always >= 61 at v=0.85.' },
{ id: 'rawdmg-005', category: 'rawdmg', fn: 'battle', seed: 15,
  args: { heroes: [{ name: 'A', atk: 30, def: 0, hp: 200, maxHp: 200, skills: ['gs'] }],
    enemies: [{ name: 'E1', maxHp: 100, atk: 0, def: 10 }],
    customSkills: { gs: atk(1.4) } },
  note: 'mult=1.4 (Crushing Blow power): round(42v - 6).' },
{ id: 'rawdmg-006', category: 'rawdmg', fn: 'battle', seed: 21,
  args: { heroes: [{ name: 'A', atk: 100, def: 0, hp: 200, maxHp: 200, skills: ['gs'] }],
    enemies: [{ name: 'E1', maxHp: 400, atk: 12, def: 0 }],
    customSkills: { gs: atk(1.0) } },
  note: 'multi-round variance sequence: damage per round round(100*v_k) plus incoming max(1, round(12*w_k)) until E1 (400hp) dies. Freezes the v-sequence, not just one draw.' },
{ id: 'rawdmg-007', category: 'rawdmg', fn: 'battle', seed: 1,
  args: { heroes: [{ name: 'A', atk: 100, def: 0, hp: 200, maxHp: 200, skills: ['gs'] }],
    enemies: [{ name: 'E1', maxHp: 120, atk: 0, def: 0 }],
    customSkills: { gs: atk(1.0) } },
  note: 'seed chosen so the first damage draw v sits near its 0.85 lower bound -> dmg near 85 (variance lower extreme).' },
{ id: 'rawdmg-008', category: 'rawdmg', fn: 'battle', seed: 37,
  args: { heroes: [{ name: 'A', atk: 100, def: 0, hp: 200, maxHp: 200, skills: ['gs'] }],
    enemies: [{ name: 'E1', maxHp: 400, atk: 0, def: 0 }],
    customSkills: { gs: atk(1.0) } },
  note: 'seed chosen so the first damage draw v sits near its 1.15 upper bound -> dmg near 115 (variance upper extreme).' },

/* ============================ effective stats / items ============================ */
{ id: 'eff-001', category: 'effstats', fn: 'battle', seed: 51,
  args: { heroes: [{ name: 'A', atk: 40, def: 10, hp: 120, maxHp: 120, skills: ['gcost'],
      items: { weapon: { atk: 10 }, armor: { def: 5, hp: 20 }, trinket: { hp: 30, atk: 2 } } }],
    enemies: [{ name: 'E1', maxHp: 200, atk: 0, def: 0 }],
    customSkills: { gcost: atk(1.0, { cost: { hpPct: 0.15 }, name: 'GCOST' }) },
    match: ['burns'] },
  note: 'computeEffective: eAtk=round(40+10+2)=52, eDef=15, eMax=120+20+30=170; item hp fills current hp to 170 at battle start. Self-cost skill logs round(eMax*0.15)=26; outgoing hits use eAtk 52.' },
{ id: 'eff-002', category: 'effstats', fn: 'battle', seed: 51,
  args: { heroes: [{ name: 'A', atk: 40, def: 10, hp: 120, maxHp: 120, skills: ['gcost'] }],
    enemies: [{ name: 'E1', maxHp: 200, atk: 0, def: 0 }],
    customSkills: { gcost: atk(1.0, { cost: { hpPct: 0.15 }, name: 'GCOST' }) },
    match: ['burns'] },
  note: 'control for eff-001 (no items): cost = round(120*0.15) = 18, damage from atk 40. Same seed -> same v draws.' },
{ id: 'eff-003', category: 'effstats', fn: 'battle', seed: 52,
  args: { heroes: [{ name: 'A', atk: 40, def: 10, hp: 600, maxHp: 600, skills: ['gs'],
      items: { armor: { def: 5 } } }],
    enemies: [{ name: 'E1', maxHp: 300, atk: 60, def: 0 }],
    customSkills: { gs: atk(1.0) } },
  note: 'incoming damage uses eDef: raw=round(60*v), taken=max(1, round(raw - 15*0.6)) with the armor (+5 def); outgoing unchanged at atk 40.' },

/* ============================ traits ============================ */
{ id: 'trait-001', category: 'traits', fn: 'battle', seed: 61,
  args: { heroes: [{ name: 'A', atk: 40, def: 0, hp: 100, maxHp: 100, trait: 'irongut', skills: ['gcost'] }],
    enemies: [{ name: 'E1', maxHp: 200, atk: 0, def: 0 }],
    customSkills: { gcost: atk(1.0, { cost: { hpPct: 0.15 }, name: 'GCOST' }) },
    match: ['burns'] },
  note: 'irongut: eMax = round(100*1.15) = 115, current hp raised to 115 at start. Self-cost = round(115*0.15) = 17 (17.25 -> 17). hpAfter shows the 115 pool minus cost/hits.' },
{ id: 'trait-002', category: 'traits', fn: 'battle', seed: 62,
  args: { heroes: [{ name: 'A', atk: 100, def: 0, hp: 200, maxHp: 200, trait: 'glassedge', skills: ['gs'] }],
    enemies: [{ name: 'E1', maxHp: 250, atk: 0, def: 0 }],
    customSkills: { gs: atk(1.0) } },
  note: 'glassedge outgoing: eAtk = round(100*1.15) = 115 -> dmg = round(115*v).' },
{ id: 'trait-003', category: 'traits', fn: 'battle', seed: 62,
  args: { heroes: [{ name: 'A', atk: 100, def: 0, hp: 200, maxHp: 200, trait: null, skills: ['gs'] }],
    enemies: [{ name: 'E1', maxHp: 250, atk: 0, def: 0 }],
    customSkills: { gs: atk(1.0) } },
  note: 'control for trait-002 (no trait): dmg = round(100*v). Same seed -> identical v sequence; the ratio to trait-002 isolates the x1.15.' },
{ id: 'trait-004', category: 'traits', fn: 'battle', seed: 63,
  args: { heroes: [{ name: 'A', atk: 30, def: 20, hp: 600, maxHp: 600, trait: 'glassedge', skills: ['gs'] }],
    enemies: [{ name: 'E1', maxHp: 300, atk: 60, def: 0 }],
    customSkills: { gs: atk(1.0) } },
  note: 'glassedge incoming: eDef = round(20*0.85) = 17 -> taken = max(1, round(60*v - 17*0.6)) = max(1, round(60v - 10.2)).' },
{ id: 'trait-005', category: 'traits', fn: 'battle', seed: 63,
  args: { heroes: [{ name: 'A', atk: 30, def: 20, hp: 600, maxHp: 600, trait: null, skills: ['gs'] }],
    enemies: [{ name: 'E1', maxHp: 300, atk: 60, def: 0 }],
    customSkills: { gs: atk(1.0) } },
  note: 'control for trait-004: taken = max(1, round(60v - 12)) with def 20.' },
{ id: 'trait-006', category: 'traits', fn: 'battle', seed: 73,
  args: { heroes: [{ name: 'A', atk: 100, def: 0, hp: 400, maxHp: 400, trait: 'bloodthirst', skills: ['gbt'] }],
    enemies: [{ name: 'E1', maxHp: 200, atk: 5, def: 0 }, { name: 'E2', maxHp: 100, atk: 5, def: 0 }],
    customSkills: { gbt: atk(0.75) } },
  note: 'bloodthirst: +10% dmg while any living enemy hp < 30% maxHp. R1 hits E2 (lowest): round(75v) wounds it under 30; R2 escalates to round(75*1.1*v). Later rounds track E1 dropping under 60/200 too.' },
{ id: 'trait-007', category: 'traits', fn: 'battle', seed: 73,
  args: { heroes: [{ name: 'A', atk: 100, def: 0, hp: 400, maxHp: 400, trait: null, skills: ['gbt'] }],
    enemies: [{ name: 'E1', maxHp: 200, atk: 5, def: 0 }, { name: 'E2', maxHp: 100, atk: 5, def: 0 }],
    customSkills: { gbt: atk(0.75) } },
  note: 'control for trait-006 (no trait): identical targeting/seed, no x1.1 on the wounded-field rounds.' },
{ id: 'trait-008', category: 'traits', fn: 'battle', seed: 72,
  args: { floor: 11, heroes: [{ name: 'A', atk: 100, def: 0, hp: 200, maxHp: 200, trait: 'nighteyes', skills: ['gs'] }],
    enemies: [{ name: 'E1', maxHp: 200, atk: 0, def: 0 }],
    customSkills: { gs: atk(1.0) } },
  note: 'nighteyes on a DARKNESS floor (11): outgoing x1.10 -> round(100*1.1*v) = round(110v). Darkness also multiplies enemy atk by 1.1 at start (0 -> 0 here).' },
{ id: 'trait-009', category: 'traits', fn: 'battle', seed: 72,
  args: { floor: 12, heroes: [{ name: 'A', atk: 100, def: 0, hp: 200, maxHp: 200, trait: null, skills: ['gs'] }],
    enemies: [{ name: 'E1', maxHp: 200, atk: 0, def: 0 }],
    customSkills: { gs: atk(1.0) } },
  note: 'floor-band control: same DARKNESS band (12) without the trait -> plain round(100*v); isolates the nighteyes bonus vs trait-008.' },
{ id: 'trait-010', category: 'traits', fn: 'battle', seed: 73,
  args: { floor: 14, heroes: [{ name: 'A', atk: 100, def: 0, hp: 200, maxHp: 200, trait: 'nighteyes', skills: ['gs'] }],
    enemies: [{ name: 'E1', maxHp: 200, atk: 0, def: 0 }],
    customSkills: { gs: atk(1.0) } },
  note: 'nighteyes OUTSIDE the 11-13 band (floor 14, BLOOD MOON): no bonus -> round(100*v). Hero kept above 30% hp so Blood Moon never fires.' },
{ id: 'trait-011', category: 'traits', fn: 'battle', seed: 74,
  args: { heroes: [{ name: 'A', atk: 100, def: 0, hp: 200, maxHp: 200, trait: 'faintheart', skills: ['gs'] }],
    enemies: [{ name: 'E1', maxHp: 250, atk: 0, def: 0 }],
    customSkills: { gs: atk(1.0) } },
  note: 'faintheart: -10% dmg dealt -> round(100*0.9*v) = round(90v).' },
{ id: 'trait-012', category: 'traits', fn: 'battle', seed: 75,
  args: { reactions: true, kind: 'event', auto: 'retreat',
    heroes: [{ name: 'A', courage: 100, greed: 50, loyalty: 50, fear: 0, atk: 100, def: 0, hp: 200, maxHp: 200, trait: 'faintheart', skills: ['gs'] }],
    enemies: [{ name: 'E1', maxHp: 500, atk: 0, def: 0 }],
    customSkills: { gs: atk(1.0) } },
  note: 'faintheart withdrawal compliance: decide(retreat) for this hero scores 5 (refuse), but the trait forces compliance -> hero withdraws before round 1 ends, battle result retreated=true, deaths empty.' },
{ id: 'trait-013', category: 'traits', fn: 'battle', seed: 75,
  args: { reactions: true, kind: 'event', auto: 'retreat',
    heroes: [{ name: 'A', courage: 100, greed: 50, loyalty: 50, fear: 0, atk: 100, def: 0, hp: 200, maxHp: 200, trait: 'irongut', skills: ['gs'] }],
    enemies: [{ name: 'E1', maxHp: 60, atk: 0, def: 0 }],
    customSkills: { gs: atk(1.0) } },
  note: 'control for trait-012 (trait without the compliance hook): same refuse-score hero refuses the order, battle continues and is won.' },
{ id: 'trait-014', category: 'traits', fn: 'battle', seed: 79,
  args: { heroes: [{ name: 'A', atk: 50, def: 0, hp: 400, maxHp: 400, fear: 80, courage: 50, trait: 'coldblood', skills: ['gs'] }],
    enemies: [{ name: 'E1', maxHp: 300, atk: 20, def: 0 }],
    customSkills: { gs: atk(1.0) }, match: ['frozen'] },
  note: 'coldblood under PANIC (fear 80 >= 75, courage 50 < 70): the 35% freeze never fires (0 frozen lines) but Panic -25% dmg still applies -> round(50*0.75*v) = round(37.5v).' },
{ id: 'trait-015', category: 'traits', fn: 'battle', seed: 79,
  args: { heroes: [{ name: 'A', atk: 50, def: 0, hp: 400, maxHp: 400, fear: 80, courage: 50, trait: null, skills: ['gs'] }],
    enemies: [{ name: 'E1', maxHp: 300, atk: 20, def: 0 }],
    customSkills: { gs: atk(1.0) }, match: ['frozen'] },
  note: 'control for trait-014, same seed: without coldblood the PANIC freeze lands at least once (a turn with no A attack line).' },

/* ============================ barrier / fragile ============================ */
{ id: 'bar-001', category: 'barrier_fragile', fn: 'battle', seed: 81,
  args: { heroes: [{ name: 'A', atk: 60, def: 0, hp: 500, maxHp: 500, skills: ['gbar', 'gs'] }],
    enemies: [{ name: 'E1', maxHp: 150, atk: 60, def: 0 }],
    customSkills: { gbar: selfBuff([{ kind: 'barrier', dur: 1, pct: 0.6 }], { cd: 3 }), gs: atk(1.0, { ai: 1 }) } },
  note: 'barrier 60% on the round it is applied (dur 1 covers the enemy phase to come): incoming raw = round(60*v*0.4), then def. Round 2 the barrier has decayed -> unreduced. Log tags "(barrier)".' },
{ id: 'bar-002', category: 'barrier_fragile', fn: 'battle', seed: 82,
  args: { heroes: [{ name: 'A', atk: 60, def: 0, hp: 500, maxHp: 500, skills: ['gbar', 'gs'] }],
    enemies: [{ name: 'E1', maxHp: 150, atk: 60, def: 0 }],
    customSkills: { gbar: selfBuff([{ kind: 'barrier', dur: 1, pct: 1 }], { cd: 3 }), gs: atk(1.0, { ai: 1 }) } },
  note: '100% barrier (Vanish spec): raw reduced to 0, but the final floor max(1, ...) still deals exactly 1. Engine truth: full barrier is not full immunity.' },
{ id: 'bar-003', category: 'barrier_fragile', fn: 'battle', seed: 83,
  args: { heroes: [{ name: 'A', atk: 60, def: 0, hp: 500, maxHp: 500, skills: ['gfrag', 'gs'] }],
    enemies: [{ name: 'E1', maxHp: 150, atk: 60, def: 0 }],
    customSkills: { gfrag: selfBuff([{ kind: 'fragile', dur: 2, pct: 0.2 }], { cd: 3 }), gs: atk(1.0, { ai: 1 }) } },
  note: 'fragile (Berserk price): taken dmg x1.2 AFTER def subtraction -> round(raw*1.2). Log tags "(fragile)".' },
{ id: 'bar-004', category: 'barrier_fragile', fn: 'battle', seed: 84,
  args: { heroes: [{ name: 'A', atk: 60, def: 0, hp: 500, maxHp: 500, skills: ['gbb', 'gs'] }],
    enemies: [{ name: 'E1', maxHp: 150, atk: 60, def: 0 }],
    customSkills: { gbb: selfBuff([{ kind: 'barrier', dur: 1, pct: 0.5 }, { kind: 'fragile', dur: 2, pct: 0.2 }], { cd: 3 }), gs: atk(1.0, { ai: 1 }) } },
  note: 'barrier + fragile stacked: raw = round(60*v*(1-0.5)), then d = round(raw*(1+0.2)). Both tags appear on the line. Order: barrier first (pre-def), fragile last (post-def).' },
{ id: 'bar-005', category: 'barrier_fragile', fn: 'battle', seed: 85,
  args: { heroes: [{ name: 'A', atk: 40, def: 0, hp: 300, maxHp: 300, skills: ['gdot', 'gs'] }],
    enemies: [{ name: 'E1', maxHp: 200, atk: 5, def: 0 }],
    customSkills: { gdot: selfBuff([{ kind: 'burn', dur: 3, pct: 0.5 }, { kind: 'barrier', dur: 3, pct: 0.5 }], { cd: 5 }), gs: atk(1.0, { ai: 1 }) } },
  note: 'DoT through barrier: burn dot = round(eAtk*0.5) = 20, then applyDot = max(1, round(20*0.5)) = 10 per tick. NOTE ENGINE TRUTH: hero-side burn never decays (tickHeroStatuses only decrements non-burn statuses), so it ticks every hero turn until battle end.' },
{ id: 'bar-006', category: 'barrier_fragile', fn: 'battle', seed: 86,
  args: { heroes: [{ name: 'A', atk: 40, def: 0, hp: 300, maxHp: 300, skills: ['gdotf', 'gs'] }],
    enemies: [{ name: 'E1', maxHp: 200, atk: 5, def: 0 }],
    customSkills: { gdotf: selfBuff([{ kind: 'burn', dur: 3, pct: 0.5 }, { kind: 'fragile', dur: 3, pct: 0.2 }], { cd: 5 }), gs: atk(1.0, { ai: 1 }) } },
  note: 'DoT through fragile: dot 20 amplified x1.2 -> 24 per tick (no def, no intercepts; hp floors still hold).' },

/* ============================ executeBonus ============================ */
{ id: 'exb-001', category: 'executebonus', fn: 'battle', seed: 91,
  args: { heroes: [{ name: 'A', atk: 100, def: 0, hp: 200, maxHp: 200, skills: ['gA', 'gB'] }],
    enemies: [{ name: 'E1', maxHp: 120, atk: 0, def: 0 }],
    customSkills: { gA: atk(1.0, { ai: 10, cd: 1, name: 'GA' }), gB: atk(1.0, { ai: 5, effects: [{ kind: 'executeBonus', dur: 0, pct: 0.5 }], name: 'GB' }) } },
  note: 'executeBonus via effects entry: R1 gA (ai 10 beats 5) leaves E1 under 30% of 120 (=36); R2 gA is on cd so gB fires with m = 1.0*(1+0.5) -> round(150*v), killing it.' },
{ id: 'exb-002', category: 'executebonus', fn: 'battle', seed: 91,
  args: { heroes: [{ name: 'A', atk: 100, def: 0, hp: 200, maxHp: 200, skills: ['gA', 'gB'] }],
    enemies: [{ name: 'E1', maxHp: 1200, atk: 0, def: 0 }],
    customSkills: { gA: atk(1.0, { ai: 10, cd: 1, name: 'GA' }), gB: atk(1.0, { ai: 5, effects: [{ kind: 'executeBonus', dur: 0, pct: 0.5 }], name: 'GB' }) } },
  note: 'executeBonus both regimes in one battle: E1 (1200hp) stays above the 30% line (360) for the first ~9 rounds — gB hits at plain round(100*v); once cumulative damage drops it under 360, gB escalates to round(150*v). Compare early vs late dmg values.' },
{ id: 'exb-003', category: 'executebonus', fn: 'battle', seed: 91,
  args: { heroes: [{ name: 'A', atk: 100, def: 0, hp: 200, maxHp: 200, skills: ['gA', 'gB2'] }],
    enemies: [{ name: 'E1', maxHp: 120, atk: 0, def: 0 }],
    customSkills: { gA: atk(1.0, { ai: 10, cd: 1, name: 'GA' }), gB2: atk(1.0, { ai: 5, executeBonus: 0.5, name: 'GB2' }) } },
  note: 'executeBonus via TOP-LEVEL spec number (the second documented encoding): identical outcome to exb-001 — both encodings must resolve to the same bonus.' },

/* ============================ heal (Mend) ============================ */
{ id: 'heal-001', category: 'heal', fn: 'battle', seed: 101,
  args: { heroes: [
      { name: 'HL', cls: 'Healer', atk: 50, lvl: 3, def: 0, hp: 200, maxHp: 200, agi: 10, skills: ['mend'] },
      { name: 'B', cls: 'Warrior', atk: 40, def: 0, hp: 30, maxHp: 200, agi: 20, skills: ['gs'] }],
    enemies: [{ name: 'E1', maxHp: 60, atk: 0, def: 0 }],
    customSkills: { gs: atk(1.0) } },
  note: 'Mend (spec power 1.6): heal = round((18 + eAtk*1.6 + lvl*2) * 1.6) = round((18+80+6)*1.6) = 166. NOTE ENGINE TRUTH: castSkill multiplies the whole base by spec.power, and the base itself already uses the 1.6 atk coefficient — effectively atk*2.56. Frozen as-is.' },
{ id: 'heal-002', category: 'heal', fn: 'battle', seed: 101,
  args: { heroes: [
      { name: 'HL', cls: 'Healer', atk: 50, lvl: 3, def: 0, hp: 200, maxHp: 200, agi: 10, skills: ['mend'] },
      { name: 'B', cls: 'Warrior', atk: 40, def: 0, hp: 100, maxHp: 200, agi: 20, skills: ['gs'] }],
    enemies: [{ name: 'E1', maxHp: 60, atk: 0, def: 0 }],
    customSkills: { gs: atk(1.0) } },
  note: 'Mend cap: heal amount 166 but hp clamped to eMax -> healed = 100 exactly (hp 100 -> 200 of 200).' },
{ id: 'heal-003', category: 'heal', fn: 'battle', seed: 102,
  args: { heroes: [
      { name: 'HL', cls: 'Healer', atk: 20, lvl: 10, def: 0, hp: 200, maxHp: 200, agi: 10, skills: ['mend'] },
      { name: 'B', cls: 'Warrior', atk: 40, def: 0, hp: 10, maxHp: 300, agi: 20, skills: ['gs'] }],
    enemies: [{ name: 'E1', maxHp: 60, atk: 0, def: 0 }],
    customSkills: { gs: atk(1.0) } },
  note: 'Mend scaling: round((18 + 20*1.6 + 10*2) * 1.6) = round(112) = 112. lvl term is +2/level, uncapped by eMax here.' },

/* ============================ Executioner mark / fizzle ============================ */
{ id: 'fz-001', category: 'exec_fizzle', fn: 'battle', seed: 111,
  args: { floor: 10, floorEnemies: 10, knowledge: { executioner: true },
    heroes: [
      { name: 'T', cls: 'Tank', atk: 180, def: 200, hp: 1000, maxHp: 1000, agi: 10, skills: ['gs'] },
      { name: 'HL', cls: 'Healer', atk: 10, def: 200, hp: 800, maxHp: 800, agi: 11, skills: ['mend'] }],
    customSkills: { gs: atk(1.0) },
    match: ['finds no weakness', 'MARKED', 'EXECUTION'] },
  note: 'F10 informed: boss cycle cleave(r1) -> MARK+dread(r2) -> EXECUTION(r3). Def 200 floors every boss hit at max(1,...)=1; Mend (knowExec retarget) tops the marked hero to full eMax before the axe -> execute FIZZLES: "finds no weakness" then axe dmg round(55+46*0.5*v) reduced by def. deaths empty. Headless start/mark interrupts resolve to choices[0] (focus/hold).' },
{ id: 'fz-002', category: 'exec_fizzle', fn: 'battle', seed: 112,
  args: { floor: 10, floorEnemies: 10,
    heroes: [{ name: 'A', cls: 'Tank', atk: 100, def: 200, hp: 600, maxHp: 600, skills: ['gs'] }],
    customSkills: { gs: atk(1.0) },
    match: ['EXECUTION. The axe falls'] },
  note: 'F10 blind (no knowledge, no healer): marked hero is 2 under max when the axe falls (r1 cleave + r2 dread deal 1 each through def) -> NOT full -> lethal execute: hp forced to 0, deaths [1], loss.' },

/* ============================ Hollow King drain ============================ */
{ id: 'hk-001', category: 'hollow_king', fn: 'battle', seed: 121,
  args: { floor: 20, floorEnemies: 20,
    heroes: [
      { name: 'L1', cls: 'Warrior', loyalty: 60, atk: 60, def: 0, hp: 900, maxHp: 900, agi: 12, skills: ['gs'] },
      { name: 'L2', cls: 'Warrior', loyalty: 80, atk: 60, def: 0, hp: 900, maxHp: 900, agi: 11, skills: ['gs'] },
      { name: 'L3', cls: 'Warrior', loyalty: 90, atk: 60, def: 0, hp: 900, maxHp: 900, agi: 10, skills: ['gs'] }],
    customSkills: { gs: atk(1.0) },
    match: ['DRAIN THE DOUBTFUL', 'knows exactly why they climb', 'The King drinks'] },
  note: 'Hollow King cycle slash(r1) -> summon courtier(r2) -> DRAIN(r3, step%3==0): targets lowest-loyalty hero (L1=60); loyalty >= 60 resists -> raw = round(52*2.2*0.5*v) = round(57.2v). King then heals the hp actually drunk.' },
{ id: 'hk-002', category: 'hollow_king', fn: 'battle', seed: 121,
  args: { floor: 20, floorEnemies: 20,
    heroes: [
      { name: 'L1', cls: 'Warrior', loyalty: 40, atk: 60, def: 0, hp: 900, maxHp: 900, agi: 12, skills: ['gs'] },
      { name: 'L2', cls: 'Warrior', loyalty: 80, atk: 60, def: 0, hp: 900, maxHp: 900, agi: 11, skills: ['gs'] },
      { name: 'L3', cls: 'Warrior', loyalty: 90, atk: 60, def: 0, hp: 900, maxHp: 900, agi: 10, skills: ['gs'] }],
    customSkills: { gs: atk(1.0) },
    match: ['DRAIN THE DOUBTFUL', 'least certain', 'The King drinks'] },
  note: 'same setup, least-loyal hero at 40: NO resist -> raw = round(52*2.2*v) = round(114.4v), exactly double the resisted roll at equal v (modulo rounding).' },
{ id: 'hk-003', category: 'hollow_king', fn: 'battle', seed: 121,
  args: { floor: 20, floorEnemies: 20,
    heroes: [
      { name: 'L1', cls: 'Warrior', loyalty: 59, atk: 60, def: 0, hp: 900, maxHp: 900, agi: 12, skills: ['gs'] },
      { name: 'L2', cls: 'Warrior', loyalty: 80, atk: 60, def: 0, hp: 900, maxHp: 900, agi: 11, skills: ['gs'] },
      { name: 'L3', cls: 'Warrior', loyalty: 90, atk: 60, def: 0, hp: 900, maxHp: 900, agi: 10, skills: ['gs'] }],
    customSkills: { gs: atk(1.0) },
    match: ['DRAIN THE DOUBTFUL', 'least certain'] },
  note: 'boundary: loyalty 59 is one under the resist line — full-power drain. Pairs with hk-001 (60 = halved) to pin the >= 60 comparison.' },

/* ============================ status ticks / cooldowns ============================ */
{ id: 'cd-001', category: 'status_cd', fn: 'battle', seed: 131,
  args: { heroes: [{ name: 'A', atk: 20, def: 0, hp: 100, maxHp: 100, skills: ['gs'] }],
    enemies: [{ name: 'E1', maxHp: 100, atk: 0, def: 0 }],
    customSkills: { gs: atk(1.0, { cd: 0 }) } },
  note: 'cd 0 = spammable: castable every hero turn; lastUsage counts gs == number of hero turns fought (strike fallback never needed).' },
{ id: 'cd-002', category: 'status_cd', fn: 'battle', seed: 131,
  args: { heroes: [{ name: 'A', atk: 20, def: 0, hp: 100, maxHp: 100, skills: ['gs'] }],
    enemies: [{ name: 'E1', maxHp: 100, atk: 0, def: 0 }],
    customSkills: { gs: atk(1.0, { cd: 1 }) } },
  note: 'cd 1 locks exactly 1 turn: cast r1, strike r2, cast r3, strike r4... Engine sets cds=cd+1 on cast and decrements at every turn START (so ready again after exactly cd locked turns).' },
{ id: 'cd-003', category: 'status_cd', fn: 'battle', seed: 131,
  args: { heroes: [{ name: 'A', atk: 20, def: 0, hp: 100, maxHp: 100, skills: ['gs'] }],
    enemies: [{ name: 'E1', maxHp: 100, atk: 0, def: 0 }],
    customSkills: { gs: atk(1.0, { cd: 2 }) } },
  note: 'cd 2 locks exactly 2 turns: cast r1, strike r2+r3, cast r4... (Fireball/Meteor cadence).' },
{ id: 'cd-004', category: 'status_cd', fn: 'battle', seed: 131,
  args: { heroes: [{ name: 'A', atk: 20, def: 0, hp: 100, maxHp: 100, skills: ['gs'] }],
    enemies: [{ name: 'E1', maxHp: 100, atk: 0, def: 0 }],
    customSkills: { gs: atk(1.0, { cd: 3 }) } },
  note: 'cd 3 (Crushing Blow/Poisoned Blade cadence): cast r1, strike r2-r4, cast r5.' },
{ id: 'burn-001', category: 'status_cd', fn: 'battle', seed: 132,
  args: { heroes: [{ name: 'A', atk: 20, def: 0, hp: 200, maxHp: 200, skills: ['gsburn'] }],
    enemies: [{ name: 'E1', maxHp: 150, atk: 0, def: 0 }],
    customSkills: { gsburn: atk(1.0, { effects: [{ kind: 'burn', dur: 2, pct: 0.3 }] }) } },
  note: 'enemy-side burn: dot = round(eAtk*0.3) = 6 (RNG-free), ticks at the ENEMY turn start, dur decrements every enemy turn (burn included). cd 0 recasts stack: r2+ shows one line per stacked burn. dots.E1 sequence frozen.' },
{ id: 'buff-001', category: 'status_cd', fn: 'battle', seed: 133,
  args: { heroes: [{ name: 'A', atk: 90, def: 0, hp: 300, maxHp: 300, skills: ['gw', 'gs'] }],
    enemies: [{ name: 'E1', maxHp: 300, atk: 0, def: 0 }],
    customSkills: { gw: selfBuff([{ kind: 'atkup', dur: 2, pct: 0.15 }], { cd: 4, target: 'party', type: 'buff' }), gs: atk(1.0, { ai: 1 }) } },
  note: 'atkup decay: applied r1 (no attack that turn — War Cry is a pure buff), active on r2 hit (x1.15: round(90*1.15*v)), decayed to 0 at the r3 turn start -> r3 hit unboosted. Same-round application never decays on the caster same turn.' },
{ id: 'taunt-001', category: 'status_cd', fn: 'battle', seed: 134,
  args: { heroes: [
      { name: 'T', cls: 'Tank', atk: 40, def: 0, hp: 500, maxHp: 500, agi: 20, skills: ['gt', 'gs'] },
      { name: 'A', cls: 'Mage', atk: 40, def: 0, hp: 100, maxHp: 100, agi: 10, skills: ['gs'] }],
    enemies: [{ name: 'E1', maxHp: 80, atk: 40, def: 0 }, { name: 'E2', maxHp: 80, atk: 40, def: 0 }],
    customSkills: { gt: selfBuff([{ kind: 'taunt', dur: 2, pct: 1 }], { cd: 4, type: 'protect' }), gs: atk(1.0, { ai: 1 }) } },
  note: 'taunt: every enemy attack line targets the taunt holder T while the status lives (dur 2), overriding the v0.2 tank-bias/pick targeting. All dmg lines read E*>T=...' },
{ id: 'stun-001', category: 'status_cd', fn: 'battle', seed: 135,
  args: { heroes: [{ name: 'A', atk: 40, def: 0, hp: 200, maxHp: 200, skills: ['gstun'] }],
    enemies: [{ name: 'E1', maxHp: 150, atk: 60, def: 0 }],
    customSkills: { gstun: atk(1.0, { effects: [{ kind: 'stun', dur: 1, chance: 1 }] }) }, match: ['reels'] },
  note: 'stun (chance 1): enemy skips its turn every round ("reels — stunned"), taking one stun line per enemy turn until death. Hero takes zero damage — dmg has only A>E1 lines.' },

/* ============================ reactions / master commands ============================ */
{ id: 'rx-001', category: 'reactions', fn: 'battle', seed: 142,
  args: { reactions: true, heroes: [{ name: 'A', atk: 30, def: 0, hp: 200, maxHp: 200, reaction: 'killer', skills: ['gs'] }],
    enemies: [{ name: 'E1', maxHp: 35, atk: 0, def: 0 }],
    customSkills: { gs: atk(1.0) } },
  note: 'killer instinct: r1 leaves E1 under 15% of 35 (=5.25); r2 multiplies m by 1.5 -> round(30*1.5*v) = round(45v). Seed chosen so r1 damage >= 30.' },
{ id: 'rx-002', category: 'reactions', fn: 'battle', seed: 142,
  args: { reactions: true, heroes: [{ name: 'A', atk: 30, def: 0, hp: 200, maxHp: 200, reaction: 'steady', skills: ['gs'] }],
    enemies: [{ name: 'E1', maxHp: 35, atk: 0, def: 0 }],
    customSkills: { gs: atk(1.0) } },
  note: 'steady control: every hit x1.05 -> round(31.5*v); no escalation on the wounded round. Same seed as rx-001.' },
{ id: 'rx-003', category: 'reactions', fn: 'battle', seed: 142,
  args: { reactions: true, heroes: [
      { name: 'LS', atk: 30, def: 0, hp: 10, maxHp: 100, courage: 90, agi: 20, skills: ['gs'] },
      { name: 'W', atk: 30, def: 0, hp: 20, maxHp: 100, courage: 50, agi: 10, skills: ['gs'] }],
    enemies: [{ name: 'E1', maxHp: 200, atk: 50, def: 0 }],
    customSkills: { gs: atk(1.0) },
    match: ['LAST STAND'] },
  note: 'Last Stand (courage 90 >= 85, hp 10 < 15%, ally 20 < 25%): triggers once; stander intercepts ALL enemy damage and floors at hp 1 (hpAfter.LS ends 1 while surviving), outgoing x1.5, 2 rounds.' },
{ id: 'rx-004', category: 'reactions', fn: 'battle', seed: 144,
  args: { reactions: true, heroes: [{ name: 'A', atk: 30, def: 0, hp: 15, maxHp: 100, reaction: 'cowardretreat', skills: ['gs'] }],
    enemies: [{ name: 'E1', maxHp: 200, atk: 0, def: 0 }],
    customSkills: { gs: atk(1.0) },
    match: ['slips out'] },
  note: "Coward's Retreat: hp 15 < 20% of eMax -> 40%/turn slip-out roll happens BEFORE acting. Seed chosen so the r1 roll fires: hero withdraws keeping 15hp, single-hero party -> battle ends retreated." },
{ id: 'rx-005', category: 'reactions', fn: 'battle', seed: 141,
  args: { reactions: true, heroes: [{ name: 'A', atk: 30, def: 0, hp: 15, maxHp: 100, reaction: 'cowardretreat', skills: ['gs'] }],
    enemies: [{ name: 'E1', maxHp: 20, atk: 0, def: 0 }],
    customSkills: { gs: atk(1.0) },
    match: ['slips out'] },
  note: 'Coward Retreat roll fails (seed chosen so u >= 0.40 on r1): hero attacks instead, kills E1 (20hp) before another roll — win, no withdrawal.' },
{ id: 'loy-001', category: 'reactions', fn: 'battle', seed: 146,
  args: { reactions: true, heroes: [{ name: 'A', atk: 40, def: 0, hp: 200, maxHp: 200, loyalty: 20, skills: ['gs'] }],
    enemies: [{ name: 'E1', maxHp: 200, atk: 0, def: 0 }],
    customSkills: { gs: atk(1.0) },
    match: ['refuses the order'] },
  note: 'in-battle loyalty gate: loyalty 20 < 30 -> 20% per turn to refuse ("refuses the order"), losing the turn. Seed chosen for at least one refusal; fewer A>E1 dmg lines than rounds fought.' },
{ id: 'loy-002', category: 'reactions', fn: 'battle', seed: 146,
  args: { reactions: true, heroes: [{ name: 'A', atk: 40, def: 0, hp: 200, maxHp: 200, loyalty: 50, skills: ['gs'] }],
    enemies: [{ name: 'E1', maxHp: 200, atk: 0, def: 0 }],
    customSkills: { gs: atk(1.0) },
    match: ['refuses the order'] },
  note: 'control: loyalty 50 never gated — 0 refusal lines, one dmg line per hero turn.' },
{ id: 'mc-001', category: 'reactions', fn: 'battle', seed: 146, 
  args: { reactions: true, autoCmd: 'overdrive',
    heroes: [{ name: 'A', atk: 40, def: 0, hp: 300, maxHp: 300, skills: ['gs'] }],
    enemies: [{ name: 'E1', maxHp: 300, atk: 0, def: 0 }],
    customSkills: { gs: atk(1.0) },
    match: ['OVERDRIVE'] },
  note: 'OVERDRIVE master command (once per battle): m x1.25 on rounds 1-2, burns off at end of r2 and adds fear +15 (fearAfter). r3+ damage back to x1.05 steady baseline.' },
{ id: 'mc-002', category: 'reactions', fn: 'battle', seed: 147,
  args: { reactions: true, autoCmd: 'protect:1',
    heroes: [
      { name: 'P1', cls: 'Tank', atk: 40, def: 30, hp: 500, maxHp: 500, agi: 20, skills: ['gs'] },
      { name: 'P2', cls: 'Mage', atk: 40, def: 0, hp: 100, maxHp: 100, agi: 10, skills: ['gs'] }],
    enemies: [{ name: 'E1', maxHp: 200, atk: 60, def: 0 }],
    customSkills: { gs: atk(1.0) },
    match: ['holds the line'] },
  note: 'PROTECT master command (2 rounds): every enemy blow is retargeted to the protector at FULL value with the protector def applying (taken = max(1, round(60v - 30*0.6))). All enemy dmg lines read E1>P1=...' },
{ id: 'legacy-001', category: 'reactions', fn: 'battle', seed: 148,
  args: { reactions: true, heroes: [{ name: 'A', cls: 'Warrior', atk: 40, def: 0, hp: 300, maxHp: 300, skills: ['strike'] }],
    enemies: [{ name: 'E1', maxHp: 300, atk: 0, def: 0 }] },
  note: 'legacy fallback path: skills resolving to nothing but strike -> kitFor returns null -> v0.2 hardcoded Warrior act (30% Power Strike x1.8, else x1.0). Freeze so un-migrated saves keep exact behavior.' },

/* ============================ decide() scores ============================ */
{ id: 'decide-001', category: 'decide', fn: 'decide', seed: 1,
  args: { hero: { courage: 60, greed: 40, loyalty: 55, fear: 20 }, action: 'open_chest', ctx: {} },
  note: 'score = round(clamp(50 + Σ axis*weight, 0, 100)); open_chest: +0.2c +0.5g -0.4f = 50+12+20-8 = 74 -> comply (>=60).' },
{ id: 'decide-002', category: 'decide', fn: 'decide', seed: 1,
  args: { hero: { courage: 60, greed: 40, loyalty: 55, fear: 20 }, action: 'investigate', ctx: {} },
  note: 'investigate: +0.4c +0.2g -0.5f = 50+24+8-10 = 72 -> comply.' },
{ id: 'decide-003', category: 'decide', fn: 'decide', seed: 1,
  args: { hero: { courage: 60, greed: 40, loyalty: 55, fear: 20 }, action: 'help_stranger', ctx: {} },
  note: 'help_stranger: +0.4c -0.3g +0.3l -0.2f = 50+24-12+16.5-4 = 74.5 -> Math.round after clamp -> 75 -> comply.' },
{ id: 'decide-004', category: 'decide', fn: 'decide', seed: 1,
  args: { hero: { courage: 60, greed: 40, loyalty: 55, fear: 20 }, action: 'rob_stranger', ctx: {} },
  note: 'rob_stranger: +0.5g -0.6l = 50+20-33 = 37 -> refuse (<40).' },
{ id: 'decide-005', category: 'decide', fn: 'decide', seed: 1,
  args: { hero: { courage: 60, greed: 40, loyalty: 55, fear: 20 }, action: 'retreat', ctx: {} },
  note: 'retreat: -0.5c +0.1l +0.4f = 50-30+5.5+8 = 33.5 -> 34 round -> refuse. This is the same table decideRetreat uses in combat.' },
{ id: 'decide-006', category: 'decide', fn: 'decide', seed: 1,
  args: { hero: { courage: 60, greed: 40, loyalty: 55, fear: 20 }, action: 'sacrifice', ctx: {} },
  note: 'sacrifice: +0.4c +0.5l -0.3f = 50+24+27.5-6 = 95.5 -> 96 round -> comply.' },
{ id: 'decide-007', category: 'decide', fn: 'decide', seed: 1,
  args: { hero: { courage: 60, greed: 40, loyalty: 55, fear: 20 }, action: 'push_on', ctx: {} },
  note: 'push_on: +0.4c +0.1g -0.4f = 50+24+4-8 = 70 -> comply.' },
{ id: 'decide-008', category: 'decide', fn: 'decide', seed: 1,
  args: { hero: { courage: 100, greed: 100, loyalty: 50, fear: 0 }, action: 'open_chest', ctx: {} },
  note: 'upper clamp: raw score 120 -> clamped 100 before round -> 100, comply.' },
{ id: 'decide-009', category: 'decide', fn: 'decide', seed: 1,
  args: { hero: { courage: 0, greed: 0, loyalty: 0, fear: 100 }, action: 'investigate', ctx: {} },
  note: 'lower clamp: raw 50-50 = 0 -> refuse.' },
{ id: 'decide-010', category: 'decide', fn: 'decide', seed: 1,
  args: { hero: { courage: 20, greed: 50, loyalty: 50, fear: 40 }, action: 'retreat', ctx: {} },
  note: 'verdict band edges: score 50-10+5+16 = 61 -> comply; retreat score of exactly 60 is the band line (>=60 comply, 40-59 grudging, <40 refuse).' },
{ id: 'decide-011', category: 'decide', fn: 'decide', seed: 1,
  args: { hero: { courage: 40, greed: 50, loyalty: 50, fear: 25 }, action: 'retreat', ctx: {} },
  note: 'mid band: 50-20+5+10 = 45 -> grudging.' },
{ id: 'decide-012', category: 'decide', fn: 'decide', seed: 197,
  args: { hero: { courage: 90, greed: 50, loyalty: 10, fear: 5 }, action: 'open_chest', ctx: {} },
  note: 'loyalty gate: loyalty 10 < 25 and action != retreat -> 30% flat-refuse override (verdict refuse + disloyal line pool). Seed chosen so the gate roll fires; score itself is ungated (91 -> comply without the gate).' },
{ id: 'decide-013', category: 'decide', fn: 'decide', seed: 201,
  args: { hero: { courage: 90, greed: 50, loyalty: 10, fear: 5 }, action: 'open_chest', ctx: {} },
  note: 'gate does NOT fire (seed roll u >= 0.30): verdict follows the score -> comply.' },
{ id: 'decide-014', category: 'decide', fn: 'decide', seed: 201,
  args: { hero: { courage: 20, greed: 0, loyalty: 100, fear: 20 }, action: 'rob_stranger', ctx: { alt: true } },
  note: 'alt branch: rob_stranger for this hero scores 50 + 0 - 60 = -10 -> clamp 0 -> refuse; with ctx.alt the 50% coin (first RNG draw) fires -> verdict "alt".' },
{ id: 'decide-015', category: 'decide', fn: 'decide', seed: 201,
  args: { hero: { courage: 20, greed: 0, loyalty: 100, fear: 20 }, action: 'rob_stranger', ctx: {} },
  note: 'no alt offered: same refusing hero (score 0) stays refuse. Loyalty 100 >= 25 so the gate coin cannot fire — isolates the alt coin. Roll order in decide(): alt coin first, then loyalty gate.' },

/* ============================ exp curve ============================ */
{ id: 'exp-001', category: 'exp', fn: 'exp_need', seed: 1,
  args: { lvls: [1, 2, 3, 5, 10, 20] },
  note: 'expNeed(lvl) = 60 + 45*lvl.' },
{ id: 'exp-002', category: 'exp', fn: 'grant_exp', seed: 1,
  args: { hero: { lvl: 1, exp: 0, maxHp: 100, atk: 20, def: 10, agi: 8, hp: 100 }, amount: 104 },
  note: '104 exp at lvl 1 (need 105): no level — stats and hp untouched, exp 104 banked.' },
{ id: 'exp-003', category: 'exp', fn: 'grant_exp', seed: 1,
  args: { hero: { lvl: 1, exp: 0, maxHp: 100, atk: 20, def: 10, agi: 8, hp: 40 }, amount: 105 },
  note: 'exactly 105: one level. maxHp=round(100*1.10)=110, atk=round(20*1.09)=22, def=round(10*1.06)=11, agi=round(8*1.03)+1=9, hp=min(110, 40+30)=70.' },
{ id: 'exp-004', category: 'exp', fn: 'grant_exp', seed: 1,
  args: { hero: { lvl: 1, exp: 0, maxHp: 100, atk: 20, def: 10, agi: 8, hp: 100 }, amount: 400 },
  note: 'multi-level cascade: needs 105+150=255 (2 levels, 145 banked). Growth applies per level with rounding between levels (compounding round chain).' },
{ id: 'exp-005', category: 'exp', fn: 'grant_exp', seed: 1,
  args: { hero: { lvl: 5, exp: 280, maxHp: 161, atk: 28, def: 12, agi: 9, hp: 3 }, amount: 30 },
  note: 'banked exp counts: 280+30=310 vs need(5)=285 -> one level, leftover 25; hp floors up via +30 heal to 33 of the new maxHp.' },

/* ============================ master progression / rewards ============================ */
{ id: 'mast-001', category: 'rewards', fn: 'master_curve', seed: 1,
  args: { lvls: [1, 2, 3, 5, 10] },
  note: 'masterExpNeed(lvl) = 100*lvl.' },
{ id: 'mast-002', category: 'rewards', fn: 'grant_master_exp', seed: 1,
  args: { level: 1, exp: 0, n: 250 },
  note: '250 exp at ML1: 100+150 -> 2 levels, 0 banked.' },
{ id: 'mast-003', category: 'rewards', fn: 'grant_master_exp', seed: 1,
  args: { level: 2, exp: 50, n: 160 },
  note: 'carried exp: 50+160=210 vs need(2)=200 -> ML3 with 10 banked (leftover carries across the level line).' },
{ id: 'mast-004', category: 'rewards', fn: 'cost_hooks', seed: 1,
  args: { level: 1 },
  note: 'unlock hooks at ML1: rosterCap 24, recruitCost 120, restMult 1.' },
{ id: 'mast-005', category: 'rewards', fn: 'cost_hooks', seed: 1,
  args: { level: 2 },
  note: 'ML2: roster cap 24->30 (deep tower unlock).' },
{ id: 'mast-006', category: 'rewards', fn: 'cost_hooks', seed: 1,
  args: { level: 4 },
  note: 'ML4: rest cost x0.6.' },
{ id: 'mast-007', category: 'rewards', fn: 'cost_hooks', seed: 1,
  args: { level: 5 },
  note: 'ML5: recruit 120->90.' },
{ id: 'rew-001', category: 'rewards', fn: 'floor_rewards', seed: 1,
  args: { floors: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10] },
  note: 'floorClearGold(n) = 40+25n except F10=600; floorClearPermits: +1 on 3/6/9, F10=3.' },
{ id: 'rew-002', category: 'rewards', fn: 'floor_rewards', seed: 1,
  args: { floors: [11, 12, 13, 14, 15, 16, 17, 18, 19, 20] },
  note: 'deep tower: permits on 12/15/18; F20 gold 900, permits 4.' },
{ id: 'scout-001', category: 'scout', fn: 'scout_cost', seed: 1,
  args: { floors: [1, 5, 10, 11, 12, 13, 14, 20] },
  note: 'scoutCost(floor): 25, but 50 inside the DARKNESS band 11-13 (inclusive both ends). M.ScoutCost constant stays 25 for back-compat.' },
{ id: 'foes-001', category: 'enemies', fn: 'make_enemies', seed: 1,
  args: { floors: [1, 4, 5, 6] },
  note: 'makeEnemies scaling: hp = round(40*(1+0.28(n-1))*m), atk = round(8*1.26scale*m), def = round(2*1.22scale*m), bounty = round((20+9n)*m); count 2 (n<=4) else 3; first is Elite (x1.5) from n>=6.' },
{ id: 'foes-002', category: 'enemies', fn: 'make_enemies', seed: 1,
  args: { floors: [9, 11, 15, 19] },
  note: 'floors 9 and 19 bulge x1.1 on top of the elite x1.5; floors 11-19 use the deep-tower mob names.' },
{ id: 'foes-003', category: 'enemies', fn: 'make_enemies', seed: 1,
  args: { floors: [10, 20] },
  note: 'boss rows: F10 THE EXECUTIONER (1300/46/10, bounty 200), F20 THE HOLLOW KING (2250/52/12, bounty 400) — fixed, no scaling.' },

/* ============================ gacha / recruit pipeline ============================ */
{ id: 'gacha-001', category: 'gacha', fn: 'roll_rarity', seed: 3001,
  args: { n: 1000 },
  note: 'rollRarity over 1000 seeded draws — empirical distribution vs the 55/28/13/4 table. Bounds documented: every count stays within binomial noise of its rate (sigma ~ 15 at n=1000 for p=.55). Frozen exactly.' },
{ id: 'gacha-002', category: 'gacha', fn: 'roll_rarity', seed: 3002,
  args: { n: 5000 },
  note: 'second independent 5000-draw run (different seed) — a port matching mulberry32 + the cumulative threshold walk (<.55 ->1, <.83 ->2, <.96 ->3, else 4) reproduces both.' },
{ id: 'gacha-003', category: 'gacha', fn: 'roll_trait_seq', seed: 3003,
  args: { n: 12 },
  note: 'rollTrait: uniform index = floor(u*6) over TRAIT_IDS key order [irongut, glassedge, coldblood, bloodthirst, nighteyes, faintheart].' },
{ id: 'gacha-004', category: 'gacha', fn: 'make_hero_seq', seed: 3004,
  args: { n: 3 },
  note: 'full recruit pipeline per hero (in RNG order): rarity roll, class pick, 4x stat variance rnd(.92,1.08) (hp/atk/def/agi), name pick, axes ri(20,90)/ri(10,90)/ri(50,90)/ri(5,30), trait roll; reaction derived from axes (precedence courage70/loyalty80/fear70/greed70/steady); personality from label(). RARITY_MULT {1:.82, 2:1, 3:1.25, 4:1.5}.' },
{ id: 'gacha-005', category: 'gacha', fn: 'gacha_flow', seed: 3005,
  args: { gold: 250, permits: 2, n: 5 },
  note: 'gacha economy: 2 permit recruits first, then gold at 120/hero until it cannot pay (250 -> 240 spent, 5th attempt returns null). Roster counts only successful recruits.' },
{ id: 'gacha-006', category: 'gacha', fn: 'gacha_flow', seed: 3006,
  args: { gold: 0, permits: 0, n: 2 },
  note: 'broke Master: no permits and less than recruitCost() gold -> null, roster stays 0.' },

/* ============================ rest / bonds / telemetry ============================ */
{ id: 'rest-001', category: 'misc', fn: 'rest', seed: 1,
  args: { masterLevel: 1, heroes: [
      { name: 'A', maxHp: 100, hp: 40, fear: 30 },
      { name: 'B', maxHp: 200, hp: 200, fear: 10 }] },
  note: 'rest: cost = ceil(missing*0.4*restMult) = ceil(60*0.4) = 24 gold; heals everyone to max, fear -25 clamped at 0 (A 30->5, B 10->0).' },
{ id: 'rest-002', category: 'misc', fn: 'rest', seed: 1,
  args: { masterLevel: 4, heroes: [{ name: 'A', maxHp: 100, hp: 40, fear: 99 }] },
  note: 'ML4 rest discount x0.6: ceil(60*0.4*0.6) = ceil(14.4) = 15. Fear 99 -> 74.' },
{ id: 'bond-001', category: 'misc', fn: 'bonds', seed: 1,
  args: { heroes: [{ name: 'A' }, { name: 'B' }, { name: 'C' }],
    ops: [['addBond', 1, 2, 40], ['addBond', 1, 2, 30], ['addBond', 2, 3, -15], ['bond', 1, 3]],
    party: [1, 2, 3], deadId: 2 },
  note: 'bond writes are symmetric, clamped -100..100 (40 then +30 -> 70, not 100 on write 1); reads mirror; bondedPairs needs >=60; mournersOf(dead) = living heroes with bond >=30 to the dead id.' },
{ id: 'pers-001', category: 'misc', fn: 'label', seed: 1,
  args: { hero: { courage: 75, greed: 40, loyalty: 50, fear: 20 } },
  note: 'personality precedence: courage>=70 Brave; fear>=70 Coward; greed>=70 Greedy; loyalty>=80 Loyal; greed>=60&&courage>=60 Reckless; fear<=30&&courage<=40 Cautious; else highest axis.' },
{ id: 'pers-002', category: 'misc', fn: 'label', seed: 1,
  args: { hero: { courage: 65, greed: 65, loyalty: 50, fear: 20 } },
  note: 'Reckless band: greed>=60 AND courage>=60.' },
{ id: 'pers-003', category: 'misc', fn: 'label', seed: 1,
  args: { hero: { courage: 30, greed: 40, loyalty: 50, fear: 25 } },
  note: 'Cautious band: fear<=30 AND courage<=40.' },
{ id: 'pers-004', category: 'misc', fn: 'label', seed: 1,
  args: { hero: { courage: 50, greed: 40, loyalty: 90, fear: 20 } },
  note: 'loyalty 90 but courage 50: falls through to highest-axis rule (loyalty 90 wins the fallback loop) — Loyal via fallback, not the >=80 shortcut (same word, different branch).' },
{ id: 'rxfor-001', category: 'misc', fn: 'reaction_for', seed: 1,
  args: { hero: { courage: 72, greed: 90, loyalty: 85, fear: 80 } },
  note: 'reactionFor precedence: courage>=70 wins over everything -> laststand.' },
{ id: 'rxfor-002', category: 'misc', fn: 'reaction_for', seed: 1,
  args: { hero: { courage: 69, greed: 90, loyalty: 85, fear: 80 } },
  note: 'courage under 70: loyalty>=80 -> protective (before fear and greed).' },
{ id: 'rxfor-003', category: 'misc', fn: 'reaction_for', seed: 1,
  args: { hero: { courage: 50, greed: 90, loyalty: 70, fear: 75 } },
  note: 'fear>=70 -> cowardretreat beats greed>=70.' },
{ id: 'rxfor-004', category: 'misc', fn: 'reaction_for', seed: 1,
  args: { hero: { courage: 50, greed: 90, loyalty: 70, fear: 30 } },
  note: 'greed>=70 -> killer; everything under the lines -> steady.' },
{ id: 'tel-001', category: 'misc', fn: 'telemetry_normalize', seed: 1,
  args: { telemetry: { run_started: 3, hero_died: 1.7, bogus_key: 9, combat_started: 0 } },
  note: 'telemetry normalize: known counters floored to int, zero/negative dropped, unknown keys (schema drift) dropped; migrateToV7 stamps ver 7.' }
];

/* ------------------------------------------------------------------ */
/* runner                                                               */
/* ------------------------------------------------------------------ */
function caseListFromDefs() { return CASES; }

function buildMeta() {
  return {
    format: 'infinite-tower-golden/1',
    purpose: 'Frozen function-level expectations for the Infinite Tower web engine (v0.7), to verify a Godot/GDScript port against.',
    engine: {
      files: ENGINE_FILES,
      sha256_16: (function () { var h = {}; ENGINE_FILES.forEach(function (f) { h[f] = sha256(f); }); return h; })()
    },
    rng: {
      name: 'mulberry32',
      impl: 'a|=0; a=(a+0x6D2B79F5)|0; t=Math.imul(a^(a>>>15),1|a); t=(t+Math.imul(t^(t>>>7),61|t))^t; return ((t^(t>>>14))>>>0)/4294967296',
      note: 'Each case swaps Math.random for mulberry32(case.seed) and restores it after. The engine has no other nondeterminism on these paths.'
    },
    conventions: [
      'Case shape: {id, category, fn, seed, args, expect, note}. fn names a probe implemented in tests/golden.js; args are JSON-able.',
      'Comparison is EXACT deep equality on the probe return value (numbers bit-identical; no tolerance).',
      'Battles run through IT.combat.start(cfg) with FAST=true, headless (no DOM). Battle observables: returned result {win, retreated, deaths}, IT.combat.lastUsage, IT.combat.debug().lines (the rendered log, damage numbers embedded), and live hero objects in IT.S (hp/fear persist).',
      'dmg entries are parsed log lines formatted "source>target=amount". dots = Burn tick amounts per holder. heals = heal amounts per target. match = occurrence counts of note-worthy substrings.',
      'Engine consumes Math.random in a fixed order per battle (AI jitter first, then variance rolls); reproducing a case means reproducing that call order. Pure-arithmetic cases (rewards, exp, decide scores, makeEnemies, scout) need no RNG at all.',
      'Test heroes are plain objects built with explicit stats/axes/trait/reaction/skills; test skills are data rows injected into IT.SKILLS using only documented spec fields (power/cd/ai/effects/condition/cost/target/type/executeBonus/prefer).',
      'Rounding everywhere: Math.round (half-up on positives), damage floors at 1 via max(1, ...).',
      'Battle cases run with IT.combat.REACTIONS = false (the engine test hook) unless args.reactions is true — the reaction-layer multipliers are stripped so frozen numbers isolate the system under test.',
      'Regenerate expectations after an intentional rebalance with: node tests/golden.js --update'
    ],
    categories: (function () { var c = {}; CASES.forEach(function (k) { c[k.category] = (c[k.category] || 0) + 1; }); return c; })()
  };
}

async function runCase(c) {
  seedRng(c.seed || 1);
  try {
    var probe = PROBES[c.fn];
    if (!probe) throw new Error('unknown probe: ' + c.fn);
    var val = await probe(c.args);
    return deepClone(val);
  } finally {
    restoreRng();
  }
}

function loadJsonCases() {
  if (!fs.existsSync(CASES_FILE)) return null;
  try {
    var d = JSON.parse(fs.readFileSync(CASES_FILE, 'utf8'));
    return (d && Array.isArray(d.cases)) ? d : null;
  } catch (e) { return null; }
}

async function main() {
  var update = process.argv.indexOf('--update') >= 0;

  if (update) {
    var out = { meta: buildMeta(), cases: [] };
    for (var i = 0; i < CASES.length; i++) {
      var c = CASES[i];
      var val = await runCase(c);
      out.cases.push({ id: c.id, category: c.category, fn: c.fn, seed: c.seed || 1, args: c.args, expect: val, note: c.note });
      process.stdout.write('\r[update] ' + (i + 1) + '/' + CASES.length + ' cases frozen');
    }
    process.stdout.write('\n');
    fs.writeFileSync(CASES_FILE, JSON.stringify(out, null, 2) + '\n');
    console.log('[update] wrote ' + CASES.length + ' cases -> ' + path.basename(CASES_FILE));
    return 0;
  }

  var data = loadJsonCases();
  if (!data) {
    console.error('[golden] FATAL: ' + path.basename(CASES_FILE) + ' missing or malformed — run `node tests/golden.js --update` first.');
    return 2;
  }

  var byCat = {}, order = [], fails = 0, total = 0;
  for (var j = 0; j < data.cases.length; j++) {
    var c = data.cases[j];
    total++;
    if (byCat[c.category] === undefined) { byCat[c.category] = { pass: 0, fail: 0 }; order.push(c.category); }
    var got, err = null;
    try { got = await runCase(c); } catch (e) { err = e; }
    var ok = !err && deepEqual(got, c.expect);
    if (ok) { byCat[c.category].pass++; }
    else {
      fails++; byCat[c.category].fail++;
      console.log('FAIL ' + c.id + ' (' + c.category + '/' + c.fn + ')' + (err ? ' threw: ' + err.message : ''));
      if (!err) {
        console.log('  expect: ' + JSON.stringify(stable(c.expect)));
        console.log('  got   : ' + JSON.stringify(stable(got)));
      }
    }
  }

  console.log('');
  order.forEach(function (cat) {
    var s = byCat[cat];
    console.log((s.fail ? 'FAIL' : 'PASS') + '  ' + cat + ': ' + s.pass + '/' + (s.pass + s.fail));
  });
  console.log('');
  console.log('golden: ' + (total - fails) + '/' + total + ' passed' + (fails ? ' — ' + fails + ' FAILED' : ' — all bit-identical'));
  return fails ? 1 : 0;
}

if (require.main === module) {
  main().then(function (code) { process.exit(code); }, function (e) {
    console.error('[golden] fatal:', e);
    process.exit(2);
  });
}

module.exports = { mulberry32: mulberry32, PROBES: PROBES, CASES: CASES, runCase: runCase, mkHero: mkHero };
