# V0.7 Addendum — Full Roster (Warrior/Rogue kits, hero traits, light telemetry)

Final pre-Godot systems pass. Same rules; edit working code; everything intact.
Save ver 6 → 7 (migration in place, same key). GOAL: every class runs pure-data
kits (legacy acts retire), heroes differ within a class via a rolled trait, and
the web build emits anonymous play counters for the upcoming playtest.

## Warrior kit (Vanguard — pressure + recklessness)

1. cleave: allEnemies 0.6, cd2, ai6, burn none — 'Widespread, honest violence.'
2. crushingblow: enemy 1.4, cd3, ai7, condition none, effect: +50% power vs
   enemies below 30% hp (new effect field `executeBonus:0.5` — engine applies
   when target hp<30%) — 'Finish what the line started.'
3. warcry: party atkup {pct:0.15, dur:2}, cd4, ai8 — 'Louder than the fear.'
4. berserk: condition selfHpBelow 0.4, self atkup {pct:0.4, dur:3} + self
   fragile {pct:0.2, dur:3} (new status kind `fragile`: dmg taken ×(1+pct)),
   once per battle, ai9 — 'Pain is just information.'

## Rogue kit (Opportunist — tricks + one cheat-death)

1. backstab: enemy 1.2, cd0, ai5, targets lowest-hp enemy (target:'enemy' with
   new spec field `prefer:'lowest'` — engine picks lowest-hp foe) — 'Fair fights are a choice.'
2. poisonedblade: enemy 1.0, cd3, ai6, burn {dur:2, pct:0.3} (flavored as
   poison in desc) — 'Steel first. Chemistry after.'
3. smokebomb: party barrier {pct:0.2, dur:1}, cd3, ai7 — 'Nobody hits what they cannot see.'
4. vanish: condition selfHpBelow 0.3, self barrier {pct:1, dur:1} + next-turn
   atkup {pct:0.8, dur:1}, once per battle, ai10 — 'You only die if you are
   there.' (100% barrier for one turn = the rogue's one free death-cheat)

All four are DATA ONLY — spec fields already exist or are added as generic
engine features (executeBonus, prefer, fragile), never hero-id checks.
legacyHeroAct's Warrior/Rogue branches retire (keep the function as fallback
for un-migrated heroes only).

## Hero traits (one rolled per hero at recruit, data-driven)

IT.TRAITS spec: {id, name, desc, hooks}. Rolled weighted-uniform, stored
hero.trait. Engine applies via trait id in generic hooks (no hero-id code):

- irongut   +15% effective maxHp
- glassedge +15% eAtk, −15% eDef
- coldblood ignores Panic (fear≥75 gate never freezes; still takes −25% if Pressure rules say so? NO — trait ignores the freeze only)
- bloodthirst +10% dmg while any enemy is below 30% hp
- nighteyes +10% dmg on DARKNESS floors (11-13) — rule-synergy trait
- faintheart −10% dmg dealt, but +20 dodge? NO dodge system — instead: −10%
  dmg dealt, Coward's Retreat / withdrawal compliance always succeeds

Migration v6→v7 assigns a random trait to existing heroes. Profile shows TRAIT
row (name + desc). Traits must NOT re-tune the balance gates out of band
(±3 points tolerance; report movement).

## Light telemetry (anonymous counters, no PII)

S.telemetry = {run_started, scout_used, combat_started, hero_injured,
hero_died, floor_cleared, run_ended, second_run} — persisted with save.
IT.track(evt, n) increments + save (throttled: piggyback existing save calls
where possible; a lone track must not re-serialize more than once per second).
Hook points (owner in brackets): startExpedition [ui], scout [ui/map],
combat start [combat], hero death [combat+flow], floor cleared [ui],
run ended [ui finishExpedition], second_run = a run_started that begins < 60
(hidden session var S._ts is fine, or Date-based in-memory) after the previous
run_ended — this is THE "อยากกดอีกไหม" metric [ui].
Settings panel not needed; counters visible in console via IT.telemetryDump()
→ JSON string (playtesters paste it back).

## Balance gate (re-run after, N=300)

- F7 lv6 all five single-class+healer comps: ≥99% win, deaths ~0
- F10 blind lv7 M/T/H: <5% · informed: 60-90% band
- F10 informed with W/R in party (W/M/H, R/M/H): report vs prior
- F20 informed lv13: 60-85%
- Skill usage: no zero-use skill across 300 informed F10 + 300 F15 runs
  (F15 covers Darkness traits/nighteyes? F15 is Blood Moon — use F12 for
  Darkness), no skill >45% casts
- All existing harnesses h3-h6 pass

## Ownership

- AGENT-F4: js/core.js — warrior/rogue kit specs + IT.TRAITS + trait roll at
  makeHero + migration v6→v7 + IT.track/S.telemetry storage + telemetryDump.
- AGENT-G4: js/combat.js — generic engine features (executeBonus, prefer,
  fragile, trait hooks: irongut/glassedge/coldblood/bloodthirst/nighteyes/
  faintheart), retire W/R legacy branches (fallback kept), telemetry hooks,
  full gate re-run + report.
- AGENT-H4: js/ui.js + style.css — TRAIT row on profile, kit sections for
  W/R (they'll now have kits — remove 'kit to come' placeholder), telemetry
  hook calls at flow points incl. second_run, small version bump 'v0.7'.
