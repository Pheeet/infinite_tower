# Infinite Tower — V0.21 "Scene + Route"

## V0.21 — one persistent expedition screen

The map and the scene stopped being two screens. TOP = the drama (the room
the party is in, decisions happening on it) · MID = the strategy (the
HORIZONTAL route — progression runs LEFT→RIGHT, branches go up-right /
down-right, always visible, always tappable) · BOTTOM = the party strip +
Scout / Torch / Leave.

- Selecting a connected node never navigates away: the party walks into the
  room in the TOP pane, the route below simply moves the current marker.
- Everything renders INTO the scene pane now — treasure caches, campsites,
  remains, events (the event cards play out over the room) — only battle
  takes the full view, and it hands straight back.
- Between rooms the scene rests on a quiet corridor: "Choose the next door
  on the route."
- `RENDER.map` is an alias of the expedition screen (old entry points keep
  working); the map generator now lays out columns left→right with the
  route strip at ~200px tall.



## V0.20 — the expedition becomes a place you walk into

The map stopped being the whole game: it is the DECISION layer, and every
node now has an EXPERIENCE layer.

- **The party walks in** (auto-directed, V0.19 chibi sprites): three heroes
  enter the room in formation, names over their heads, 🩸 when badly
  wounded, 😨 when afraid — the roster's state rendered as people.
- **Rooms have identity** by node type — a far doorway for corridors, a
  3-tone chest for vaults, a shrine stone, an unlit firepit, a cairn with a
  planted sword, a gold-trimmed boss arch — and a NAME (STONE CORRIDOR, THE
  HALL OF ECHOES, A FORGOTTEN VAULT…).
- **Room-to-room continuity**: the shell palette is seeded by the floor —
  same walls, same torches within a floor; the deeper floors change stone.
- **Dread is atmosphere now**: uneasy adds ground fog; dread adds blinking
  eyes in the far doorway; panic tints the air red, dims the torches and
  sifts dust from the ceiling.
- **The decision appears when the party settles**: Approach / Advance /
  Make camp / Leave it buried — then the existing layers (battle, events,
  treasure, rest, remains) take over underneath, untouched.
- Rhythm: MAP (choose) → WALK IN → DISCOVERY → DECISION → CONSEQUENCE →
  MAP. Headless/no-canvas falls through to the old direct flow (tests
  unchanged).



## V0.18 — the village at the Tower's foot

The hall became what the game is about: a tiny settlement huddled against an
impossible Tower.

- **THE TOWER dominates**: cold tapered stone rising center, cut by the top
  of the frame and swallowed by mist — impossibly tall. Arrow slits dark,
  two lit far above. Its entrance is a black arch with stone steps and cold
  breath of light: tap it → the Tower screen. `▸ THE TOWER` marks the door.
- **The village wraps the base**: two lit huts (amber windows), fences,
  storage crates, a workshop lean-to with the anvil, a training dummy,
  bed-roll lean-to, gravestones + candles for the Memorial, and the campfire
  plaza. A dirt path runs from the square up to the Tower steps.
- **Palette**: night sky → dark moss green ground, grass tufts, trees and
  bushes framing the village; earthy browns for wood; the Tower stays cold
  blue-gray. Warmth only where people live (fire, windows, candles).
- **Lighting**: darkness blanket with holes at the fire, both hut windows,
  the memorial — the village reads warm, the Tower reads cold and
  uninviting. Stars stay out of the Tower's silhouette.
- Heroes live in it unchanged (same AI/zones/drawer); zone anchors moved to
  village spots, `tower` added as a tap zone.



## V0.16 — spatial game UI (world first, UI on demand)

The direction: **pixel world + restrained UI** — never a mobile dashboard.

- **The hall IS the home screen** — full-viewport between HUD and nav.
  Bottom navigation is 3 doors and only 3: 🏠 HOME · ⚔ TOWER · 👥 HEROES.
  Master panel moved to the Tower; supplies/roster left the lobby.
- **Context, not menus**: tap the bedrolls → REST; tap the candles → the
  Memorial; tap the fire → PREPARE (supplies sheet); the workshop/training
  corners answer with texture. Two floating buttons remain: PREPARE/RECRUIT.
- **HEROES tab**: roster as CARDS — who / rarity / level / condition only
  (❤ % or Griev​ing), PARTY badge; depth is one tap deeper. Filters shared.
- **The summon is a ceremony**: full-screen UNKNOWN + **HOLD TO REVEAL**
  (press-and-hold with a fill bar; a familiar name teases "…the name feels
  familiar") → then the reveal card. Rarity → silhouette → identity →
  numbers.
- **Extraction is the moment of greed**: "BANK THE RUN?" with Secured /
  Unbanked AT RISK columns and PUSH ON (danger) vs EXTRACT — take Ng (gold).
- Typography discipline: world > important state (HP/DREAD/UNBANKED, big) >
  technical numbers (small, in drawers).



## V0.15 — the spatial lobby (campfire → one room, five zones)

The campfire was a landmark playing the whole lobby. Now the lobby is a
PLACE: one stone hall, five zones, heroes as actors in it.

- **ZONES**: the FIREPIT plaza (landmark), REST (bedrolls), TRAINING
  (wooden dummy), WORKSHOP (anvil + hammer), MEMORIAL (candles on their own
  shelf — a place, not a page).
- **Hero AI (tiny, readable)**: every hero picks what to do from their live
  condition — wounded (<45% HP) or afraid (>65 fear) → REST; grieving →
  MEMORIAL (they stand at the candles and bow); otherwise TRAINING (they
  swing at the dummy — attack pose, dust), WORKSHOP (hammering, gold
  sparks), by the fire, TALKING (they walk to a colleague; speech dots),
  or walking. System state shows through location.
- **The Master oversees**: tap a figure → the drawer under the scene —
  name/marks, Lv/★, HP, status, CURRENT ACTIVITY, party membership, and
  View Hero / Step out. Nobody walks for you.
- Bench heroes (top-4 by level outside the party) live in the hall too,
  dimmer. Party keeps their names on the floor.



## V0.14 — Blood Pact + Iron Brand (Phase 5: Temptation)

Two irreversible offers, now that there is something to lose.

- **The Black Altar** (event): a hero may take the PACT — +20% damage and
  +10% HP per level (up to 3), and every battle opens with the pact taking
  6% of their HP as due. Loyalty −20, fear +10, greed +10 — the Tower owns a
  piece of them. **When a pact hero falls there is nothing to bury**: no
  remains node, no gear. The name can still come back (legacy) — the Tower
  keeps its side of the deal. Refusing the altar by smashing it pays gold
  and loyalty instead.
- **The Iron Brand** (event): +8 ATK forever, and the hero **will never
  comply with a retreat order again** — no withdrawal, no coward's slip-out.
  Only the Escape Kit (a thing, not an order) still carries them out.
- Sprite marks: pact = red eyes, brand = a gold pixel on the brow, legacy =
  the cheek scar — visible everywhere (camp, battle, portraits).
- Profile chips spell out exactly what was traded. golden.js stays 115/115
  (all hooks are hero-field driven; golden's heroes carry none of them).



## V0.13 — Lobby life (Phase 4: Home)

The lobby stops being a menu and becomes the place they come back to.

- **The camp**: a living canvas scene — firepit with flickering flames and
  rising embers, and the PARTY around it: they stand, wander, and sit by the
  fire on their own. Bench heroes stand dim at the edges. Tap a figure to
  open their page.
- **Candles for the fallen**: the back wall carries a candle per memorial
  entry (six shown, newest burns brightest). Heroes walk beneath them. A
  death now has a spatial consequence you see every time you come home.
- Legacy heroes carry their cheek scar into the scene; returning nameplates
  show 🩸.
- Real lighting: darkness blanket with holes at the fire and torches, warm
  additive glow, vignette.
- Self-cleaning: the scene stops the frame its canvas leaves the DOM.
  Zero engine/balance change (golden 115/115 untouched).



## V0.12 — Legacy (Phase 3: Memory)

The gacha's signature moment: a dead hero's name can come back.

- Names of the fallen return to the recruit pool (25% of rolls pick from the
  memorial's names when available — rare early, meaningful late; measured
  ~1.25%/recruit with one memorial entry). When the gacha rolls one:
  **THE TOWER REMEMBERS.** A reveal ceremony — their old epitaph quoted,
  a LEGACY counter, and a cheek scar drawn into their pixel sprite forever.
- The returned are changed, not stronger: loyalty 80-95 (nobody climbs twice
  by accident), fear −10 (they have seen worse), and a first memory that
  says exactly what they are.
- The memorial plaque counts: "The Tower sent them back N times."
- Telemetry: `legacy_return`. golden.js stays 115/115 — the name-pool change
  draws NO extra rng when no memorial name is in play (rng discipline).



## V0.11 — finite supplies (Phase 2: Agency)

Three items, bought in the lobby (gold finally has a sink), carried into the
Tower, spent one at a time — no cooldown, no refill, and **a wipe takes the
whole bag**:

- **🧪 Potion · 40g** — in battle, heals the most-wounded living hero 45%
  eMax. Use it now or save it for a worse moment.
- **🔥 Torch · 30g** — on the climb: dread −20. The clock has AGENCY now —
  safety is a resource you choose to spend.
- **🏃 Escape Kit · 90g** — the guaranteed exit: no compliance rolls, no
  refusers, no force-pull. The party is simply gone, loot riding out with
  them.

Lobby carries a supply panel (count + price); the map gets the Torch button;
the battle command bar shows Potion/Kit with live counts (hidden when the
bag is empty). Telemetry: `supply_bought`, `potion_used`, `torch_used`,
`escape_used`, `supplies_lost`. golden.js stays 115/115 bit-identical
(supplies are read through guarded IT.S access; buttons are DOM-only).



Vertical mobile web prototype. All five classes run pure-data skill kits,
heroes are people (axes + reaction + trait), the economy is sim-tuned — and
now the game finally LOOKS like the game: stone and candlelight, heroes as
figures (not cards), a death beat that stops the fight.

## V0.10 — the Pressure & Greed loop (dread + unbanked loot, ONE system)

The missing roguelike heart: a reason to fear your own decisions.

- **DREAD (0-100) rises from what you DO** — every node entered feeds it
  (combat +12, treasure +7, event +6, remains +5). Tiers change the
  situation, not just a stat bar: CALM → UNEASY (20% ambush) → DREAD
  (40% ambush + an Elite hunts) → PANIC (55% ambush + every foe empowered,
  the floor label bleeds).
- **UNBANKED loot** — gold/permits found on the way are at risk until
  banked. A **campsite banks + eases dread (−30)**; the floor's end banks
  everything; **leaving keeps everything** (the extraction — safe, but the
  floor stays uncleared). A **WIPE loses the unbanked share** — the result
  ledger shows what the Tower kept.
- The map screen makes the greed legible in one second: SECURED / UNBANKED
  ⚠ AT RISK + the dread meter; treasure carries the risk line; the old
  Abandon is now **LEAVE — take the loot**.
- Event costs can be paid from purse → carried → secured (in that order).
- Telemetry: `dread_panic`, `unbanked_lost`. golden.js stays 115/115
  bit-identical (dread is cfg-driven, absent headless).

## V0.9 additions (canvas battle scene — presentation only, mechanics frozen)

- **`js/scene.js`** — the battle stops being cards and becomes a room: a stone
  chamber with flickering torches and drifting fog, rendered on one `<canvas>`.
- **Figures fight**: attackers LUNGE at their target, hits flash and spark,
  damage numbers float, HP bars bleed down (white trailing-lag bar), kills
  burst, the slain fall and stay.
- **Game feel**: screen shake on crits / cleaves / EXECUTION / the King's
  drain, skill-name banners (Fireball, Vanish, LAST STAND, OVERDRIVE…),
  marked heroes pulse red, Last Stand wears a gold ring, statuses ride above
  figures as emoji (🔥🛡💫🎯⬆🩸🖤).
- **Floor rules tint the room**: Darkness dims the torches, Blood Moon burns
  red, Betrayal goes sickly green.
- **Zero engine change**: combat.js feeds the scene snapshots + beat events
  (`fx()`); golden.js stays 115/115 bit-identical. No canvas (headless,
  old browsers)? combat keeps its v0.8 DOM view untouched.
- Master-command hero picking works on canvas (tap the figure), speed
  buttons / retreat / interrupt bar and the log strip stay DOM.
- **Pixel pass (v0.9.1)**: figures are now PROCEDURAL PIXEL SPRITES — one
  12x16 body plan per class (Warrior helm+sword, Tank tower shield, Rogue
  hood+dagger, Mage pointed hat+orb staff, Healer circlet+stole staff), with
  per-HERO hair/skin/cloth rolled from the hero id (same class, different
  people). Mobs get 6 body plans by name (humanoid / beast / skeleton /
  ghost / ogre / spider), hue from a name hash; bosses have dedicated 18x22
  sprites (Executioner's axe, Hollow King's crown and cape). Sprites blit
  with imageSmoothing OFF at integer scale; damage numbers / banners /
  nameplates use Press Start 2P; particles are square pixels; torch flames
  carry a blocky core. RNG here is a local mulberry32 — engine untouched.
- **Pixel everywhere (v0.9.2)**: the whole game wears the retro skin — display
  face is Press Start 2P (headers, buttons, nameplates; prose stays Alegreya),
  every radius retired, gradients flattened to slab panels with hard offset
  pixel shadows, buttons get an 8-bit bevel, bars go square and glowless, and
  a faint CRT scanline overlay rides the page. Every hero figure on every
  screen (lobby, roster, profile, reveal, memorial, march strip) is now the
  procedural pixel sprite via `IT.scene.heroSpriteURL` + `ui.js pxImg()`
  (emoji remains the no-canvas fallback). The skin is one append-only block
  at the end of style.css — delete it to restore the V0.8 candle look.
- **The Sound (V0.9.3)**: `js/sound.js` — procedural chiptune, zero audio
  files. SFX synthesized per beat (hit/crit/heal/burn/death/kill/skill/mark/
  victory/defeat), a 3-voice tracker for music (town waltz / driving battle
  pulse / boss menace), mute toggle in the header (persisted). AudioContext
  unlocks on first tap.
- **Sprite animation**: figures are 3-pose now — 2-frame idle breathe (torso
  sinks, feet planted) + an attack pose per class (sword raised, shield bash,
  dagger slash, orb flare). Foes idle in 2 frames (beast legs stagger, ghost
  hems wave, spider legs flick).
- **3 new event rooms**: The Toll Keeper (pay / stare it down / sneak under
  the bridge), The Still Pool (a reflection that may flinch first), The Oath
  of the Fallen (carry a dying knight's oath — loyalty and nerve).
- **Light & shadow (V0.9.4)**: real lighting pass — a darkness layer with
  holes punched by every light (flickering torches, living heroes carry their
  own small pools, the boss breathes a red bloom), plus additive warm glows.
  Cast shadows stretch away from the nearest torch. Ambient embers rise off
  the torches and dust drifts through the light. Hits now draw a slash
  crescent + shockwave ring (EXECUTION rings the whole room); barriers
  shimmer; the header sound button cycles full → half → off.
- **Title splash**: every boot opens on the title — the tap that enters also
  unlocks audio (browser autoplay policy) and starts the town loop. Page
  vignette + breathing panel glow finish the mood.

## V0.8 additions (presentation only — mechanics frozen, proven bit-identical)

- **Game-feel pass**: dark-fantasy stone/candle direction, Alegreya prose +
  Cinzel display, screen-beat transitions, floor title cards.
- **Heroes have presence** — large arched sprites with idle breathing, bowed
  when dead, candle-lit ghost slots for the lost.
- **Lobby**: the party stands together; roster is a quiet portrait strip.
- **Battle**: boss IS the room; log collapses to a chronicle strip; commands
  are carved stone.
- **Death beat**: a hero's death pauses the fight — full-bleed DEFEATED card
  with their last line. Implemented without touching rng (queue drained at
  existing await points).
- **Expedition as a scene**: FLOOR N title card, torchlit climb map, marching
  party, "Something waits ahead."
- Old UI harnesses retired → `tests/ui-smoke.js` (57 checks) now guards the
  new structure; `tests/golden.js` (115) remains the mechanics freeze;
  `tests/economy-sim.js` the systems model.

## V0.7 additions

- **Warrior & Rogue kits** (completes all 5 classes on the kit engine — legacy
  hardcoded acts retired): Cleave / Crushing Blow / War Cry / Berserk, and
  Backstab / Poisoned Blade / Smoke Bomb / **Vanish** (barrier 100% for one
  turn — the rogue's single death-cheat).
- **Hero traits** — one rolled per hero at recruit: Iron Gut, Glass Edge, Cold
  Blood, Bloodthirst, Night Eyes (Darkness synergy), Faint Heart. Mage #1 and
  Mage #2 are now genuinely different people.
- **New engine spec fields (all generic)**: `executeBonus` (+dmg vs low-HP
  targets), `prefer:'lowest'`, `fragile` status. Zero hero-id checks anywhere —
  a new hero is a data row.
- **Light telemetry** — anonymous counters (`run_started`, `second_run`,
  `scout_used`, `floor_cleared`, `run_ended`, `combat_started`, `hero_injured`,
  `hero_died`); `IT.telemetryDump()` in console for playtesters to paste back.

Known flags: Last Flame / Unbreakable see ~0 uses in auto-sim (desperation
windows close fast — may differ with real players); Rogue kit runs hot under
wear (98% informed) — watch next version.

## V0.6 additions

- **Skill system (pure data — `IT.SKILLS` in core.js, portable to Godot as-is)**:
  Mage / Tank / Healer each carry a 4-skill kit. Skills have target/power/
  cooldown/cost/effects/condition/AI-priority — the engine reads specs, nothing
  hero-specific is hardcoded. Warrior/Rogue kits come next version.
- **Status effects**: burn, barrier, taunt, stun, redirect, stress — Bulwark
  answers the Executioner's cleave; Guardian Prayer redirects damage away from
  the lowest ally (but never the lethal axe); Cleanse strips the Wall's dread.
- **Reactions** — per-hero identity fixed at recruit from their axes: Last Stand,
  Protective Instinct, Coward's Retreat (withdraws alive at low HP), Killer
  Instinct, Steady. Shown on the hero profile.
- **Master Commands** (once per battle): PROTECT (a hero shields everyone),
  OVERDRIVE (+25% party damage, then fear +15), SACRIFICE (one hero taunts all,
  +30% damage — legend-maker or corpse).
- **Telemetry**: `IT.combat.lastUsage` — the result screen shows what the party
  leaned on. Balance gate (300-run sims): F7 100% · F10 blind 0.3% · F10
  informed 89% · F20 informed 85%. No dead skills: the one 0-use skill found
  (Cleanse) got its reason to exist — the Wall's dread now applies stress.

## V0.5 additions

- **Floors 11-20 with rule modifiers** (shown before you enter — informed risk):
  - F11-13 🌑 **Darkness** — scouting costs 50g, fear on entry, enemies hit harder
  - F14-16 🌕 **Blood Moon** — heroes under 30% HP deal +30% but take +15%
  - F17-19 🐍 **Betrayal** — heroes refuse orders below loyalty 45; bonds forged here run deeper (×2)
  - F20 👑 **THE HOLLOW KING** — summons his court, and every cycle **drains the
    least-loyal hero**. The loyal (≥60) resist, halving it. The V0.4 relationship
    layer is the counter: campfires, burial rites, and clears raise loyalty.
    Blind ~0% win; informed loyalty-60+ party 68-81% (simmed).
- **Master progression** — clear floors → Master EXP → levels unlock the Deep
  Tower (ML2: F11-15 + roster 30 · ML3: F16-20 · ML4: cheaper rest · ML5: cheaper
  recruits). Panel in the Lobby.
- 9 new mob types, knowledge progression for the Hollow King, saves migrate from V0.3/V0.4.

## V0.4 additions

- **Bonds** — heroes fighting together grow bond (0-100); ≥60 pairs fight better
  and talk. Shown on the hero profile (BONDS section, rival↔bonded bar).
- **Grief** — when a bonded hero dies, mourners fight their next battle at -10%
  (🖤 Grieving) and carry a memory. The Campfire event lets them process it.
- **Gear of the fallen** — a dead hero's equipment stays on the floor (⚰️ node on
  the next expedition there). Recover it (inventory, equip, 3 slots) or bury it.
  Recovered gear keeps a history line: `Carried by Sera (†F1)` — and it appends
  every time its next carrier dies wearing it. This is how a 1★ becomes a legend.
- Save auto-migrates from V0.3 (same localStorage key).

## Run

Open `index.html` in a browser. No install, no build. (For phone testing:
`npx serve v0.3` and open on the same Wi-Fi.)

Save: localStorage key `infinite_tower_v03`. Clear via DevTools to reset.

## What's new vs V0.2

- **Expedition maps** — each floor is a branching node map (combat / event /
  treasure / rest). Scout nodes for 25g or go in blind.
- **Hero axes** — Courage / Greed / Loyalty / Fear (0-100). Personality label is
  derived from the axes.
- **Decision engine** — at events you pick a hero and give an order; the hero
  may comply, grumble, refuse, or do their own thing. Refusing a retreat is how
  legends (and corpses) are made.
- **Semi-auto combat** — rounds auto-run; the game pauses for Master commands
  (Focus / Defend / Push on / Retreat). Resolve states (Pressure / Focused /
  Panic) and one-per-battle **Last Stand** (Courage ≥85, near death, ally
  critical → intercepts everything 2 rounds).
- **Memories** — heroes remember defining moments; shown on their profile.
- **Knowledge progression** — die to the Executioner once and the Tower
  Analysis unlocks; your Healer learns to answer the Mark. Blind ~2-11% win,
  informed ~84% at Lv7.
- Anti-softlock: battles force-withdraw at round 60.

## Modules

`js/core.js` state+heroes+decide · `js/map.js` expedition maps ·
`js/events.js` 9 events · `js/combat.js` battle engine · `js/scene.js` canvas
battle presentation · `js/ui.js` screens+flow.
Contract: `CONTRACT.md`.

## Playtest question for V0.3

"Does a hero feel *alive*?" — when Mira refuses to open the chest, or stays in
the fight after you ordered retreat, does the party feel like people you manage
rather than units you own? That answer decides V0.4 (relationships + grief echo).
