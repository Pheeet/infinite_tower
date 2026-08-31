# V0.6 Addendum — Skill System (data-driven, decision-forcing)

Extends all prior contracts. Same rules; edit working code, keep everything
intact. Save ver 5 → 6 (migrate in place, same key). Skills are pure DATA —
engine reads spec, nothing hero-specific hardcoded.

## Skill spec (exact shape, lives in core.js as IT.SKILLS)

```js
{
  id:'fireball', name:'Fireball', cls:'Mage', tier:'basic',
  target:'allEnemies'|'enemy'|'lowestAlly'|'anyAllyBelow35'|'self'|'party',
  type:'attack'|'heal'|'protect'|'buff'|'utility',
  power:0.75,                 // multiplier on caster atk (heal: on formula)
  cd:2,                       // cooldown turns after use (0 = spammable)
  cost:null|{hpPct:0.15},     // self HP cost
  effects:[{kind:'burn',dur:2,pct:0.25}],   // status applied
  condition:null|{selfHpBelow:0.25}|{allyDiedThisBattle:true}|{anyAllyBelow:0.35},
  ai:8                        // AI priority weight (higher = preferred when off cd)
}
```
Status kinds (engine supports exactly these): `burn` (dot = atk*pct at turn
start), `barrier` (dmg taken ×(1−pct)), `taunt` (enemies forced to target holder),
`stun` (skip action; bosses immune), `redirect` (dmg to ally X hits holder at pct),
`stress` (applies fear after; informational). All statuses: {kind,dur,pct,srcId,targetId}.

## The 12 basic skills (numbers final unless sim says otherwise — report, don't tune silently)

MAGE — Fireball: allEnemies 0.75 cd2 burn{2t,0.25} ai7 · Meteor: enemy 2.0 cd4 ai9 ·
Emergency Barrier: anyAllyBelow35 → barrier{pct:0.6,dur:1} on that ally, cd3, ai10
(defensive auto) · Last Flame: condition selfHpBelow 0.25, enemy 2.6, cost hpPct
0.15, cd0 but once-per-battle, ai6.
TANK — Shield Bash: enemy 0.9, stun{1t} 25% chance vs non-boss, cd0 ai5 ·
Bulwark: party barrier{pct:0.25,dur:1}, cd3 ai10 · Taunt: self taunt{dur:2}, cd4
ai8 · Unbreakable: condition selfHpBelow 0.3, self: takes ALL party-targeted dmg
at ×0.5 for 1 turn, hp floors at 1, once per battle, ai11.
HEALER — Mend: lowestAlly heal (existing formula), cd0 ai9 · Guardian Prayer:
redirect{2t,0.7} — damage aimed at lowest-HP ally hits the healer at 70%, cd4
ai8 · Cleanse: remove all negative statuses from party + fear−10, cd3 ai7 ·
Benediction: condition allyDiedThisBattle, party atkBuff +20% 2t + heal 15%
maxHp all, cd0 once-per-battle, ai10.

## Reaction skills (per-HERO identity, fixed at recruit from axes; stored hero.reaction)

courage>=70→laststand (existing behavior) · loyalty>=80→protective (30% intercept
for an ally below 30% hp — in ADDITION to tank class intercept if both) ·
fear>=70→cowardretreat (hp<20%: 40%/turn chance to withdraw self from battle
alive, keeping hp) · greed>=70→killer (+50% dmg vs enemies below 15% hp) · else
steady (+5% dmg). Precedence order: courage, loyalty, fear, greed, steady.
IT.DATA.REACTIONS carries name+desc for UI. Existing v0.4 'mournDeath' etc untouched.

## Master Commands (battle bar; each usable ONCE per battle)

Existing: Focus / Defend / Push on / Retreat (keep). Add:
- PROTECT → hero-picker → chosen protector intercepts ALL damage to everyone 2
  turns (they take it at full value unless Tank class reduction) — pair with a
  healer or a Tank.
- OVERDRIVE → party atk ×1.25 for 2 rounds; when it ends every hero fear+15 (log
  line about frayed nerves).
- SACRIFICE → hero-picker → chosen hero taunts ALL enemies 2 turns AND deals
  +30% dmg; hp floors at 1 only if Tank, otherwise can die. Log the choice
  dramatically ("Mira steps forward. 'Keep them safe.'").
Buttons live in the command bar (with the speed controls / interrupt bar layout
already there); disabled+counted once used. Pickers = tap hero card.

## Combat engine changes (combat.js)

- Skill loop replaces the hardcoded class acts for Mage/Tank/Healer ONLY.
  Warrior/Rogue keep their current hardcoded behavior this version (their kits
  come later) — do not regress them.
- Turn: for each hero — tick statuses (burn dot, decrement durs) → reaction
  checks (cowardretreat/protective) → pick skill: filter off-cooldown +
  condition-met, score = ai weight + situational bonus (Emergency Barrier huge
  when someone <35%, Mend scales with how hurt lowest ally is, Meteor preferred
  vs boss single, Fireball vs 3+ enemies) → execute. Basic attack (power 0.75,
  no cd) when nothing qualifies.
- Statuses resolve inside existing dmg pipelines (dmgHero applies barrier/redirect
  first, then tank/Last-Stand/PROTECT/SACRIFICE/taunt retargeting per current
  order — document the final order in a comment).
- Cooldowns tick per hero turn; once-per-battle flags reset per battle.
- Telemetry: IT.combat.lastUsage = {skillId:count,...} per battle — sims and the
  playtest read it.
- Bosses: stun immune; Executioner/Hollow King unchanged. Bulwark/barrier
  interact with cleave naturally (reduces each hit). Redirect does NOT catch
  the Executioner's lethal execute (it's dodge-the-axe, not damage) — Guardian
  Prayer catches cleave/dread only. Document this in the analysis text (ui).

## Balance gate (AGENT-G3 must sim, N=400)

- F7 lv6 (any comp incl. M/T/H): still ~100% win, deaths 0.
- F10 informed lv7 with kits: 60-90% (skills may shift within band; report).
- F10 blind lv7: <20%.
- F20 informed lv13 loyalty-65: 60-85%.
- Telemetry: no skill at 0 uses across 400 sims; no skill >45% of all casts
  (if so, its ai weight is wrong — adjust weight only, report).
- REGRESSION: Warrior/Rogue-only comps unchanged vs V0.5 numbers.

## Ownership

- AGENT-F3: js/core.js — IT.SKILLS data (12 + basic attack + reactions spec),
  hero.skills (class kit ids) + hero.reaction at makeHero, migration v5→v6
  (assign kit+reaction to existing heroes), IT.DATA.REACTIONS. Sanity: data
  shape complete, migration assigns correctly by axes.
- AGENT-G3: js/combat.js — skill engine, statuses, master commands, telemetry,
  full sim table + regression vs V0.5 numbers (re-run your V0.5 sims).
- AGENT-H3: js/ui.js + style.css — profile: skill kit list (name/power/cd/desc
  one-liner) + REACTION row; battle: status tags on cards (🔥🛡🎯😵➡🧠 pick
  1-2), PROTECT/OVERDRIVE/SACRIFICE buttons + hero pickers + once-per-battle
  disabled state; Tower Analysis note (Bulwark answers the cleave; redirect
  can't catch the axe). Harness: skills render, buttons fire once, pickers work.

Report deviations with reasons. All prior harnesses must still pass.
