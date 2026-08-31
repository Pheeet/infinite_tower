# V0.5 Addendum — The Deep Tower (floors 11-20, rule modifiers, Master progression)

Extends CONTRACT.md + V04-CONTRACT.md. Same rules; edit working code, keep
everything intact. Save ver 4 → 5 (migrate in place, same localStorage key).

## Rule modifiers (the point of V0.5 — floors change RULES, not just numbers)

| Floors | Rule | Effect (exact) |
|---|---|---|
| 11-13 | 🌑 DARKNESS | scout cost 50g (not 25); on expedition start every hero fear+5; all enemies atk +10% |
| 14-16 | 🌕 BLOOD MOON | hero with hp<30% max: dmg dealt ×1.30, dmg taken ×1.15 |
| 17-19 | 🐍 BETRAYAL | loyalty refusal gate: loyalty<45 (instead of <30) rolls the 20% refuse; campfire +bond and bury +loyalty effects doubled on these floors |
| 20 | 👑 THE HOLLOW KING | boss floor (see below) |

Tower screen must show each floor's rule label before entering (informed risk).
Rules apply to map combats AND event-sourced combats on that floor.

## Master progression

```js
S.master = { level:1, exp:0 }   // migrated default
IT.masterExpNeed(lvl) = 100 * lvl
```
- EXP: clearing floor n → +n*8 (+60 extra if n===10 or n===20). Applied in
  finishExpedition. Level-up: toast + panel.
- Unlocks (checked where noted, all display the requirement when blocked):
  - ML2 → floors 11-15, roster cap 24→30
  - ML3 → floors 16-20
  - ML4 → rest cost ×0.6
  - ML5 → gacha cost 120→90 gold
- Lobby gains a small MASTER panel: level, exp bar, next unlock text.

## Floors 11-20 content

New mobs (index 11..19 in MOBS, same gen formula continues):
Tower Knight, Gloom Wraith, Changeling, Ash Beast, Pale Priest, Hollow Courtier,
Gloom Widow, Stone Warden, Twin Abomination. Elites as before (floor>=6 first
mob Elite ×1.5; floor 19 ×1.1 like floor 9).
Rewards: clear gold 40+25×floor continues; permits on floors 12,15,18 (+1);
F20 clear: 900 gold + 4 permits.

## Boss — THE HOLLOW KING (floor 20)

hp 1900, atk 52, def 12. Phase 1 (hp>50%): cycle —
1. Crown Slash: single target ×1.2
2. Summon: spawn a Hollow Courtier add (hp 220×floor-scale keep simple: flat
   hp 260/atk 26/def 6) if fewer than 2 adds alive
3. Drain the Doubtful: lowest-LOYALTY living hero takes ×2.2 atk drain; if that
   hero's loyalty >= 60 the drain is HALVED (they resist — they know why they
   climb). Heals king for damage dealt.
Phase 2 (hp<=50%): adds die instantly (log line), king atk +20%, Drain becomes
every 2nd turn, Crown Slash ×1.4.
Semi-auto: the v0.3 interrupt set applies (start Focus/Defend, low-HP, and —
when knowledge.hollowKing — a hint interrupt on first Drain turn: "The King
drinks doubt. The loyal resist.").
Knowledge: S.knowledge.hollowKing set after first F20 fight (win or lose);
Tower Analysis panel gains a Hollow King section when known.
Counter design: blind run painful (bring whoever), informed run = raise loyalty
(campfire, bury rites, clears) → drain resisted. Balance sim targets: blind
win <15%, informed (party avg loyalty>=60) 65-85% at lv13.

## Ownership

- AGENT-F2: js/core.js + js/map.js — master state/API/migration, MOBS 11-19,
  reward constants exposure (IT.DATA or API), scout-cost rule for F11-13
  (map.ScoutCost becomes fn of floor: IT.map.scoutCost(floor)), nothing else.
- AGENT-G2: js/combat.js — modifier effects (darkness enemy atk, blood moon
  thresholds, betrayal loyalty gate via cfg.rules + floor lookup), Hollow King
  boss pattern + adds, F20 enemies from makeEnemies, re-sim: F15 clear rate for
  lv11-12 party ≈ high (report), F20 blind vs informed targets above.
- AGENT-H2: js/ui.js + style.css — tower rows 11-20 with rule labels + ML locks,
  master panel in lobby, master exp in result screen, battle header shows active
  rule chip, knowledge.hollowKing Tower Analysis section, gacha/rest cost hooks
  (read from core API, fallback to old constants).

Verify rules per module: node --check + headless sanity + report deviations.
READ current files fully first. Report sim tables.
