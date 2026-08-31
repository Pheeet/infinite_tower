# Infinite Tower V0.3 — Module Contract

Vertical mobile web prototype. No dependencies, no build step. Pure JS + CSS + HTML.
Goal: one full expedition loop — Lobby → Party → Scout → Expedition Map (branching) → Events (hero decisions) → Semi-auto Combat (Master commands) → Rewards/Memorial.

## Files & ownership

```
v0.3/
  index.html      ← shell by lead; AGENT-E finalizes (views, nav)
  style.css       ← AGENT-E
  js/core.js      ← AGENT-A  (data, state, hero gen, decision engine, gacha)
  js/map.js       ← AGENT-B  (expedition map gen + scout + render)
  js/events.js    ← AGENT-C  (event pool + hero decision resolution)
  js/combat.js    ← AGENT-D  (semi-auto battle engine)
  js/ui.js        ← AGENT-E  (screens, router, flow, integration)
```

Load order in index.html: core → map → events → combat → ui. `IT.ui.init()` bootstraps.

## Global namespace

Every file starts: `window.IT = window.IT || {};` then attaches ONLY its own keys.
NO cross-module calls at load time (top level). All gameplay calls happen after init/flow.
All game text in ENGLISH. 'use strict'. ES2017 max. localStorage key: `infinite_tower_v03`.

## State schema (owned by core.js, exact)

```js
S = {
  ver: 3,
  gold: 250, permits: 3, nextId: 1,
  heroes: [Hero],            // roster, cap 24
  party: [heroId],           // max 3, alive heroes only
  memorial: [Mem],
  cleared: {floorN: true},
  knowledge: { executioner:false, wallBroken:false, firstBlood:false },
  expedition: null | {
    floor: n,
    map: MapObj,             // from IT.map.gen
    curId: nodeId,
    done: {nodeId: true},
    tally: { gold:0, permits:0, exp:{heroId:n} }
  }
}

Hero = {
  id, name, cls,             // cls: Warrior|Tank|Rogue|Mage|Healer
  rarity: 1-4, lvl, exp,
  hp, maxHp, atk, def, agi,
  courage: 0-100, greed: 0-100, loyalty: 0-100, fear: 0-100,  // axes, integer
  personality: 'Brave|Coward|Greedy|Loyal|Reckless|Cautious|',  // DERIVED label from axes
  kills: 0, floors: 0,
  memories: [ {floor:n, text:'...'} ]   // max 12, newest last
}

Mem = { ...Hero snapshot fields, diedFloor:n, killer:'...', epitaph:'...' }
```

Personality derivation (core.js): courage>=70→'Brave'; fear>=70→'Coward'; greed>=70→'Greedy';
loyalty>=80→'Loyal'; greed>=60&&courage>=60→'Reckless'; fear<=30&&courage<=40→'Cautious'; else pick highest axis label. Re-derive via `IT.label(hero)` whenever axes change.

## APIs (exact signatures)

### core.js — AGENT-A
```
IT.S                    // state object
IT.save()               // persist S to localStorage (try/catch)
IT.newGame()            // fresh S
IT.loadGame()           // returns S or null
IT.rnd(a,b) IT.ri(a,b) IT.pick(arr) IT.clamp(v,a,b)
IT.makeHero()           // → Hero (random class/rarity/axes), pushed to S.heroes
IT.rollRarity()         // 1:55% 2:28% 3:13% 4:4%
IT.gacha()              // spend 1 permit else 120g; returns {hero, used} or null + toast via IT.ui
IT.expNeed(lvl)         // 60+45*lvl
IT.grantExp(hero, amt)  // → levels gained; per level: maxHp*1.10, atk*1.09, def*1.06, agi*1.03+1, heal +30
IT.rest()               // cost 0.4g per missing HP, heals all, fear -25; returns {cost} or null
IT.addMemory(hero, floor, text)   // cap 12
IT.recordDeath(hero, floor, killer) // → Mem pushed, hero removed from roster+party
IT.decide(hero, action, ctx) → { verdict:'comply'|'grudging'|'refuse'|'alt', line:'"'...'"' }
IT.label(hero)          // personality label
IT.DATA                 // { NAMES:[30], CLASSES:{...}, MOBS:[9], EPITAPHS:[6] }
```

CLASSES (copy v0.2 base stats): Warrior hp120 atk22 def12 agi10 · Tank 185/15/20/6 ·
Rogue 90/26/6/20 · Mage 80/30/5/12 · Healer 95/14/8/11.
Rarity mult: {1:.82, 2:1, 3:1.25, 4:1.5}. Stat variance ±8%.
Axes at gen: courage ri(20,90), greed ri(10,90), loyalty ri(50,90), fear ri(5,30).

### Decision engine — core.js (AGENT-A)
Score 0-100. Base 50, then action modifiers, then gates:

| action        | +courage | +greed | +loyalty | −fear | notes |
|---------------|----------|--------|----------|-------|-------|
| open_chest    | +0.2×    | +0.5×  | —        | −0.4× | mimic risk is invisible to hero |
| investigate   | +0.4×    | +0.2×  | —        | −0.5× | dark/unknown |
| help_stranger | +0.4×    | −0.3×  | +0.3×    | −0.2× | |
| rob_stranger  | —        | +0.5×  | −0.6×    | —     | |
| retreat       | −0.5×    | —      | +0.1×    | +0.4× | |
| sacrifice     | +0.4×    | —      | +0.5×    | −0.3× | |
| push_on       | +0.4×    | +0.1×  | —        | −0.4× | |

(modifier = axis value × weight, applied to base 50)
Gates: if hero.loyalty < 25 and action not 'retreat' → 30% flat refuse.
Verdict: score>=60 comply · 40-59 grudging (comply + complaint line) · <40 refuse.
'alt' only when ctx.alt defined and greed/courage suggests it — implement: if refused and ctx.alt exists → 50% alt instead.
Each verdict gets a short in-character line (write 3-4 per verdict type per personality flavor, generic pool OK).

### map.js — AGENT-B
```
IT.map.gen(floor) → MapObj {
  nodes: [ {id:'n0', type, x, y, threat:1-5, scouted:false, cleared:false} ],
  edges: [ ['n0','n1'], ... ],
  startId, endId
}
IT.map.ScoutCost = 25  // gold per node
IT.map.scout(map, nodeId) → true/false  // spends gold, sets scouted
IT.map.render(map, containerEl, onEnter)  // draws SVG edges + node buttons into containerEl
IT.map.reachable(map) → [nodeId]  // frontier: neighbors of cleared/current nodes, not done
```
types: start(1) → 4-6 mid nodes (event 40% / combat 30% / treasure 15% / rest 15%) → end (combat, or boss if floor===10).
Layout: 3-5 rows, 1-2 per row, some branching + merging. x,y ∈ 5-95 (percent coords for SVG viewBox 0 0 100 100).
Threat scales with floor. Scout reveals type+threat of ONE node (unscouted shows '?').
Reachable rule: a node is enterable if adjacent to start or a cleared node, and not cleared itself. Only reachable nodes clickable in render.
After clearing a node UI shows ✓. End node cleared → expedition complete (flow handles).

### events.js — AGENT-C
```
IT.events.pool        // ≥9 events
IT.events.run(node, containerEl, done)  // renders event, handles option→hero pick→decide→resolve, calls done(summary)
summary = { text, effects: {gold, permits, fearΔ per heroId, loyaltyΔ per heroId, hpDmg per heroId, memory:{heroId:{floor,text}}, combat:null|{enemies:[...], kind:'event'}} }
```
Event shape:
```js
{ id, title, text, options: [ {id, label, action, needsHero:true} ] }
```
Flow inside run(): show card+text+options → player picks option → pick hero (party picker: name+class+axes) →
`const d = IT.decide(hero, option.action, {})` → show verdict + line (dramatic beat, ~600ms) →
if refuse: nothing happens / small fear+5; if comply/grudging/alt: resolve outcome → apply via core helpers → done(summary).
If outcome has combat (e.g. mimic): flow calls combat then done.

Required events (write ≥9): unknown chest (mimic 25% unless Rogue in party → inspect reveals), two doors (sound vs smell of blood — greedy/coward flavor lines), wounded stranger (help→loyalty+reward / rob→gold+loyalty−), shrine (offer 50g → party heal 30% or nothing), corpse of another Master's party (loot gold vs bury→memorial line), fork shortcut (fast=risk combat / long=+fear), whispering well (fear check: fear>60 hero refuses water), merchant (buy potion→next combat +20% hp? keep simple: buy 60g → full heal party), ancient tablet (learn floor intel → reveal all nodes, memory line).

### combat.js — AGENT-D
```
IT.combat.start(cfg) → Promise<result>
cfg = { enemies:[{name,maxHp,atk,def,boss?}], floor, kind:'node'|'event'|'boss', canRetreat:true }
result = { win, retreated, deaths:[heroId], expGained:{id:n}, killsGained:{id:n} }
```
Renders into `#battle-view` (owns that element): enemies top, party mid, log, bottom command bar.
Port v0.2 formulas EXACTLY from ../index.html (rawDmg, hero class skills, targeting, tank intercept 30%, boss mark/execute 3-turn cycle, knowledge.executioner → healer prioritizes marked, phase2 <35% frenzy).
New in v0.3:
- Semi-auto: rounds run automatically (600ms/B.speed, speed buttons 1x/2x/4x/≫), BUT pause + show Master command bar at interrupt moments:
  1. Battle start (if ambush/elite): [Focus] (+25% dmg 2 rounds) [Defend] (+50% def 2 rounds)
  2. Any hero < 35% HP first time: [Push on] [Defend] [Retreat]
  3. Boss mark (floor 10, knowledge known): [Heal marked] hint text [Hold the line] [Retreat]
- [Retreat] always visible in command bar when cfg.canRetreat: per-hero compliance roll via IT.decide(hero,'retreat'); refusers stay 1 more round ("I'm staying.") then are pulled out; retreat = result.retreated, no deaths unless already dead.
- Resolve states: each hero, checked each round: hp<50% → if courage>=70 'Focused' (+10% atk) else 'Pressure' (−10% atk); fear>=75 → if courage>=70 ignore, else 'Panic' (−25% atk, 35% freeze w/ log line).
- Last Stand: once per battle, if courage>=85 && hp<15% && an ally <25% hp → auto: intercepts ALL dmg 2 rounds, atk +50%, big log moment "MIRA — LAST STAND". Survives at 1 HP minimum during those 2 rounds.
Command bar choices affect next rounds; keep implementation simple (stance flags on B).

### ui.js + style.css + index.html — AGENT-E
```
IT.ui = { init(), go(screen), toast(msg), updateHeader(), el(id) }
IT.flow = {
  toLobby(), openTower(), startExpedition(floor),   // scout overlay → IT.map.gen → map screen
  enterNode(id), nodeDone(summary),                  // dispatch by node type
  finishExpedition(win), heroProfile(id), openMemorial()
}
```
Screens (single #app, switch innerHTML or hidden divs): lobby, hero, tower, map, event, battle, result, memorial.
Layout: portrait phone. `body{max-width:430px;margin:0 auto}` dark theme tokens below.
Lobby: party strip (3 slots) + roster cards (tap → hero profile w/ axes bars + memories) + [Rest] + [Tower].
Tower: floor list 1-10 (locked/cleared/THE WALL F10) + threat stars + knowledge panel (port v0.2 text).
Map screen: map render + [Scout random node 25g] + current tally + [Abandon expedition] (counts as retreat, keep loot).
Event/battle: containers events/combat own.
Result screen after end node: gold/exp tally, level-ups, deaths list + epitaphs, [Return to Lobby].
BOOT: `IT.ui.init()` → load or newGame; if !S.heroes.length show intro overlay (port v0.2 intro).
WIRE EVERYTHING: recruit button, party add/remove, rest, scout, node clicks, combat promise → flow, event done → flow.

## Style tokens (all agents use)
bg #0b0d12 · card #141822 · card2 #1b2130 · line #262d3d · txt #d7dce6 · dim #8b94a7 ·
gold #e8b04b · red #e05263 · green #5fbf77 · blue #5aa2e8.
Class colors: Warrior #d98e3f Tank #7f8fa6 Rogue #7ec97e Mage #9b6ee8 Healer #5fd4e0.
Rarity colors: 1 #9aa3b2 2 #7ec97e 3 #5aa2e8 4 #e8b04b. Headers: Cinzel via Google Fonts + Georgia fallback.
HP bar green→red <35%. Touch targets ≥44px.

## Rules for all agents
1. Read this contract + ../index.html (v0.2 reference) BEFORE writing.
2. Touch ONLY your assigned files. Never edit another module's file.
3. Code against the contract even if the other module doesn't exist yet.
4. No external libs/fonts besides the Google Fonts link already in index.html.
5. `node --check <yourfile>` must pass before you finish.
6. In-character English lines: short, punchy, no emoji spam (1-2 emoji max per line).
7. Report back: implemented API surface + any deviation from contract + 1 line why.
