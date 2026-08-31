'use strict';
/* ============================================================
   INFINITE TOWER v0.3/v0.4/v0.5 — js/core.js  (AGENT-A; v0.4 AGENT-F; v0.5 AGENT-F2)
   Data tables, state, hero generation, gacha, decision engine.
   v0.4 adds: hero bonds (rel), equipment slots (items), grieving,
   state inventory/remains/nextItemId, fallen-gear item pool, migration.
   v0.5 adds: Master progression (S.master, grantMasterExp), floors 11-19
   mob names, exposed reward constants (floorClearGold/floorClearPermits),
   master-gated costs (recruitCost/restMult/rosterCap), v4→v5 migration.
   v0.6 adds (AGENT-F3): skill system DATA — IT.SKILLS (12 class basics +
   shared 'strike'), class kits (hero.skills) + hero.reaction fixed at
   recruit (reactionFor precedence), IT.DATA.REACTIONS flavor, v5→v6
   migration. Engine lives in combat.js; core stays pure data.
   v0.7 adds (AGENT-F4): Full Roster — Warrior/Rogue kits in IT.SKILLS +
   IT.KITS (['strike'] placeholder retired), hero traits (IT.TRAITS, rolled
   uniform at recruit → hero.trait), light telemetry (S.telemetry counters +
   IT.track / IT.telemetryDump), v6→v7 migration.
   Standalone: no DOM, never calls other IT modules. Callers act
   on return values (ui handles toasts/rendering).
   Data values ported verbatim from v0.2 ../index.html.
   ============================================================ */
window.IT = window.IT || {};
(function (IT) {

  var KEY = 'infinite_tower_v03';
  var ROSTER_CAP = 24;   // max living heroes
  var MEMO_CAP = 12;     // max memories per hero, newest last
  var RECRUIT_COST = 120;

  /* ============================== DATA (v0.2 tables) ============================== */

  var DATA = {
    NAMES: ['Mira','Kael','Rook','Sera','Dain','Ilya','Bram','Nyx','Odell','Petra',
            'Silas','Vera','Corin','Wren','Halden','Juno','Fen','Maro','Lys','Tobin',
            'Ash','Rin','Garrick','Elva','Moss','Kira','Dorn','Sable','Pip','Yara'],
    PERSONALITIES: {
      Brave: 'Fights harder at death\'s door.',
      Coward: 'May freeze when fear takes hold.',
      Greedy: '+10% damage. They came for the loot.',
      Loyal: 'Avenges fallen allies (+20% dmg).',
      Reckless: '+15% damage dealt, +10% taken.',
      Cautious: 'Takes 10% less damage.'
    },
    CLASSES: {
      Warrior: { icon: '⚔️', hp: 120, atk: 22, def: 12, agi: 10, desc: 'Power Strike: 30% chance for 180% dmg.' },
      Tank:    { icon: '🛡️', hp: 185, atk: 15, def: 20, agi: 6,  desc: 'Draws enemy attacks. 30% chance to intercept a hit for an ally.' },
      Rogue:   { icon: '🗡️', hp: 90,  atk: 26, def: 6,  agi: 20, desc: 'Targets the weakest foe. 25% crit for 170%.' },
      Mage:    { icon: '🔮', hp: 80,  atk: 30, def: 5,  agi: 12, desc: 'Fireball: 40% chance to hit ALL enemies for 65%.' },
      Healer:  { icon: '✨', hp: 95,  atk: 14, def: 8,  agi: 11, desc: 'Heals the most wounded ally each turn.' }
    },
    RARITY_MULT: { 1: .82, 2: 1, 3: 1.25, 4: 1.5 },
    GACHA_RATES: [[1, .55], [2, .28], [3, .13], [4, .04]],
    /* v0.5 deep tower: mob for floor n is MOBS[n-1]. Floors 11-19 use the nine
     * new names at indices 10-18 (length 19). Index 9 (floor 10 mid rooms —
     * the end node is the Executioner boss) repeats 'Flesh Ogre' so F10
     * non-boss fights keep their exact pre-v0.5 name (the old 9-entry array
     * clamped floor 10 onto index 8). Floor 20 mid fights clamp onto 18. */
    MOBS: ['Plague Rat','Cave Bat','Goblin Scrapper','Dire Wolf','Bandit',
           'Rattling Skeleton','Orc Raider','Tower Cultist','Flesh Ogre',
           'Flesh Ogre',
           'Tower Knight','Gloom Wraith','Changeling','Ash Beast','Pale Priest',
           'Hollow Courtier','Gloom Widow','Stone Warden','Twin Abomination'],
    EPITAPHS: [
      'They went up. They did not come down.',
      'The Tower keeps what it takes.',
      'Somewhere below, a candle burns out.',
      'The Tower remembers.',
      'Their name still echoes in the stairwell.',
      'The Tower was hungrier today.'
    ],
    /* v0.4 — "gear of the fallen" name pools (stats rolled in rollFallenItem). */
    FALLEN_ITEMS: {
      weapon:  ['Rusted Dagger', 'Notched Blade', 'Splintered Spear', 'Pitted Handaxe', 'Worn Shortsword', 'Chipped Falchion'],
      armor:   ['Cracked Cuirass', 'Battered Mail', 'Stitched Leathers', 'Dented Half-Plate', 'Faded Guard Coat'],
      trinket: ['Lucky Coin', 'Bone Charm', 'Chipped Talisman', 'Faded Ribbon', 'Snuffed Candle', 'Tarnished Ring']
    },
    FIRST_BLOOD: 'First Blood — the first name the Tower took from you.',
    /* v0.6 reaction identities — name + one flavor line for the UI profile
     * row. Mechanics (laststand dmg floor, protective intercept, etc.) are
     * combat.js's; the id set here mirrors reactionFor() exactly. */
    REACTIONS: {
      laststand:     { name: 'Last Stand',          desc: 'Dying just makes them angry.' },
      protective:    { name: 'Protective Instinct', desc: 'Some bonds are worth broken ribs.' },
      cowardretreat: { name: "Coward's Retreat",    desc: 'You cannot die if you are not here.' },
      killer:        { name: 'Killer Instinct',     desc: 'Finish it. Take everything.' },
      steady:        { name: 'Steady',              desc: 'Boring. Reliable.' }
    }
  };

  /* ============================== v0.6 SKILL SYSTEM (pure data) ============================== */
  /* Spec shape — every field present on every entry (combat.js reads specs,
   * nothing hero-specific hardcoded anywhere):
   *   id / name / cls / tier / target / type / power / cd / cost / effects /
   *   condition / ai (+ desc for UI, + optional once:true / prefer:'lowest')
   *     cls:      owning class; null = shared by everyone ('strike')
   *     target:   'allEnemies' | 'enemy' | 'lowestAlly' | 'anyAllyBelow35' | 'self' | 'party'
   *     type:     'attack' | 'heal' | 'protect' | 'buff' | 'utility'
   *     power:    multiplier on caster atk (Mend: the atk coefficient of the
   *               existing v0.2 heal formula 18 + atk×power + lvl×2)
   *     cd:       cooldown turns after use (0 = spammable)
   *     cost:     null | {hpPct} — self HP cost paid on cast
   *     effects:  statuses applied on hit/heal. Core kinds (engine stamps
   *               srcId/targetId at apply time): burn (dot = atk×pct),
   *               barrier (dmg ×(1−pct)), taunt (foes target holder),
   *               stun (skip action; bosses immune), redirect (dmg aimed at
   *               the status's target hits its srcId at pct; on 'self' specs
   *               it means catch-ALL party damage). Beyond the core six,
   *               documented additions: 'cleanse' (strip all negative
   *               statuses; optional fear:<flat points> delta) and
   *               Benediction's 'atkup' (+pct atk for dur) / 'heal'
   *               (pct of maxHp). dur 0 = instant, nothing lingers.
   *               v0.7 additions (engine side = AGENT-G4, generic features):
   *               'executeBonus' (on-hit dmg ×(1+pct) when the TARGET is
   *               below 30% of its maxHp — dur 0 cast-time modifier, never
   *               stored) and 'fragile' (holder takes dmg ×(1+pct) for dur —
   *               barrier in reverse; Berserk's price).
   *     condition: null | {selfHpBelow} | {allyDiedThisBattle:true} |
   *               {anyAllyBelow} — skill only considered when met
   *     ai:       AI priority weight (higher = preferred when off cd)
   *     once:     true = usable once per battle (engine flag resets/battle)
   *     prefer:   optional 'lowest' — on target 'enemy' specs the engine aims
   *               at the lowest-hp living foe instead of the default pick
   *               (Backstab; v0.7, engine side = AGENT-G4)
   */
  var SKILLS = {
    /* shared basic attack — everyone's fallback when no kit skill qualifies */
    strike: { id: 'strike', name: 'Strike', cls: null, tier: 'basic', target: 'enemy', type: 'attack',
      power: 0.75, cd: 0, cost: null, effects: [], condition: null, ai: 1,
      desc: 'Everyone can hit something.' },

    /* -------- MAGE -------- */
    fireball: { id: 'fireball', name: 'Fireball', cls: 'Mage', tier: 'basic', target: 'allEnemies', type: 'attack',
      power: 0.75, cd: 2, cost: null, effects: [{ kind: 'burn', dur: 2, pct: 0.25 }], condition: null, ai: 7,
      desc: 'Fire obeys. Everything else burns.' },
    meteor: { id: 'meteor', name: 'Meteor', cls: 'Mage', tier: 'basic', target: 'enemy', type: 'attack',
      power: 2.0, cd: 4, cost: null, effects: [], condition: null, ai: 9,
      desc: 'The sky falls. It was always going to.' },
    /* defensive auto: gated until someone is actually low */
    emergencybarrier: { id: 'emergencybarrier', name: 'Emergency Barrier', cls: 'Mage', tier: 'basic', target: 'anyAllyBelow35', type: 'protect',
      power: 0, cd: 3, cost: null, effects: [{ kind: 'barrier', dur: 1, pct: 0.6 }], condition: { anyAllyBelow: 0.35 }, ai: 10,
      desc: 'A wall, right where the screaming started.' },
    /* desperate nuke: pays 15% of own HP, once per battle */
    lastflame: { id: 'lastflame', name: 'Last Flame', cls: 'Mage', tier: 'basic', target: 'enemy', type: 'attack',
      power: 2.6, cd: 0, cost: { hpPct: 0.15 }, effects: [], condition: { selfHpBelow: 0.25 }, once: true, ai: 6,
      desc: 'One last fire. It burns what is left.' },

    /* -------- TANK -------- */
    /* stun rolls at pct chance, non-bosses only (bosses immune engine-side) */
    shieldbash: { id: 'shieldbash', name: 'Shield Bash', cls: 'Tank', tier: 'basic', target: 'enemy', type: 'attack',
      power: 0.9, cd: 0, cost: null, effects: [{ kind: 'stun', dur: 1, pct: 0.25 }], condition: null, ai: 5,
      desc: 'Shields hit back. Blink and you miss it.' },
    bulwark: { id: 'bulwark', name: 'Bulwark', cls: 'Tank', tier: 'basic', target: 'party', type: 'protect',
      power: 0, cd: 3, cost: null, effects: [{ kind: 'barrier', dur: 1, pct: 0.25 }], condition: null, ai: 10,
      desc: 'One shield, held wide enough for everyone.' },
    taunt: { id: 'taunt', name: 'Taunt', cls: 'Tank', tier: 'basic', target: 'self', type: 'protect',
      power: 0, cd: 4, cost: null, effects: [{ kind: 'taunt', dur: 2, pct: 1 }], condition: null, ai: 8,
      desc: 'Come on, then. All of you. Me.' },
    /* self redirect = catches ALL party-targeted damage at ×pct; hp floors at
     * 1 and once-per-battle are engine-side semantics of this condition+once */
    unbreakable: { id: 'unbreakable', name: 'Unbreakable', cls: 'Tank', tier: 'basic', target: 'self', type: 'protect',
      power: 0, cd: 0, cost: null, effects: [{ kind: 'redirect', dur: 1, pct: 0.5 }], condition: { selfHpBelow: 0.3 }, once: true, ai: 11,
      desc: 'Not today. Not like this.' },

    /* -------- HEALER -------- */
    /* existing v0.2 formula: heal = 18 + atk×power + lvl×2 */
    mend: { id: 'mend', name: 'Mend', cls: 'Healer', tier: 'basic', target: 'lowestAlly', type: 'heal',
      power: 1.6, cd: 0, cost: null, effects: [], condition: null, ai: 9,
      desc: 'Needle, thread, no complaints.' },
    /* lands ON the lowest-HP ally; damage aimed at them hits the healer at 70% */
    guardianprayer: { id: 'guardianprayer', name: 'Guardian Prayer', cls: 'Healer', tier: 'basic', target: 'lowestAlly', type: 'protect',
      power: 0, cd: 4, cost: null, effects: [{ kind: 'redirect', dur: 2, pct: 0.7 }], condition: null, ai: 8,
      desc: 'Their wounds come to me instead. Most of them.' },
    cleanse: { id: 'cleanse', name: 'Cleanse', cls: 'Healer', tier: 'basic', target: 'party', type: 'utility',
      power: 0, cd: 3, cost: null, effects: [{ kind: 'cleanse', dur: 0, pct: 1, fear: -10 }], condition: null, ai: 7,
      desc: 'Breathe. Whatever that was, it is off you now.' },
    /* the dead ally's price, collected: +20% party atk 2t, heal 15% maxHp all */
    benediction: { id: 'benediction', name: 'Benediction', cls: 'Healer', tier: 'basic', target: 'party', type: 'buff',
      power: 0, cd: 0, cost: null, effects: [{ kind: 'atkup', dur: 2, pct: 0.2 }, { kind: 'heal', dur: 0, pct: 0.15 }], condition: { allyDiedThisBattle: true }, once: true, ai: 10,
      desc: 'They died so we climb. Honor that.' },

    /* -------- WARRIOR (v0.7 — Vanguard: pressure + recklessness) -------- */
    cleave: { id: 'cleave', name: 'Cleave', cls: 'Warrior', tier: 'basic', target: 'allEnemies', type: 'attack',
      power: 0.6, cd: 2, cost: null, effects: [], condition: null, ai: 6,
      desc: 'Widespread, honest violence.' },
    /* executeBonus (new kind): on-hit dmg ×1.5 when the target is below 30% hp */
    crushingblow: { id: 'crushingblow', name: 'Crushing Blow', cls: 'Warrior', tier: 'basic', target: 'enemy', type: 'attack',
      power: 1.4, cd: 3, cost: null, effects: [{ kind: 'executeBonus', dur: 0, pct: 0.5 }], condition: null, ai: 7,
      desc: 'Finish what the line started.' },
    warcry: { id: 'warcry', name: 'War Cry', cls: 'Warrior', tier: 'basic', target: 'party', type: 'buff',
      power: 0, cd: 4, cost: null, effects: [{ kind: 'atkup', dur: 2, pct: 0.15 }], condition: null, ai: 8,
      desc: 'Louder than the fear.' },
    /* fragile (new kind): takes dmg ×1.2 while it lasts — rage has a price */
    berserk: { id: 'berserk', name: 'Berserk', cls: 'Warrior', tier: 'basic', target: 'self', type: 'buff',
      power: 0, cd: 0, cost: null, effects: [{ kind: 'atkup', dur: 3, pct: 0.4 }, { kind: 'fragile', dur: 3, pct: 0.2 }], condition: { selfHpBelow: 0.4 }, once: true, ai: 9,
      desc: 'Pain is just information.' },

    /* -------- ROGUE (v0.7 — Opportunist: tricks + one cheat-death) -------- */
    /* prefer:'lowest' (new spec field): engine aims at the lowest-hp foe */
    backstab: { id: 'backstab', name: 'Backstab', cls: 'Rogue', tier: 'basic', target: 'enemy', type: 'attack',
      power: 1.2, cd: 0, cost: null, effects: [], condition: null, ai: 5, prefer: 'lowest',
      desc: 'Fair fights are a choice.' },
    /* burn = poison wearing a knife's clothing (desc carries the flavor) */
    poisonedblade: { id: 'poisonedblade', name: 'Poisoned Blade', cls: 'Rogue', tier: 'basic', target: 'enemy', type: 'attack',
      power: 1.0, cd: 3, cost: null, effects: [{ kind: 'burn', dur: 2, pct: 0.3 }], condition: null, ai: 6,
      desc: 'Steel first. Chemistry after.' },
    smokebomb: { id: 'smokebomb', name: 'Smoke Bomb', cls: 'Rogue', tier: 'basic', target: 'party', type: 'protect',
      power: 0, cd: 3, cost: null, effects: [{ kind: 'barrier', dur: 1, pct: 0.2 }], condition: null, ai: 7,
      desc: 'Nobody hits what they cannot see.' },
    /* the one free death-cheat: 100% barrier for a turn, then hit very hard */
    vanish: { id: 'vanish', name: 'Vanish', cls: 'Rogue', tier: 'basic', target: 'self', type: 'protect',
      power: 0, cd: 0, cost: null, effects: [{ kind: 'barrier', dur: 1, pct: 1 }, { kind: 'atkup', dur: 1, pct: 0.8 }], condition: { selfHpBelow: 0.3 }, once: true, ai: 10,
      desc: 'You only die if you are there.' }
  };

  /* Class kits (hero.skills = these ids). All five classes run pure-data
   * kits as of v0.7 — the Warrior/Rogue ['strike'] placeholder is retired
   * (migrateToV7 promotes old saves off it; combat.js keeps the W/R legacy
   * act only as an un-migrated-hero fallback). */
  var KITS = {
    Mage:    ['fireball', 'meteor', 'emergencybarrier', 'lastflame'],
    Tank:    ['shieldbash', 'bulwark', 'taunt', 'unbreakable'],
    Healer:  ['mend', 'guardianprayer', 'cleanse', 'benediction'],
    Warrior: ['cleave', 'crushingblow', 'warcry', 'berserk'],
    Rogue:   ['backstab', 'poisonedblade', 'smokebomb', 'vanish']
  };

  /* Kit ids by class — always a fresh array (callers may reorder/mutate).
   * Unknown/missing class falls back to the shared basic attack. */
  function kitFor(cls) {
    var ids = KITS[cls];
    return (ids && ids.length) ? ids.slice() : ['strike'];
  }

  /* Reaction identity, fixed at recruit from axes. Precedence (V06-CONTRACT):
   * courage>=70 laststand · loyalty>=80 protective · fear>=70 cowardretreat ·
   * greed>=70 killer · else steady. Heroes without usable axes land steady. */
  function reactionFor(h) {
    var ax = function (k) { return (h && typeof h[k] === 'number') ? h[k] : 0; };
    if (ax('courage') >= 70) return 'laststand';
    if (ax('loyalty') >= 80) return 'protective';
    if (ax('fear') >= 70) return 'cowardretreat';
    if (ax('greed') >= 70) return 'killer';
    return 'steady';
  }

  /* ============================== v0.7 HERO TRAITS (pure data) ============================== */
  /* One trait per hero, rolled uniform at recruit (rollTrait) and stored as
   * hero.trait (id string) — what makes two recruits of a class differ.
   * Engine applies BY TRAIT ID in generic hooks (combat.js, AGENT-G4); no
   * hero-specific code anywhere, same rule as skills/reactions.
   * Spec shape — every field present on every entry:
   *   id / name / desc / hooks
   *     id:    stable key stored on heroes + the engine hook key
   *     name:  profile TRAIT row label (ui, AGENT-H4)
   *     desc:  player-facing one-liner — mechanic first, flavor after
   *     hooks: implementation notes for the engine owner (NOT player-facing):
   *            where each modifier lands so G4 can wire it without guessing
   * Balance guard (V07-CONTRACT): traits must not move the gates out of band
   * (±3 points) — G4's N=300 gate run owns that report.
   */
  var TRAITS = {
    irongut:     { id: 'irongut', name: 'Iron Gut',
      desc: '+15% effective max HP. They have eaten worse.',
      hooks: 'combat.js: effective-maxHp calc ×1.15 (hp pool + heal caps, not a one-time heal)' },
    glassedge:   { id: 'glassedge', name: 'Glass Edge',
      desc: '+15% attack, −15% defense. The edge cuts the hand that holds it.',
      hooks: 'combat.js: eAtk ×1.15 AND eDef ×0.85 — one trait, both numbers' },
    coldblood:   { id: 'coldblood', name: 'Cold Blood',
      desc: 'Never freezes in Panic, whatever the fear meter says.',
      hooks: 'combat.js: Panic gate (fear≥75 freeze) bypassed for this trait ONLY — every other fear effect (debuffs, pressure) still applies' },
    bloodthirst: { id: 'bloodthirst', name: 'Bloodthirst',
      desc: '+10% damage while any enemy is below 30% HP. Wounded things smell like winning.',
      hooks: 'combat.js: outgoing dmg ×1.10 while any LIVING enemy sits below 30% of its maxHp' },
    nighteyes:   { id: 'nighteyes', name: 'Night Eyes',
      desc: '+10% damage on Darkness floors (11–13). The dark never fooled them.',
      hooks: 'combat.js: outgoing dmg ×1.10 on DARKNESS floors (11–13 — the same band map.js scoutCost keys on)' },
    faintheart:  { id: 'faintheart', name: 'Faint Heart',
      desc: '−10% damage dealt, but retreat orders always succeed. Alive is a strategy.',
      hooks: 'combat.js: outgoing dmg ×0.90. Plus: Coward\'s Retreat / withdrawal compliance always succeeds (order flow — events/ui wiring)' }
  };
  var TRAIT_IDS = Object.keys(TRAITS);

  /* Uniform roll over the six (the contract's 'weighted-uniform' with all
   * weights equal). Called at recruit + by migration for traitless heroes. */
  function rollTrait() { return TRAIT_IDS[ri(0, TRAIT_IDS.length - 1)]; }

  /* ============================== RNG / UTIL ============================== */

  var rnd = function (a, b) { return a + Math.random() * (b - a); };
  var ri = function (a, b) { return Math.floor(rnd(a, b + 1)); };
  var pick = function (arr) { return arr[Math.floor(Math.random() * arr.length)]; };
  var clamp = function (v, a, b) { return Math.max(a, Math.min(b, v)); };

  /* ============================== STATE ============================== */

  var S = null; // current state (also exported as IT.S via adopt)

  function adopt(st) { S = st; IT.S = st; return st; }

  function freshState() {
    return {
      ver: 7,
      gold: 250, permits: 3, nextId: 1,
      master: { level: 1, exp: 0 },   // v0.5: Master progression
      heroes: [],            // roster, cap 24 (30 from Master level 2 — rosterCap())
      party: [],             // heroIds, max 3, alive heroes only
      memorial: [],
      cleared: {},
      knowledge: { executioner: false, wallBroken: false, firstBlood: false, hollowKing: false },
      expedition: null,
      inventory: [],         // v0.4: unequipped Items
      supplies: { potion: 0, torch: 0, escape: 0 },  // v0.11: finite run resources
      remains: {},           // v0.4: floorN → [{heroName, cls, lvl, items, floor, epitaph}]
      nextItemId: 1,         // v0.4: next 'it<n>' id
      telemetry: freshTelemetry()  // v0.7: anonymous play counters (IT.track)
    };
  }

  function newGame() { return adopt(freshState()); }

  function loadGame() {
    var d = null;
    try {
      var raw = localStorage.getItem(KEY);
      if (raw) d = JSON.parse(raw);
    } catch (e) { d = null; }
    if (!d || !Array.isArray(d.heroes)) return null;
    var st = adopt(normalize(d));
    // MIGRATION CHAIN: v3 → v4 (memory layer) → v5 (master progression) →
    // v6 (skill system) → v7 (traits + telemetry + W/R kits), then re-save
    // once. Each step only fills what is missing (idempotent).
    var migrated = false;
    if (!st.ver || st.ver < 4) { migrateToV4(st); migrated = true; }
    if (!st.ver || st.ver < 5) { migrateToV5(st); migrated = true; }
    if (!st.ver || st.ver < 6) { migrateToV6(st); migrated = true; }
    if (!st.ver || st.ver < 7) { migrateToV7(st); migrated = true; }
    if (migrated) save();
    return st;
  }

  function save() {
    try { localStorage.setItem(KEY, JSON.stringify(S)); } catch (e) { /* storage unavailable/blocked */ }
  }

  /* Fill defaults so partially-shaped saves never crash the other modules. */
  function normalize(d) {
    var mx = 0;
    d.ver = typeof d.ver === 'number' ? d.ver : 3; // v0.4: keep stored ver so migration runs once
    d.gold = typeof d.gold === 'number' ? d.gold : 0;
    d.permits = typeof d.permits === 'number' ? d.permits : 0;
    // v0.5 master progression (belt-and-suspenders alongside migrateToV5 —
    // never touches ver, so migration still stamps it)
    var mst = (d.master && typeof d.master === 'object') ? d.master : {};
    d.master = {
      level: (typeof mst.level === 'number' && mst.level >= 1) ? Math.floor(mst.level) : 1,
      exp: (typeof mst.exp === 'number' && mst.exp >= 0) ? Math.floor(mst.exp) : 0
    };
    d.memorial = Array.isArray(d.memorial) ? d.memorial : [];
    d.cleared = d.cleared || {};
    var k = d.knowledge || {};
    d.knowledge = { executioner: !!k.executioner, wallBroken: !!k.wallBroken, firstBlood: !!k.firstBlood, hollowKing: !!k.hollowKing };
    d.expedition = d.expedition || null;
    // v0.11 supplies (belt-and-suspenders — never touches ver): finite,
    // bought in the lobby, carried into the Tower, GONE on a wipe.
    var sp = (d.supplies && typeof d.supplies === 'object') ? d.supplies : {};
    d.supplies = {
      potion: Math.max(0, Math.floor(Number(sp.potion) || 0)),
      torch: Math.max(0, Math.floor(Number(sp.torch) || 0)),
      escape: Math.max(0, Math.floor(Number(sp.escape) || 0))
    };
    // v0.7 telemetry (belt-and-suspenders alongside migrateToV7 — never
    // touches ver, so migration still stamps it)
    d.telemetry = normalizeTelemetry(d.telemetry);
    d.heroes.forEach(hydrate);
    // nextId must exceed every id ever issued (living + memorialized)
    d.heroes.concat(d.memorial).forEach(function (x) {
      if (x && typeof x.id === 'number' && x.id > mx) mx = x.id;
    });
    d.nextId = Math.max(typeof d.nextId === 'number' ? d.nextId : 0, mx + 1, 1);
    d.party = Array.isArray(d.party)
      ? d.party.filter(function (id) { return d.heroes.some(function (h) { return h.id === id; }); }).slice(0, 3)
      : [];
    return d;
  }

  function hydrate(h) {
    if (!h) return h;
    if (typeof h.courage !== 'number') h.courage = 50;
    if (typeof h.greed !== 'number') h.greed = 50;
    if (typeof h.loyalty !== 'number') h.loyalty = 50;
    if (typeof h.fear !== 'number') h.fear = 15;
    if (typeof h.exp !== 'number') h.exp = 0;
    if (typeof h.kills !== 'number') h.kills = 0;
    if (typeof h.floors !== 'number') h.floors = 0;
    if (!Array.isArray(h.memories)) h.memories = [];
    // v0.4 memory layer fields (belt-and-suspenders alongside migrateToV4)
    if (!h.rel || typeof h.rel !== 'object') h.rel = {};
    if (!h.items || typeof h.items !== 'object') h.items = {};
    if (!h.items.weapon) h.items.weapon = null;
    if (!h.items.armor) h.items.armor = null;
    if (!h.items.trinket) h.items.trinket = null;
    if (typeof h.grieving !== 'number') h.grieving = 0;
    // v0.6 skill system (belt-and-suspenders alongside migrateToV6)
    if (!Array.isArray(h.skills) || !h.skills.length) h.skills = kitFor(h.cls);
    if (typeof h.reaction !== 'string') h.reaction = reactionFor(h);
    // v0.7 trait (belt-and-suspenders alongside migrateToV7)
    if (typeof h.trait !== 'string' || !Object.prototype.hasOwnProperty.call(TRAITS, h.trait)) h.trait = rollTrait();
    if (!h.personality) label(h);
    return h;
  }

  /* ============================== HERO ============================== */

  function unusedName() {
    /* v0.12: living heroes keep their names; the DEAD release theirs back
       into the pool — the Tower sends them back sometimes. 75% fresh name /
       25% a name off the memorial when one is available, so a returning
       hero stays an event (~4%/recruit early, growing as the memorial does). */
    var living = {};
    S.heroes.forEach(function (h) { living[h.name] = 1; });
    var dead = {};
    S.memorial.forEach(function (m) { dead[m.name] = 1; });
    var fresh = DATA.NAMES.filter(function (n) { return !living[n] && !dead[n]; });
    var avail = DATA.NAMES.filter(function (n) { return !living[n]; });
    if (!avail.length) return pick(DATA.NAMES) + ' II';
    var pool = fresh;
    /* rng discipline: NO extra draw when no memorial name is in play, or
       golden's seeded stream shifts and the freeze breaks */
    if (fresh.length !== avail.length && (Math.random() >= 0.75 || !fresh.length)) pool = avail;
    return pick(pool);
  }

  function rollRarity() {
    var r = Math.random(), acc = 0, i, row;
    for (i = 0; i < DATA.GACHA_RATES.length; i++) {
      row = DATA.GACHA_RATES[i];
      acc += row[1];
      if (r < acc) return row[0];
    }
    return 1;
  }

  /* v0.2 formula: hp/atk/def scale with rarity, agi with variance only. */
  function makeHero() {
    var star = rollRarity();
    var cls = pick(Object.keys(DATA.CLASSES));
    var C = DATA.CLASSES[cls];
    var m = DATA.RARITY_MULT[star];
    var v = function () { return rnd(.92, 1.08); };
    var h = {
      id: S.nextId++,
      name: unusedName(),
      cls: cls,
      rarity: star, lvl: 1, exp: 0,
      maxHp: Math.round(C.hp * m * v()),
      atk: Math.round(C.atk * m * v()),
      def: Math.round(C.def * m * v()),
      agi: Math.round(C.agi * v()),
      courage: ri(20, 90),
      greed: ri(10, 90),
      loyalty: ri(50, 90),
      fear: ri(5, 30),
      kills: 0, floors: 0,
      memories: [],
      rel: {},                                           // v0.4: { otherHeroId: -100..100 }
      items: { weapon: null, armor: null, trinket: null }, // v0.4: worn gear
      grieving: 0                                        // v0.4: battles of grief remaining
    };
    h.hp = h.maxHp;
    h.skills = kitFor(cls);        // v0.6: class kit (full 4-skill kit, all five classes)
    h.reaction = reactionFor(h);   // v0.6: identity fixed at recruit from axes
    h.trait = rollTrait();         // v0.7: one trait, uniform over the six
    /* v0.12 LEGACY — the name belonged to someone who died in the Tower.
       Names return to the pool on death (unusedName), so the gacha can roll
       a dead hero's name again: the Tower sends them BACK. Not a dupe shard
       — a person, twice. Memorial keeps the count of returns. */
    var prior = null;
    for (var mi = 0; mi < (S.memorial || []).length; mi++) {
      if (S.memorial[mi] && S.memorial[mi].name === h.name) { prior = S.memorial[mi]; break; }
    }
    if (prior) {
      prior.returns = (prior.returns || 0) + 1;
      h.legacy = { floor: prior.diedFloor || 0, count: prior.returns,
                   epitaph: prior.epitaph || '' };
      h.loyalty = ri(80, 95);             // nobody climbs twice by accident
      h.fear = Math.max(0, h.fear - 10);   // they have seen worse
      h.memories.push({ floor: prior.diedFloor || 0,
        text: 'The Tower sent them back. They have died on Floor ' +
              (prior.diedFloor || '?') + ' once already.' });
    }
    label(h); // derives + assigns personality
    S.heroes.push(h);
    return h;
  }

  function expNeed(lvl) { return 60 + 45 * lvl; }

  /* v0.2 multipliers, per level gained. */
  function grantExp(h, amount) {
    if (!h || !amount) return 0;
    var gained = 0;
    h.exp += amount;
    while (h.exp >= expNeed(h.lvl)) {
      h.exp -= expNeed(h.lvl);
      h.lvl++;
      gained++;
      h.maxHp = Math.round(h.maxHp * 1.10);
      h.atk = Math.round(h.atk * 1.09);
      h.def = Math.round(h.def * 1.06);
      h.agi = Math.round(h.agi * 1.03) + 1;
      h.hp = Math.min(h.maxHp, h.hp + 30);
    }
    return gained;
  }

  /* Spend 1 permit, else gold (120; 90 from Master level 5 — recruitCost()).
   * null when broke (or roster full — rosterCap(): 24, 30 from ML2). */
  function gacha() {
    if (S.heroes.length >= rosterCap()) return null;
    var used;
    if (S.permits > 0) { S.permits--; used = '1 Permit'; }
    else {
      var cost = recruitCost();
      if (S.gold >= cost) { S.gold -= cost; used = cost + ' Gold'; }
      else return null;
    }
    var hero = makeHero();
    save();
    return { hero: hero, used: used };
  }

  /* 0.4g per missing HP (×0.6 from Master level 4 — restMult()). Heals all
   * heroes, fear -25. null when nothing to heal / can't afford. */
  function rest() {
    var missing = S.heroes.reduce(function (s, h) { return s + (h.maxHp - h.hp); }, 0);
    var cost = Math.ceil(missing * 0.4 * restMult());
    if (missing < 1 || S.gold < cost) return null;
    S.gold -= cost;
    S.heroes.forEach(function (h) {
      h.hp = h.maxHp;
      h.fear = clamp(h.fear - 25, 0, 100);
    });
    save();
    return { cost: cost };
  }

  function addMemory(hero, floor, text) {
    if (!hero || !Array.isArray(hero.memories)) return;
    hero.memories.push({ floor: floor, text: text });
    if (hero.memories.length > MEMO_CAP) hero.memories.splice(0, hero.memories.length - MEMO_CAP);
  }

  var HERO_FIELDS = ['id', 'name', 'cls', 'rarity', 'lvl', 'exp', 'hp', 'maxHp', 'atk', 'def', 'agi',
                     'courage', 'greed', 'loyalty', 'fear', 'personality', 'kills', 'floors', 'memories'];

  /* v0.4 death path: fallen gear → remains entry on this floor → snapshot →
   * removal → every mourner (bond>=30) grieves. */
  function recordDeath(hero, floor, killer) {
    if (!hero) return null;
    if (!S.remains || typeof S.remains !== 'object') S.remains = {};
    /* v0.14 TEMPTATION: a pact-bound hero belongs to the Tower — no gear,
     * no body on the floor. Only the name comes back (and it can). */
    var items = hero.pact ? [] : makeFallenItems(hero).concat(makeFallenGear(hero, floor));
    if (hero.pact) killer = 'the pact, collected';
    if (!Array.isArray(S.remains[floor])) S.remains[floor] = [];
    // bonds still live on the survivors while the dead hero is on the roster
    var mournerIds = mournersOf(hero.id);
    var mem = {};
    HERO_FIELDS.forEach(function (f) { mem[f] = hero[f]; });
    if (mem.memories && mem.memories.slice) mem.memories = mem.memories.slice();
    mem.diedFloor = floor;
    mem.killer = killer || 'Floor ' + floor + ' denizens';
    mem.epitaph = S.memorial.length === 0 ? DATA.FIRST_BLOOD : pick(DATA.EPITAPHS);
    mem.items = items; // memorial card reads .name off each
    mem.mourners = mournerIds.map(function (id) {
      var m = heroById(id);
      return m ? m.name : null;
    }).filter(function (n) { return !!n; });
    /* no remains node for the pact-bound — there is nothing on the floor
     * to find; only the memorial (and the name, which can return) remains */
    if (!hero.pact) S.remains[floor].push({
      heroName: hero.name, cls: hero.cls, lvl: hero.lvl,
      items: items, floor: floor, epitaph: mem.epitaph
    });
    S.memorial.push(mem);
    S.heroes = S.heroes.filter(function (h) { return h.id !== hero.id; });
    S.party = S.party.filter(function (id) { return id !== hero.id; });
    // after removal — grief lands on every mourner
    mournerIds.forEach(function (id) {
      var m = heroById(id);
      if (!m) return;
      m.grieving = 1;
      m.fear = clamp(m.fear + 10, 0, 100);
      label(m);
      addMemory(m, floor, hero.name + ' fell. ' + m.name + ' will not speak of it.');
    });
    S.knowledge.firstBlood = true;
    save();
    return mem;
  }

  /* ============================== v0.4 MEMORY LAYER ============================== */
  /* Bonds, grief, fallen-gear item pool, remains, v3→v4 migration. */

  var SLOTS = ['weapon', 'armor', 'trinket'];

  function heroById(id) {
    for (var i = 0; i < S.heroes.length; i++) if (S.heroes[i].id === id) return S.heroes[i];
    return null;
  }

  /* bond read: symmetric, missing key = 0, always within -100..100.
   * Writes go ONLY through addBond. */
  function bond(aId, bId) {
    var a = heroById(aId), b = heroById(bId);
    var v = (a && a.rel && typeof a.rel[bId] === 'number') ? a.rel[bId]
          : (b && b.rel && typeof b.rel[aId] === 'number') ? b.rel[aId] : 0;
    return clamp(Math.round(v), -100, 100);
  }

  /* bond write: clamp -100..100, rel entry created on BOTH heroes. → new value. */
  function addBond(aId, bId, d) {
    if (typeof d !== 'number' || !d) return bond(aId, bId);
    var a = heroById(aId), b = heroById(bId);
    if (!a || !b || aId === bId) return 0;
    var v = clamp(bond(aId, bId) + d, -100, 100);
    if (!a.rel || typeof a.rel !== 'object') a.rel = {};
    if (!b.rel || typeof b.rel !== 'object') b.rel = {};
    a.rel[bId] = v;
    b.rel[aId] = v;
    return v;
  }

  /* Every pair among partyIds with bond >= 60 → [[aId,bId,val],...]. */
  function bondedPairs(partyIds) {
    var ids = partyIds || [], out = [], i, j, v;
    for (i = 0; i < ids.length; i++) {
      for (j = i + 1; j < ids.length; j++) {
        v = bond(ids[i], ids[j]);
        if (v >= 60) out.push([ids[i], ids[j], v]);
      }
    }
    return out;
  }

  /* Living heroes whose bond to deadId is >= 30 → [heroId,...]. */
  function mournersOf(deadId) {
    return S.heroes.filter(function (h) {
      return h.id !== deadId && bond(h.id, deadId) >= 30;
    }).map(function (h) { return h.id; });
  }

  /* "Gear of the fallen" pool roll. Stats per contract:
   * weapon {atk 6-14} · armor {def 5-12, hp 10-30} · trinket {hp 15-40, atk 2-6}.
   * history starts as 'Carried by <deadName> (†F<floor>)'. */
  function rollFallenItem(slot, deadName, floor) {
    var it;
    if (slot === 'weapon') {
      it = { id: null, name: pick(DATA.FALLEN_ITEMS.weapon), slot: 'weapon', atk: ri(6, 14), def: 0, hp: 0, history: '' };
    } else if (slot === 'armor') {
      it = { id: null, name: pick(DATA.FALLEN_ITEMS.armor), slot: 'armor', atk: 0, def: ri(5, 12), hp: ri(10, 30), history: '' };
    } else {
      it = { id: null, name: pick(DATA.FALLEN_ITEMS.trinket), slot: 'trinket', atk: ri(2, 6), def: 0, hp: ri(15, 40), history: '' };
    }
    it.id = 'it' + S.nextItemId++;
    it.history = 'Carried by ' + deadName + ' (†F' + floor + ')';
    return it;
  }

  /* Fallen heroes also "carried" fresh gear: 50% per EMPTY slot at death.
   * (Worn slots are handled by makeFallenItems — this only fills the rest.) */
  function makeFallenGear(hero, floor) {
    var out = [], items = (hero && hero.items) || {};
    SLOTS.forEach(function (slot) {
      if (!items[slot] && Math.random() < 0.5) out.push(rollFallenItem(slot, hero.name, floor));
    });
    return out;
  }

  /* Unequip every worn item (history appends ', then <carrier>' — they died
   * wearing it). Returns the items; hero.items ends with all slots null. */
  function makeFallenItems(hero) {
    var out = [];
    if (!hero) return out;
    if (!hero.items || typeof hero.items !== 'object') hero.items = { weapon: null, armor: null, trinket: null };
    SLOTS.forEach(function (slot) {
      var it = hero.items[slot];
      hero.items[slot] = null;
      if (it) {
        it.history = it.history ? it.history + ', then ' + hero.name
                                : 'Carried by ' + hero.name;
        out.push(it);
      }
    });
    return out;
  }

  /* Unequipped storage. Assigns an id if the item lacks one. → item. */
  function addItemToInventory(item) {
    if (!item) return null;
    if (!item.id) item.id = 'it' + S.nextItemId++;
    if (!Array.isArray(S.inventory)) S.inventory = [];
    S.inventory.push(item);
    return item;
  }

  /* v3 → v4: fill rel/items/grieving on heroes, inventory/remains/nextItemId on
   * state; stamp ver 4. Idempotent — only fills what is missing. */
  function migrateToV4(st) {
    if (!st) return st;
    if (!Array.isArray(st.inventory)) st.inventory = [];
    if (!st.remains || typeof st.remains !== 'object') st.remains = {};
    (Array.isArray(st.heroes) ? st.heroes : []).forEach(function (h) {
      if (!h) return;
      if (!h.rel || typeof h.rel !== 'object') h.rel = {};
      if (!h.items || typeof h.items !== 'object') h.items = {};
      SLOTS.forEach(function (s) { if (!h.items[s]) h.items[s] = null; });
      if (typeof h.grieving !== 'number') h.grieving = 0;
    });
    // nextItemId must exceed every item id ever issued
    var mx = 0;
    function scan(it) {
      var n;
      if (it && typeof it.id === 'string' && it.id.indexOf('it') === 0) {
        n = parseInt(it.id.slice(2), 10);
        if (!isNaN(n) && n > mx) mx = n;
      }
    }
    st.inventory.forEach(scan);
    Object.keys(st.remains).forEach(function (k) {
      var list = st.remains[k];
      (Array.isArray(list) ? list : []).forEach(function (entry) {
        (entry && Array.isArray(entry.items) ? entry.items : []).forEach(scan);
      });
    });
    (Array.isArray(st.heroes) ? st.heroes : []).forEach(function (h) {
      if (h && h.items) SLOTS.forEach(function (s) { scan(h.items[s]); });
    });
    st.nextItemId = Math.max(typeof st.nextItemId === 'number' ? st.nextItemId : 1, mx + 1, 1);
    st.ver = 4;
    return st;
  }

  /* ============================== v0.5 MASTER PROGRESSION / REWARDS ============================== */

  function masterLevel() {
    return (S && S.master && typeof S.master.level === 'number') ? S.master.level : 1;
  }

  /* EXP to go from lvl → lvl+1. Curve per V05-CONTRACT: 100 × lvl. */
  function masterExpNeed(lvl) { return 100 * lvl; }

  /* Add n master EXP → levels gained (0 when none). Pure state math: the
   * caller saves and handles the level-up toast/panel (ui applies this in
   * finishExpedition: floor n → n*8 EXP, +60 extra on floors 10 and 20). */
  function grantMasterExp(n) {
    if (!S || !S.master) return 0;
    n = Math.floor(Number(n) || 0);
    if (n <= 0) return 0;
    var gained = 0, need;
    S.master.exp += n;
    while ((need = masterExpNeed(S.master.level)) > 0 && S.master.exp >= need) {
      S.master.exp -= need;
      S.master.level++;
      gained++;
    }
    return gained;
  }

  /* Floor-clear rewards (V05-CONTRACT) — single source of truth so ui/combat
   * never hardcode numbers. Gold 40+25×floor; F10 (The Wall) 600; F20 (The
   * Hollow King) 900. Permits: +1 on floors 3/6/9/12/15/18; F10 = 3; F20 = 4. */
  var PERMIT_FLOORS = [3, 6, 9, 12, 15, 18];

  function floorClearGold(n) {
    n = Math.floor(Number(n) || 0);
    if (n === 20) return 900;
    if (n === 10) return 600;
    return 40 + 25 * n;
  }

  function floorClearPermits(n) {
    n = Math.floor(Number(n) || 0);
    if (n === 20) return 4;
    if (n === 10) return 3;
    return PERMIT_FLOORS.indexOf(n) >= 0 ? 1 : 0;
  }

  /* Master unlock hooks (all fall back to the exact pre-v0.5 values):
   * ML2 → roster cap 24→30 · ML4 → rest cost ×0.6 · ML5 → recruit 120→90. */
  function rosterCap() { return masterLevel() >= 2 ? ROSTER_CAP + 6 : ROSTER_CAP; }
  function recruitCost() { return masterLevel() >= 5 ? 90 : RECRUIT_COST; }
  function restMult() { return masterLevel() >= 4 ? 0.6 : 1; }

  /* v4 → v5: fill master progression, stamp ver 5. Idempotent — only fills
   * what is missing. Runs after migrateToV4 in loadGame, so a v3 save gets
   * BOTH the v4 memory layer and the v5 master fields in one load. */
  function migrateToV5(st) {
    if (!st) return st;
    var m = (st.master && typeof st.master === 'object') ? st.master : {};
    st.master = {
      level: (typeof m.level === 'number' && m.level >= 1) ? Math.floor(m.level) : 1,
      exp: (typeof m.exp === 'number' && m.exp >= 0) ? Math.floor(m.exp) : 0
    };
    st.ver = 5;
    return st;
  }

  /* v5 → v6: give every existing hero their skill kit (by class) and reaction
   * (by axes), stamp ver 6. Idempotent — only fills what is missing, never
   * re-rolls an already-assigned reaction. Runs after migrateToV5 in loadGame,
   * so a v3 save gets v4+v5+v6 in one load. Heroes lacking usable axes land
   * on 'steady' + their class kit (or ['strike'] for unknown classes). */
  function migrateToV6(st) {
    if (!st) return st;
    (Array.isArray(st.heroes) ? st.heroes : []).forEach(function (h) {
      if (!h) return;
      if (!Array.isArray(h.skills) || !h.skills.length) h.skills = kitFor(h.cls);
      if (typeof h.reaction !== 'string') h.reaction = reactionFor(h);
    });
    st.ver = 6;
    return st;
  }

  /* v6 → v7: roll a trait for every hero lacking one (idempotent — a rolled
   * trait is never re-rolled), promote Warrior/Rogue heroes off the retired
   * ['strike'] placeholder onto their real kits, seed telemetry counters,
   * stamp ver 7. Runs after migrateToV6 in loadGame, so a v3 save gets
   * v4+v5+v6+v7 in one load. */
  function migrateToV7(st) {
    if (!st) return st;
    (Array.isArray(st.heroes) ? st.heroes : []).forEach(function (h) {
      if (!h) return;
      if (typeof h.trait !== 'string' || !Object.prototype.hasOwnProperty.call(TRAITS, h.trait)) {
        h.trait = rollTrait();
      }
      // v0.6 stamped W/R with ['strike'] while their kits were pending; any
      // other skill array (a real kit) is left exactly as saved
      if ((h.cls === 'Warrior' || h.cls === 'Rogue') &&
          Array.isArray(h.skills) && h.skills.length === 1 && h.skills[0] === 'strike') {
        h.skills = kitFor(h.cls);
      }
    });
    st.telemetry = normalizeTelemetry(st.telemetry);
    st.ver = 7;
    return st;
  }

  /* ============================== v0.7 LIGHT TELEMETRY ============================== */
  /* Anonymous play counters for the upcoming playtest — no PII, nothing
   * per-hero. Persisted with the save (S.telemetry). Hook points live with
   * their owners (ui: run_started/second_run/scout_used/floor_cleared/
   * run_ended; combat: combat_started/hero_injured/hero_died). Counters are
   * visible in console via IT.telemetryDump() — playtesters paste the JSON
   * back. second_run = a run_started < 60s after the previous run_ended
   * (the 'อยากกดอีกไหม' metric — its timing bookkeeping is ui's, in-memory). */

  var TELEMETRY_KEYS = ['run_started', 'scout_used', 'combat_started', 'hero_injured',
                        'hero_died', 'floor_cleared', 'run_ended', 'second_run'];

  function freshTelemetry() {
    var t = {}, i;
    for (i = 0; i < TELEMETRY_KEYS.length; i++) t[TELEMETRY_KEYS[i]] = 0;
    return t;
  }

  /* Known counters keep their stored value (integers, never negative);
   * anything else in the object is dropped so the schema stays fixed. */
  function normalizeTelemetry(t) {
    var out = freshTelemetry(), k;
    if (t && typeof t === 'object') {
      for (k in out) {
        if (Object.prototype.hasOwnProperty.call(t, k) && typeof t[k] === 'number' && t[k] > 0) {
          out[k] = Math.floor(t[k]);
        }
      }
    }
    return out;
  }

  var lastTrackedAt = 0; // epoch ms of the last track()-triggered save

  /* Increment a counter by n (default 1; unknown keys ignored so a typo'd
   * hook cannot grow the schema). Saving is throttled to once per second —
   * a lone track never re-serializes more than once per second, and saves
   * the flow makes anyway simply piggyback the counter along. */
  function track(evt, n) {
    if (!S) return;
    if (!S.telemetry) S.telemetry = freshTelemetry();
    if (!Object.prototype.hasOwnProperty.call(S.telemetry, evt)) return;
    S.telemetry[evt] += (typeof n === 'number' && n >= 1) ? Math.floor(n) : 1;
    var now = Date.now();
    if (now - lastTrackedAt >= 1000) {
      lastTrackedAt = now;
      save();
    }
  }

  /* Console dump for playtesters — the counters as a JSON string. */
  function telemetryDump() {
    return JSON.stringify(S && S.telemetry ? S.telemetry : freshTelemetry());
  }

  /* ============================== PERSONALITY LABEL ============================== */

  var AXIS_LABELS = [['courage', 'Brave'], ['greed', 'Greedy'], ['loyalty', 'Loyal'], ['fear', 'Coward']];

  function label(hero) {
    var lab;
    if (hero.courage >= 70) lab = 'Brave';
    else if (hero.fear >= 70) lab = 'Coward';
    else if (hero.greed >= 70) lab = 'Greedy';
    else if (hero.loyalty >= 80) lab = 'Loyal';
    else if (hero.greed >= 60 && hero.courage >= 60) lab = 'Reckless';
    else if (hero.fear <= 30 && hero.courage <= 40) lab = 'Cautious';
    else {
      var best = null, i, ax;
      for (i = 0; i < AXIS_LABELS.length; i++) {
        ax = AXIS_LABELS[i];
        if (!best || hero[ax[0]] > best.v) best = { lab: ax[1], v: hero[ax[0]] };
      }
      lab = best ? best.lab : 'Brave';
    }
    hero.personality = lab; // re-derive anytime axes change
    return lab;
  }

  /* ============================== DECISION ENGINE ============================== */
  /* score = 50 + Σ (axis × weight). Signs are per contract table. */

  var DECIDE_W = {
    open_chest:    { courage: +0.2, greed: +0.5, loyalty: 0,    fear: -0.4 }, // mimic risk invisible to hero
    investigate:   { courage: +0.4, greed: +0.2, loyalty: 0,    fear: -0.5 }, // dark/unknown
    help_stranger: { courage: +0.4, greed: -0.3, loyalty: +0.3, fear: -0.2 },
    rob_stranger:  { courage: 0,    greed: +0.5, loyalty: -0.6, fear: 0 },
    retreat:       { courage: -0.5, greed: 0,    loyalty: +0.1, fear: +0.4 },
    sacrifice:     { courage: +0.4, greed: 0,    loyalty: +0.5, fear: -0.3 },
    push_on:       { courage: +0.4, greed: +0.1, loyalty: 0,    fear: -0.4 }
  };

  /* In-character lines, plain text; wrapped in quotes on output. */
  var LINES = {
    comply: {
      generic:  ["Done.", "I'm on it.", "Right behind you.", "Moving now.", "Say no more."],
      Brave:    ["Stand back. I'll take it.", "Finally, some action.", "Watch me work."],
      Coward:   ["O-okay. But quickly.", "I'll go. Don't rush me.", "Just... stay close."],
      Greedy:   ["Whatever pays.", "Loot first. Questions later.", "Gold says yes."],
      Loyal:    ["For you, Master.", "As you order.", "Your call is my call."],
      Reckless: ["Already running.", "HA! Watch this.", "Too slow — I'm gone."],
      Cautious: ["Carefully, then.", "Slow is smooth, Master.", "On my terms. Slowly."]
    },
    grudging: {
      generic:  ["Fine. Don't blame me later.", "Ugh. If you insist.", "This is a mistake. Doing it.",
                 "One day this kills us.", "My way was faster."],
      Brave:    ["I'd rather fight it. Fine.", "Coward's plan. But okay.", "This dulls my blade. Whatever."],
      Coward:   ["Why me? Fine. Going.", "I hate you a little.", "If I die, I'm haunting you."],
      Greedy:   ["Where's my cut, though?", "No loot? Fine. Doing it.", "I'm invoicing the Tower."],
      Loyal:    ["I trust you. Barely.", "Not my choice. Still yours.", "For the party. Not you."],
      Reckless: ["Boring. But fine.", "Slower than I'd like.", "Fine. Next time, my plan."],
      Cautious: ["Against my better judgment.", "Noted. Proceeding under protest.", "There's a safer way. Ignoring it."]
    },
    refuse: {
      generic:  ["No.", "Not happening.", "Find another fool.", "I'm not dying today.", "Ask someone else."],
      Brave:    ["I don't run.", "Never. We hold.", "You flinch. I won't."],
      Coward:   ["Nope. Nope. Nope.", "That room eats people.", "My legs say no."],
      Greedy:   ["No coin, no risk.", "What's the payout? Nothing?", "I don't work free."],
      Loyal:    ["Not against my own.", "I won't leave them.", "That betrays the party."],
      Reckless: ["Waiting? I'd rather die.", "Plans are for cowards.", "No. We smash through."],
      Cautious: ["Too risky. I did the math.", "That's how parties die.", "I checked. It's suicide."],
      disloyal: ["Why should I bleed for you?", "You first, Master.", "My contract says otherwise."]
    },
    alt: {
      generic:  ["Third option: this.", "Better idea — follow me.", "I've got another way.", "New plan. Keep up."],
      Brave:    ["Or — I just charge.", "Better: I go first."],
      Coward:   ["Or we just... leave?", "Alternate plan: I hide."],
      Greedy:   ["Or we take it quietly.", "Better: I pocket it first."],
      Loyal:    ["Or we shield them instead.", "I'll cover the others."],
      Reckless: ["Or — bigger swing, bigger glory.", "Let's just torch it."],
      Cautious: ["Or we scout it first.", "I know a safer route."]
    }
  };

  function lineFor(verdict, hero, gated) {
    var pool;
    if (verdict === 'refuse' && gated) pool = LINES.refuse.disloyal;
    else pool = (LINES[verdict][hero.personality] && LINES[verdict][hero.personality].length)
      ? LINES[verdict][hero.personality]
      : LINES[verdict].generic;
    return '"' + pick(pool) + '"';
  }

  function decide(hero, action, ctx) {
    ctx = ctx || {};
    var w = DECIDE_W[action] || {};
    var score = 50, k;
    for (k in w) {
      if (Object.prototype.hasOwnProperty.call(w, k) && w[k]) {
        score += (typeof hero[k] === 'number' ? hero[k] : 0) * w[k];
      }
    }
    score = Math.round(clamp(score, 0, 100));
    var verdict = score >= 60 ? 'comply' : (score >= 40 ? 'grudging' : 'refuse');
    // refused + an alternative exists -> 50% they do their own thing instead
    if (verdict === 'refuse' && ctx.alt && Math.random() < 0.5) verdict = 'alt';
    // loyalty gate: low-loyalty hero flat-refuses any order (except retreat) 30% of the time
    var gated = false;
    if (hero.loyalty < 25 && action !== 'retreat' && Math.random() < 0.3) {
      verdict = 'refuse';
      gated = true;
    }
    return { verdict: verdict, line: lineFor(verdict, hero, gated), score: score };
  }

  /* ============================== EXPORT ============================== */

  IT.DATA = DATA;
  IT.newGame = newGame;
  IT.loadGame = loadGame;
  IT.save = save;
  IT.rnd = rnd;
  IT.ri = ri;
  IT.pick = pick;
  IT.clamp = clamp;
  IT.makeHero = makeHero;
  IT.rollRarity = rollRarity;
  IT.gacha = gacha;
  IT.expNeed = expNeed;
  IT.grantExp = grantExp;
  IT.rest = rest;
  IT.addMemory = addMemory;
  IT.recordDeath = recordDeath;
  IT.decide = decide;
  IT.label = label;
  /* v0.4 memory layer */
  IT.bond = bond;
  IT.addBond = addBond;
  IT.bondedPairs = bondedPairs;
  IT.mournersOf = mournersOf;
  IT.addItemToInventory = addItemToInventory;
  IT.makeFallenItems = makeFallenItems;
  IT.rollFallenItem = rollFallenItem;
  IT.makeFallenGear = makeFallenGear;
  IT.migrateToV4 = migrateToV4;
  /* v0.5 master progression + reward constants */
  IT.masterExpNeed = masterExpNeed;
  IT.grantMasterExp = grantMasterExp;
  IT.floorClearGold = floorClearGold;
  IT.floorClearPermits = floorClearPermits;
  IT.rosterCap = rosterCap;
  IT.recruitCost = recruitCost;
  IT.restMult = restMult;
  IT.migrateToV5 = migrateToV5;
  /* v0.6 skill system (pure data — combat.js owns the engine) */
  IT.SKILLS = SKILLS;
  IT.KITS = KITS;
  IT.kitFor = kitFor;
  IT.reactionFor = reactionFor;
  IT.migrateToV6 = migrateToV6;
  /* v0.7 full roster: traits + telemetry (engine wiring = AGENT-G4,
   * profile/hook calls = AGENT-H4; core stays pure data + storage) */
  IT.TRAITS = TRAITS;
  IT.rollTrait = rollTrait;
  IT.migrateToV7 = migrateToV7;
  IT.track = track;
  IT.telemetryDump = telemetryDump;

  /* IT.S is valid immediately; ui.init() will loadGame() or newGame() over it. */
  adopt(freshState());

})(window.IT);
