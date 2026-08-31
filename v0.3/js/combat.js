'use strict';
/* combat.js — AGENT-D — Infinite Tower v0.3 (v0.4 memory layer by AGENT-G)
   Semi-auto battle engine. Exact port of v0.2 combat math (rawDmg, class skills,
   tank intercept + targeting bias, Executioner 3-turn cycle / phase 2, makeEnemies)
   plus v0.3 Master interrupts, resolve states, Last Stand, and per-hero retreat.
   v0.4: effective stats from equipped items (saved stats never mutated), grieving
   (-10% dmg, burns off one battle), bonds (>=60 pair +3% dmg, +1 on resolve,
   healer bonds with the healed), mourners marked on in-battle deaths.
   v0.5 (AGENT-G2): floor rule modifiers (DARKNESS 11-13 enemy atk +10%,
   BLOOD MOON 14-16 desperate heroes hit harder/bleed easier, BETRAYAL 17-19
   loyalty refusal gate <45), mobs 11-19, and THE HOLLOW KING boss (floor 20,
   3-phase cycle, courtier adds, Drain the Doubtful, phase 2 at <=50%).
   v0.6 (AGENT-G3): data-driven SKILL ENGINE (Mage/Tank/Healer read IT.SKILLS
   specs — per-hero cooldowns, condition gating, scored AI pick, 'strike'
   fallback; Warrior/Rogue keep their hardcoded v0.2 acts this version and any
   hero without kit data falls back to the legacy act), STATUS SYSTEM (burn /
   barrier / taunt / stun / redirect / stress + atkup for Benediction) resolved
   inside the existing damage pipelines, REACTIONS (per-hero identity: laststand /
   protective / cowardretreat / killer / steady), and Master Commands PROTECT /
   OVERDRIVE / SACRIFICE (once per battle, hero pickers for the two protective
   ones — combat.js owns every in-battle button; ui.js never renders battle
   controls). Telemetry: IT.combat.lastUsage = {skillId:count} per battle.
   v0.7 (AGENT-G4) "Full Roster": the kit path now covers ALL classes —
   Warrior/Rogue run pure-data kits and their legacyHeroAct usage retires (the
   function stays ONLY as the no-kit fallback for un-migrated heroes, i.e. a
   skills list that resolves to nothing but 'strike'). New GENERIC engine
   features (spec-driven, never a class/hero-id check): spec field
   executeBonus, spec field prefer:'lowest', status kind 'fragile'. Hero
   TRAITS applied by hero.trait id (guarded — see TRAITS block below). Light
   telemetry: combat_started / hero_injured / hero_died fired through IT.track
   when core ships it (guarded no-op otherwise).
   v0.8 (AGENT-FEEL-B, game-feel pass — PRESENTATION ONLY, mechanics frozen):
   battle view rebuilt per the V0.8 contract (enemy zone top: boss sprite BIG +
   name + one HP bar, mobs as a smaller sprite row; heroes mid as sprites +
   nameplates + slim HP bars + the same status tags; log collapses to a last-3
   strip, tap to expand; carved command buttons), DEATH BEAT (a hero falling
   mid-battle pauses the loop on a full-bleed beat — bowed sprite, DEFEATED,
   the death log line as epitaph, CONTINUE; auto 1.4s at fast speeds), and a
   VICTORY / THE PARTY IS LOST title card before the promise resolves.
   FREEZE SAFETY: every new DOM/timing path is gated on the built battle view
   (null headless — golden.js has no document, economy-sim's stub returns no
   #battle-view) AND on !IT.combat.FAST for anything that waits; the death
   beat is queued from heroDies AFTER its log push and drained at await points
   the loop already had — no rng draws, no round-flow change, result object
   untouched (tests/golden.js stays bit-identical).
   v0.9 (AGENT-SCENE): CANVAS BATTLE SCENE — when js/scene.js is loaded
   (IT.scene.attach), buildView hands the layout to it (canvas room + log +
   command bar) and renderUnits feeds it snapshots (sceneSnap) instead of
   rewriting DOM; beat moments call fx() (hit/heal/burn/skill/death/mark/
   shake). PRESENTATION ONLY, same freeze rules as v0.8: every scene path is
   gated on the scene handle being live (null headless / no-canvas / FAST
   harnesses), fx is try/caught, and no rng draw, no round flow, no result
   change — the legacy DOM view remains as the no-scene fallback.
   Renders into #battle-view (owns it), clears it when the promise resolves. */
window.IT = window.IT || {};
IT.combat = (function () {

/* ============================ local utils (self-contained) ============================ */
var rnd = function (a, b) { return a + Math.random() * (b - a); };
var ri = function (a, b) { return Math.floor(a + Math.random() * (b - a + 1)); };
var pick = function (arr) { return arr[Math.floor(Math.random() * arr.length)]; };
var clamp = function (v, a, b) { return Math.max(a, Math.min(b, v)); };
var wait = function (ms) { return ms <= 0 ? Promise.resolve() : new Promise(function (r) { setTimeout(r, ms); }); };

/* v0.7 telemetry — anonymous counters owned by core (IT.track(evt, n), saved
   with S.telemetry). Guarded: a core without it (or a throwing one) must never
   affect a battle. */
function track(evt, n) {
  if (typeof IT.track !== 'function') return;
  try { IT.track(evt, n || 1); } catch (e) { /* counters are best-effort */ }
}

/* v0.9: canvas scene handle (from IT.scene.attach in buildView; null when
   scene.js is absent, canvas is unusable, or the battle is headless — the
   legacy DOM view covers those). fx() reports beat moments for animation;
   it must never feed back into the engine. */
var scene = null;
function fx(type, data) {
  if (!scene) return;
  try { scene.fx(type, data); } catch (e) { /* presentation only */ }
}

/* v0.9.3: audio hooks (sound.js optional — silent when absent/muted) */
function sndPlay(name) {
  if (typeof IT !== 'undefined' && IT.snd && IT.snd.play) {
    try { IT.snd.play(name); } catch (e) { /* audio is best-effort */ }
  }
}
function sndMusic(track) {
  if (typeof IT !== 'undefined' && IT.snd && IT.snd.music) {
    try { IT.snd.music(track); } catch (e) { /* audio is best-effort */ }
  }
}

/* v0.5: floors 11-19 extend the list (index n-1 = floor n, mirroring core's
   IT.DATA.MOBS). Index 9 repeats 'Flesh Ogre' — floor 10's end node is the
   Executioner boss (early return below), but any floor-10 fallback roll keeps
   the pre-v0.5 name. */
var MOBS = ['Plague Rat','Cave Bat','Goblin Scrapper','Dire Wolf','Bandit',
            'Rattling Skeleton','Orc Raider','Tower Cultist','Flesh Ogre',
            'Flesh Ogre',
            'Tower Knight','Gloom Wraith','Changeling','Ash Beast','Pale Priest',
            'Hollow Courtier','Gloom Widow','Stone Warden','Twin Abomination'];
var ICON = { Warrior:'⚔️', Tank:'🛡️', Rogue:'🗡️', Mage:'🔮', Healer:'✨' };

/* ============================ v0.5 floor rule modifiers ============================ */
/* Derived from the battle's floor only — no core dependency. Applies to map
   combats AND event-sourced combats on that floor (rules key off cfg.floor). */
var RULES = [
  { id: 'darkness', lo: 11, hi: 13, label: '🌑 DARKNESS',
    line: '🌑 Darkness — something moves at the edge of the light.' },
  { id: 'bloodmoon', lo: 14, hi: 16, label: '🌕 BLOOD MOON',
    line: '🌕 Blood Moon — desperation cuts deeper, and wounds gape wider.' },
  { id: 'betrayal', lo: 17, hi: 19, label: '🐍 BETRAYAL',
    line: '🐍 Betrayal — on this floor, every order is a test of faith.' }
];
function ruleFor(floor) {
  for (var i = 0; i < RULES.length; i++) {
    if (floor >= RULES[i].lo && floor <= RULES[i].hi) return RULES[i];
  }
  return null;
}
function isRule(id) { return !!(B && B.rule && B.rule.id === id); }

var HAS_DOM = (typeof document !== 'undefined') && !!document.getElementById;

/* ============================ scoped style (injected once) ============================ */
/* v0.8 AGENT-FEEL-B — battle sheet rewritten for the contract composition:
   stone & candle, open composition (hairlines + kickers, cards only where the
   thing IS an object), sprites for people, numbers demoted to footnotes.
   Class names consumed by the JS below; tag classes (cb-tag*) keep their
   v0.6/v0.7 semantics untouched. Colors ride style.css tokens with literal
   fallbacks so this sheet stands alone if the shell is older. */
var STYLE = [
/* --- shell --- */
'#battle-view{position:relative;display:flex;flex-direction:column;gap:10px;padding:12px 14px 14px;min-height:100%;color:var(--txt,#d7dce6);font:15px/1.5 -apple-system,"Segoe UI",Roboto,Arial,sans-serif;background:radial-gradient(900px 380px at 50% -8%,rgba(232,176,75,.055),transparent 60%),radial-gradient(700px 360px at 108% 112%,rgba(224,82,99,.045),transparent 55%),radial-gradient(500px 260px at -8% 88%,rgba(95,191,119,.03),transparent 60%),#07080c;}',
'.cb-top{display:flex;justify-content:space-between;align-items:baseline;gap:10px;padding-bottom:8px;border-bottom:1px solid rgba(232,176,75,.25);}',
'.cb-floor{font-family:Cinzel,Georgia,serif;font-weight:800;font-size:15px;letter-spacing:3px;color:var(--gold,#e8b04b);text-transform:uppercase;}',
'.cb-round{color:var(--dim,#8b94a7);font-size:11.5px;letter-spacing:1.5px;text-transform:uppercase;}',
'.cb-sect{font-size:10px;letter-spacing:2.5px;color:var(--dim,#8b94a7);text-transform:uppercase;margin:2px 0 4px;}',
'.cb-rule{font-size:10.5px;letter-spacing:2px;color:var(--red,#e05263);border:1px solid rgba(224,82,99,.35);display:inline-block;padding:3px 8px;border-radius:4px;margin-bottom:6px;}',
/* --- enemy zone (top): boss BIG + one bar; mobs as a smaller sprite row --- */
'.cb-stage{display:flex;flex-direction:column;gap:4px;padding-bottom:10px;border-bottom:1px solid rgba(232,176,75,.14);}',
'.cb-bosszone{display:flex;align-items:center;gap:14px;padding:6px 4px 8px;}',
'.cb-bossfig{width:104px;height:104px;min-width:104px;font-size:64px;display:flex;align-items:center;justify-content:center;background:radial-gradient(80% 70% at 50% 30%,rgba(224,82,99,.12),transparent 70%),#0c0e14;border:1px solid rgba(224,82,99,.4);border-radius:52px 52px 10px 10px;box-shadow:0 6px 18px rgba(0,0,0,.55),inset 0 1px 0 rgba(255,255,255,.05);filter:drop-shadow(0 0 12px rgba(224,82,99,.18));}',
'.cb-bossfig.dead{filter:grayscale(1) brightness(.5);opacity:.55;}',
'.cb-bossinfo{flex:1;min-width:0;display:flex;flex-direction:column;gap:5px;}',
'.cb-bossname{font-family:Cinzel,Georgia,serif;font-weight:800;font-size:17px;letter-spacing:2px;color:var(--txt,#d7dce6);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}',
'.cb-bossbar{height:10px;background:#080a0e;border:1px solid rgba(232,176,75,.25);border-radius:5px;overflow:hidden;margin:2px 0 1px;}',
'.cb-bossbar i{display:block;height:100%;background:linear-gradient(90deg,#a8333f,var(--red,#e05263));transition:width .3s ease;}',
'.cb-bossbar i.cb-low{background:#e05263;}',
'.cb-bossmeta{display:flex;flex-wrap:wrap;align-items:center;gap:4px;min-height:0;}',
'.cb-bosshp{color:var(--dim,#8b94a7);font-size:11.5px;font-variant-numeric:tabular-nums;margin-right:4px;}',
'.cb-slain{font-size:10px;letter-spacing:2px;color:var(--dim,#8b94a7);}',
'.cb-mobrow{display:flex;gap:8px;overflow-x:auto;padding-bottom:2px;}',
'.cb-mob{flex:1 1 0;min-width:86px;display:flex;flex-direction:column;align-items:center;gap:3px;padding:6px 4px;border:1px solid rgba(232,176,75,.12);border-radius:10px 10px 6px 6px;background:rgba(20,24,34,.55);}',
'.cb-mob.cb-elite{border-color:rgba(232,176,75,.45);}',
'.cb-mob.dead{opacity:.4;}',
'.cb-esprite{width:54px;height:54px;font-size:32px;display:flex;align-items:center;justify-content:center;background:#0c0e14;border:1px solid rgba(232,176,75,.18);border-radius:27px 27px 6px 6px;box-shadow:0 4px 10px rgba(0,0,0,.5);}',
'.cb-esprite.dead{filter:grayscale(1) brightness(.5);}',
'.cb-mname{font-size:10.5px;letter-spacing:.8px;color:var(--txt,#d7dce6);text-align:center;line-height:1.25;max-width:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}',
'.cb-mname em{display:block;font-style:normal;font-size:8.5px;letter-spacing:2px;color:var(--gold,#e8b04b);}',
/* --- heroes mid: sprites + nameplates + slim bars + tags --- */
'.cb-partywrap{padding:2px 0 8px;}',
'.cb-partyrow{display:flex;gap:8px;}',
'.cb-hero{flex:1 1 0;min-width:0;display:flex;flex-direction:column;align-items:center;gap:3px;padding:6px 3px 7px;border-radius:12px 12px 6px 6px;border:1px solid transparent;}',
'.cb-hero.cb-marked{border-color:rgba(224,82,99,.55);animation:cbpulse 1s infinite alternate;}',
'.cb-hero.dead{opacity:.6;}',
'.cb-hero.withdrawn{opacity:.55;}',
'.cb-hero.cb-pick{cursor:pointer;border-color:var(--blue,#5aa2e8);box-shadow:0 0 0 1px rgba(90,162,232,.6);}',
'@keyframes cbpulse{to{box-shadow:0 0 10px 2px rgba(224,82,99,.5);}}',
'#battle-view .hero-sprite{width:72px;height:78px;font-size:42px;display:flex;align-items:center;justify-content:center;background:radial-gradient(75% 60% at 50% 28%,rgba(232,176,75,.07),transparent 70%),#0d1017;border:1px solid rgba(232,176,75,.22);border-top-color:rgba(232,176,75,.4);border-radius:36px 36px 8px 8px;box-shadow:0 5px 14px rgba(0,0,0,.5),inset 0 1px 0 rgba(255,255,255,.04);animation:cbBreathe 2.8s ease-in-out infinite;}',
'#battle-view .hero-sprite.dead{animation:none;transform:rotate(6deg) translateY(6px);filter:grayscale(1) brightness(.55);border-color:rgba(139,148,167,.2);}',
'#battle-view .hero-sprite.gone{animation:none;filter:grayscale(.7) brightness(.7);opacity:.7;}',
'@keyframes cbBreathe{0%,100%{transform:translateY(0)}50%{transform:translateY(-3px)}}',
'.cb-hero.cb-cwarrior .hero-sprite{border-top-color:rgba(217,142,63,.5)}',
'.cb-hero.cb-ctank .hero-sprite{border-top-color:rgba(127,143,166,.55)}',
'.cb-hero.cb-crogue .hero-sprite{border-top-color:rgba(126,201,126,.5)}',
'.cb-hero.cb-cmage .hero-sprite{border-top-color:rgba(155,110,232,.55)}',
'.cb-hero.cb-chealer .hero-sprite{border-top-color:rgba(95,212,224,.55)}',
'.cb-name{font-family:Cinzel,Georgia,serif;font-size:11.5px;font-weight:700;letter-spacing:1px;color:var(--txt,#d7dce6);max-width:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;text-align:center;}',
'.cb-hero.dead .cb-name{color:var(--dim,#8b94a7);text-decoration:line-through;text-decoration-color:rgba(224,82,99,.6);}',
'.cb-hpbar{width:100%;height:4px;background:#080a0e;border-radius:2px;overflow:hidden;}',
'.cb-hpbar i{display:block;height:100%;background:var(--green,#5fbf77);transition:width .3s ease;}',
'.cb-hpbar i.cb-low{background:var(--red,#e05263);}',
'.cb-hpnum{font-size:9.5px;color:var(--dim,#8b94a7);font-variant-numeric:tabular-nums;letter-spacing:.5px;}',
/* --- status tags (semantics unchanged from v0.6/v0.7) --- */
'.cb-tags{display:flex;flex-wrap:wrap;justify-content:center;gap:3px;min-height:0;}',
'.cb-tag{font-size:9px;line-height:1;padding:3px 5px;border-radius:3px;border:1px solid rgba(232,176,75,.18);color:var(--dim,#8b94a7);background:rgba(15,18,26,.8);letter-spacing:.4px;white-space:nowrap;}',
'.cb-tag.cb-tmark{color:var(--red,#e05263);border-color:var(--red,#e05263);font-weight:700;}',
'.cb-tag.cb-tfocus{color:var(--green,#5fbf77);border-color:var(--green,#5fbf77);}',
'.cb-tag.cb-tpress{color:var(--gold,#e8b04b);border-color:var(--gold,#e8b04b);}',
'.cb-tag.cb-tpanic{color:var(--red,#e05263);border-color:var(--red,#e05263);font-weight:700;}',
'.cb-tag.cb-tlast{color:var(--gold,#e8b04b);border-color:var(--gold,#e8b04b);font-weight:800;background:#241a08;}',
'.cb-tag.cb-tgone{color:var(--dim,#8b94a7);}',
'.cb-tag.cb-tgrief{color:#a99bd1;border-color:#5c5280;}',
'.cb-tag.cb-tburn{color:#e8845b;border-color:#a04b2c;}',
'.cb-tag.cb-tbar{color:#7fb0e8;border-color:#3d5a80;}',
'.cb-tag.cb-ttaunt{color:var(--gold,#e8b04b);border-color:#8a6a1f;}',
'.cb-tag.cb-tstun{color:#c99be8;border-color:#6a4b8a;}',
'.cb-tag.cb-tredir{color:#5fd4e0;border-color:#2f6f78;}',
'.cb-tag.cb-tbuff{color:var(--green,#5fbf77);border-color:#2f6f42;}',
'.cb-tag.cb-tfrag{color:#e0849b;border-color:#8a3b4d;}',
/* --- log: slim last-3 strip, tap to expand --- */
'.cb-logwrap{margin-top:auto;display:flex;flex-direction:column;border-top:1px solid rgba(232,176,75,.14);padding-top:6px;}',
'.cb-logtoggle{align-self:flex-start;background:none;border:none;color:var(--dim,#8b94a7);font-size:9.5px;letter-spacing:2.5px;text-transform:uppercase;cursor:pointer;padding:2px 0 4px;}',
'.cb-logtoggle:active{color:var(--gold,#e8b04b);}',
'.cb-log{background:#080a0e;border:1px solid rgba(232,176,75,.12);border-radius:6px;padding:6px 9px;overflow-y:auto;font:11px/1.5 ui-monospace,Menlo,Consolas,monospace;white-space:pre-wrap;max-height:180px;}',
'.cb-logwrap.collapsed .cb-log{max-height:63px;overflow:hidden;border-color:rgba(232,176,75,.08);}',
'.cb-log .cb-sys{color:var(--gold,#e8b04b)}.cb-log .cb-bad{color:var(--red,#e05263)}.cb-log .cb-good{color:var(--green,#5fbf77)}.cb-log .cb-dim{color:var(--dim,#8b94a7)}',
/* --- command bar: carved stone/brass --- */
'.cb-barwrap{border-top:1px solid rgba(232,176,75,.25);padding-top:8px;display:flex;flex-direction:column;gap:6px;}',
'.cb-hint{font-size:13px;color:var(--gold,#e8b04b);min-height:0;font-family:Alegreya,Georgia,serif;}',
'.cb-cmds{display:flex;flex-wrap:wrap;gap:8px;}',
'.cb-btn{min-height:50px;min-width:44px;padding:9px 16px;color:var(--txt,#d7dce6);border:1px solid #3a4356;border-top-color:#4d5870;border-bottom-color:#0b0e15;border-radius:10px;background:linear-gradient(180deg,#252c3c,#161b26 55%,#111520);font-size:15px;font-weight:600;letter-spacing:.4px;cursor:pointer;box-shadow:inset 0 1px 0 rgba(255,255,255,.07),0 3px 6px rgba(0,0,0,.5);}',
'.cb-btn:active{transform:translateY(1px);box-shadow:inset 0 2px 7px rgba(0,0,0,.65);}',
'.cb-btn.cb-on{color:var(--gold,#e8b04b);border-color:var(--gold,#e8b04b);box-shadow:inset 0 1px 0 rgba(255,255,255,.07),0 0 10px rgba(232,176,75,.25);}',
'.cb-btn.cb-danger{color:var(--red,#e05263);border-color:rgba(224,82,99,.6);background:linear-gradient(180deg,#2b1a20,#170f13 55%,#120d10);}',
'.cb-btn.cb-big{flex:1 1 40%;font-size:15.5px;}',
'.cb-btn:disabled{opacity:.35;cursor:default;}',
'.cb-spd{display:flex;gap:5px;align-items:center;}',
'.cb-spd .cb-btn{min-height:34px;min-width:40px;padding:4px 10px;font-size:12px;border-radius:8px;letter-spacing:0;}',
'.cb-mc{margin-top:2px;}',
'.cb-mc .cb-btn{flex:1 1 30%;font-size:12.5px;letter-spacing:1.5px;padding:8px 6px;font-family:Cinzel,Georgia,serif;font-weight:700;}',
'.cb-pickhint{font-size:13px;color:#5fd4e0;}',
/* --- v0.8 death beat (full-bleed) --- */
'.cb-beat{position:absolute;inset:0;z-index:30;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:9px;padding:26px 22px;text-align:center;background:radial-gradient(420px 300px at 50% 38%,rgba(224,82,99,.10),transparent 70%),rgba(4,5,8,.96);animation:cbFade .28s ease both;}',
'#battle-view .cb-beat .cb-beatfig{width:120px;height:126px;font-size:64px;animation:cbBow .7s ease both;border-color:rgba(139,148,167,.25);}',
'@keyframes cbBow{from{transform:rotate(0) translateY(0)}to{transform:rotate(6deg) translateY(10px)}}',
'.cb-beatname{font-family:Cinzel,Georgia,serif;font-size:17px;font-weight:800;letter-spacing:3px;color:var(--txt,#d7dce6);}',
'.cb-beatword{font-family:Cinzel,Georgia,serif;font-size:29px;font-weight:800;letter-spacing:9px;color:var(--red,#e05263);text-indent:9px;}',
'.cb-beatquote{font:italic 14.5px/1.65 Alegreya,Georgia,serif;color:var(--dim,#8b94a7);max-width:36ch;}',
'.cb-beat .cb-btn{min-width:180px;}',
/* --- v0.8 end title card --- */
'.cb-titlecard{position:absolute;inset:0;z-index:31;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:8px;background:rgba(4,5,8,.96);animation:cbFadeIn .9s ease both;cursor:pointer;}',
'.cb-tcword{font-family:Cinzel,Georgia,serif;font-size:30px;font-weight:800;letter-spacing:8px;text-indent:8px;text-align:center;}',
'.cb-titlecard.cb-tcwin .cb-tcword{color:var(--gold,#e8b04b);}',
'.cb-titlecard.cb-tcret .cb-tcword{color:var(--dim,#8b94a7);font-size:24px;}',
'.cb-titlecard.cb-tcloss .cb-tcword{color:var(--red,#e05263);font-size:23px;letter-spacing:5px;}',
'.cb-tcsub{font:italic 13.5px/1.6 Alegreya,Georgia,serif;color:var(--dim,#8b94a7);letter-spacing:.5px;}',
'.cb-tcskip{font-size:9px;letter-spacing:2.5px;color:rgba(139,148,167,.55);text-transform:uppercase;margin-top:14px;}',
'@keyframes cbFade{from{opacity:0}to{opacity:1}}',
'@keyframes cbFadeIn{from{opacity:0;transform:scale(1.04)}to{opacity:1;transform:scale(1)}}',
/* --- reduced motion: beats stay, motion does not --- */
'@media(prefers-reduced-motion:reduce){#battle-view .hero-sprite{animation:none}.cb-hero.cb-marked{animation:none}.cb-beat{animation:none}#battle-view .cb-beat .cb-beatfig{animation:none}.cb-titlecard{animation:none}.cb-hpbar i,.cb-bossbar i{transition:none}}'
].join('\n');

function injectStyle() {
  if (!HAS_DOM) return;
  try {
    if (document.getElementById('cb-style')) return;
    var s = document.createElement('style');
    s.id = 'cb-style';
    s.textContent = STYLE;
    document.head.appendChild(s);
  } catch (e) { /* style is cosmetic; never block battle */ }
}

/* ============================ v0.2 port: enemy generation ============================ */
function makeEnemies(n) {
  if (n === 10) return [{ name: 'THE EXECUTIONER 👹', maxHp: 1300, hp: 1300, atk: 46, def: 10, bounty: 200, boss: true, elite: false, step: 0 }];
  /* v0.5: floor 20 — THE HOLLOW KING (contract spec atk52/def12; hp tuned
     1900→2250 after sim — 1900 gave informed runs 93-99% vs the 65-85% target;
     2250 lands 68-79% across comps while blind stays <15%. All multipliers,
     the drain, and the adds stay contract-exact). Cycle/phase 2 live in kingAct. */
  if (n === 20) return [{ name: 'THE HOLLOW KING 👑', maxHp: 2250, hp: 2250, atk: 52, def: 12, bounty: 400, boss: true, elite: false, step: 0 }];
  var scale = 1 + (n - 1) * 0.28, ascale = 1 + (n - 1) * 0.26, dscale = 1 + (n - 1) * 0.22;
  var count = n <= 4 ? 2 : 3;
  var list = [];
  for (var i = 0; i < count; i++) {
    var nm = MOBS[n - 1] || pick(MOBS), m = 1, elite = false;
    if (n >= 6 && i === 0) { nm = 'Elite ' + nm; m = 1.5; elite = true; }
    if (n === 9 || n === 19) m *= 1.1;   // v0.5: floor 19 bulges like floor 9
    list.push({ name: nm, maxHp: Math.round(40 * scale * m), hp: Math.round(40 * scale * m),
      atk: Math.round(8 * ascale * m), def: Math.round(2 * dscale * m),
      bounty: Math.round((20 + n * 9) * m), boss: false, elite: elite, step: 0 });
  }
  return list;
}

/* ============================ module state ============================ */
var B = null;                 // active battle (not persisted)
var view = null, logEl = null, barEl = null, floorEl = null, roundEl = null,
    stageEl = null, partyEl = null, logWrapEl = null, logBtnEl = null;
/* v0.8 presentation state (battle-scoped, never touched headless):
   deathQueue — heroes fallen since the last drain (the beat is shown from the
                loop's existing await points, NOT from inside the engine);
   beatEl/beatResolve/beatTimer — the currently-showing death beat;
   cardEl — the end-of-battle title card;  logOpen — log strip expanded? */
var deathQueue = [];
var beatEl = null, beatResolve = null, beatTimer = null;
var cardEl = null;
var logOpen = false;

/* IT.combat.FAST — test hook: strip round delays.
   IT.combat.auto — test hook: fn(moment) -> choice id, skips UI wait. */
function st(h) { return B.st[h.id]; }
function heroById(id) { for (var i = 0; i < B.heroes.length; i++) if (B.heroes[i].id === id) return B.heroes[i]; return null; }
function aliveH() { return B.heroes.filter(function (h) { return h.hp > 0 && !B.st[h.id].withdrawn; }); }
function aliveE() { return B.enemies.filter(function (e) { return e.hp > 0; }); }
function boss() { for (var i = 0; i < B.enemies.length; i++) if (B.enemies[i].boss && B.enemies[i].hp > 0) return B.enemies[i]; return null; }

/* ============================ v0.4 memory layer: effective stats & bonds ============================ */
/* Effective stats = saved stats + equipped items (hero.items), computed once per
   battle. Saved atk/def/maxHp are NEVER mutated — only hp is healed up by the
   hp bonus so a full hero stays at 100% of their effective pool. */
function eAtk(h) { var e = B.eff && B.eff[h.id]; return e ? e.atk : h.atk; }
function eDef(h) { var e = B.eff && B.eff[h.id]; return e ? e.def : h.def; }
function eMax(h) { var e = B.eff && B.eff[h.id]; return e ? e.maxHp : h.maxHp; }

/* ============================ v0.7 hero traits ============================ */
/* One rolled trait id per hero (hero.trait, data + roll in core's IT.TRAITS).
   The engine applies effects BY ID in generic hooks — no hero-id code, and a
   hero with no trait field (pre-v0.7 save before migration) simply matches
   nothing and plays exactly as before:
   irongut     +15% effective maxHp (current hp rises with the cap, so a full
               hero stays at 100% of the effective pool — same rule as item hp)
   glassedge   +15% eAtk, −15% eDef
   coldblood   fear-gated freezes never fire for this hero; Panic's −25% dmg
               still applies (the trait ignores the freeze only)
   bloodthirst +10% dmg while any living enemy is below 30% maxHp
   nighteyes   +10% dmg on DARKNESS floors (11-13)
   faintheart  −10% dmg dealt; always complies with a withdrawal order */
function traitOf(h) {
  return (h && typeof h.trait === 'string') ? h.trait : null;
}
/* any living enemy under the execute threshold (30% maxHp) */
function anyEnemyLow() {
  return aliveE().some(function (e) { return e.hp < e.maxHp * 0.3; });
}

function computeEffective(party) {
  B.eff = {};
  party.forEach(function (h) {
    var a = 0, d = 0, hp = 0, items = h.items || {};
    Object.keys(items).forEach(function (slot) {
      var it = items[slot];
      if (it && typeof it === 'object') { a += it.atk || 0; d += it.def || 0; hp += it.hp || 0; }
    });
    /* v0.7 traits fold in here so every eAtk/eDef/eMax consumer (damage, def
       subtraction, heal caps, resolve states, conditions) sees them for free.
       v0.14: the pact's promised vigor (+10% eMax per level). */
    var tr = traitOf(h);
    var baseHp = h.maxHp + hp;
    var pactHp = (h.pact && h.pact.lvl) ? (1 + 0.10 * Math.min(3, h.pact.lvl)) : 1;
    var eff = {
      atk: Math.round((h.atk + a) * (tr === 'glassedge' ? 1.15 : 1)),
      def: Math.round((h.def + d) * (tr === 'glassedge' ? 0.85 : 1)),
      maxHp: Math.round(baseHp * (tr === 'irongut' ? 1.15 : 1) * pactHp)
    };
    B.eff[h.id] = eff;
    var gain = (hp > 0 ? hp : 0) + (eff.maxHp - baseHp);   // item hp + trait hp fill current hp
    if (gain > 0 && h.hp > 0) h.hp = Math.min(eff.maxHp, h.hp + gain);
  });
}

/* Pairs holding the line together: bond >= 60 at battle start. Guarded so an
   older core (no IT.bond) keeps combat fully functional. */
function computeBonds(party) {
  B.bondPairs = [];
  B.bondedIds = {};
  if (typeof IT.bond !== 'function') return;
  for (var i = 0; i < party.length; i++) {
    for (var j = i + 1; j < party.length; j++) {
      var v = 0;
      try { v = IT.bond(party[i].id, party[j].id) || 0; } catch (e) { v = 0; }
      if (v >= 60) {
        B.bondPairs.push([party[i].id, party[j].id]);
        B.bondedIds[party[i].id] = true;
        B.bondedIds[party[j].id] = true;
      }
    }
  }
}

/* Living heroes who feel a death (bond >= 30). Combat only marks grief/fear —
   remains & recordDeath stay owned by the flow layer. */
function mournersFor(dead) {
  var out = [];
  if (typeof IT.mournersOf === 'function') {
    var ids;
    try { ids = IT.mournersOf(dead.id) || []; } catch (e) { ids = []; }
    ids.forEach(function (id) {
      var h = heroById(id);
      if (h && h.id !== dead.id && h.hp > 0) out.push(h);
    });
    return out;
  }
  if (typeof IT.bond === 'function') {
    B.heroes.forEach(function (h) {
      if (h.id === dead.id || h.hp <= 0) return;
      try { if ((IT.bond(h.id, dead.id) || 0) >= 30) out.push(h); } catch (e) { /* skip */ }
    });
  }
  return out;
}

function mournDeath(dead) {
  var mourners = mournersFor(dead);
  if (!mourners.length) return;
  /* fear+10 and the memory line are recordDeath's job (flow calls it from
     result.deaths) — combat only marks the grief so it fights the next battle */
  mourners.forEach(function (h) {
    h.grieving = 1;
  });
  log('🖤 ' + mourners.map(function (h) { return h.name; }).join(', ') + ' ' +
      (mourners.length === 1 ? 'watches' : 'watch') + ' ' + dead.name + ' fall. They will not speak of it.', 'dim');
}

/* Healer's work earns bond: +2 per heal toward each target, capped +6 per pair per battle. */
function noteHeal(healer, target) {
  if (typeof IT.addBond !== 'function') return;
  var k = healer.id + '|' + target.id;
  B.healBond[k] = Math.min(6, (B.healBond[k] || 0) + 2);
}

/* Battle resolve (win/retreat/loss alike): grief carried INTO the battle burns
   off one battle for survivors; fresh grief earned mid-battle (a mourner
   watching an ally fall) survives to fight the next battle at -10%. Surviving
   bonded pairs +1 bond; accrued heal-bond applied — both only if core has it. */
function resolveMemoryLayer() {
  B.heroes.forEach(function (h) {
    if (h.hp <= 0) return;
    var startGrief = (B.griefAtStart && B.griefAtStart[h.id]) || 0;
    if (startGrief > 0 && typeof h.grieving === 'number' && h.grieving > 0) h.grieving -= 1;
  });
  if (typeof IT.addBond !== 'function') return;
  B.bondPairs.forEach(function (p) {
    var a = heroById(p[0]), b = heroById(p[1]);
    if (!a || !b || a.hp <= 0 || b.hp <= 0) return;
    try { IT.addBond(a.id, b.id, 1); } catch (e) { /* core guard */ }
  });
  Object.keys(B.healBond).forEach(function (k) {
    var ids = k.split('|');
    var a = heroById(Number(ids[0])), b = heroById(Number(ids[1]));
    if (!a || !b || a.hp <= 0 || b.hp <= 0) return;
    try { IT.addBond(a.id, b.id, B.healBond[k]); } catch (e) { /* core guard */ }
  });
}

/* ============================ v0.6 SKILL / STATUS / REACTION ENGINE ============================ */
/* Everything below is pure DATA-driven: specs come from IT.SKILLS (core.js,
   AGENT-F3). Every field is typeof-guarded so an older/absent core degrades to
   the legacy hardcoded acts (which also keeps Warrior/Rogue on their exact
   v0.2 behavior — their kits come in a later version). */

/* Basic attack every kit hero falls back to when nothing qualifies
   (contract: power 0.75, no cd). If core ships a basic-attack spec under
   IT.SKILLS.strike we use that one verbatim. */
var STRIKE = { id: 'strike', name: 'strike', cls: '*', tier: 'basic',
  target: 'enemy', type: 'attack', power: 0.75, cd: 0, cost: null,
  effects: [], condition: null, ai: 1 };
function strikeSpec() {
  if (IT.SKILLS && IT.SKILLS.strike && typeof IT.SKILLS.strike === 'object' &&
      IT.SKILLS.strike.id) return IT.SKILLS.strike;
  return STRIKE;
}

/* v0.7: the kit path covers ALL classes — a hero runs the engine whenever
   their skills list resolves to real specs. The ONLY thing that still routes
   to the legacy act is a kit that is nothing but the shared basic attack
   (a pre-v0.7 Warrior/Rogue save, or a class whose kit has not landed in
   core yet): those heroes keep their exact v0.2 hardcoded behavior. */
function kitFor(h) {
  if (!IT.SKILLS || typeof IT.SKILLS !== 'object') return null;
  var ids = Array.isArray(h.skills) ? h.skills : null;
  if (!ids || !ids.length) return null;
  var kit = [], hasReal = false;
  for (var i = 0; i < ids.length; i++) {
    var sp = IT.SKILLS[ids[i]];
    if (sp && typeof sp === 'object' && sp.id && typeof sp.power !== 'undefined') {
      kit.push(sp);
      if (sp.id !== 'strike') hasReal = true;
    }
  }
  if (!hasReal) return null;   // 'strike'-only = un-migrated hero -> legacy fallback
  return kit.length ? kit : null;
}

/* ---------------------------- reactions (v0.6) ---------------------------- */
/* Per-HERO identity fixed at recruit (hero.reaction, set by core). Derived
   fallback uses the exact contract precedence: courage, loyalty, fear, greed,
   steady — so heroes without the field behave identically.
   IT.combat.REACTIONS = false is a test hook that strips the reaction layer
   (Last Stand is NOT a reaction — it keeps its own v0.3 courage>=85 trigger). */
var REACTION_IDS = { laststand: 1, protective: 1, cowardretreat: 1, killer: 1, steady: 1 };
function reactionOf(h) {
  if (IT.combat.REACTIONS === false) return null;
  if (h && typeof h.reaction === 'string' && REACTION_IDS[h.reaction]) return h.reaction;
  if (!h) return null;
  if (h.courage >= 70) return 'laststand';
  if (h.loyalty >= 80) return 'protective';
  if (h.fear >= 70) return 'cowardretreat';
  if (h.greed >= 70) return 'killer';
  return 'steady';
}

/* ---------------------------- statuses (v0.6) ---------------------------- */
/* Status = {kind,dur,pct,srcId,targetId,roundApplied}. Kinds:
   burn    dot = src atk * pct at the holder's turn start
   barrier dmg taken x(1-pct) while held
   taunt   enemies are forced to target the holder (attack targeting only —
           boss identity picks like the Executioner's gaze and the King's
           Drain choose by their own rules and ignore it)
   stun    holder skips its action; bosses are immune
   redirect damage aimed at the lowest-HP ally hits the holder at x pct
           (does NOT catch the Executioner's lethal execute)
   stress  informational only (stored + ticked, no engine effect yet)
   atkup   holder's outgoing damage x(1+pct)  [Benediction's +20% atk,
           War Cry's +15%, Berserk/Vanish bursts]
   fragile dmg taken x(1+pct) while held (v0.7 — Berserk's recklessness tax).
           The mirror of barrier: multiplies blows after def subtraction AND
           DoTs; like every taken-mod it never touches the lethal execute.
   cleanse / healPct / unbreakable are executor pseudo-effects resolved at
   cast time, never stored.

   v0.7 SPEC FIELDS (generic engine features — spec-driven, never a
   class/hero-id check; documented here alongside the statuses they feed):
   executeBonus           attack skill: dmg x(1+bonus) against targets below
                          30% maxHp (Crushing Blow's finisher; the AI also
                          scores it higher while any foe sits under the line).
                          TWO data encodings, both honored: a top-level
                          number, or an effects entry {kind:'executeBonus',
                          pct} (core's encoding — dur 0 pseudo-effect,
                          consumed by the hit itself, never stored)
   prefer:'lowest'        target:'enemy' skill: pick the lowest-HP foe
                          instead of the default boss-first focus (Backstab) */
function executeBonusOf(sp) {
  if (typeof sp.executeBonus === 'number' && sp.executeBonus > 0) return sp.executeBonus;
  var effs = sp.effects || [];
  for (var i = 0; i < effs.length; i++) {
    if (effs[i] && effs[i].kind === 'executeBonus' &&
        typeof effs[i].pct === 'number' && effs[i].pct > 0) return effs[i].pct;
  }
  return 0;
}

function statusesOf(targetId) {
  return B.statuses.filter(function (s) { return s.targetId === targetId && s.dur > 0; });
}
function hasStatus(targetId, kind) {
  for (var i = 0; i < B.statuses.length; i++) {
    if (B.statuses[i].targetId === targetId && B.statuses[i].kind === kind && B.statuses[i].dur > 0) return true;
  }
  return false;
}
/* Highest-pct active status of a kind (stacking barriers -> strongest wins). */
function statusPct(targetId, kind) {
  var best = 0;
  for (var i = 0; i < B.statuses.length; i++) {
    var s = B.statuses[i];
    if (s.targetId === targetId && s.kind === kind && s.dur > 0 && s.pct > best) best = s.pct;
  }
  return best;
}
function pruneStatuses() {
  for (var i = B.statuses.length - 1; i >= 0; i--) if (B.statuses[i].dur <= 0) B.statuses.splice(i, 1);
}

function applyStatus(target, eff, src) {
  if (!eff || !eff.kind || !target) return;
  if (eff.chance != null && Math.random() >= eff.chance) return;   // e.g. Shield Bash stun 25%
  if (eff.kind === 'stun' && target.boss) {   // bosses are stun-immune
    if (src) log(target.name + ' shrugs off the stun — bosses do not kneel.', 'dim');
    return;
  }
  if (eff.kind === 'unbreakable') {           // Tank skill: battle-level intercept state
    if (B.unbreak) return;
    B.unbreak = { id: target.id, rounds: Math.max(1, eff.dur || 1) };
    return;
  }
  B.statuses.push({ kind: eff.kind, dur: Math.max(1, Math.round(eff.dur || 1)),
    pct: (typeof eff.pct === 'number') ? eff.pct : 0,
    srcId: src ? src.id : null, targetId: (target.uid != null) ? target.uid : target.id,
    roundApplied: B.round });
}

/* Hero-side tick at the hero's turn start: burn dots bite, buff durations
   decay. Buffs applied THIS round don't decay on the holder's same-round turn
   (a dur:1 barrier must still cover the enemy phase to come); burn always
   ticks — its dot ticks once per holder turn, dur times total. */
function tickHeroStatuses(h) {
  var s = st(h);
  if (h.hp <= 0 || s.withdrawn) return;
  statusesOf(h.id).forEach(function (x) {
    if (x.kind === 'burn') {
      var src = x.srcId != null ? heroById(x.srcId) : null;
      applyDot(h, Math.round((src ? eAtk(src) : 10) * (x.pct || 0.25)), '🔥 Burn', src);
    }
    /* golden-090: hero-side burn now decays like every other status (it
       previously ticked forever — latent, nothing applied burn to heroes) */
    if (x.roundApplied !== B.round) x.dur--;
  });
  pruneStatuses();
}

/* Enemy-side tick at the enemy's turn start (burn / stun live on enemies). */
function tickEnemyStatuses(e) {
  var stunned = false;
  statusesOf(e.uid).forEach(function (x) {
    if (x.kind === 'burn') {
      var src = x.srcId != null ? heroById(x.srcId) : null;
      applyDot(e, Math.round((src ? eAtk(src) : 10) * (x.pct || 0.25)), '🔥 Burn', src);
    }
    if (x.kind === 'stun') stunned = true;
    x.dur--;
  });
  pruneStatuses();
  return stunned;
}

/* DoT application: barrier still softens it (damage taken), fragile amplifies
   it (v0.7 — the mirror of barrier), no intercepts, no redirect — a burn is
   not a blow anyone can step in front of. HP floors from Last Stand /
   Unbreakable / SACRIFICE(tank) still hold. */
function applyDot(t, amount, srcName, src) {
  if (!t || t.hp <= 0) return;
  var key = (t.uid != null) ? t.uid : t.id;
  var bar = (t.uid == null) ? statusPct(t.id, 'barrier') : 0;
  var fr = statusPct(key, 'fragile');
  var d = Math.max(1, Math.round(amount * (1 - bar) * (1 + fr)));
  t.hp -= d;
  log(srcName + ' sears ' + t.name + ' for ' + d +
      (bar > 0 ? ' (barrier)' : '') + (fr > 0 ? ' (fragile)' : '') + '.', 'bad');
  fx('burn', { to: { k: (t.uid != null) ? 'e' : 'h', id: t.id, uid: t.uid }, dmg: d });   // v0.9
  if (t.hp <= 0) {
    if (t.uid != null) { t.hp = 0; creditKill(t, src); log(t.name + ' burns out.', 'good'); return; }
    if (floorActive(t)) { t.hp = 1; return; }
    heroDies(t, srcName);
  }
  if (t.uid == null) noteInjury(t);
}

/* Active hp-floor effects on a hero (Last Stand / Unbreakable / tank SACRIFICE). */
function floorActive(h) {
  if (B.lastStand && B.lastStand.id === h.id && B.lastStand.rounds > 0) return true;
  if (B.unbreak && B.unbreak.id === h.id && B.unbreak.rounds > 0) return true;
  if (B.sacrifice && B.sacrifice.id === h.id && B.sacrifice.rounds > 0 && h.cls === 'Tank') return true;
  return false;
}

/* ---------------------------- shared kill/credit ---------------------------- */
function creditKill(e, h) {
  if (!h || !B.tally[h.id]) return;
  B.tally[h.id].kills++;
  B.tally[h.id].exp += e.bounty || 0;
}

/* v0.7 telemetry beat: first time IN THIS BATTLE a living hero drops below
   50% of their effective maxHp -> one hero_injured counter per battle. */
function noteInjury(t) {
  if (!B || B.injuredFired || !t || t.hp <= 0) return;
  if (t.hp < eMax(t) * 0.5) {
    B.injuredFired = true;
    track('hero_injured');
  }
}

/* The in-battle death beat (fear/loyalty shock, grief, mark clear) — shared by
   strikes, dots, everything. Remains/recordDeath stay owned by the flow layer. */
function heroDies(t, srcName) {
  t.hp = 0;
  B.deadIds.push(t.id);
  track('hero_died');   // v0.7 anonymous counter (flow layers must NOT double-fire this)
  log('☠ ' + srcName + ' → ' + t.name + ' FALLS. ' + t.name + ' is gone.', 'bad');
  fx('death', { to: { k: 'h', id: t.id } });   // v0.9 scene: the fall
  /* v0.8: queue the death beat — the log line just pushed is the epitaph.
     Pure no-op headless (no view); drained from runLoop's await points. */
  queueDeathBeat(t, B.lines[B.lines.length - 1]);
  aliveH().forEach(function (x) {
    x.fear = clamp(x.fear + 15, 0, 100);
    x.loyalty = clamp(x.loyalty - 8, 0, 100);
  });
  mournDeath(t);
  if (B.marked === t) B.marked = null;
  if (B.protect && B.protect.id === t.id) B.protect = null;
  if (B.sacrifice && B.sacrifice.id === t.id) B.sacrifice = null;
  if (B.unbreak && B.unbreak.id === t.id) B.unbreak = null;
  if (B.lastStand && B.lastStand.id === t.id) B.lastStand = null;
}

/* ---------------------------- cooldowns (v0.6) ---------------------------- */
/* cds[id] = spec.cd + 1 is set on cast; every hero turn STARTS by decrementing
   all of them, and a skill is castable only at <= 0 — so cd:N locks the skill
   for exactly N of the hero's turns ("cooldown turns after use"). cd:0 = every
   turn. Once-per-battle skills use B.skillOnce instead of a huge cd. */
function tickCooldowns(h) {
  var cds = B.skillCd[h.id];
  if (!cds) return;
  Object.keys(cds).forEach(function (k) { if (cds[k] > 0) cds[k]--; });
}
function skillReady(h, sp) {
  var cds = B.skillCd[h.id] || {};
  if ((cds[sp.id] || 0) > 0) return false;
  var once = B.skillOnce[h.id] || {};
  if ((sp.once === true || sp.oncePerBattle === true) && once[sp.id]) return false;
  return true;
}

/* ---------------------------- conditions (v0.6) ---------------------------- */
function conditionMet(h, sp) {
  var c = sp.condition;
  if (!c) return true;
  if (typeof c.selfHpBelow === 'number' && !(h.hp < eMax(h) * c.selfHpBelow)) return false;
  if (c.allyDiedThisBattle === true && !B.deadIds.length) return false;
  if (typeof c.anyAllyBelow === 'number' &&
      !aliveH().some(function (x) { return x.hp < eMax(x) * c.anyAllyBelow; })) return false;
  return true;
}

/* ---------------------------- targeting (v0.6) ---------------------------- */
function lowestHpAlly(list) {
  return list.slice().sort(function (a, b) { return a.hp / eMax(a) - b.hp / eMax(b); })[0] || null;
}
/* Target resolution per spec.target. Returns [] when the skill has no valid
   target this turn (the picker then treats it as unusable). */
function resolveTargets(h, sp) {
  var es = aliveE();
  if (sp.target === 'allEnemies') return es.slice();
  if (sp.target === 'enemy') {
    var low = es.slice().sort(function (a, c) { return a.hp - c.hp; })[0];
    /* prefer:'lowest' (v0.7): the spec hunts the most wounded foe — boss-first
       focus is skipped, so a finisher never wastes itself on a healthy boss
       while an add limps. */
    if (sp.prefer === 'lowest') return [low];
    var b = boss();
    return [(b && b.hp > 0) ? b : low];
  }
  if (sp.target === 'lowestAlly') {
    /* knowledge.executioner still teaches kit healers to answer the mark first
       (v0.3 behavior preserved for the Mend line) */
    if (B.marked && B.marked.hp > 0 && !B.st[B.marked.id].withdrawn && B.knowExec &&
        B.marked.hp < eMax(B.marked)) return [B.marked];
    return [lowestHpAlly(aliveH())];
  }
  if (sp.target === 'anyAllyBelow35') {
    var below = aliveH().filter(function (x) { return x.hp < eMax(x) * 0.35; });
    return below.length ? [lowestHpAlly(below)] : [];
  }
  if (sp.target === 'self') return [h];
  if (sp.target === 'party') return aliveH().slice();
  return [];
}
/* Pick-time validity: a heal with nothing to heal is not a cast (legacy healers
   smite instead — kit healers strike instead). */
function skillTargetsOk(h, sp, ts) {
  if (!ts.length) return false;
  if (sp.type === 'heal' && ts[0] && ts[0].hp >= eMax(ts[0])) return false;
  return true;
}

/* ---------------------------- AI scoring (v0.6) ---------------------------- */
/* score = spec.ai + situational bonuses, structural (never keyed on skill id):
   - heals scale with how hurt the lowest ally is (Mend),
   - protect/buff-ally skills jump when someone is critical (Emergency Barrier
     is huge the moment its condition passes),
   - AoE attacks prefer 3+ enemies (Fireball),
   - single-target nukes prefer a lone boss (Meteor),
   - stun effects are worth less into a boss (immune). */
function scoreSkill(h, sp, es) {
  var sc = (typeof sp.ai === 'number') ? sp.ai : 5;
  if (sp.type === 'heal') {
    var low = lowestHpAlly(aliveH());
    var pct = low ? low.hp / eMax(low) : 1;
    sc += (1 - pct) * 12;                        // Mend scales with the wound
  }
  if (sp.target === 'anyAllyBelow35' ||
      (sp.condition && typeof sp.condition.anyAllyBelow === 'number')) sc += 12;
  if (sp.target === 'allEnemies') {
    if (es.length >= 3) sc += 6;                 // Fireball vs 3+
    else if (es.length === 1) sc -= 3;
  }
  if (sp.target === 'enemy' && sp.type === 'attack') {
    /* nuke-vs-boss preference is for HEAVY single hits (power >= 1.5: Meteor,
       Last Flame) — a cheap spammable swing must not out-prioritize the kit */
    if ((typeof sp.power === 'number' ? sp.power : 1) >= 1.5 && boss() && es.length === 1) sc += 6;
    if (es.length >= 3) sc -= 3;
    /* executeBonus (v0.7): a finisher is worth more the moment someone is
       actually under the line */
    if (executeBonusOf(sp) > 0 &&
        es.some(function (e) { return e.hp < e.maxHp * 0.3; })) sc += 5;
  }
  (sp.effects || []).forEach(function (eff) {
    if (eff.kind === 'stun') sc += boss() ? 0 : 2;
    if (eff.kind === 'burn') sc += 2;
    /* cleanse earns its slot when the party carries something negative (dread-
       stress at the Wall) — but ONLY while the party is stable. It must never
       steal the healer's turn from topping the marked hero before the axe
       falls: one mistimed cleanse there wipes informed runs (96%→0%, measured). */
    if (eff.kind === 'cleanse' && partyHasNegativeStatus() && partyIsStable()) sc += 8;
  });
  return sc;
}
function partyHasNegativeStatus() {
  var alive = {};
  aliveH().forEach(function (h) { alive[h.id] = true; });
  return (B.statuses || []).some(function (s) {
    return alive[s.targetId] && (s.kind === 'burn' || s.kind === 'stun' || s.kind === 'stress');
  });
}
/* "stable" = nobody critical AND the marked hero (if any) needs no topping */
function partyIsStable() {
  var hs = aliveH();
  if (!hs.length) return false;
  if (B.marked && B.marked.hp > 0 && !st(B.marked).withdrawn && B.marked.hp < eMax(B.marked)) return false;
  var low = lowestHpAlly(hs);
  return !low || (low.hp / eMax(low)) > 0.6;
}

function pickSkill(h, kit, es) {
  var best = null, bestScore = -Infinity;
  kit.forEach(function (sp) {
    if (!skillReady(h, sp)) return;
    if (!conditionMet(h, sp)) return;
    var ts = resolveTargets(h, sp);
    if (!skillTargetsOk(h, sp, ts)) return;
    var sc = scoreSkill(h, sp, es) + Math.random();   // jitter breaks ai-weight ties
    if (sc > bestScore) { bestScore = sc; best = sp; }
  });
  return best || strikeSpec();   // basic attack when nothing qualifies
}

/* ---------------------------- execution (v0.6) ---------------------------- */
function healUnit(h, t, amount) {
  if (!t || t.hp <= 0) return;
  var before = t.hp;
  t.hp = Math.min(eMax(t), t.hp + amount);
  var healed = Math.round(t.hp - before);
  log('✨ ' + h.name + ' heals ' + t.name + ' for ' + healed +
      (B.marked === t ? ' (the mark answers to mercy)' : ''), 'good');
  fx('heal', { to: { k: 'h', id: t.id }, amt: healed });   // v0.9
  if (healed > 0 && t.id !== h.id) noteHeal(h, t);   // v0.4: mending earns bond
}

function cleanseUnit(t, fearMod) {
  if (!t || t.hp <= 0) return;
  var removed = 0;
  for (var i = B.statuses.length - 1; i >= 0; i--) {
    var s = B.statuses[i];
    if (s.targetId === t.id && (s.kind === 'burn' || s.kind === 'stun' || s.kind === 'stress')) {
      B.statuses.splice(i, 1);
      removed++;
    }
  }
  if (typeof fearMod === 'number' && fearMod) t.fear = clamp(t.fear + fearMod, 0, 100);
  return removed;
}

function castSkill(h, sp) {
  B.usage[sp.id] = (B.usage[sp.id] || 0) + 1;                    // telemetry
  /* self HP cost (Last Flame) — floors at 1, never self-kills */
  if (sp.cost && typeof sp.cost.hpPct === 'number' && sp.cost.hpPct > 0) {
    var cost = Math.round(eMax(h) * sp.cost.hpPct);
    h.hp = Math.max(1, h.hp - cost);
    log('🕯 ' + h.name + ' burns ' + cost + ' of their own life for ' + sp.name + '.', 'dim');
  }
  var ts = resolveTargets(h, sp);
  if (!ts.length) return;
  var isBasic = sp.tier === 'basic' || sp.id === 'strike';
  if (!isBasic) {
    log((ICON[h.cls] || '⚔️') + ' ' + h.name + ' — ' + sp.name + '!', 'sys');
    fx('skill', { name: sp.name, hero: h.name });   // v0.9 scene banner
  }
  if (sp.type === 'attack') {
    var pw = (typeof sp.power === 'number') ? sp.power : 1;
    var ex = executeBonusOf(sp);
    ts.slice().forEach(function (e) {
      if (e.hp <= 0) return;
      var m = pw;
      /* executeBonus (v0.7): +bonus damage vs targets below 30% maxHp —
         generic spec field (top-level number OR effects entry), applied
         target-by-target so an AoE finisher only escalates on the wounded */
      if (ex > 0 && e.hp < e.maxHp * 0.3) m *= (1 + ex);
      hitEnemy(h, e, m, isBasic ? '' : sp.name);
    });
  } else if (sp.type === 'heal') {
    ts.forEach(function (t) {
      healUnit(h, t, Math.round((18 + eAtk(h) * 1.6 + h.lvl * 2) *
        (typeof sp.power === 'number' ? sp.power : 1)));         // existing formula × spec.power
    });
  }
  (sp.effects || []).forEach(function (eff) {
    if (eff.kind === 'executeBonus') return;   // v0.7: consumed by the hit multiplier above, never stored
    if (eff.kind === 'cleanse') {
      ts.forEach(function (t) { cleanseUnit(t, (typeof eff.fear === 'number') ? eff.fear : -10); });
      log('✨ ' + h.name + ' cleanses the party — minds clear, fear recedes.', 'good');
      return;
    }
    if (eff.kind === 'healPct' || eff.kind === 'heal') {   // 'heal': F3's Benediction spelling
      ts.forEach(function (t) { healUnit(h, t, Math.round(eMax(t) * (eff.pct || 0))); });
      return;
    }
    ts.forEach(function (t) { if (t.hp > 0) applyStatus(t, eff, h); });
  });
  /* bookkeeping: cooldown + once-per-battle flags */
  var cds = B.skillCd[h.id] = B.skillCd[h.id] || {};
  cds[sp.id] = ((typeof sp.cd === 'number') ? sp.cd : 0) + 1;
  if (sp.once === true || sp.oncePerBattle === true) {
    var once = B.skillOnce[h.id] = B.skillOnce[h.id] || {};
    once[sp.id] = true;
  }
}

/* cowardretreat reaction: hp<20% -> 40%/turn to slip out alive, keeping hp.
   v0.14: the BRANDED cannot turn back — no slip-out, no withdrawal. */
function checkCowardRetreat(h) {
  if (h.branded) return false;
  if (reactionOf(h) !== 'cowardretreat') return false;
  if (h.hp >= eMax(h) * 0.20) return false;
  if (Math.random() >= 0.40) return false;
  st(h).withdrawn = true;
  if (B.lastStand && B.lastStand.id === h.id) B.lastStand = null;
  log('🏃 ' + h.name + ' breaks — they slip out of the line, alive, wounds and all.', 'dim');
  return true;
}

/* ============================ DOM helpers ============================ */
function log(t, cls) {
  if (!t) return;
  B.lines.push(cls ? { t: t, c: cls } : { t: t });
  if (B.lines.length > 160) B.lines.splice(0, B.lines.length - 160);
  if (!logEl) return;
  try {
    var d = document.createElement('div');
    if (cls) d.className = 'cb-' + cls;
    d.textContent = t;
    logEl.appendChild(d);
    while (logEl.childNodes.length > 160) logEl.removeChild(logEl.firstChild);
    logEl.scrollTop = logEl.scrollHeight;
  } catch (e) { /* headless */ }
}

function esc(s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }

function tagsHtml(h) {
  var s = st(h), out = [];
  if (h.hp <= 0) { out.push('<span class="cb-tag cb-tgone">FALLEN</span>'); }
  else if (s.withdrawn) { out.push('<span class="cb-tag cb-tgone">WITHDRAWN</span>'); }
  else {
    if (B.marked === h) out.push('<span class="cb-tag cb-tmark">Marked 🎯</span>');
    if (s.state === 'Focused') out.push('<span class="cb-tag cb-tfocus">Focused</span>');
    if (s.state === 'Pressure') out.push('<span class="cb-tag cb-tpress">Pressure</span>');
    if (s.state === 'Panic') out.push('<span class="cb-tag cb-tpanic">Panic</span>');
    if (h.grieving > 0) out.push('<span class="cb-tag cb-tgrief">🖤 Grieving</span>');
    if (B.lastStand && B.lastStand.id === h.id) out.push('<span class="cb-tag cb-tlast">Last Stand</span>');
    /* v0.6 status tags (pick 1-2: only what is actually active) */
    if (hasStatus(h.id, 'burn')) out.push('<span class="cb-tag cb-tburn">🔥 Burn</span>');
    if (statusPct(h.id, 'barrier') > 0) out.push('<span class="cb-tag cb-tbar">🛡 Barrier</span>');
    if (hasStatus(h.id, 'taunt')) out.push('<span class="cb-tag cb-ttaunt">🎯 Taunt</span>');
    if (hasStatus(h.id, 'stun')) out.push('<span class="cb-tag cb-tstun">😵 Stun</span>');
    if (hasStatus(h.id, 'redirect')) out.push('<span class="cb-tag cb-tredir">➡ Prayer</span>');
    if (statusPct(h.id, 'atkup') > 0) out.push('<span class="cb-tag cb-tbuff">⬆ Blessed</span>');
    if (statusPct(h.id, 'fragile') > 0) out.push('<span class="cb-tag cb-tfrag">🩸 Fragile</span>');
    if (B.protect && B.protect.id === h.id) out.push('<span class="cb-tag cb-tlast">🛡 PROTECT</span>');
    if (B.sacrifice && B.sacrifice.id === h.id) out.push('<span class="cb-tag cb-tmark">💀 SACRIFICE</span>');
    if (B.unbreak && B.unbreak.id === h.id) out.push('<span class="cb-tag cb-tlast">Unbreakable</span>');
  }
  return out.join('');
}

/* v0.6: enemy-side status tags (burn/stun land on foes today; fragile shows
   here too the moment a spec ever puts it on one). */
function foeTagsHtml(e) {
  var out = [];
  if (hasStatus(e.uid, 'burn')) out.push('<span class="cb-tag cb-tburn">🔥 Burn</span>');
  if (hasStatus(e.uid, 'stun')) out.push('<span class="cb-tag cb-tstun">😵 Stun</span>');
  if (statusPct(e.uid, 'fragile') > 0) out.push('<span class="cb-tag cb-tfrag">🩸 Fragile</span>');
  return out.join('');
}

/* ---- v0.8 sprite renderers (pure markup; NO Math.random anywhere — a
   renderer that drew rng would shift the engine stream and break the freeze;
   mob glyphs are picked by a deterministic name hash) ---- */
var MOB_GLYPHS = ['👺', '💀', '🕷️', '🦂', '🦇', '🐀', '🧟', '🐍', '🪨', '👁️', '🦴', '🐗'];
function glyphFor(name) {
  var s = String(name || ''), h = 0;
  for (var i = 0; i < s.length; i++) h = ((h * 31) + s.charCodeAt(i)) >>> 0;
  return MOB_GLYPHS[h % MOB_GLYPHS.length];
}
/* Boss names carry their emoji ('THE EXECUTIONER 👹') — the glyph becomes the
   sprite, the ASCII prefix becomes the plate. Plain mobs hash to a glyph. */
function splitFoeName(name) {
  var s = String(name || ''), cut = s.length;
  while (cut > 0 && s.charCodeAt(cut - 1) > 0x2000) cut--;
  var glyph = s.slice(cut).trim();
  var text = s.slice(0, cut).trim();
  if (!glyph) glyph = glyphFor(s);
  return { text: text || s, glyph: glyph };
}

function hpPct(u, mh) { return clamp(Math.round(u.hp / mh * 100), 0, 100); }

/* Hero figure: arched-frame sprite + Cinzel nameplate + slim HP bar + the
   v0.6/v0.7 status tags (tagsHtml semantics untouched). data-hero stays —
   the Master Command picker clicks ride on it. */
function heroFig(h) {
  var s = st(h), mh = eMax(h);
  var pct = hpPct(h, mh);
  var dead = h.hp <= 0, wd = !!s.withdrawn;
  var cls = 'cb-hero cb-c' + h.cls.toLowerCase();
  if (dead) cls += ' dead';
  else if (wd) cls += ' withdrawn';
  if (B.marked === h && h.hp > 0) cls += ' cb-marked';
  if (B.picker && h.hp > 0 && !wd) cls += ' cb-pick';
  var nm = esc(h.name) + ((B.marked === h && h.hp > 0) ? ' 🎯' : '');
  return '<div class="' + cls + '" data-hero="' + h.id + '">' +
    '<div class="hero-sprite' + (dead ? ' dead' : (wd ? ' gone' : '')) + '">' + (ICON[h.cls] || '⚔️') + '</div>' +
    '<div class="cb-name">' + nm + '</div>' +
    '<div class="cb-hpbar"><i class="' + (pct < 35 ? 'cb-low' : '') + '" style="width:' + pct + '%"></i></div>' +
    '<div class="cb-hpnum">' + Math.max(0, Math.round(h.hp)) + '/' + mh + '</div>' +
    '<div class="cb-tags">' + tagsHtml(h) + '</div>' +
    '</div>';
}

/* Regular enemy: smaller sprite, name, hp sliver — dead stays on the field,
   bowed and gray, never removed silently. */
function mobFig(e) {
  var pct = hpPct(e, e.maxHp);
  var dead = e.hp <= 0;
  var parts = splitFoeName(e.name);
  return '<div class="cb-mob' + (dead ? ' dead' : '') + (e.elite ? ' cb-elite' : '') + '">' +
    '<div class="cb-esprite' + (dead ? ' dead' : '') + '">' + parts.glyph + '</div>' +
    '<div class="cb-mname">' + (e.elite ? '<em>ELITE</em>' : '') + esc(parts.text) + '</div>' +
    '<div class="cb-hpbar"><i class="' + (pct < 35 ? 'cb-low' : '') + '" style="width:' + pct + '%"></i></div>' +
    (foeTagsHtml(e) ? '<div class="cb-tags">' + foeTagsHtml(e) + '</div>' : '') +
    '</div>';
}

/* The boss is the room: one BIG sprite, one name, ONE HP bar. No stat table. */
function bossZoneHtml(b) {
  var pct = hpPct(b, b.maxHp);
  var dead = b.hp <= 0;
  var parts = splitFoeName(b.name);
  var tg = foeTagsHtml(b);
  return '<div class="cb-bosszone">' +
    '<div class="cb-bossfig' + (dead ? ' dead' : '') + '">' + parts.glyph + '</div>' +
    '<div class="cb-bossinfo">' +
    '<div class="cb-bossname">' + esc(parts.text) + (dead ? ' <span class="cb-slain">— SLAIN</span>' : '') + '</div>' +
    '<div class="cb-bar cb-bossbar"><i class="' + (pct < 35 ? 'cb-low' : '') + '" style="width:' + pct + '%"></i></div>' +
    '<div class="cb-bossmeta"><span class="cb-bosshp">' + Math.max(0, Math.round(b.hp)) + '/' + b.maxHp + '</span>' + tg + '</div>' +
    '</div></div>';
}

function enemyZoneHtml() {
  var out = '', bs = null, mobs = [];
  B.enemies.forEach(function (e) { if (e.boss && !bs) bs = e; else mobs.push(e); });
  if (B.rule) out += '<div class="cb-rule">' + esc(B.rule.label) + '</div>';
  if (bs) out += bossZoneHtml(bs);
  if (mobs.length) out += '<div class="cb-sect">FOES</div><div class="cb-mobrow">' +
    mobs.map(mobFig).join('') + '</div>';
  return out;
}

/* v0.9: the snapshot the canvas scene consumes (pure data, no DOM). Hero
   tags are a slim emoji list — the scene caps the row at 3. */
function heroTags(h) {
  var out = [];
  if (hasStatus(h.id, 'burn')) out.push('🔥');
  if (statusPct(h.id, 'barrier') > 0) out.push('🛡');
  if (hasStatus(h.id, 'stun')) out.push('💫');
  if (hasStatus(h.id, 'taunt')) out.push('🎯');
  if (statusPct(h.id, 'atkup') > 0) out.push('⬆');
  if (statusPct(h.id, 'fragile') > 0) out.push('🩸');
  if (h.grieving > 0) out.push('🖤');
  return out;
}
function foeTags(e) {
  var out = [];
  if (hasStatus(e.uid, 'burn')) out.push('🔥');
  if (hasStatus(e.uid, 'stun')) out.push('💫');
  if (statusPct(e.uid, 'fragile') > 0) out.push('🩸');
  return out;
}
function sceneSnap() {
  var bs = boss(), mobs = [];
  B.enemies.forEach(function (e) {
    if (e.boss && e === bs) return;
    var p = splitFoeName(e.name);
    mobs.push({ key: 'e' + e.uid, uid: e.uid, name: p.text, glyph: p.glyph,
      hp: e.hp, maxHp: e.maxHp, elite: !!e.elite, tags: foeTags(e) });
  });
  var bsp = null;
  if (bs) {
    var p2 = splitFoeName(bs.name);
    bsp = { key: 'e' + bs.uid, uid: bs.uid, name: p2.text, glyph: p2.glyph,
      hp: bs.hp, maxHp: bs.maxHp, tags: foeTags(bs) };
  }
  return {
    round: B.round, paused: !!B.paused, speed: B.speed,
    picker: B.picker || null,
    ruleTint: B.rule ? B.rule.id : null,
    boss: bsp, mobs: mobs,
    heroes: B.heroes.map(function (h) {
      var s = st(h);
      return { key: 'h' + h.id, id: h.id, name: h.name, cls: h.cls,
        glyph: ICON[h.cls] || '⚔️', hp: Math.max(0, h.hp), max: eMax(h),
        dead: h.hp <= 0, withdrawn: !!s.withdrawn,
        marked: B.marked === h && h.hp > 0,
        pickable: !!B.picker && h.hp > 0 && !s.withdrawn,
        stand: !!(B.lastStand && B.lastStand.id === h.id),
        state: (h.hp > 0 && !s.withdrawn) ? s.state : null,
        tags: heroTags(h) };
    })
  };
}

function renderUnits() {
  if (!view) return;
  if (scene) {
    try { scene.sync(sceneSnap()); } catch (e) { /* presentation */ }
    try { roundEl.textContent = 'Round ' + B.round + (B.paused ? ' — PAUSED' : ''); } catch (e2) { /* headless */ }
    return;
  }
  try {
    stageEl.innerHTML = enemyZoneHtml();
    partyEl.innerHTML = B.heroes.map(heroFig).join('');
    roundEl.textContent = 'Round ' + B.round + (B.paused ? ' — PAUSED' : '');
  } catch (e) { /* headless */ }
}

function renderAll() {
  if (!view) return;
  renderUnits();
  if (B.paused) return;
  renderRunBar();
}

function renderRunBar() {
  if (!barEl) return;
  try {
    var html = '<div class="cb-spd">';
    [1, 2, 4, 16].forEach(function (s) {
      html += '<button class="cb-btn' + (B.speed === s ? ' cb-on' : '') + '" data-cmd="speed:' + s + '">' +
        (s === 16 ? '≫' : s + 'x') + '</button>';
    });
    html += '</div><div class="cb-cmds">';
    if (B.canRetreat && !B.over) html += '<button class="cb-btn cb-big cb-danger" data-cmd="retreat">Retreat</button>';
    html += '</div>';
    /* v0.11: carried supplies — finite, shown with counts, disabled at 0 */
    if (!B.over && !B.picker) {
      var hasSup = supCount('potion') > 0 || supCount('escape') > 0;
      if (hasSup) html += '<div class="cb-cmds cb-suprow">' +
        supBtn('potion', '🧪 Potion') +
        supBtn('escape', '🏃 Kit') +
        '</div>';
    }
    /* v0.6 Master Commands — once per battle each, disabled + counted once used.
       combat.js owns every in-battle button; the UI layer never renders these. */
    if (!B.over) {
      if (B.picker) {
        html += '<div class="cb-pickhint">Choose who answers the command — tap a hero card.</div>' +
          '<div class="cb-cmds">' +
          '<button class="cb-btn cb-big" data-cmd="mc_cancel">Never mind</button>' +
          '</div>';
      } else {
        html += '<div class="cb-cmds cb-mc">' +
          mcBtn('protect', '🛡️ PROTECT') +
          mcBtn('overdrive', '⚡ OVERDRIVE') +
          mcBtn('sacrifice', '💀 SACRIFICE') +
          '</div>';
      }
    }
    barEl.innerHTML = html;
  } catch (e) { /* headless */ }
}

function mcBtn(id, label) {
  var used = !!B.cmdUsed[id];
  return '<button class="cb-btn"' + (used ? ' disabled' : '') + ' data-cmd="mc_' + id + '">' + label + '</button>';
}

/* ============================ v0.11 SUPPLIES ============================
   Finite resources bought in the lobby, spent in the fight — no cooldown,
   no refill, gone with a wipe. combat reads/writes IT.S.supplies directly
   (guarded: no IT.S / no field = feature silently absent, golden safe). */
function supCount(kind) {
  try {
    var S = (typeof IT !== 'undefined' && IT.S) ? IT.S : null;
    return (S && S.supplies && typeof S.supplies[kind] === 'number') ? S.supplies[kind] : 0;
  } catch (e) { return 0; }
}
function supSpend(kind) {
  try {
    var S = (typeof IT !== 'undefined' && IT.S) ? IT.S : null;
    if (S && S.supplies && S.supplies[kind] > 0) { S.supplies[kind]--; return true; }
  } catch (e) { /* ignore */ }
  return false;
}
function supBtn(kind, label) {
  var n = supCount(kind);
  return '<button class="cb-btn cb-sup"' + (n > 0 ? '' : ' disabled') +
    ' data-cmd="sup_' + kind + '">' + label + ' <span class="cb-supn">×' + n + '</span></button>';
}
/* 🧪 Potion — free action, heals the most-wounded living hero 45% eMax. */
function usePotion() {
  if (B.over || B.paused || B.waiting) return false;
  var t = null;
  aliveH().forEach(function (h) {
    if (!t || (h.hp / eMax(h)) < (t.hp / eMax(t))) t = h;
  });
  if (!t) return false;
  if (!supSpend('potion')) return false;
  var before = t.hp;
  t.hp = Math.min(eMax(t), t.hp + Math.round(eMax(t) * 0.45));
  log('🧪 The Master\'s hand — a potion, crushed against ' + t.name + '\'s lips. (+' + Math.round(t.hp - before) + ' HP)', 'good');
  track('potion_used');
  fx('heal', { to: { k: 'h', id: t.id }, amt: Math.round(t.hp - before) });
  renderAll();
  return true;
}
/* 🏃 Escape Kit — the guaranteed exit: no compliance rolls, no refusers,
   no force-pull. The party is simply gone. Loot rides out with them. */
function useEscapeKit() {
  if (B.over || !aliveH().length) return false;
  if (!supSpend('escape')) return false;
  log('💨 The kit bursts — smoke and cordage. When it clears, the party is already on the stair below.', 'sys');
  track('escape_used');
  aliveH().slice().forEach(function (h) { B.st[h.id].withdrawn = true; });
  finishBattle(false, true);
  return true;
}

function renderInterruptBar(hint, choices) {
  if (!barEl) return;
  try {
    var html = '<div class="cb-hint">' + esc(hint) + '</div><div class="cb-cmds">';
    choices.forEach(function (c) {
      html += '<button class="cb-btn cb-big' + (c.danger ? ' cb-danger' : '') + '" data-cmd="' + c.id + '">' + esc(c.label) + '</button>';
    });
    html += '</div>';
    barEl.innerHTML = html;
  } catch (e) { /* headless */ }
}

/* ============================ v0.8 DEATH BEAT (the one pacing addition) ============================ */
/* HOW THE PAUSE AVOIDS RNG DRIFT: heroDies() — deep inside the sync engine —
   only PUSHES {hero, line} onto a module queue (a pure no-op unless the
   battle view was actually built; golden.js runs with no document and
   economy-sim's stub getElementById returns null, so headless never queues).
   The queue is drained from runLoop at await points the loop ALREADY had
   (right after each renderAll(), before checkEnd()) — awaiting a DOM promise
   draws no rng, advances no round, and mutates nothing but B.paused, exactly
   like the existing interrupt() pause. If a battle somehow ends with beats
   pending, cancelBeats() resolves them cleanly and drops the queue. */
function queueDeathBeat(hero, lineObj) {
  if (!view || !hero) return;          // headless / view torn down: inert
  deathQueue.push({ hero: hero, line: lineObj });
}

function cancelBeats() {
  deathQueue.length = 0;
  if (beatTimer) { clearTimeout(beatTimer); beatTimer = null; }
  if (beatResolve) {
    var r = beatResolve; beatResolve = null; beatEl = null;
    try { r(); } catch (e) { /* never block the engine */ }
  }
}

async function drainDeathBeats() {
  if (!B || !deathQueue.length) return;
  while (deathQueue.length) {
    if (B.over) { cancelBeats(); return; }   // battle ended mid-beat: resolve cleanly
    await showDeathBeat(deathQueue.shift());
  }
}

function showDeathBeat(beat) {
  return new Promise(function (resolve) {
    if (!view) { resolve(); return; }
    /* auto-continue: scripted drivers (FAST / auto hook) resolve on the next
       tick so the beat observably fires yet never stalls a harness; live play
       auto-continues at 1.4s under the fast speeds (>=4x), tap-waits at 1x/2x
       exactly like the Master interrupts. reduced-motion keeps the beat, the
       CSS media query strips the motion. */
    var scripted = IT.combat.FAST || typeof IT.combat.auto === 'function';
    var autoMs = scripted ? 0 : (B.speed >= 4 ? 1400 : 0);
    var done = false;
    function fin() {
      if (done) return;
      done = true;
      if (beatTimer) { clearTimeout(beatTimer); beatTimer = null; }
      if (beatEl && beatEl.parentNode) { try { beatEl.parentNode.removeChild(beatEl); } catch (e) { /* ignore */ } }
      beatEl = null; beatResolve = null;
      if (B) { B.paused = false; renderAll(); }
      resolve();
    }
    beatResolve = fin;
    try {
      var el = document.createElement('div');
      el.className = 'cb-beat';
      var sp = document.createElement('div');
      sp.className = 'hero-sprite dead cb-beatfig';
      sp.textContent = ICON[beat.hero.cls] || '⚔️';
      var nm = document.createElement('div');
      nm.className = 'cb-beatname'; nm.textContent = beat.hero.name;
      var wd = document.createElement('div');
      wd.className = 'cb-beatword'; wd.textContent = 'DEFEATED';
      var q = document.createElement('div');
      q.className = 'cb-beatquote';
      q.textContent = (beat.line && beat.line.t) ? beat.line.t : '';
      var btn = document.createElement('button');
      btn.type = 'button'; btn.className = 'cb-btn cb-beatbtn'; btn.textContent = 'CONTINUE';
      btn.addEventListener('click', fin);
      el.appendChild(sp); el.appendChild(nm); el.appendChild(wd);
      el.appendChild(q); el.appendChild(btn);
      view.appendChild(el);
      beatEl = el;
      B.paused = true;      // same semantics as interrupt(): retreat/command clicks gated
      renderUnits();        // round line shows PAUSED; the fallen hero renders dead
      if (scripted || autoMs > 0) beatTimer = setTimeout(fin, autoMs);
    } catch (e) { fin(); }
  });
}

/* ============================ v0.8 end title card ============================ */
/* finishBattle() is sync, so it only MOUNTS the card; the hold is awaited in
   start() where the settle wait already lived. Headless / FAST: never built,
   zero added delay — the promise resolves on the existing settle timing. */
function queueEndCard(win, retreated) {
  if (!view || IT.combat.FAST) return false;
  try {
    var el = document.createElement('div');
    el.className = 'cb-titlecard' + (win ? ' cb-tcwin' : retreated ? ' cb-tcret' : ' cb-tcloss');
    var w = document.createElement('div');
    w.className = 'cb-tcword';
    w.textContent = win ? 'VICTORY' : retreated ? 'WITHDRAWN' : 'THE PARTY IS LOST';
    var sub = document.createElement('div');
    sub.className = 'cb-tcsub';
    sub.textContent = win ? 'The floor falls silent.' :
      retreated ? 'The Tower keeps its floor — and your heroes.' :
      'No one comes back down the stair.';
    var skip = document.createElement('div');
    skip.className = 'cb-tcskip'; skip.textContent = 'tap to continue';
    el.appendChild(w); el.appendChild(sub); el.appendChild(skip);
    var removed = false;
    B._cardDone = function () {
      if (removed) return;
      removed = true;
      if (el.parentNode) { try { el.parentNode.removeChild(el); } catch (e) { /* ignore */ } }
      if (cardEl === el) cardEl = null;
      if (B) B._cardSkip = null;
    };
    B._cardSkip = null;
    el.addEventListener('click', function () {
      if (B && B._cardSkip) { try { B._cardSkip(); } catch (e) { /* ignore */ } }
    });
    view.appendChild(el);
    cardEl = el;
    return true;
  } catch (e) { return false; }
}

/* Awaits max(settle, cardHold); a tap on the card resolves early. */
function endHold(settle) {
  var done = B && B._cardDone;
  if (!done || !view) return wait(settle);
  return new Promise(function (res) {
    var t = null, fin = function () {
      if (t) { clearTimeout(t); t = null; }
      try { done(); } catch (e) { /* ignore */ }
      res();
    };
    t = setTimeout(fin, Math.max(settle, 900));
    B._cardSkip = fin;
  });
}

function buildView() {
  if (!HAS_DOM) { view = null; return; }
  var root = document.getElementById('battle-view');
  if (!root) { view = null; return; }
  /* v0.9: canvas scene first — IT.scene.attach builds the layout (canvas
     room + log strip + command bar) and hands back refs. Any failure falls
     through to the v0.8 DOM composition below. */
  scene = null;
  if (typeof IT !== 'undefined' && IT.scene && typeof IT.scene.attach === 'function') {
    try { scene = IT.scene.attach(root); } catch (e) { scene = null; }
  }
  if (scene) {
    view = root;
    stageEl = null; partyEl = null;
    floorEl = scene.floor; roundEl = scene.round;
    logEl = scene.log; logWrapEl = scene.logWrap; logBtnEl = scene.logBtn;
    barEl = scene.bar;
    wireBar();
    wireLog();
    /* canvas hero taps resolve an open Master Command picker (hit-test) */
    scene.onHeroTap(function (id) {
      if (B && B.picker) useCommand(B.picker, id);
    });
    return;
  }
  /* v0.8 composition (top -> bottom): floor/round kicker hairline, enemy
     stage, the party, the collapsible chronicle strip, the command bar. */
  root.innerHTML = '<div class="cb-top"><div class="cb-floor" id="cb-floor"></div>' +
    '<div class="cb-round" id="cb-round"></div></div>' +
    '<div class="cb-stage" id="cb-stage"></div>' +
    '<div class="cb-partywrap"><div class="cb-sect">THE PARTY</div>' +
    '<div class="cb-partyrow" id="cb-party"></div></div>' +
    '<div class="cb-logwrap collapsed" id="cb-logwrap">' +
    '<button type="button" class="cb-logtoggle" id="cb-logtoggle">battle log ▾</button>' +
    '<div class="cb-log" id="cb-log"></div></div>' +
    '<div class="cb-barwrap" id="cb-bar"></div>';
  view = root;
  floorEl = root.querySelector('#cb-floor');
  roundEl = root.querySelector('#cb-round');
  stageEl = root.querySelector('#cb-stage');
  partyEl = root.querySelector('#cb-party');
  logWrapEl = root.querySelector('#cb-logwrap');
  logBtnEl = root.querySelector('#cb-logtoggle');
  logEl = root.querySelector('#cb-log');
  barEl = root.querySelector('#cb-bar');
  wireBar();
  /* v0.6: hero-figure taps resolve an open Master Command picker (data-hero) */
  partyEl.addEventListener('click', function (ev) {
    if (!B || !B.picker) return;
    var u = ev.target;
    while (u && u !== partyEl && !u.getAttribute('data-hero')) u = u.parentNode;
    var id = (u && u.getAttribute && u.getAttribute('data-hero')) ? +u.getAttribute('data-hero') : null;
    if (id != null) useCommand(B.picker, id);
  });
  wireLog();
}

/* command-bar clicks (shared by the canvas layout and the DOM fallback) */
function wireBar() {
  barEl.addEventListener('click', function (ev) {
    var b = ev.target;
    while (b && b !== barEl && !b.getAttribute('data-cmd')) b = b.parentNode;
    if (b && b.getAttribute && b.getAttribute('data-cmd')) onCmd(b.getAttribute('data-cmd'));
  });
}

/* v0.8: chronicle strip — collapsed by default (last 3 lines ride the
   bottom edge via log()'s scrollTop), tap toggles the full scrollback. */
function wireLog() {
  logOpen = false;
  logBtnEl.addEventListener('click', function () {
    logOpen = !logOpen;
    try {
      logWrapEl.className = 'cb-logwrap' + (logOpen ? '' : ' collapsed');
      logBtnEl.textContent = 'battle log ' + (logOpen ? '▴' : '▾');
      logEl.scrollTop = logEl.scrollHeight;
    } catch (e) { /* cosmetic */ }
  });
}

function clearView() {
  if (scene) { try { scene.detach(); } catch (e) { /* presentation */ } scene = null; }   // v0.9
  sndMusic(null);                      // v0.9.3: battle music never outlives the view
  cancelBeats();                       // v0.8: a pending beat never outlives the view
  if (cardEl && cardEl.parentNode) { try { cardEl.parentNode.removeChild(cardEl); } catch (e) { /* ignore */ } }
  cardEl = null;
  if (B) { B._cardDone = null; B._cardSkip = null; }
  if (!view) return;
  try { view.innerHTML = ''; } catch (e) { /* ignore */ }
  view = logEl = barEl = floorEl = roundEl = stageEl = partyEl = null;
  logWrapEl = logBtnEl = null;
}

/* ============================ combat math (v0.2 port) ============================ */
/* rawDmg — v0.2 exact: atk*mult*(0.85..1.15) - def*0.6, floor 1 */
function rawDmg(atk, mult, def) {
  return Math.max(1, Math.round(atk * mult * rnd(0.85, 1.15) - def * 0.6));
}

/* personality micro-effects, recomputed from axes (courage>=70 stands in for Brave etc.) */
function isBrave(h)     { return h.courage >= 70; }
function isCoward(h)    { return h.fear >= 70; }
function isGreedy(h)    { return h.greed >= 70; }
function isLoyal(h)     { return h.loyalty >= 80; }
function isReckless(h)  { return h.greed >= 60 && h.courage >= 60; }
function isCautious(h)  { return h.fear <= 30 && h.courage <= 40; }

function hitEnemy(h, e, mult, tag) {
  var m = mult, s = st(h);
  if (s.state === 'Focused') m *= 1.10;            // v0.3 resolve: Focused
  else if (s.state === 'Pressure') m *= 0.90;      // v0.3 resolve: Pressure
  else if (s.state === 'Panic') m *= 0.75;         // v0.3 resolve: Panic
  if (B.focusRounds > 0) m *= 1.25;                // Master stance: Focus
  if (B.overdrive > 0) m *= 1.25;                  // v0.6 Master command: OVERDRIVE
  if (B.lastStand && B.lastStand.id === h.id) m *= 1.5;  // Last Stand
  if (B.sacrifice && B.sacrifice.id === h.id && B.sacrifice.rounds > 0) m *= 1.3;  // v0.6 SACRIFICE +30% dmg
  if (isBrave(h) && h.hp < eMax(h) * 0.3) m *= 1.25;      // v0.2 Brave
  if (isGreedy(h)) m *= 1.1;                              // v0.2 Greedy
  if (isLoyal(h) && B.deadIds.length) m *= 1.2;           // v0.2 Loyal
  if (isReckless(h)) m *= 1.15;                           // v0.2 Reckless
  if (B.bondedIds[h.id]) m *= 1.03;                       // v0.4 bond >= 60: +3% dmg
  if (h.grieving > 0) m *= 0.90;                          // v0.4 grieving: -10% dmg
  if (h.pact && h.pact.lvl) m *= 1 + 0.20 * Math.min(3, h.pact.lvl);   // v0.14: the pact's price was paid
  if (isRule('bloodmoon') && h.hp < eMax(h) * 0.30) m *= 1.30;  // v0.5 BLOOD MOON: desperate heroes hit harder
  var tr = traitOf(h);                                    // v0.7 trait dmg mods
  if (tr === 'bloodthirst' && anyEnemyLow()) m *= 1.10;         // bloodthirst: +10% vs a wounded field
  if (tr === 'faintheart') m *= 0.90;                            // faintheart: -10% dmg dealt
  if (tr === 'nighteyes' && isRule('darkness')) m *= 1.10;       // nighteyes: +10% on DARKNESS floors
  var rx = reactionOf(h);                                 // v0.6 reactions
  if (rx === 'killer' && e.hp > 0 && e.hp < e.maxHp * 0.15) m *= 1.5;   // killer: +50% vs <15% foes
  else if (rx === 'steady') m *= 1.05;                                  // steady: +5% dmg
  var up = statusPct(h.id, 'atkup');                      // v0.6 Benediction atk buff
  if (up > 0) m *= (1 + up);
  var d = rawDmg(eAtk(h), m, e.def);
  e.hp -= d;
  log(h.name + ' → ' + (tag ? tag + ' ' : '') + e.name + ' for ' + d + (tag ? '!' : ''));
  fx('hit', { from: { k: 'h', id: h.id }, to: { k: 'e', uid: e.uid }, dmg: d, tag: tag || '', dead: e.hp <= 0 });   // v0.9
  if (e.hp <= 0) {
    e.hp = 0;
    creditKill(e, h);
    log(e.name + ' is slain.', 'good');
  }
}

/* ==== v0.6 FINAL DAMAGE-RETARGETING ORDER (contract-documented) ====
   0. opts.lethal — the Executioner's EXECUTE is dodge-the-axe, not damage:
      it skips every step below EXCEPT Last Stand (v0.3 behavior kept: the
      stander can still throw themselves into it and floor at 1). Redirect,
      barrier, PROTECT and UNBREAKABLE never touch it; only a full-HP mark
      fizzles it (checked by the caller).
   1. REDIRECT (Guardian Prayer): damage aimed at the lowest-HP living ally
      hits the prayer's holder at x pct. Catches ordinary hits, cleave and
      creeping dread; NOT the lethal execute.
   2. BARRIER: the current target's barrier status reduces the damage
      x(1-pct). Interacts with cleave naturally (each hit is reduced).
   3. TANK class intercept: 30% chance a Tank takes the hit (v0.2; respects
      opts.noIntercept, skipped while Last Stand is up).
   3b. PROTECTIVE reaction: 30% chance a loyalty>=80 hero takes a hit meant
      for an ally under 30% hp — in ADDITION to the Tank class intercept
      (independent roll, evaluated only if the Tank roll didn't fire).
   4. LAST STAND: the stander intercepts ALL enemy damage (v0.3; overrides
      tank/protective, keeps the hp floor at 1).
   5. PROTECT (Master command) / UNBREAKABLE (Tank skill): the chosen
      protector takes ALL damage for its duration — PROTECT at full value
      (their own def applies; Tanks simply have more), UNBREAKABLE at x0.5
      with hp floored at 1. Neither catches the lethal execute.
   6. base: def subtraction (Defend stance x1.5), Cautious/Reckless/BLOOD
      MOON/FRAGILE taken-mods, then hp. SACRIFICE floors a Tank at 1.
      (v0.7: fragile = dmg taken x(1+pct) — applied after def like the other
      taken-mods, and never on the lethal execute, which skips step 6.) */
function dmgHero(t, raw, srcName, opts) {
  opts = opts || {};
  var barred = false;

  /* 1. REDIRECT — Guardian Prayer */
  if (!opts.lethal && t.hp > 0) {
    var lowest = lowestHpAlly(aliveH());
    var holders = aliveH().filter(function (x) { return hasStatus(x.id, 'redirect'); });
    for (var i = 0; i < holders.length; i++) {
      var holder = holders[i];
      if (lowest && lowest.id === t.id && holder.id !== t.id) {
        raw = Math.round(raw * (statusPct(holder.id, 'redirect') || 0.7));
        log('➡ ' + holder.name + "'s Guardian Prayer takes the blow meant for " + t.name + '.', 'sys');
        t = holder;
        break;
      }
    }
  }

  /* 2. BARRIER */
  if (!opts.lethal) {
    var bar = statusPct(t.id, 'barrier');
    if (bar > 0) { raw = Math.round(raw * (1 - bar)); barred = true; }
  }

  var lsActive = B.lastStand && B.lastStand.rounds > 0;

  /* 3 + 3b. Tank class intercept, then the protective reaction */
  var intercepted = false;
  if (!opts.noIntercept && !lsActive && t.cls !== 'Tank') {
    var tank = aliveH().find(function (x) { return x.cls === 'Tank' && x.id !== t.id; });
    if (tank && Math.random() < 0.3) {
      log('🛡️ ' + tank.name + ' intercepts the blow meant for ' + t.name + '!', 'sys');
      t = tank;
      intercepted = true;
    }
    if (!intercepted && t.hp < eMax(t) * 0.30) {
      var guardians = aliveH().filter(function (x) {
        return x.id !== t.id && reactionOf(x) === 'protective';
      });
      if (guardians.length && Math.random() < 0.3) {
        var g = pick(guardians);
        log('🤍 ' + g.name + ' steps in front of ' + t.name + ' — not on their watch.', 'sys');
        t = g;
      }
    }
  }

  /* 4. Last Stand intercepts ALL enemy damage (overrides everything, even noIntercept) */
  if (lsActive && t.id !== B.lastStand.id && t.hp > 0) {
    var lsH = heroById(B.lastStand.id);
    if (lsH && lsH.hp > 0) {
      if (!B._lsCoverLogged) { log('⚔ ' + lsH.name + ' throws themselves into the blow meant for ' + t.name + '!', 'sys'); B._lsCoverLogged = true; }
      t = lsH;
    }
  }

  /* 5. PROTECT / UNBREAKABLE — chosen protector takes everything */
  if (!opts.lethal) {
    if (B.protect && B.protect.rounds > 0 && t.id !== B.protect.id) {
      var ph = heroById(B.protect.id);
      if (ph && ph.hp > 0 && !B.st[ph.id].withdrawn) {
        t = ph;
        if (!B._prCoverLogged) { log('🛡 ' + ph.name + ' holds the line — the blow breaks on them.', 'sys'); B._prCoverLogged = true; }
      }
    } else if (B.unbreak && B.unbreak.rounds > 0 && t.id !== B.unbreak.id) {
      var uh = heroById(B.unbreak.id);
      if (uh && uh.hp > 0 && !B.st[uh.id].withdrawn) {
        t = uh;
        raw = Math.round(raw * 0.5);
        if (!B._ubCoverLogged) { log('🛡️ ' + uh.name + ' is UNBREAKABLE — the Tower breaks instead.', 'sys'); B._ubCoverLogged = true; }
      }
    }
  }

  /* 6. base resolution */
  var d, fr = 0;
  if (opts.lethal) {
    d = 9999;
  } else {
    var def = eDef(t) * (B.defendRounds > 0 ? 1.5 : 1); // Master stance: Defend
    d = Math.max(1, Math.round(raw - def * 0.6));
    if (isCautious(t)) d = Math.round(d * 0.9);         // v0.2 Cautious
    if (isReckless(t)) d = Math.round(d * 1.1);         // v0.2 Reckless
    if (isRule('bloodmoon') && t.hp < eMax(t) * 0.30) d = Math.round(d * 1.15);  // v0.5 BLOOD MOON: the wounded bleed easier
    fr = statusPct(t.id, 'fragile');
    if (fr > 0) d = Math.round(d * (1 + fr));           // v0.7 fragile: recklessness tax
  }
  t.hp -= d;
  if (floorActive(t) && t.hp < 1) t.hp = 1;              // Last Stand / Unbreakable / tank SACRIFICE floor
  if (t.hp <= 0) {
    heroDies(t, srcName);
  } else {
    log(srcName + ' → ' + t.name + ' for ' + d + (barred ? ' (barrier)' : '') + (fr > 0 ? ' (fragile)' : ''), 'bad');
    fx('hit', { from: { k: 'e', name: srcName }, to: { k: 'h', id: t.id }, dmg: d, big: d >= 60 });   // v0.9
    noteInjury(t);
  }
}

/* ============================ hero AI (v0.2 port + v0.3 states) ============================ */
function loyaltyCheck(h) {
  var gate = isRule('betrayal') ? 45 : 30;   // v0.5 BETRAYAL: whispers on floors 17-19 widen the refusal gate
  if (h.loyalty < gate && Math.random() < 0.2) {
    log(h.name + ' refuses the order. ("Why should we die for you?")', 'bad');
    return true;
  }
  return false;
}

function freezeCheck(h) {
  var s = st(h);
  var panic = s.state === 'Panic';
  var coward = isCoward(h);       // v0.2 Coward freeze (fear>=70 implies fear>50)
  /* v0.7 coldblood: the fear-gated freeze never lands — Panic's −25% dmg and
     everything else still apply; the trait ignores the freeze only. */
  if ((panic || coward) && traitOf(h) === 'coldblood') return false;
  if ((panic || coward) && Math.random() < 0.35) {
    log(panic ? h.name + ' is frozen by PANIC — they cannot move.' : h.name + ' hesitates, frozen by fear...', 'dim');
    return true;
  }
  return false;
}

/* v0.6 hero turn, contract order: tick statuses (burn dots, durations) →
   reaction checks (cowardretreat here; protective is passive in dmgHero) →
   pick skill (filter off-cooldown + condition-met, score = ai weight +
   situational bonus) → execute. v0.7: every class runs the kit engine; only
   a hero with NO kit data (pre-v0.7 save / kit not yet in core) drops to the
   exact legacy v0.2 class act below. */
async function heroAct(h) {
  var s = st(h);
  if (s.withdrawn || h.hp <= 0) return;
  tickCooldowns(h);        // cooldowns tick every hero turn (even a stunned/frozen one)
  tickHeroStatuses(h);     // burn bites, buff durations decay
  if (h.hp <= 0 || s.withdrawn) return;
  if (hasStatus(h.id, 'stun')) { log(h.name + ' is stunned — the turn is lost.', 'dim'); return; }
  if (checkCowardRetreat(h)) { renderAll(); return; }   // v0.6 reaction
  if (loyaltyCheck(h) || freezeCheck(h)) return;
  var es = aliveE();
  if (!es.length) return;
  var kit = kitFor(h);
  if (!kit) { legacyHeroAct(h, es); return; }
  castSkill(h, pickSkill(h, kit, es));
}

/* The v0.2 hardcoded acts, verbatim behavior — v0.7: FALLBACK ONLY. Reached
   when kitFor() finds no real kit (a pre-v0.7 Warrior/Rogue save still
   carrying ['strike'], a class whose kit has not landed in core, or a core
   without IT.SKILLS). The kit path above now covers all five classes; these
   branches stay so un-migrated heroes keep their exact v0.2 behavior.
   Do not regress. */
function legacyHeroAct(h, es) {
  if (h.cls === 'Healer') {
    var allies = aliveH();
    var t;
    // learned counter (knowledge.executioner): answer the mark
    if (B.marked && B.marked.hp > 0 && !B.st[B.marked.id].withdrawn && B.knowExec && B.marked.hp < eMax(B.marked)) t = B.marked;
    else t = allies.slice().sort(function (a, b) { return a.hp / eMax(a) - b.hp / eMax(b); })[0];
    if (t && t.hp < eMax(t)) {
      var heal = Math.round(18 + eAtk(h) * 1.6 + h.lvl * 2);
      var before = t.hp;
      t.hp = Math.min(eMax(t), t.hp + heal);
      log('✨ ' + h.name + ' heals ' + t.name + ' for ' + Math.round(t.hp - before) + (t === B.marked ? ' (the mark answers to mercy)' : ''), 'good');
      if (t.hp > before && t.id !== h.id) noteHeal(h, t);   // v0.4: mending earns bond
    } else {
      var e0 = es.slice().sort(function (a, b) { return a.hp - b.hp; })[0];
      hitEnemy(h, e0, 0.9, 'smite');
    }
    return;
  }
  var mult = 1, tag = '', aoe = false, target = null;
  if (h.cls === 'Warrior' && Math.random() < 0.3) { mult = 1.8; tag = 'Power Strike'; }
  else if (h.cls === 'Rogue') {
    target = es.slice().sort(function (a, b) { return a.hp - b.hp; })[0];
    if (Math.random() < 0.25) { mult = 1.7; tag = 'CRIT'; }
  }
  else if (h.cls === 'Mage' && es.length > 1 && Math.random() < 0.4) { aoe = true; mult = 0.65; tag = 'Fireball'; }
  else if (h.cls === 'Tank') mult = 0.8;
  if (aoe) {
    log('🔮 ' + h.name + ' casts Fireball!', 'sys');
    es.slice().forEach(function (e) { if (e.hp > 0) hitEnemy(h, e, mult); });
  } else {
    hitEnemy(h, target || pick(es), mult, tag);
  }
}

/* ============================ enemy AI (v0.2 port) ============================ */
/* v0.6: attack targeting respects taunt first (Taunt skill, SACRIFICE), then
   the v0.2 tank bias. Boss IDENTITY picks — the Executioner's gaze and the
   King's Drain the Doubtful — choose by their own rules and ignore taunt. */
function pickEnemyTarget(hs) {
  var taunters = hs.filter(function (h) { return hasStatus(h.id, 'taunt'); });
  if (taunters.length) return pick(taunters);
  var tank = hs.find(function (h) { return h.cls === 'Tank'; });
  return (tank && Math.random() < 0.45) ? tank : pick(hs);
}

async function enemyAct(e) {
  if (e.hp <= 0) return;
  var stunned = tickEnemyStatuses(e);   // v0.6: burn dots bite, stun blocks the turn
  if (e.hp <= 0) return;                // burned down before it could act
  if (stunned) { log(e.name + ' reels — stunned, the turn is lost.', 'dim'); return; }
  var hs = aliveH();
  if (!hs.length) return;
  if (e.boss) { if (isKing(e)) kingAct(e); else bossAct(e); return; }
  dmgHero(pickEnemyTarget(hs), Math.round(e.atk * rnd(0.9, 1.1)), e.name);
}

function bossAct(b) {
  b.step++;
  var phase2 = b.hp < b.maxHp * 0.35;
  var hs = aliveH();
  if (!hs.length) return;
  if (b.step % 3 === 2) {
    // MARK + creeping dread
    B.marked = pick(hs);
    log('❗ THE EXECUTIONER fixes its gaze. ' + B.marked.name + ' has been MARKED.', 'sys');
    fx('mark', { to: { k: 'h', id: B.marked.id } });   // v0.9
    if (isCoward(B.marked)) log('"...no. No no no." — ' + B.marked.name, 'dim');
    hs.slice().forEach(function (t) {
      if (t.hp > 0) {
        dmgHero(t, Math.round(b.atk * 0.4), 'Creeping dread', { noIntercept: true });
        /* stress is inert — but it gives Cleanse a reason to exist at the Wall */
        applyStatus(t, { kind: 'stress', dur: 2 }, b);
      }
    });
  } else if (b.step % 3 === 0 && B.marked) {
    // EXECUTION
    var m = B.marked;
    var t = (m && m.hp > 0 && !B.st[m.id].withdrawn) ? m : pick(aliveH());
    if (t.hp >= eMax(t)) {
      log('⛓ EXECUTION — the axe falls on ' + t.name + '... and finds no weakness. (Full HP: the mark fizzles.)', 'good');
      dmgHero(t, Math.round(55 + b.atk * 0.5), '⛓ The axe', { noIntercept: true });
    } else {
      log('⛓ EXECUTION. The axe falls on ' + t.name + '.', 'bad');
      fx('shake', { mag: 9 });   // v0.9
      dmgHero(t, 0, '⛓ The Executioner', { lethal: true, noIntercept: true });
    }
    B.marked = null;
  } else {
    // CLEAVE (+ frenzy in phase 2)
    log('The Executioner raises its cleaver — it sweeps the whole party!', 'sys');
    fx('shake', { mag: 6 });   // v0.9
    var cm = phase2 ? 1.05 : 0.85;
    aliveH().slice().forEach(function (t) { if (t.hp > 0) dmgHero(t, Math.round(b.atk * cm), 'Cleaver', { noIntercept: true }); });
    if (phase2 && aliveH().length) {
      log('The Executioner lunges, frenzied!', 'sys');
      dmgHero(pickEnemyTarget(aliveH()), Math.round(b.atk * 0.9), 'A frenzied lunge');
    }
  }
}

/* ============================ v0.5: THE HOLLOW KING (floor 20) ============================ */
/* Boss identity by name — normalizeEnemies rebuilds enemies from cfg.enemies,
   so any extra identity field would be dropped; names survive. */
function isKing(e) { return !!e && !!e.boss && /^THE HOLLOW KING/.test(e.name || ''); }
function isExec(e) { return !!e && !!e.boss && /^THE EXECUTIONER/.test(e.name || ''); }

function livingAdds() { return B.enemies.filter(function (e) { return e.add && e.hp > 0; }); }
function partyHpSum() { return B.heroes.reduce(function (s, h) { return s + Math.max(0, h.hp); }, 0); }

/* Crown Slash — the plain royal blow (taunt/tank-biased targeting like mob AI). */
function kingSlash(b, mult) {
  var hs = aliveH();
  if (!hs.length) return;
  log('👑 Crown Slash — the long blade of the realm falls!', 'sys');
  dmgHero(pickEnemyTarget(hs), Math.round(b.atk * mult), '👑 Crown Slash');
}

/* Summon — a Hollow Courtier add (flat hp260/atk26/def6) if fewer than 2 alive.
   Court already full: the King strikes instead (the cycle never idles). */
function kingSummon(b) {
  if (livingAdds().length < 2) {
    B.enemies.push({ name: 'Hollow Courtier', maxHp: 260, hp: 260, atk: 26, def: 6,
      bounty: 60, boss: false, elite: false, step: 0, add: true,
      uid: 'e' + B.enemies.length });   /* v0.6: uid for status targeting */
    log('👑 The Hollow King gestures — a Hollow Courtier steps out of the dark to serve.', 'sys');
    fx('skill', { name: 'SUMMON THE COURT', hero: 'The Hollow King' });   // v0.9
    return;
  }
  log('👑 The King gestures — but his court already stands. He strikes instead.', 'dim');
  kingSlash(b, 1.2);
}

/* Drain the Doubtful — ×2.2 atk on the lowest-LOYALTY living hero; HALVED if
   that hero's loyalty >= 60 (they know why they climb). King heals the damage
   actually dealt (measured across the party, so intercepts still feed him —
   but only what was truly drunk). */
function kingDrain(b) {
  var hs = aliveH();
  if (!hs.length) return;
  var tgt = hs.slice().sort(function (a, c) { return a.loyalty - c.loyalty; })[0];
  var resist = tgt.loyalty >= 60;
  log('👑 DRAIN THE DOUBTFUL — the Hollow King opens his hollow palm.', 'bad');
  fx('shake', { mag: 7 });   // v0.9
  if (resist) log(tgt.name + ' knows exactly why they climb. The drain finds little doubt to drink.', 'good');
  else log('The King\'s empty eyes fix on ' + tgt.name + ' — the least certain of them all.', 'dim');
  var before = partyHpSum();
  dmgHero(tgt, Math.round(b.atk * 2.2 * (resist ? 0.5 : 1)), '👑 Drain the Doubtful', { noIntercept: true });
  var drunk = before - partyHpSum();
  if (drunk > 0) {
    b.hp = Math.min(b.maxHp, b.hp + drunk);
    log('The King drinks ' + drunk + ' — his wounds knit closed.', 'bad');
  } else {
    log('Nothing to drink. The King is left hollow.', 'dim');
  }
}

/* Phase 1 (hp > 50%): Crown Slash ×1.2 → Summon → Drain, cycling.
   Phase 2 (hp <= 50%): adds die, atk +20%, Crown Slash ×1.4, Drain every 2nd turn. */
function kingAct(b) {
  b.step++;
  if (!b.phase2 && b.hp <= b.maxHp * 0.5) {
    b.phase2 = true;
    var adds = livingAdds();
    if (adds.length) {
      adds.forEach(function (a) { a.hp = 0; });
      log('The crown CRACKS. The courtiers collapse like emptied robes.', 'sys');
    } else {
      log('The crown CRACKS. The Hollow King rises from his throne.', 'sys');
    }
    b.atk = Math.round(b.atk * 1.2);
    log('👑 "DOUBT IS A RIVER. I AM ITS MOUTH." — the King\'s strength surges.', 'bad');
    fx('shake', { mag: 8 });   // v0.9
  }
  var drainTurn = b.phase2 ? (b.step % 2 === 0) : (b.step % 3 === 0);
  if (drainTurn) { kingDrain(b); return; }
  if (!b.phase2 && b.step % 3 === 2) { kingSummon(b); return; }
  kingSlash(b, b.phase2 ? 1.4 : 1.2);
}

/* ============================ v0.3 resolve states ============================ */
/* Each round: hp<50% -> courage>=70 ? Focused(+10% atk) : Pressure(-10% atk);
   fear>=75 -> courage>=70 ? ignore : Panic(-25% atk, 35% freeze). */
function resolveStates() {
  B.heroes.forEach(function (h) {
    var s = B.st[h.id];
    if (h.hp <= 0 || s.withdrawn) { s.state = null; return; }
    var state = null;
    if (h.hp < eMax(h) * 0.5) state = h.courage >= 70 ? 'Focused' : 'Pressure';
    if (h.fear >= 75 && h.courage < 70) state = 'Panic';
    if (state !== s.state) {
      if (state === 'Panic') log('💫 ' + h.name + "'s nerve snaps — PANIC.", 'bad');
      else if (state === 'Focused') log(h.name + ' steadies their breathing — FOCUSED.', 'good');
      else if (state === 'Pressure') log(h.name + ' fights on under PRESSURE.', 'dim');
      s.state = state;
    }
  });
}

/* ============================ v0.3 Last Stand ============================ */
/* Once per battle: courage>=85 && hp<15% && an ally <25% -> intercepts ALL enemy
   damage for 2 rounds, atk +50%, HP floors at 1. */
function checkLastStand() {
  if (B.lastStand || B.lsUsed || B.over) return;
  var allies = aliveH();
  var cand = allies.find(function (h) {
    return h.courage >= 85 && h.hp < eMax(h) * 0.15 &&
      allies.some(function (x) { return x.id !== h.id && x.hp > 0 && x.hp < eMax(x) * 0.25; });
  });
  if (!cand) return;
  B.lastStand = { id: cand.id, rounds: 2 };
  B.lsUsed = true;
  log('⚔ ' + cand.name.toUpperCase() + ' — LAST STAND ⚔', 'sys');
  fx('skill', { name: 'LAST STAND', hero: cand.name });   // v0.9
  log(cand.name + ' plants themselves between the enemy and the wounded. Nothing gets past.', 'sys');
}

function endOfRound() {
  if (B.focusRounds > 0) B.focusRounds--;
  if (B.defendRounds > 0) B.defendRounds--;
  if (B.lastStand) {
    B.lastStand.rounds--;
    var h = heroById(B.lastStand.id);
    if (B.lastStand.rounds <= 0) {
      if (h && h.hp > 0) log('The last stand ends. ' + h.name + ' stands, barely.', 'sys');
      B.lastStand = null;
    }
  }
  /* v0.6: OVERDRIVE pays its nerve toll when it burns off */
  if (B.overdrive > 0) {
    B.overdrive--;
    if (B.overdrive === 0) {
      B.heroes.forEach(function (x) {
        if (x.hp > 0 && !B.st[x.id].withdrawn) x.fear = clamp(x.fear + 15, 0, 100);
      });
      log('The overdrive burns off. Hands shake, eyes dart — nerves frayed. (fear +15)', 'dim');
    }
  }
  if (B.protect && B.protect.rounds > 0) {
    B.protect.rounds--;
    var ph2 = heroById(B.protect.id);
    if (B.protect.rounds <= 0) {
      if (ph2 && ph2.hp > 0) log(ph2.name + ' steps back into the line. The PROTECT ends.', 'dim');
      B.protect = null;
    }
  }
  if (B.sacrifice && B.sacrifice.rounds > 0) {
    B.sacrifice.rounds--;
    var sh = heroById(B.sacrifice.id);
    if (B.sacrifice.rounds <= 0) {
      if (sh && sh.hp > 0) log('The SACRIFICE is answered — ' + sh.name + ' still stands.', sh.cls === 'Tank' ? 'sys' : 'good');
      B.sacrifice = null;
    }
  }
  if (B.unbreak && B.unbreak.rounds > 0) {
    B.unbreak.rounds--;
    if (B.unbreak.rounds <= 0) B.unbreak = null;
  }
}

/* ============================ v0.3 Master interrupts ============================ */
var INT_DEFS = {
  start: {
    hint: 'The enemy has the drop on you. Command the party:',
    choices: [
      { id: 'focus', label: '⚡ Focus — party +25% damage, 2 rounds' },
      { id: 'defend', label: '🛡️ Defend — party +50% defense, 2 rounds' }
    ]
  },
  lowhp: {
    hint: 'A hero is badly hurt. The party looks to you:',
    choices: [
      { id: 'push_on', label: 'Push on' },
      { id: 'defend_stance', label: '🛡️ Defend stance — +50% DEF, 2 rounds' }
    ]
  },
  mark: {
    hint: 'The marked must be flawless — 100% HP — when the axe falls.',
    choices: [
      { id: 'hold', label: '🛡️ Hold the line — +50% DEF, 2 rounds' }
    ]
  },
  drain: {   // v0.5: Hollow King hint (only when knowledge.hollowKing)
    hint: 'The King drinks doubt. The loyal resist.',
    choices: [
      { id: 'hold', label: '🛡️ Brace — +50% DEF, 2 rounds' }
    ]
  }
};

function applyChoice(id) {
  if (id === 'focus') { B.focusRounds = 2; log('The Master commands: FOCUS. Blades sharpen.', 'sys'); }
  else if (id === 'defend' || id === 'defend_stance' || id === 'hold') { B.defendRounds = 2; log('The Master commands: HOLD. Shields up.', 'sys'); }
  else if (id === 'push_on') { log('The Master commands: PUSH ON. No step back.', 'sys'); }
  else if (id === 'retreat') { B.retreatRequested = true; }
}

async function interrupt(kind) {
  if (B.over) return null;
  var def = INT_DEFS[kind];
  var choices = def.choices.slice();
  if (B.canRetreat) choices.push({ id: 'retreat', label: '🏃 Retreat', danger: true });
  B.paused = true;
  renderUnits();
  renderInterruptBar(def.hint, choices);
  var choice = null;
  if (typeof IT.combat.auto === 'function') {
    try {
      choice = IT.combat.auto({ type: kind, hint: def.hint, choices: choices.map(function (c) { return c.id; }) });
      if (!choices.some(function (c) { return c.id === choice; })) choice = null;
    } catch (e) { choice = null; }
  }
  if (!choice && barEl) {
    choice = await new Promise(function (res) { B.waiting = res; });
  }
  if (!choice) choice = choices[0].id;   // headless safety: never hang
  B.waiting = null;
  B.paused = false;
  applyChoice(choice);
  renderAll();
  return choice;
}

/* ============================ v0.6 Master Commands ============================ */
/* PROTECT / OVERDRIVE / SACRIFICE — each ONCE per battle. Public entry point
   IT.combat.useCommand(id, heroId) so the UI layer never has to render or
   simulate battle controls; the in-battle buttons and hero-card pickers are
   owned right here. Headless sims drive it through the same door. */
function useCommand(id, heroId) {
  if (!B || B.over || B.paused || B.waiting) return false;
  if (id !== 'protect' && id !== 'overdrive' && id !== 'sacrifice') return false;
  if (B.cmdUsed[id]) return false;
  if (id === 'overdrive') {
    B.cmdUsed.overdrive = true;
    B.picker = null;
    B.overdrive = 2;
    log('⚡ MASTER\'S COMMAND — OVERDRIVE. The whole party redlines.', 'sys');
    fx('skill', { name: 'OVERDRIVE', hero: 'MASTER\'S COMMAND' });   // v0.9
    fx('shake', { mag: 5 });
    renderAll();
    return true;
  }
  var h = heroById(heroId);
  if (!h || h.hp <= 0 || B.st[h.id].withdrawn) return false;
  B.cmdUsed[id] = true;
  var wasPicking = B.picker;
  B.picker = null;
  if (id === 'protect') {
    B.protect = { id: h.id, rounds: 2 };
    log('🛡 MASTER\'S COMMAND — PROTECT.', 'sys');
    fx('skill', { name: 'PROTECT', hero: h.name });   // v0.9
    log(h.name + ' steps forward. "Nothing reaches them. Not while I stand."', 'sys');
    if (h.cls === 'Healer') log('A strange order for a healer — ' + h.name + ' will be the wall.', 'dim');
  } else {
    B.sacrifice = { id: h.id, rounds: 2 };
    applyStatus(h, { kind: 'taunt', dur: 2 }, h);   // taunts ALL enemies (attack targeting)
    log('💀 MASTER\'S COMMAND — SACRIFICE.', 'sys');
    fx('skill', { name: 'SACRIFICE', hero: h.name });   // v0.9
    log(h.name + ' steps forward. "Keep them safe."', h.cls === 'Tank' ? 'sys' : 'bad');
    if (h.cls === 'Tank') log('The Tower will have to go through ' + h.name + ' — and ' + h.name + ' does not break.', 'sys');
    else log(h.name + ' bares their chest to the Tower. This may well kill them.', 'bad');
  }
  if (wasPicking || !IT.combat.FAST) renderAll();
  return true;
}

function onCmd(id) {
  if (!B || B.over) return;
  if (id.indexOf('speed:') === 0) { B.speed = +id.slice(6); renderRunBar(); return; }
  if (id === 'retreat') {
    if (!B.waiting && !B.retreatRequested && !B.paused) {
      B.retreatRequested = true;
      log('The Master signals a retreat...', 'sys');
    }
    return;
  }
  /* v0.6 master command buttons / picker */
  if (id === 'mc_overdrive') { useCommand('overdrive'); return; }
  if (id === 'mc_protect' || id === 'mc_sacrifice') {
    if (B.paused || B.waiting) return;
    var kind = id.slice(3);
    if (B.cmdUsed[kind]) return;
    B.picker = kind;
    /* headless: let the test hook choose the hero directly */
    if (typeof IT.combat.auto === 'function') {
      var pickId = null;
      try {
        pickId = IT.combat.auto({ type: 'picker', kind: kind,
          heroes: aliveH().map(function (x) { return x.id; }) });
      } catch (e) { pickId = null; }
      if (pickId != null && useCommand(kind, +pickId)) return;
    }
    renderAll();
    return;
  }
  if (id === 'mc_cancel') { B.picker = null; renderAll(); return; }
  /* v0.11 supplies */
  if (id === 'sup_potion') { usePotion(); return; }
  if (id === 'sup_escape') { useEscapeKit(); return; }
  if (B.waiting) { var w = B.waiting; B.waiting = null; w(id); }
}

async function maybeStartInterrupt() {
  if (B.over) return;
  if (B.cfg.kind === 'boss' || B.cfg.kind === 'event' || B.cfg.ambush || B.enemies.some(function (e) { return e.boss || e.elite || /^Elite /.test(e.name); })) {
    await interrupt('start');
  }
}

async function maybeMarkInterrupt() {
  if (B.over) return;
  var b = boss();
  if (!b || !isExec(b) || !B.knowExec) return;   // v0.5: Executioner only — the King has his own tells
  if ((b.step || 0) % 3 === 1) {           // next boss action is the MARK
    await interrupt('mark');
  }
}

/* v0.5: Hollow King — hint interrupt on the FIRST Drain turn, only when the
   Master knows the fight (S.knowledge.hollowKing, read-only here; the flow
   layer sets knowledge after the first F20 fight, exactly as it does for the
   Executioner). */
async function maybeKingDrainInterrupt() {
  if (B.over || B.kingHintFired) return;
  var b = boss();
  if (!b || !isKing(b) || !B.knowKing) return;
  var drainNext = b.phase2 ? ((b.step + 1) % 2 === 0) : ((b.step + 1) % 3 === 0);
  if (drainNext) {
    B.kingHintFired = true;
    await interrupt('drain');
  }
}

async function maybeLowHpInterrupt() {
  if (B.over || B.lowFired) return;
  if (aliveH().some(function (h) { return h.hp < eMax(h) * 0.35; })) {
    B.lowFired = true;
    await interrupt('lowhp');
  }
}

/* ============================ v0.3 retreat ============================ */
function decideRetreat(h) {
  if (typeof IT !== 'undefined' && IT.decide && typeof IT.decide === 'function') {
    try { return IT.decide(h, 'retreat', {}); } catch (e) { /* fall through */ }
  }
  // core-table fallback for 'retreat': base 50 -0.5*courage +0.1*loyalty +0.4*fear
  var score = 50 - h.courage * 0.5 + h.loyalty * 0.1 + h.fear * 0.4;
  var verdict = score >= 60 ? 'comply' : (score >= 40 ? 'grudging' : 'refuse');
  return { verdict: verdict, line: '' };
}

var WITHDRAW_LINES = ['"Understood. Live to climb again."', '"Fine. We fall back."', '"They need me alive, not buried."'];
var REFUSE_LINES = ['"I\'m staying."', '"Not while they still bleed."', '"I don\'t run."', '"The Tower ends here, one way or another."'];

async function processRetreat() {
  if (B.over) return true;
  var act = aliveH();
  if (!act.length) { finishBattle(false, true); return true; }
  log('RETREAT ORDER — the Master calls the party back.', 'sys');
  var refusers = [];
  act.slice().forEach(function (h) {
    if (h.branded) {   // v0.14: the brand burns — the door is not for them
      log('🔥 ' + h.name + ' does not even turn around. The brand will not allow it.', 'bad');
      refusers.push(h);
      return;
    }
    var d = decideRetreat(h) || {};
    /* v0.7 faintheart: withdrawal compliance always succeeds — the trait's
       courage problem is exactly this gate. (Coward's Retreat, the reaction,
       is untouched: rolling it stays a separate 40% slip-out.) */
    var faintheart = traitOf(h) === 'faintheart';
    var forced = faintheart && d.verdict === 'refuse';
    var complies = faintheart || d.verdict !== 'refuse';
    var line = forced ? pick(WITHDRAW_LINES) : (d.line || pick(complies ? WITHDRAW_LINES : REFUSE_LINES));
    if (complies) {
      B.st[h.id].withdrawn = true;
      if (B.lastStand && B.lastStand.id === h.id) B.lastStand = null;
      log(h.name + ' disengages. ' + line, 'dim');
    } else {
      refusers.push(h);
      log(h.name + ' refuses the order. ' + line, 'bad');
    }
  });
  renderAll();
  if (!aliveH().length) { finishBattle(false, true); return true; }
  if (refusers.length === act.length) {
    B.retreatRefusals++;
    if (B.retreatRefusals >= 2) {
      // force-pull: the order is enforced, HP floors at 1
      aliveH().slice().forEach(function (h) { h.hp = Math.max(1, h.hp); });
      var puller = aliveH().slice().sort(function (a, b) { return b.courage - a.courage; })[0];
      var pulled = aliveH().slice().sort(function (a, b) { return a.hp / eMax(a) - b.hp / eMax(b); })[0];
      if (puller && pulled && puller.id !== pulled.id) {
        log(puller.name + ' drags ' + pulled.name + ' out by the collar.', 'sys');
      } else if (pulled) {
        log('The Master\'s will drags ' + pulled.name + ' out of the fray — alive, barely.', 'sys');
      }
      aliveH().slice().forEach(function (h) { B.st[h.id].withdrawn = true; });
      finishBattle(false, true);
      return true;
    }
    log('They will not leave. The Master\'s order goes unheeded — for now.', 'dim');
  } else {
    B.retreatRefusals = 0;
  }
  return false;
}

async function gateRetreat() {
  if (!B.retreatRequested || B.over) return false;
  B.retreatRequested = false;
  return await processRetreat();
}

/* ============================ loop & finish ============================ */
function pause() {
  var ms = (typeof IT.combat.FAST !== 'undefined' && IT.combat.FAST) ? 0 : 600 / B.speed;
  return wait(ms);
}

function checkEnd() {
  if (B.over) return true;
  if (!aliveE().length) { finishBattle(true, false); return true; }
  if (!aliveH().length) {
    var someoneAlive = B.heroes.some(function (h) { return h.hp > 0; });
    finishBattle(false, someoneAlive);   // all alive heroes withdrew -> retreated
    return true;
  }
  return false;
}

function finishBattle(win, retreated) {
  if (B.over) return;
  B.over = true;
  B.paused = false;
  B.picker = null;
  IT.combat.lastUsage = B.usage || {};   // v0.6 telemetry lands with the result
  resolveMemoryLayer();   // v0.4: grief burns off, bonds settle (win/retreat/loss alike)
  var expGained = {}, killsGained = {};
  if (!retreated) {   // v0.2: retreat forfeits earned bounty/kills
    B.heroes.forEach(function (h) {
      var t = B.tally[h.id] || { exp: 0, kills: 0 };
      if (t.exp) expGained[h.id] = t.exp;
      if (t.kills) killsGained[h.id] = t.kills;
    });
  }
  B.result = {
    win: !!win,
    retreated: !!retreated,
    deaths: B.heroes.filter(function (h) { return h.hp <= 0; }).map(function (h) { return h.id; }),
    expGained: expGained,
    killsGained: killsGained
  };
  log(win ? '— ✓ VICTORY. The floor falls silent. —' : retreated ? '— WITHDRAWN. The Tower keeps its floor — and your heroes. —' : '— ☠ THE PARTY HAS FALLEN. —', win ? 'good' : (retreated ? 'dim' : 'bad'));
  sndPlay(win ? 'victory' : (retreated ? null : 'defeat'));   // v0.9.3
  sndMusic(null);
  if (B.marked) B.marked = null;
  renderAll();
  queueEndCard(win, retreated);   // v0.8 title card; held (and tap-skippable) in start()
}

async function runLoop() {
  await maybeStartInterrupt();
  while (!B.over) {
    B.round++;
    if (B.round > 60) {
      // Anti-stall valve (v0.2's lone-Healer equilibrium could loop forever):
      // nobody can die, nobody can win — the Tower expels the party. No deaths.
      log('The Tower grows bored of this dance. The floor seals itself...', 'sys');
      log('...and expels the party down the stair. No ground lost but none gained.', 'dim');
      finishBattle(false, true);
      break;
    }
    await maybeAutoCmd();   // v0.6 test hook: headless Master Commands
    resolveStates();
    checkLastStand();
    // --- hero phase ---
    var order = aliveH().slice().sort(function (a, b) { return b.agi - a.agi; });
    for (var i = 0; i < order.length; i++) {
      if (B.over || !aliveE().length) break;
      if (await gateRetreat()) break;
      resetCoverLogs();
      await heroAct(order[i]);
      renderAll();
      await drainDeathBeats();   // v0.8 death beat (presentation pause — no rng, no round flow)
      if (checkEnd()) break;
      await pause();
    }
    if (B.over) break;
    // --- enemy phase ---
    await maybeMarkInterrupt();
    await maybeKingDrainInterrupt();
    if (await gateRetreat()) break;
    var foes = aliveE().slice();
    for (var j = 0; j < foes.length; j++) {
      if (B.over || !aliveH().length) break;
      if (await gateRetreat()) break;
      resetCoverLogs();
      await enemyAct(foes[j]);
      renderAll();
      await drainDeathBeats();   // v0.8 death beat (presentation pause — no rng, no round flow)
      if (checkEnd()) break;
      await maybeLowHpInterrupt();
      if (checkEnd()) break;
      await pause();
    }
    if (B.over) break;
    endOfRound();
    await maybeLowHpInterrupt();
    if (checkEnd()) break;
    await pause();
  }
}

function resetCoverLogs() {
  B._lsCoverLogged = false;   // v0.3
  B._prCoverLogged = false;   // v0.6 PROTECT
  B._ubCoverLogged = false;   // v0.6 UNBREAKABLE
}

/* Headless-sim hook (like FAST/auto): IT.combat.autoCmd(moment) -> command
   string 'overdrive' | 'protect:<heroId>' | 'sacrifice:<heroId>' | null,
   asked once per round before the hero phase. Never consulted in DOM play. */
async function maybeAutoCmd() {
  if (B.over || typeof IT.combat.autoCmd !== 'function') return;
  var cmd = null;
  try {
    cmd = IT.combat.autoCmd({
      round: B.round,
      used: { protect: !!B.cmdUsed.protect, overdrive: !!B.cmdUsed.overdrive, sacrifice: !!B.cmdUsed.sacrifice },
      party: aliveH().map(function (h) { return { id: h.id, cls: h.cls, hpPct: h.hp / eMax(h) }; }),
      boss: !!boss(),
      enemies: aliveE().length
    });
  } catch (e) { return; }
  if (!cmd || typeof cmd !== 'string') return;
  var parts = cmd.split(':');
  if (parts[0] === 'overdrive') useCommand('overdrive');
  else if ((parts[0] === 'protect' || parts[0] === 'sacrifice') && parts[1]) useCommand(parts[0], +parts[1]);
}

/* ============================ public API ============================ */
function normalizeEnemies(cfg) {
  return (cfg.enemies && cfg.enemies.length ? cfg.enemies : makeEnemies(cfg.floor || 1)).map(function (e, i) {
    var elite = !!e.elite || /^Elite /.test(e.name || '');
    var bounty = e.bounty != null ? e.bounty
      : Math.round((20 + (cfg.floor || 1) * 9) * (elite ? 1.5 : 1));
    return {
      name: e.name || 'Unknown Foe', maxHp: e.maxHp || 1, hp: e.maxHp || 1,
      atk: e.atk || 1, def: e.def || 0, boss: !!e.boss, elite: elite,
      bounty: bounty, step: 0,
      uid: 'e' + i   /* v0.6: battle-scoped id so statuses can target enemies */
    };
  });
}

async function start(cfg) {
  cfg = cfg || {};
  var S = (typeof IT !== 'undefined' && IT.S) ? IT.S : null;
  var party = S && S.heroes && S.party
    ? S.heroes.filter(function (h) { return S.party.indexOf(h.id) >= 0; })
    : [];
  injectStyle();
  buildView();
  deathQueue.length = 0;   // v0.8: fresh beat queue per battle
  cancelBeats();

  B = {
    cfg: cfg,
    floor: cfg.floor || 1,
    kind: cfg.kind || 'node',
    canRetreat: cfg.canRetreat !== false,
    heroes: party,
    enemies: normalizeEnemies(cfg),
    st: {}, tally: {},
    round: 0, speed: 1, over: false, paused: false, waiting: null,
    marked: null, deadIds: [],
    focusRounds: 0, defendRounds: 0,
    lastStand: null, lsUsed: false,
    lowFired: false, retreatRequested: false, retreatRefusals: 0,
    injuredFired: false,   /* v0.7: hero_injured fires once per battle */
    knowExec: !!(S && S.knowledge && S.knowledge.executioner),
    knowKing: !!(S && S.knowledge && S.knowledge.hollowKing),   // v0.5: read-only — flow sets knowledge
    kingHintFired: false, rule: null,
    eff: {}, bondPairs: [], bondedIds: {}, healBond: {}, griefAtStart: {},
    /* v0.6 skill/status/reaction/command state (reset every battle) */
    statuses: [], skillCd: {}, skillOnce: {}, usage: {},
    cmdUsed: { protect: false, overdrive: false, sacrifice: false },
    protect: null, sacrifice: null, unbreak: null, overdrive: 0, picker: null,
    lines: [], result: null
  };
  IT.combat.lastUsage = {};   // v0.6 telemetry: {skillId:count} for this battle
  party.forEach(function (h) {
    B.st[h.id] = { withdrawn: false, state: null };
    B.tally[h.id] = { exp: 0, kills: 0 };
    B.griefAtStart[h.id] = (typeof h.grieving === 'number' && h.grieving > 0) ? h.grieving : 0;
  });
  computeEffective(party);   // v0.4: gear on, saved stats untouched
  computeBonds(party);       // v0.4: bond >= 60 pairs hold the line

  /* v0.14: the pact takes its due at every battle's start — no rng, no flow
     change; heroes without a pact (golden headless cases) are untouched. */
  party.forEach(function (h) {
    if (!h.pact || !h.pact.lvl) return;
    var tax = Math.round(eMax(h) * 0.06 * Math.min(3, h.pact.lvl));
    h.hp = Math.max(1, h.hp - tax);
    if (h.hp < eMax(h) * 0.3) h.fear = clamp(h.fear + 5, 0, 100);
    log('🩸 ' + h.name + ' pays the pact its due — ' + tax + ' HP gone before a blade is drawn.', 'bad');
  });

  /* v0.5 floor rules — derived from cfg.floor alone, applied here so they hit
     map combats AND event-sourced cfg.enemies alike (single application point;
     makeEnemies stays rule-free to avoid double-bumping). */
  B.rule = ruleFor(B.floor);
  if (B.rule && B.rule.id === 'darkness') {
    B.enemies.forEach(function (e) { e.atk = Math.round(e.atk * 1.1); });
  }

  /* v0.10 PRESSURE & GREED: dread tiers change the SITUATION, not just a
     multiplier. cfg.dread is optional — absent (golden headless cases,
     economy-sim's own cfgs) everything below is a no-op and the engine is
     bit-identical to v0.9. */
  B.dread = (typeof cfg.dread === 'number') ? cfg.dread : 0;
  if (B.dread >= 26) {
    var tier = B.dread >= 76 ? 'panic' : (B.dread >= 51 ? 'dread' : 'uneasy');
    var ambChance = tier === 'panic' ? 0.55 : (tier === 'dread' ? 0.4 : 0.2);
    if (Math.random() < ambChance) {
      B.cfg.ambush = true;   // the existing start-interrupt fires
      log('⚠ The Tower\'s attention snaps onto the party — AMBUSH!', 'bad');
    }
    if (tier === 'dread' || tier === 'panic') {
      var n = 0;
      B.enemies.forEach(function (e) {
        if (e.boss) return;
        if (tier === 'dread' && n > 0) return;   // one huntsman at DREAD
        n++;
        e.elite = true;
        if (!/^Elite /.test(e.name)) e.name = 'Elite ' + e.name;
        e.maxHp = Math.round(e.maxHp * 1.3); e.hp = e.maxHp;
        e.atk = Math.round(e.atk * 1.15);
      });
      if (n) log(tier === 'panic'
        ? '🩸 The Tower sends its attention IN PERSON — every foe stands empowered.'
        : 'Something stronger hunts the party...', 'bad');
    }
  }

  if (!party.length) {
    // nothing to fight with: immediate loss, nothing at stake
    B.over = true;
    B.result = { win: false, retreated: false, deaths: [], expGained: {}, killsGained: {} };
    if (floorEl) floorEl.textContent = 'FLOOR ' + B.floor;
    log('No party. No battle. The Tower waits.', 'dim');
    renderAll();
    await wait(IT.combat.FAST ? 0 : 600);
    var r0 = B.result;
    clearView();
    return r0;
  }

  if (floorEl) floorEl.textContent = (B.floor === 10 ? 'FLOOR 10 — THE WALL' :
      B.floor === 20 ? 'FLOOR 20 — THE HOLLOW KING' :
      (B.kind === 'event' ? 'AMBUSH — FLOOR ' + B.floor : 'FLOOR ' + B.floor)) +
      (B.dread >= 76 ? ' · 🩸 PANIC' : (B.dread >= 51 ? ' · ⚠ DREAD' : (B.dread >= 26 ? ' · UNEASY' : '')));   // v0.10
  if (B.floor === 10) party.forEach(function (h) { h.fear = clamp(h.fear + 10, 0, 100); });
  log(B.kind === 'boss' ? 'The stairwell ends. Something enormous is waiting.' :
      B.kind === 'event' ? 'Ambush! The party is caught off guard.' :
      'Floor ' + B.floor + ' — the party advances.', 'sys');
  if (B.rule) log(B.rule.line, 'sys');   // v0.5: the floor's rule, announced once
  // v0.4 memory layer — one grief line + one bond line at the opening
  var grieverNames = party.filter(function (h) { return B.griefAtStart[h.id] > 0; })
                          .map(function (h) { return h.name; });
  if (grieverNames.length) log('🖤 ' + grieverNames.join(', ') +
      (grieverNames.length > 1 ? ' fight' : ' fights') + ' with red eyes — grief rides with them.', 'dim');
  if (B.bondPairs.length) {
    var bp = B.bondPairs[0], bA = heroById(bp[0]), bB = heroById(bp[1]);
    if (bA && bB) log('"' + bA.name + ': With me, ' + bB.name + '." — old friends hold the line.', 'sys');
  }
  if (B.floor === 10 && !B.knowExec) log('The air is wrong here. Heroes grip their weapons tighter.', 'dim');
  if (B.floor === 20 && !B.knowKing) log('The stair ends at a throne. Something hollow waits on it, wearing a crown.', 'dim');
  renderAll();
  track('combat_started');   // v0.7 anonymous counter (real battles only — the no-party path above returns early)
  sndMusic(boss() ? 'boss' : 'battle');   // v0.9.3

  try {
    await runLoop();
  } catch (err) {
    if (typeof console !== 'undefined' && console.error) console.error('[combat] engine error:', err);
    if (!B.result) finishBattle(false, false);
  }

  var settle = IT.combat.FAST ? 0 : Math.max(80, Math.min(1200, 1000 / B.speed));
  await endHold(settle);   // v0.8: VICTORY / THE PARTY IS LOST card (headless: plain settle)
  var result = B.result;
  clearView();
  return result;
}

return {
  start: start,
  makeEnemies: makeEnemies,   // exposed so flow/events can build cfg.enemies with proven scaling
  useCommand: useCommand,     // v0.6: (id, heroId) — Master Commands from anywhere (ui/sims)
  lastUsage: {},              // v0.6 telemetry: {skillId:count} for the last battle
  FAST: false,                // test hook: true strips all delays (headless sim)
  auto: null,                 // test hook: fn(moment) -> choice id (headless sim)
  autoCmd: null,              // v0.6 test hook: fn(moment) -> 'overdrive'|'protect:<id>'|'sacrifice:<id>'|null
  REACTIONS: true,            // v0.6 test hook: false strips the reaction layer (regression sims)
  debug: function () {
    return B ? { round: B.round, over: B.over, result: B.result,
      statuses: B.statuses, cmdUsed: B.cmdUsed, lines: B.lines,
      bondPairs: B.bondPairs } : null;
  }
};

})();
