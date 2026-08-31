# V0.8 Addendum — Game-Feel Pass (presentation only)

MECHANICS FREEZE: no gameplay/balance/logic changes. All harnesses h3-h7 and
golden tests must pass untouched after this pass. Every change is DOM/CSS/beat
pacing. The game currently reads "dashboard → card → button → result"; it must
read "I am leading three people into a tower they may not come back from."

## Art direction (binding for all three agents)

**Dark fantasy, stone and candle.** Not a SaaS dark theme.

Tokens (extend style.css :root — keep names, retune values + add):
- bg deepened #07080c; a faint stone-texture feel via layered radial-gradients
  (CSS only, no image assets).
- surfaces: NOT bordered cards everywhere. Prefer open composition: thin gold
  hairlines (1px #e8b04b40) as separators, section kickers in letterspaced
  small caps, generous vertical rhythm. A "card" is allowed ONLY where the
  thing IS an object (an event card, an item, a memorial plaque).
- accent: muted candle gold #e8b04b; danger #e05263; life #5fbf77.
- Type: display stays Cinzel (headers, floor titles, hero names — larger, more
  air, letter-spacing). NEW body face: 'Alegreya' (Google Fonts, add to
  index.html link) for prose/event text — serif, bookish. Log stays monospace.
- Hierarchy: Background → Environment → Hero → Key info → Action. Never show
  everything at once; one screen states one sentence.

**Hero presence (the core fix):**
- `.hero-sprite`: large (96-128px) class figure — big class emoji (or two-emoji
  composition) inside a subtle arched stone frame (CSS border-radius top).
- Idle animation: gentle 2.8s bob/breathe (transform translateY ±3px); party
  members slightly smaller; DEAD = desaturated, head-bowed (rotate 6deg, dim),
  never removed silently.
- `.nameplate`: Cinzel name + stars under the sprite, not beside a stats row.
- Stats exist but DEMOTED: one compact line or expandable details. The person
  is the hero; the numbers are a footnote.

**Beats & transitions:**
- `.screenbeat`: on every UI.go() the screen fades through near-black ~260ms
  (respect prefers-reduced-motion → 0ms).
- Floor title card: expedition start shows full-bleed "FLOOR N" (Cinzel, huge,
  centered, fades 900ms) before the map renders.
- Battle victory/defeat + result screen keep existing logic, get the same
  title-card treatment ("THE WALL BREAKS" / "THE PARTY IS LOST").

## Screen-by-screen (the only three that matter — plus cheap wins elsewhere)

### LOBBY — "นี่คือทีมของฉัน" (AGENT-FEEL-A)
Open composition, no roster grid-of-cards: the PARTY stands together center
(sprites + nameplates, tap to open profile); roster below as a quiet horizontal
scroll strip of small portraits. Recruit/Rest/Tower = one bottom action bar,
buttons look like engraved stone/brass, ≥52px. Master panel becomes a slim
parchment strip, not a card. Hero profile: portrait LARGE at top (sprite in
arched frame), name in Cinzel, then axes as thin candle-gold bars, kit/trait/
bonds/memories as book chapters (kickers + prose), not tables.

### BATTLE — "ฉันกำลังจะเสียใครบางคน" (AGENT-FEEL-B)
Composition per spec: enemy zone top (boss sprite BIG, name + one HP bar —
no stat tables), heroes mid as sprites with nameplates + slim HP bars, log
collapsible to a slim strip (default shows last 3 lines, tap to expand).
Command bar restyled as carved buttons (Focus/Defend/Retreat + master
commands). Speed controls shrink to small icon-ish buttons.
**Death beat (the moment):** when a hero dies mid-battle the battle PAUSES and
a full-bleed beat shows — sprite head-bowed, "DEFEATED", their last line or
the killer's line ("She refused to retreat." style — reuse the log line text),
[CONTINUE] (auto at 1.4s under FAST speeds / reduced-motion keeps the beat but
instant). This is the only pacing change allowed — it must not alter results
(sim harnesses run headless: guard ALL beat DOM behind the existing HAS_DOM /
document checks so headless timing is unchanged; the pause must not advance
rounds or change rng consumption).

### EXPEDITION — "ฉันกำลังเสี่ยงชีวิตทีม" (AGENT-FEEL-C)
Map screen becomes a scene: floor title card first, then the node map framed
as a torchlit climb — nodes keep their graph semantics but restyle (stone
discs, gold ring on current, darkness vignette at edges). Under the map one
flavor line per state ("Something waits ahead." / "The path splits here.").
Party strip = marching sprites with HP slivers. Scout/Abandon restyled, quiet.
Event cards (events.js already has beat pacing) get the Alegreya prose + the
outcome card styled as a parchment note — coordinate via classes only, you own
the event-view CONTAINER styling from ui.js side; events.js internals stay.
Treasure/rest/remains screens get the same scene treatment (big icon moment +
flavor + single button), result screen gets the title-card + ledger as
parchment rows.

## Ownership & rules

- AGENT-FEEL-A: index.html (fonts link + any shell tweaks), style.css core
  tokens/typography/transitions, ui.js lobby+hero+tower+memorial renderers.
- AGENT-FEEL-B: combat.js presentation layer only (its scoped styles,
  battle view build, death beat; results object untouched).
- AGENT-FEEL-C: ui.js map/event/battle-adjacent/result renderers + their css;
  may not touch combat.js.
- A owns style.css root tokens; B/C append scoped blocks at file end (comment
  headers) — no editing each other's blocks.
- No image assets, no CDN beyond the fonts link. Emoji-as-sprite is the
  placeholder art, done with care (size, frame, shadow, animation).
- Version label → v0.8.
- Verify: node --check on touched js; ALL of h3-h7 + tests/golden.js pass
  unchanged (mechanics freeze proof); headless DOM smoke of each reworked
  screen (renders, no missing ids the flow needs).
