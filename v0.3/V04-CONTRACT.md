# V0.4 Addendum — Memory Layer (relationships, grief, corpse recovery)

Extends CONTRACT.md. Same rules. Save key `infinite_tower_v03` unchanged — migrate
in place (see MIGRATION). All numbers final; do not re-tune.

## New state (exact)

```js
Hero += {
  rel: { otherHeroId: -100..100 },   // bond. missing key = 0
  items: { weapon: Item|null, armor: Item|null, trinket: Item|null },
  grieving: 0        // battles of grief remaining; combat decrements at resolve
}
Item = { id:'it'+n, name, slot:'weapon'|'armor'|'trick', atk, def, hp, history:'' }
S    += {
  inventory: [Item],                 // unequipped
  remains: { floorN: [ {heroName, cls, lvl, items:[Item], floor, epitaph} ] },
  nextItemId: 1
}
```

Item pool (generated on recovery — gear "of the fallen", not shop loot):
weapon {atk:6-14} names like "Rusted Dagger"/"Notched Blade"; armor {def:5-12,hp:10-30}
"Cracked Cuirass"; trinket {hp:15-40,atk:2-6} "Lucky Coin"/"Bone Charm".
`history` starts as `Carried by <deadName> (†F<floor>)` and APPENDS `, then <carrier>`
each time its carrier dies wearing it.

## New core APIs (AGENT-F, in core.js)

```
IT.bond(aId,bId)           // read: rel value -100..100 (symmetric)
IT.addBond(aId,bId,d)      // clamp -100..100; creates rel entries both sides
IT.bondedPairs(partyIds)   // → [[aId,bId,val],...] for val>=60
IT.mournersOf(deadId)      // → [heroId...] living heroes with bond(dead)>=30
IT.addItemToInventory(item)
IT.makeFallenItems(hero)   // unequip all slots → array of Items w/ history appended; returns [Item]
IT.migrateToV4(S)          // fills rel/items/grieving/inventory/remains/nextItemId; S.ver=4
```
Death path change (recordDeath): before snapshot — run `IT.makeFallenItems(hero)`,
push remains entry `{heroName, cls, lvl, items, floor, epitaph}` into
`S.remains[floor]`; after removal — every `IT.mournersOf(deadId)`: `grieving=1`,
`fear+10`, memory `<deadName> fell. <name> will not speak of it.` via addMemory.
`bond` writes allowed only through addBond.

MIGRATION: loadGame() → if `!S.ver || S.ver<4` → migrateToV4(S) then save.

## map.js (AGENT-F)

`IT.map.gen(floor)`: if `S.remains[floor]` non-empty → convert ONE mid 'event'
node (last one if possible) to `type:'remains'` (icon ⚰️). Everything else unchanged.
No new API.

## combat.js (AGENT-G)

1. Effective stats: at battle start compute per hero `eAtk=atk+Σitems.atk`,
   `eDef=def+Σitems.def`, `eMaxHp=maxHp+Σitems.hp` (heal same amount on gain so
   ratio kept). Use effective values everywhere. NEVER mutate saved atk/def/maxHp.
2. Grieving: hero with `grieving>0` → -10% dmg dealt, card tag `🖤 Grieving`, one
   log line at battle start ("fights with red eyes"). Decrement each hero's
   grieving by 1 when the battle resolves (win/retreat/loss alike, survivors only).
3. Bond: pairs from party with bond>=60 → both +3% dmg, one opening log line
   `"<A>: With me, <B>." — old friends hold the line.` (once per battle).
   On resolve: all surviving pairs +1 bond; healer→each healed target +2 (cap
   ~+6/battle). Death in battle: mourners get grieving=1 (do NOT re-push remains —
   flow/recordDeath owns that; combat only sets grieving+fear via result? NO —
   combat mutates hero.grieving/fear directly like it already does fear/loyalty,
   and reports deaths as before).
4. Result object adds nothing. Keep sim hooks working — re-run your harness after.

## events.js (AGENT-G)

One new event "The Campfire" (append to pool): during any event node, 25% chance
to BE the event (weight it via pool entry flag `campfire:true` and pick logic
preferring it if any party member grieving or bond pair >=60, else 10%):
text about the party resting a moment. Options:
- "Sit them together" → pick 2 heroes → +8 bond both, memory if bond crosses 60
  (`<A> and <B> — something like friends now.`).
- "Let them grieve" (only if someone grieving) → that hero fear-10, grieving
  cleared immediately, memory `They spoke of the dead until the fire died.`
- "Eat in silence" → nothing, small flavor.
Resolves via existing summary shape (loyaltyΔ etc. — add `bondΔ:{'aId|bId':d}`
key to summary effects; ui applies via addBond). No new combat.

## ui.js + style.css (AGENT-H)

1. Hero profile: new "BONDS" section — one row per rel entry (living heroes:
  name + bond bar -100..100 colored red↔green + label Rival<0 / Neutral / Bonded≥60);
  dead heroes w/ bond≥30 show `🪦 <name> — mourned` row. New "EQUIPMENT" section:
  3 slots (name+stats+history tooltip line), inventory list below with [Equip]
  per item (slot swap → old item to inventory), [Unequip] per worn slot.
2. Remains node screen (node.type==='remains'): card "WHAT WAS LEFT" — dead hero
  name, epitaph, items list. [Take the gear] → items→inventory + taker memory
  (`Recovered <deadName>'s gear on F<floor>.`) + fear+5 all; [Bury them properly]
  → party fear-10 loyalty+5 + taker memory. Either way remove ONE remains entry
  from S.remains[floor] (the matching one), clear node. Show ONLY if S.remains
  has entry; else node behaves as plain event (fall back to IT.events.run).
3. Memorial: card shows items held at death (names) + mourners line
  (`Mourned by Kael, Nia` — computed from living heroes' rel at death time;
  store mourners:[names] in Mem during recordDeath... AGENT-F adds this field).
4. Result screen: grief notices — if any survivor gained grieving this run, line
  `🖤 <name> returns changed.`
5. Boot: nothing new (migration runs inside loadGame).
Wiring reminder: events summary may now carry `effects.bondΔ` keyed `'aId|bId'`
— apply with IT.addBond.

## Ownership

AGENT-F: js/core.js, js/map.js · AGENT-G: js/combat.js, js/events.js ·
AGENT-H: js/ui.js, style.css. Same verify rules: node --check, headless sanity,
report deviations. READ the current files first — you are EDITING working code,
not writing fresh. Keep every existing behavior intact (V0.3 playtest passed).
