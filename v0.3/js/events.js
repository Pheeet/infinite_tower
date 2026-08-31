'use strict';
/* ============================================================
   INFINITE TOWER v0.3 — js/events.js  (AGENT-C; v0.4 campfire by AGENT-G)
   Event pool + hero-decision resolution.

   API:
     IT.events.pool                      // 10 event defs (shape per contract)
     IT.events.pickEvent(party)          // v0.4: pool pick w/ campfire weighting
     IT.events.run(node, containerEl, done)
       1. render event card + options (touch targets >= 44px)
       2. player picks option -> hero picker (name / class / axes)
       3. IT.decide(hero, option.action, ctx)   [ctx = {alt:true} where an
          alternative fits] -> verdict beat (~900ms), colored:
          comply green / grudging dim / refuse red / alt gold
       4. resolve -> done(summary)
     IT.events.resolve(ev, opt, hero, verdict, line, env) -> summary
       (headless-testable core of step 4; exported for verification)

   summary = { text,
     effects: { gold, permits,
                fearD:{heroId:n}, loyaltyD:{heroId:n}, hpDmg:{heroId:n},
                memory:{heroId:{floor,text}},
                bondΔ:{'aId|bId':d},   // v0.4: flow applies via IT.addBond
                combat:null|{enemies:[...], kind:'event'},
                reveal:false|true } }
   (fearD / loyaltyD are the delta maps the contract calls fearΔ / loyaltyΔ;
   the Greek key is kept as the literal property name 'fearΔ'/'loyaltyΔ' so
   the flow layer can read it straight off the contract. Same for bondΔ.)

   Application split (per CONTRACT.md + task brief):
   - fearΔ / loyaltyΔ / hpDmg / gold / permits / combat / reveal are ONLY
     reported here — the flow layer (ui.js) applies them to state.
   - memories are written through IT.addMemory at resolve time AND reported
     in effects.memory for display.
   - healing cannot be expressed in the effects schema, so heals are applied
     directly to the live hero objects here and described in summary.text.
   Module-load-safe: no top-level calls into other IT modules.
   ============================================================ */
window.IT = window.IT || {};
window.IT.events = window.IT.events || {};

(function (E) {

  /* ============================ UTILS (local) ============================ */

  function ri(a, b) { return a + Math.floor(Math.random() * (b - a + 1)); }
  function pick(arr) { return arr[Math.floor(Math.random() * arr.length)]; }
  function clamp(v, a, b) { return Math.max(a, Math.min(b, v)); }
  function esc(t) {
    return String(t).replace(/&/g, '&amp;').replace(/</g, '&lt;')
      .replace(/>/g, '&gt;').replace(/\"/g, '&quot;');
  }
  function others(party, actorId) {
    return (party || []).filter(function (h) { return h && h.id !== actorId; });
  }

  var LOCAL_MOBS = ['Plague Rat', 'Cave Bat', 'Goblin Scrapper', 'Dire Wolf', 'Bandit',
    'Rattling Skeleton', 'Orc Raider', 'Tower Cultist', 'Flesh Ogre'];
  var CLASS_COLORS = { Warrior: '#d98e3f', Tank: '#7f8fa6', Rogue: '#7ec97e', Mage: '#9b6ee8', Healer: '#5fd4e0' };

  /* ============================ SUMMARY HELPERS ============================ */

  function mkSummary(text) {
    return {
      text: text || '',
      effects: {
        gold: 0, permits: 0,
        fearΔ: {}, loyaltyΔ: {}, hpDmg: {},
        memory: {}, bondΔ: {},
        combat: null,
        reveal: false
      }
    };
  }
  function addFear(s, id, n) { var k = String(id); s.effects.fearΔ[k] = (s.effects.fearΔ[k] || 0) + n; }
  function addLoy(s, id, n) { var k = String(id); s.effects.loyaltyΔ[k] = (s.effects.loyaltyΔ[k] || 0) + n; }
  function addDmg(s, id, n) { var k = String(id); s.effects.hpDmg[k] = (s.effects.hpDmg[k] || 0) + n; }
  /* v0.4: bond deltas keyed 'aId|bId'; the flow layer applies via IT.addBond. */
  function addBondD(s, aId, bId, n) {
    var k = String(aId) + '|' + String(bId);
    s.effects.bondΔ[k] = (s.effects.bondΔ[k] || 0) + n;
  }
  function addMem(s, hero, floor, text) {
    if (!hero) return;
    s.effects.memory[String(hero.id)] = { floor: floor, text: text };
  }
  /* Heals are not expressible in effects — apply straight to live objects. */
  function healParty(party, frac) {
    (party || []).forEach(function (h) {
      if (h && h.maxHp) h.hp = clamp(Math.round(h.hp) + Math.round(h.maxHp * frac), 0, h.maxHp);
    });
    var IT = window.IT;
    if (IT && typeof IT.save === 'function') { try { IT.save(); } catch (e) { /* best effort */ } }
  }

  /* ============================ EVENT COMBAT ENEMIES ============================ */
  /* Scaling mirrors v0.2 ../index.html makeEnemies(); combat.js owns the fight. */

  function scaleFor(floor) {
    return { h: 1 + (floor - 1) * 0.28, a: 1 + (floor - 1) * 0.26, d: 1 + (floor - 1) * 0.22 };
  }
  function mkMimic(floor) {
    var k = scaleFor(floor), hp = Math.round(48 * k.h);
    return { name: 'Chest Mimic', maxHp: hp, hp: hp, atk: Math.round(10 * k.a), def: Math.round(3 * k.d) };
  }
  function mkAmbush(floor) {
    var IT = window.IT;
    var mobs = (IT && IT.DATA && IT.DATA.MOBS) || LOCAL_MOBS;
    var k = scaleFor(floor), out = [], n = floor >= 5 ? 3 : 2, i, m, hp, nm;
    for (i = 0; i < n; i++) {
      m = (i === 0 && floor >= 6) ? 1.5 : 1;
      nm = mobs[clamp(floor - 1, 0, mobs.length - 1)];
      hp = Math.round(40 * k.h * m);
      out.push({ name: (m > 1 ? 'Elite ' : '') + nm, maxHp: hp, hp: hp, atk: Math.round(8 * k.a * m), def: Math.round(2 * k.d * m) });
    }
    return out;
  }

  /* ============================ DEFAULT REFUSE ============================ */

  function refuseDefault(s, hero, env, tail) {
    s.text = hero.name + ' — ' + env.line + ' ' + (tail || 'The party moves on.');
    addFear(s, hero.id, 5);
  }

  /* ============================ EVENT POOL ============================ */

  var POOL = [
    {
      id: 'chest',
      title: 'The Sealed Chest',
      text: 'An iron-bound chest sits against the wall, lid shut with wax and prayer. The dust around it is undisturbed — nothing has opened it in years. When you look away, something inside shifts its weight.',
      options: [
        { id: 'open', label: 'Open it', action: 'open_chest', needsHero: true },
        { id: 'inspect', label: 'Inspect it first', action: 'investigate', needsHero: true, rogueOnly: true }
      ]
    },
    {
      id: 'doors',
      title: 'Two Doors',
      text: 'The corridor splits. Behind the left door: a slow, patient knocking, like a knuckle on wood, keeping time. Behind the right: no sound at all, but the smell of blood is thick enough to chew.',
      options: [
        { id: 'left', label: 'Left — answer the knocking', action: 'help_stranger', needsHero: true },
        { id: 'right', label: 'Right — follow the blood', action: 'open_chest', needsHero: true }
      ]
    },
    {
      id: 'stranger',
      title: 'The Wounded Stranger',
      text: 'A man in another Master\'s colors lies against the wall, holding his side together with both hands. He has been waiting for someone. Anyone. His eyes find yours and ask the only question that matters.',
      options: [
        { id: 'help', label: 'Help him', action: 'help_stranger', needsHero: true },
        { id: 'rob', label: 'Take what he carries', action: 'rob_stranger', needsHero: true, alt: true }
      ]
    },
    {
      id: 'shrine',
      title: 'The Quiet Shrine',
      text: 'A niche in the stone holds a small god with a smooth, worn face. Old offerings crowd its feet — coins, rings, a child\'s tooth. It is very quiet here, and the quiet feels like attention.',
      options: [
        { id: 'offer', label: 'Offer 50 gold', action: 'sacrifice', needsHero: true, cost: 50 },
        { id: 'loot', label: 'Take the offerings', action: 'rob_stranger', needsHero: true, alt: true }
      ]
    },
    {
      id: 'corpse',
      title: 'Another Master\'s Party',
      text: 'Four bodies in the livery of a rival Tower, laid out neatly — not by whoever buried them. By whatever finished them. Their boots are better than yours. So were they.',
      options: [
        { id: 'loot', label: 'Search the bodies', action: 'rob_stranger', needsHero: true, alt: true },
        { id: 'bury', label: 'Bury them properly', action: 'sacrifice', needsHero: true }
      ]
    },
    {
      id: 'fork',
      title: 'The Squeeze',
      text: 'The map shows one way around: a long stair, hours of climbing in the dark. There is also a gap in the wall — a shortcut, if a body fits, and if nothing else had the same idea first.',
      options: [
        { id: 'shortcut', label: 'Crawl through the gap', action: 'push_on', needsHero: true },
        { id: 'long', label: 'Take the long stair', action: 'retreat', needsHero: true }
      ]
    },
    {
      id: 'well',
      title: 'The Whispering Well',
      text: 'A stone well stands where no well should, rope running down into black water. Put an ear to the rim and there is a voice, far below, saying your name. Not the Master\'s. Yours.',
      options: [
        { id: 'drink', label: 'Answer the whisper', action: 'investigate', needsHero: true },
        { id: 'leave', label: 'Leave the well', action: 'retreat', needsHero: true }
      ]
    },
    {
      id: 'merchant',
      title: 'The Peddler',
      text: 'A bent figure waits at the landing with a crate of salves, clean linen, and prices written on a slate. No cart. No mule. He does not explain how he got here, and you do not ask.',
      options: [
        { id: 'buy', label: 'Buy the crate — 60 gold', action: 'sacrifice', needsHero: true, cost: 60 }
      ]
    },
    {
      id: 'tablet',
      title: 'The Ancient Tablet',
      text: 'A slab of black stone fills the end of the passage, cut dense with old script. It is not decoration. It reads like a map — this floor, its rooms, its teeth — if someone can hold the words still long enough.',
      options: [
        { id: 'study', label: 'Read the stone', action: 'investigate', needsHero: true }
      ]
    },
    /* ---- V0.9.3 content: three new rooms ---- */
    {
      id: 'toll',
      title: 'The Toll Keeper',
      text: 'A rope bridge crosses a shaft with no bottom. On the near side stands a hooded figure with a ledger and a very patient knife. "Eighty gold the crossing," it says, in a voice like dry paper. "Or the long way round. The Tower is not in a hurry. Neither am I."',
      options: [
        { id: 'pay', label: 'Pay the toll — 80 gold', action: 'sacrifice', needsHero: true, cost: 80 },
        { id: 'refuse', label: 'No toll — stare it down', action: 'push_on', needsHero: true },
        { id: 'sneak', label: 'Slip past under the bridge', action: 'investigate', needsHero: true }
      ]
    },
    {
      id: 'mirror',
      title: 'The Still Pool',
      text: 'Water fills a basin of black stone, perfectly still, perfectly clean — nothing stays clean here. Looking in, the water does not show the ceiling. It shows a face, and it is almost yours.',
      options: [
        { id: 'look', label: 'Look long into the water', action: 'investigate', needsHero: true },
        { id: 'smash', label: 'Break the surface', action: 'push_on', needsHero: true }
      ]
    },
    {
      id: 'oath',
      title: 'The Oath of the Fallen',
      text: 'A knight in rusted plate sits propped against the wall, exactly where his legs stopped working. Under the visor, someone is still home — barely. His gauntlet rises an inch off the stone. "Someone hold it," he says. "Just to the end. It does not matter whose."',
      options: [
        { id: 'swear', label: 'Take the oath', action: 'sacrifice', needsHero: true },
        { id: 'close', label: 'Close his eyes and walk on', action: 'help_stranger', needsHero: true }
      ]
    },
    /* ---- V0.14 TEMPTATION: the two irreversible offers ---- */
    {
      id: 'altar',
      title: 'The Black Altar',
      text: 'A slab of stone that drinks the torchlight. On its face, a shallow bowl worn smooth by hands — thousands of them, all sizes, all desperate. Whoever sits here leaves stronger. The price is written in the wear: it is not paid all at once, and it is not paid in gold.',
      options: [
        { id: 'pact', label: 'Speak the words — take the pact', action: 'sacrifice', needsHero: true, sub: '+20% dmg, +10% HP · irreversible' },
        { id: 'smash', label: 'Smash the altar', action: 'push_on', needsHero: true }
      ]
    },
    {
      id: 'brand',
      title: 'The Iron Brand',
      text: 'A brazier of white coals, still hot after years with no one to feed it. Floating above: an iron seal, turning slowly, waiting. Whoever takes the brand will hit harder than they ever have — and will never again be someone who turns back.',
      options: [
        { id: 'take', label: 'Take the brand', action: 'sacrifice', needsHero: true, sub: '+8 ATK · can never retreat' },
        { id: 'refuse', label: 'Leave it burning', action: 'retreat', needsHero: true }
      ]
    },
    {
      /* v0.4 memory layer — the party rests a moment. Not an order, not a risk:
         no hero decision, no combat. Pick logic (pickEvent) prefers this when
         someone is grieving or a bond pair >= 60 exists, else 10%. */
      id: 'campfire',
      campfire: true,
      title: 'The Campfire',
      text: 'The corridor widens into a landing where some earlier party stacked a ring of stones and a heap of dry wood. Someone lights it without being told. For a few minutes nothing in the Tower is trying to kill anyone, and nobody quite knows what to do with that.',
      options: [
        { id: 'together', label: 'Sit them together', needsPair: true, sub: 'Shoulder to shoulder' },
        { id: 'grieve', label: 'Let them grieve', grievingOnly: true, sub: 'Speak of the dead' },
        { id: 'silence', label: 'Eat in silence', sub: 'Nothing needs saying' }
      ]
    }
  ];

  /* ============================ RESOLUTION HANDLERS ============================ */
  /* Each: (s, ev, opt, hero, verdict, env) — fills the summary.
   * env = { floor, party, flags:{mimic:bool}, line }. */

  var HANDLERS = {

    chest: function (s, ev, opt, hero, v, env) {
      var g, dmg, rest;
      if (v === 'refuse') { refuseDefault(s, hero, env, 'The chest stays shut. The Tower keeps it.'); return; }
      if (opt.id === 'inspect') {
        if (env.flags.mimic) {
          s.text = hero.name + ' — ' + env.line + ' The Rogue goes very still. "It\'s breathing," comes the whisper. The chest would rather be caught than be caught hungry — it unfolds anyway. Weapons up.';
          s.effects.combat = { enemies: [mkMimic(env.floor)], kind: 'event' };
        } else {
          g = ri(40, 90);
          s.effects.gold = g;
          addMem(s, hero, env.floor, 'Picked a dead man\'s lock on floor ' + env.floor + '. No teeth inside. ' + g + ' gold.');
          s.text = hero.name + ' — ' + env.line + ' Hinges, pins, no traps. A knife-tip and two minutes: ' + g + ' gold, clean.';
        }
        return;
      }
      // opt.id === 'open'
      if (env.flags.mimic) {
        dmg = ri(60, 80);
        if (hero.courage < 50) {
          // only squishies can actually die from this — hp 60-80 vs Mage/Rogue hp
          addDmg(s, hero.id, dmg);
          rest = others(env.party, hero.id);
          for (var i = 0; i < rest.length; i++) {
            addMem(s, rest[i], env.floor, 'Watched the chest bite ' + hero.name + ' to the bone on floor ' + env.floor + '.');
          }
          s.text = hero.name + ' — ' + env.line + ' The lid comes up. The lid is teeth. ' + hero.name + ' takes the first bite — ' + dmg + ' HP gone before anyone moves — and the chest is still hungry.';
        } else {
          s.text = hero.name + ' — ' + env.line + ' The chest unfolds into something with far too many hinges. It was waiting for exactly this. Weapons up.';
        }
        s.effects.combat = { enemies: [mkMimic(env.floor)], kind: 'event' };
      } else {
        g = ri(40, 90);
        s.effects.gold = g;
        s.text = hero.name + ' — ' + env.line + ' The wax seal breaks with a small sigh. ' + g + ' gold — and nothing bites.';
      }
    },

    doors: function (s, ev, opt, hero, v, env) {
      var g, rest;
      if (v === 'refuse') {
        refuseDefault(s, hero, env, 'The knocking keeps its rhythm as the party backs away. Whatever it is, it can keep knocking.');
        return;
      }
      if (opt.id === 'left') {
        g = ri(15, 30);
        rest = others(env.party, hero.id);
        s.effects.gold = g;
        addLoy(s, hero.id, 8);
        for (var i = 0; i < rest.length; i++) addLoy(s, rest[i].id, 2);
        addFear(s, hero.id, -5);
        addMem(s, hero, env.floor, 'Answered the knocking on floor ' + env.floor + '. A caver lived because of it.');
        s.text = hero.name + ' — ' + env.line + ' The knocking stops the moment a hand touches the door. ' + hero.name + ' breaks it open anyway: a caver, three days sealed in, blinking at torchlight. She empties her purse into their hands — ' + g + ' gold — and runs for the stair.';
      } else {
        g = ri(40, 90);
        rest = others(env.party, hero.id);
        s.effects.gold = g;
        addFear(s, hero.id, 12);
        for (var j = 0; j < rest.length; j++) addFear(s, rest[j].id, 5);
        s.text = hero.name + ' — ' + env.line + ' No sound behind the right door. Just blood, thick enough to chew. ' + hero.name + ' steps through anyway and comes back with a fresh purse — ' + g + ' gold. Nobody asks whose it was.';
      }
    },

    stranger: function (s, ev, opt, hero, v, env) {
      var g, rest;
      if (v === 'refuse') {
        refuseDefault(s, hero, env, 'The party walks past. He does not call after them. He has met Masters before.');
        return;
      }
      rest = others(env.party, hero.id);
      if (opt.id === 'help') {
        g = ri(15, 35);
        s.effects.gold = g;
        addLoy(s, hero.id, 10);
        for (var i = 0; i < rest.length; i++) addLoy(s, rest[i].id, 3);
        addFear(s, hero.id, -4);
        addMem(s, hero, env.floor, 'Gave water to a dying rival on floor ' + env.floor + '. He paid it back with a warning.');
        s.text = hero.name + ' — ' + env.line + ' Bind the wound, give the water. The man presses his purse back — ' + g + ' gold — and one warning: "It circles back. It always circles back."';
      } else if (v === 'alt') {
        // ordered to rob; refused; did their own thing instead
        addLoy(s, hero.id, 6);
        addMem(s, hero, env.floor, 'Was ordered to rob a dying man on floor ' + env.floor + '. Couldn\'t.');
        s.text = hero.name + ' — ' + env.line + ' But at the last moment ' + hero.name + ' kneels and gives water instead of taking coin. The man\'s breathing steadies. The party pretends not to have seen the hesitation.';
      } else {
        g = ri(40, 90);
        s.effects.gold = g;
        addLoy(s, hero.id, -12);
        for (var j = 0; j < rest.length; j++) addLoy(s, rest[j].id, -4);
        addMem(s, hero, env.floor, 'Robbed a dying man on floor ' + env.floor + '. He didn\'t fight for it.');
        s.text = hero.name + ' — ' + env.line + ' The man does not fight for it. He just watches ' + hero.name + ' turn out his pockets: ' + g + ' gold, a good knife, no dignity.';
      }
    },

    shrine: function (s, ev, opt, hero, v, env) {
      var g, rest, answered;
      if (v === 'refuse') {
        refuseDefault(s, hero, env, 'They leave the small god to its silence. It was here before them; it will be here after.');
        return;
      }
      rest = others(env.party, hero.id);
      if (opt.id === 'offer') {
        s.effects.gold = -50;
        answered = Math.random() < 0.55;
        if (answered) {
          healParty(env.party, 0.30);
          addFear(s, hero.id, -8);
          for (var i = 0; i < rest.length; i++) addFear(s, rest[i].id, -8);
          addLoy(s, hero.id, 6);
          addMem(s, hero, env.floor, 'The small god answered on floor ' + env.floor + '. Warmth poured through the party.');
          s.text = hero.name + ' — ' + env.line + ' The coins sink into worn stone like still water. Warmth moves through the party — wounds pulling closed, breath coming easier (everyone heals 30%). The little god\'s face looks, for a moment, less blank.';
        } else {
          for (var j = 0; j < rest.length; j++) addFear(s, rest[j].id, 3);
          addFear(s, hero.id, 3);
          s.text = hero.name + ' — ' + env.line + ' The coins vanish between one blink and the next. The silence does not change. Whatever listened here has stopped listening — or never was.';
        }
      } else if (v === 'alt') {
        addLoy(s, hero.id, 4);
        s.text = hero.name + ' — ' + env.line + ' But ' + hero.name + '\'s hand stops over the child\'s tooth, and closes on nothing. Ends up kneeling instead — briefly, awkwardly. The cold recedes exactly that much.';
      } else {
        g = ri(20, 45);
        s.effects.gold = g;
        addLoy(s, hero.id, -10);
        addFear(s, hero.id, 6);
        for (var k = 0; k < rest.length; k++) addFear(s, rest[k].id, 6);
        addMem(s, hero, env.floor, 'Pried ' + g + ' gold from a shrine\'s feet on floor ' + env.floor + '. The cold followed.');
        s.text = hero.name + ' — ' + env.line + ' The offerings come loose easy — too easy. ' + g + ' gold in ' + hero.name + '\'s fist, and the air goes cold enough to see. Nobody suggests giving it back.';
      }
    },

    corpse: function (s, ev, opt, hero, v, env) {
      var g, rest;
      if (v === 'refuse') {
        refuseDefault(s, hero, env, 'The dead keep their boots. The living keep walking.');
        return;
      }
      rest = others(env.party, hero.id);
      if (v === 'alt' && opt.id === 'loot') {
        // ordered to loot the dead; couldn't; buried them instead
        addLoy(s, hero.id, 4);
        for (var a = 0; a < rest.length; a++) addFear(s, rest[a].id, -4);
        addMem(s, hero, env.floor, 'Was ordered to loot the dead on floor ' + env.floor + '. Buried them instead.');
        s.text = hero.name + ' — ' + env.line + ' Turns the first body over — and cannot finish the order. Ends up moving stones onto them instead, muttering the words. The party stands in the cold and lets it happen.';
        return;
      }
      if (opt.id === 'loot') {
        g = ri(40, 90);
        s.effects.gold = g;
        addLoy(s, hero.id, -8);
        for (var i = 0; i < rest.length; i++) addLoy(s, rest[i].id, -3);
        addMem(s, hero, env.floor, 'Searched four dead rivals on floor ' + env.floor + '. Their boots were better than ours.');
        s.text = hero.name + ' — ' + env.line + ' Searches with a professional\'s patience: ' + g + ' gold, a boot knife, and no answers.';
      } else {
        g = ri(5, 15);
        s.effects.gold = g;
        addLoy(s, hero.id, 6);
        addFear(s, hero.id, -6);
        for (var j = 0; j < rest.length; j++) addFear(s, rest[j].id, -6);
        addMem(s, hero, env.floor, 'Buried another Master\'s party on floor ' + env.floor + '. Said the words.');
        s.text = hero.name + ' — ' + env.line + ' It takes time they don\'t have. ' + hero.name + ' says the words over strangers while the party holds torches and shivers. Their leader\'s ring comes loose in the digging — ' + g + ' gold. It feels owed, and it is.';
      }
    },

    fork: function (s, ev, opt, hero, v, env) {
      var g, rest;
      rest = others(env.party, hero.id);
      if (opt.id === 'shortcut') {
        if (v === 'refuse') {
          // nobody crawls into the gap on an order — the long way it is
          addFear(s, hero.id, 8);
          for (var r = 0; r < rest.length; r++) addFear(s, rest[r].id, 8);
          s.text = hero.name + ' — ' + env.line + ' Nobody will crawl into that gap on an order. The long stair, then — hours of it.';
          return;
        }
        if (Math.random() < 0.55) {
          s.effects.combat = { enemies: mkAmbush(env.floor), kind: 'event' };
          s.text = hero.name + ' — ' + env.line + ' Halfway into the gap, the dark decides it is hungry too. Something is already coming up the other end.';
        } else {
          g = ri(5, 20);
          s.effects.gold = g;
          s.text = hero.name + ' — ' + env.line + ' The gap fits a body, barely. ' + hero.name + ' goes through and comes back holding someone\'s dropped satchel — ' + g + ' gold. It was fine. It was fine.';
        }
        return;
      }
      // opt.id === 'long'
      if (v === 'refuse') { refuseDefault(s, hero, env, 'The fork waits a moment longer. The party moves on.'); return; }
      for (var i = 0; i < rest.length; i++) addFear(s, rest[i].id, 10);
      addFear(s, hero.id, 10);
      s.text = hero.name + ' — ' + env.line + ' Hours of stair in the dark, and the dark whispers the whole climb. Everyone arrives. Nobody talks about it.';
    },

    well: function (s, ev, opt, hero, v, env) {
      var dmg, rest;
      rest = others(env.party, hero.id);
      if (opt.id === 'drink') {
        if (v === 'refuse') {
          refuseDefault(s, hero, env, 'The well keeps whispering. The party keeps walking.');
          return;
        }
        if (Math.random() < 0.65) {
          healParty([hero], 1);
          addFear(s, hero.id, -15);
          addMem(s, hero, env.floor, 'Drank from the whispering well on floor ' + env.floor + '. It gave back peace.');
          s.text = hero.name + ' — ' + env.line + ' The water is cold and clean and tastes like sleep. ' + hero.name + '\'s wounds close to nothing while the whispering below turns to something like humming.';
        } else {
          dmg = ri(10, 18);
          addDmg(s, hero.id, dmg);
          addFear(s, hero.id, 12);
          for (var i = 0; i < rest.length; i++) addFear(s, rest[i].id, 4);
          addMem(s, hero, env.floor, 'The well drank back on floor ' + env.floor + '. It knows our names.');
          s.text = hero.name + ' — ' + env.line + ' Hands on the rim, leaning in — and the water moves first. ' + dmg + ' HP gone before anyone can grab a hood. The whispering knows the whole party\'s names now.';
        }
        return;
      }
      // opt.id === 'leave'
      if (v === 'refuse') { refuseDefault(s, hero, env, 'They stand at the rim a moment longer. The water waits.'); return; }
      s.text = hero.name + ' — ' + env.line + ' They walk on. The voice below keeps saying their names, fainter and fainter, until it finds a new one.';
    },

    merchant: function (s, ev, opt, hero, v, env) {
      var rest;
      if (v === 'refuse') {
        refuseDefault(s, hero, env, 'He shrugs — already looking past the party, at the next customer the Tower will send. Then the landing is empty, crate and all.');
        return;
      }
      rest = others(env.party, hero.id);
      s.effects.gold = -60;
      healParty(env.party, 1);
      addLoy(s, hero.id, 4);
      for (var i = 0; i < rest.length; i++) addLoy(s, rest[i].id, 2);
      s.text = hero.name + ' — ' + env.line + ' Coins change hands. The salves are real, the linen is clean, and every wound in the party closes to nothing. When anyone looks up, the landing is empty.';
    },

    tablet: function (s, ev, opt, hero, v, env) {
      if (v === 'refuse') {
        refuseDefault(s, hero, env, 'The stone keeps its map. The party keeps its ignorance.');
        return;
      }
      s.effects.reveal = true; // flow scouts every node on this floor
      addFear(s, hero.id, 5);
      addMem(s, hero, env.floor, 'Read the black stone on floor ' + env.floor + '. The floor\'s paths laid bare — the last line left unspoken.');
      s.text = hero.name + ' — ' + env.line + ' Reads until their eyes water, lips moving over dead grammar. The shape of the whole floor settles into place — every room, every path, every tooth (the map is revealed). The last line is a warning ' + hero.name + ' chooses not to translate aloud.';
    },

    /* ---- V0.9.3 content handlers ---- */
    toll: function (s, ev, opt, hero, v, env) {
      var i, rest;
      if (v === 'refuse') { refuseDefault(s, hero, env, 'The ledger closes. The knife does not move. The party takes the long way.'); return; }
      if (opt.id === 'pay') {
        s.effects.gold = -80;
        addLoy(s, hero.id, 3);
        rest = others(env.party, hero.id);
        for (i = 0; i < rest.length; i++) addFear(s, rest[i].id, -4);
        addMem(s, hero, env.floor, 'Paid the Toll Keeper\'s price on floor ' + env.floor + '. Eighty gold, and everyone crossed alive.');
        s.text = hero.name + ' — ' + env.line + ' Coins into the hood, no receipt. The rope bridge holds all the way across, which is more than the Tower usually promises.';
        return;
      }
      if (opt.id === 'refuse') {
        if (hero.courage >= 60) {
          addFear(s, hero.id, -6);
          addMem(s, hero, env.floor, 'Met the Toll Keeper\'s stare on floor ' + env.floor + '. It blinked first.');
          s.text = hero.name + ' — ' + env.line + ' Says nothing. Just stands there, looking. The hood tilts, recalculates, and the knife goes back wherever it lives. "The Tower likes you," it says, and steps aside.';
        } else {
          s.text = hero.name + ' — ' + env.line + ' The stare falters — and the ledger snaps shut like a mouth. Whatever keeps the toll keeps the bridge too. It comes out from under the hood.';
          s.effects.combat = { enemies: mkAmbush(env.floor), kind: 'event' };
        }
        return;
      }
      // sneak
      if (hero.fear <= 40) {
        var g = ri(30, 70);
        s.effects.gold = g;
        addMem(s, hero, env.floor, 'Crossed under the Toll Keeper\'s bridge on floor ' + env.floor + '. Its purse came too.');
        s.text = hero.name + ' — ' + env.line + ' Down the ravine side, along the rope, hand over hand above nothing. The hood never turns. On the far side, its purse is lighter by ' + g + ' gold — the toll, collected in reverse.';
      } else {
        addDmg(s, hero.id, ri(15, 30));
        addFear(s, hero.id, 10);
        s.text = hero.name + ' — ' + env.line + ' Halfway under the bridge, the ropes start moving like plucked strings. The drop is long enough to think several things. ' + hero.name + ' comes up bleeding, on the wrong side, with company.';
        s.effects.combat = { enemies: mkAmbush(env.floor), kind: 'event' };
      }
    },

    mirror: function (s, ev, opt, hero, v, env) {
      if (v === 'refuse') { refuseDefault(s, hero, env, 'The pool keeps its face. The party keeps theirs.'); return; }
      if (opt.id === 'look') {
        if (hero.fear <= 40) {
          addFear(s, hero.id, -10);
          addLoy(s, hero.id, 3);
          addMem(s, hero, env.floor, 'Met their own eyes in the Still Pool on floor ' + env.floor + ' — and did not look away.');
          s.text = hero.name + ' — ' + env.line + ' Kneels at the rim and looks. The face in the water is older, calmer, wearing the same scars plus a few not earned yet. It nods, once, like a promise. The water lets go, and so does something in ' + hero.name + '\'s shoulders.';
        } else {
          addFear(s, hero.id, 10);
          addLoy(s, hero.id, -4);
          addMem(s, hero, env.floor, 'The Still Pool on floor ' + env.floor + ' showed them a version that flinched.');
          s.text = hero.name + ' — ' + env.line + ' Kneels at the rim — and the face in the water flinches first. It wears ' + hero.name + '\'s face doing everything ' + hero.name + ' is afraid of. The basin will not hold a reflection after that. Neither will the party\'s trust in the dark.';
        }
        return;
      }
      // smash
      if (Math.random() < 0.3) {
        s.text = hero.name + ' — ' + env.line + ' A fist through the reflection. The water takes it personally — the whole basin heaves, and what stands up out of it is wearing the shattered face like a mask.';
        s.effects.combat = { enemies: [mkMimic(env.floor)], kind: 'event' };
      } else {
        var g = ri(20, 60);
        s.effects.gold = g;
        addFear(s, hero.id, 5);
        s.text = hero.name + ' — ' + env.line + ' Strikes once. The reflection comes apart into rings, and keeps coming apart until the basin is just water. In the grit at the bottom: an old ring, gold enough to matter (' + g + ' gold). The air behind the party feels like a held breath, released.';
      }
    },

    oath: function (s, ev, opt, hero, v, env) {
      var rest, i;
      if (v === 'refuse') { refuseDefault(s, hero, env, 'The gauntlet stays up a while after the party is gone.'); return; }
      rest = others(env.party, hero.id);
      if (opt.id === 'swear') {
        addLoy(s, hero.id, 12);
        for (i = 0; i < rest.length; i++) addFear(s, rest[i].id, -8);
        addFear(s, hero.id, -8);
        addMem(s, hero, env.floor, 'Held a dying knight\'s oath on floor ' + env.floor + '. It is theirs to carry now.');
        s.text = hero.name + ' — ' + env.line + ' Takes the gauntlet. The words are older than the Tower and ' + hero.name + ' says them like they cost something, because they do. The visor tilts — approving, or done — and the wall holds him up a little longer than it needs to. The party walks steadier after that.';
      } else {
        for (i = 0; i < rest.length; i++) addFear(s, rest[i].id, -3);
        addMem(s, hero, env.floor, 'Closed a stranger\'s eyes on floor ' + env.floor + '. The Tower noted it, or they did.');
        s.text = hero.name + ' — ' + env.line + ' Two fingers, a moment, done properly. The gauntlet settles on the stone by itself. No one swears anything, but no one pretends it was nothing either.';
      }
    },

    /* ---- V0.14 TEMPTATION handlers ---- */
    altar: function (s, ev, opt, hero, v, env) {
      var rest, i;
      if (v === 'refuse') { refuseDefault(s, hero, env, 'The bowl keeps waiting. It has practice.'); return; }
      if (opt.id === 'pact') {
        var lvl = ((hero.pact && hero.pact.lvl) || 0) + 1;
        if (lvl > 3) {
          s.text = hero.name + ' — ' + env.line + ' The altar does not answer a third time. Whatever they sold is already sold.';
          return;
        }
        hero.pact = { lvl: lvl, floor: env.floor };
        addLoy(s, hero.id, -20);
        addFear(s, hero.id, 10);
        hero.greed = Math.min(100, (hero.greed || 0) + 10);   /* live ref — they liked it */
        addMem(s, hero, env.floor, 'Spoke the words at the Black Altar on floor ' + env.floor + '. Pact ' + lvl + '. Something old said "agreed."');
        rest = others(env.party, hero.id);
        for (i = 0; i < rest.length; i++) addFear(s, rest[i].id, 6);
        s.text = hero.name + ' — ' + env.line + ' Kneels. Speaks. The bowl is dry and still something drinks. ' + hero.name +
          ' stands up wrong for a heartbeat — then righter than before. Their grip finds new weight. Their eyes find yours last. (PACT ' + lvl +
          ': +20% damage, +10% HP each battle. Every battle costs blood now. If they fall, the Tower keeps everything — there will be nothing to bury.)';
      } else {
        var g = ri(40, 80);
        s.effects.gold = g;
        addLoy(s, hero.id, 5);
        rest = others(env.party, hero.id);
        for (i = 0; i < rest.length; i++) addLoy(s, rest[i].id, 3);
        addMem(s, hero, env.floor, 'Smashed the Black Altar on floor ' + env.floor + '. The idol\'s gold was real. So was the screaming.');
        s.text = hero.name + ' — ' + env.line + ' Brings the hammer down before anyone can speak. The slab cracks with a sound like a held breath let go — and the room is only a room again. Gold in the rubble (' + g + 'g). Somewhere far below, something that had been listening stops.';
      }
    },

    brand: function (s, ev, opt, hero, v, env) {
      var rest, i;
      if (v === 'refuse') { refuseDefault(s, hero, env, 'The seal keeps turning. It is patient the way stone is patient.'); return; }
      if (opt.id === 'take') {
        hero.branded = true;
        hero.atk = Math.round((hero.atk || 0) + 8);
        addLoy(s, hero.id, 5);
        addMem(s, hero, env.floor, 'Took the Iron Brand on floor ' + env.floor + '. They hit harder now. They also do not leave rooms.');
        rest = others(env.party, hero.id);
        for (i = 0; i < rest.length; i++) addFear(s, rest[i].id, 4);
        s.text = hero.name + ' — ' + env.line + ' Takes the seal out of the fire bare-handed and holds it to their own throat until it stops hissing. When their eyes open they are the same eyes and something behind them has finished an argument. (+8 ATK. ' + hero.name + ' will never comply with a retreat order again — choose their fights with that in mind.)';
      } else {
        rest = others(env.party, hero.id);
        for (i = 0; i < rest.length; i++) addFear(s, rest[i].id, -3);
        s.text = hero.name + ' — ' + env.line + ' Nobody reaches for it. The seal turns a while longer, then drops into the coals, and the party walks past the light it gives off like it isn\'t there. Which, carefully, it isn\'t.';
      }
    },

    /* v0.4 — no verdict path (these are arrangements, not orders): the pair /
       griever travel in env.campPair / env.campGriever, set by the run() flow. */
    campfire: function (s, ev, opt, hero, v, env) {
      var IT = window.IT, a, b, g, old;
      if (opt.id === 'together') {
        a = (env.campPair || [])[0];
        b = (env.campPair || [])[1];
        if (a && b) {
          addBondD(s, a.id, b.id, 8);   // +8 both, applied by the flow via IT.addBond
          old = 0;
          if (IT && typeof IT.bond === 'function') {
            try { old = IT.bond(a.id, b.id) || 0; } catch (e) { old = 0; }
          }
          if (old < 60 && old + 8 >= 60) {
            addMem(s, a, env.floor, a.name + ' and ' + b.name + ' — something like friends now.');
            addMem(s, b, env.floor, a.name + ' and ' + b.name + ' — something like friends now.');
          }
          s.text = 'Two logs are set side by side, and nobody explains why. ' + a.name + ' and ' + b.name +
            ' end up shoulder to shoulder, arguing quietly about nothing at all. When the fire needs feeding, neither of them moves apart. (+8 bond' +
            (old < 60 && old + 8 >= 60 ? ' — something like friends now)' : ')');
        } else {
          s.text = 'The fire burns low. Two stools stay empty. The party moves on.';
        }
        return;
      }
      if (opt.id === 'grieve') {
        g = env.campGriever || hero;
        if (g) {
          addFear(s, g.id, -10);
          g.grieving = 0;   // cleared immediately — grief cannot ride into the next battle
          if (IT && typeof IT.save === 'function') { try { IT.save(); } catch (e) { /* best effort */ } }
          addMem(s, g, env.floor, 'They spoke of the dead until the fire died.');
          s.text = g.name + ' speaks of the dead — names, habits, a debt unpaid — while the fire burns down to embers. By the last of the light, their shoulders have come down from around their ears. (fear -10, grief released)';
        } else {
          s.text = 'The fire burns low. Nobody has anything to say after all.';
        }
        return;
      }
      // opt.id === 'silence'
      s.text = 'They eat. The fire cracks and spits. Nobody talks, and for once nobody has to. It helps more than it should.';
    }
  };

  /* Fear-gate and other verdict overrides, applied BEFORE the beat is shown. */
  function overrideVerdict(ev, opt, hero, d) {
    if (ev.id === 'well' && opt.id === 'drink' && hero.fear > 60) {
      return { verdict: 'refuse', line: '"The water is saying my name. No."', score: d.score };
    }
    return d;
  }

  /* ============================ RESOLVE ============================ */
  /* Pure-ish decision core: no DOM, safe headless. Writes memories through
   * IT.addMemory when present; everything else is reported, not applied. */

  function resolve(ev, opt, hero, verdict, line, env) {
    env = env || {};
    env.line = line || '';
    env.floor = env.floor || 1;
    env.party = env.party || [hero];
    var s = mkSummary('');
    var h = HANDLERS[ev && ev.id];
    if (h) h(s, ev, opt || {}, hero, verdict, env);
    else refuseDefault(s, hero, env);

    var IT = window.IT;
    if (IT && typeof IT.addMemory === 'function') {
      var mem = s.effects.memory, targets = [hero].concat(env.party), t;
      Object.keys(mem).forEach(function (k) {
        t = null;
        for (var i = 0; i < targets.length; i++) if (targets[i] && String(targets[i].id) === k) t = targets[i];
        if (t) IT.addMemory(t, mem[k].floor, mem[k].text);
      });
    }
    return s;
  }

  /* ============================ v0.4 EVENT PICK (campfire weighting) ============================ */
  /* 25% chance to be the event when any party member is grieving or a bond pair
     >= 60 exists; 10% otherwise. All bond reads guarded for older cores. */
  function pickEvent(party) {
    var IT = window.IT;
    var camps = POOL.filter(function (e) { return e.campfire; });
    var rest = POOL.filter(function (e) { return !e.campfire; });
    var prefer = false, i, j;
    if (party && party.length) {
      prefer = party.some(function (h) { return h && typeof h.grieving === 'number' && h.grieving > 0; });
      if (!prefer && IT && typeof IT.bond === 'function') {
        outer:
        for (i = 0; i < party.length; i++) {
          for (j = i + 1; j < party.length; j++) {
            try {
              if ((IT.bond(party[i].id, party[j].id) || 0) >= 60) { prefer = true; break outer; }
            } catch (e) { /* core guard */ }
          }
        }
      }
    }
    if (camps.length && Math.random() < (prefer ? 0.25 : 0.10)) return camps[0];
    return pick(rest);
  }

  /* ============================ DOM ============================ */

  var STYLE_ID = 'it-ev-style';
  var CSS = [
    '.ev-wrap{display:flex;flex-direction:column;gap:12px;}',    '.ev-card{background:#141822;border:1px solid #262d3d;border-radius:12px;padding:16px 16px 18px;}',
    '.ev-kicker{font-size:11px;letter-spacing:2.5px;text-transform:uppercase;color:#8b94a7;}',
    '.ev-title{font-family:Cinzel,Georgia,serif;font-weight:600;font-size:20px;color:#e8b04b;margin:6px 0 10px;letter-spacing:.5px;}',
    '.ev-text{color:#d7dce6;font-size:15px;line-height:1.65;margin:0 0 14px;}',
    '.ev-opts{display:flex;flex-direction:column;gap:10px;}',
    '.ev-opt{display:block;width:100%;min-height:48px;text-align:left;background:#1b2130;color:#d7dce6;',
    'border:1px solid #262d3d;border-radius:10px;padding:12px 14px;font:inherit;font-size:15px;cursor:pointer;',
    '-webkit-tap-highlight-color:transparent;transition:border-color .12s,transform .06s;}',
    '.ev-opt .ev-sub{display:block;font-size:12px;color:#8b94a7;margin-top:3px;}',
    '.ev-opt:active{transform:scale(.985);border-color:#8b94a7;}',
    '.ev-opt:focus-visible{outline:2px solid #e8b04b;outline-offset:2px;}',
    '.ev-opt[disabled]{opacity:.4;cursor:not-allowed;}',
    '.ev-picks{display:flex;flex-direction:column;gap:10px;}',
    '.ev-hero{display:block;width:100%;min-height:58px;text-align:left;background:#1b2130;color:#d7dce6;',
    'border:1px solid #262d3d;border-left:3px solid #8b94a7;border-radius:10px;padding:10px 14px;font:inherit;cursor:pointer;',
    '-webkit-tap-highlight-color:transparent;}',
    '.ev-hero:active{transform:scale(.985);border-color:#8b94a7;}',
    '.ev-hero .ev-hname{font-weight:700;font-size:15px;}',
    '.ev-hero .ev-hname .ev-hcls{color:#8b94a7;font-weight:400;font-size:12.5px;}',
    '.ev-hero .ev-haxes{display:block;font-size:12px;color:#8b94a7;margin-top:2px;}',
    '.ev-hero .ev-hsub{display:block;font-size:11px;color:#8b94a7;opacity:.85;margin-top:1px;}',
    '.ev-beatcard{text-align:center;padding:36px 16px;}',
    '.ev-verdict{font-family:Georgia,serif;font-size:22px;line-height:1.45;animation:evfade .35s ease-out;}',
    '.ev-vname{margin-top:14px;color:#8b94a7;font-size:12px;letter-spacing:2px;text-transform:uppercase;}',
    '.ev-v-comply{color:#5fbf77;}',
    '.ev-v-grudging{color:#8b94a7;}',
    '.ev-v-refuse{color:#e05263;}',
    '.ev-v-alt{color:#e8b04b;}',
    '.ev-back{display:block;width:100%;min-height:44px;margin-top:12px;background:none;border:none;',
    'color:#8b94a7;font:inherit;font-size:13.5px;cursor:pointer;}',
    '.ev-outcard{border-color:#e8b04b;}',
    '.ev-outtext{color:#d7dce6;font-size:14.5px;margin:10px 0 4px;line-height:1.5;}',
    '.ev-outtext.dim,.dim{color:#8b94a7;}',
    '.ev-outlist{list-style:none;margin:8px 0 4px;padding:0;display:flex;flex-direction:column;gap:5px;}',
    '.ev-outlist li{font-size:13.5px;color:#d7dce6;background:#1b2130;border:1px solid #262d3d;',
    'border-radius:6px;padding:6px 10px;}',
    '.ev-outlist .ev-hurt{color:#e05263;}',
    '.ev-continue{display:block;width:100%;min-height:46px;margin-top:14px;background:#1b2130;',
    'color:#e8b04b;border:1px solid #e8b04b;border-radius:10px;font:inherit;font-size:15px;',
    'font-weight:600;cursor:pointer;}',
    '@keyframes evfade{from{opacity:0;transform:translateY(6px);}}',
    '@media(prefers-reduced-motion:reduce){.ev-verdict{animation:none;}}',
    ''
  ].join('\n');

  function injectStyle() {
    if (document.getElementById(STYLE_ID)) return;
    var st = document.createElement('style');
    st.id = STYLE_ID;
    st.textContent = CSS;
    (document.head || document.documentElement).appendChild(st);
  }

  /* run(node, containerEl, done) — full browser flow. Owns containerEl. */
  function run(node, containerEl, done) {
    if (typeof document === 'undefined' || !containerEl) return;
    if (typeof done !== 'function') done = function () {};
    injectStyle();

    var IT = window.IT;
    var S = IT && IT.S;
    var floor = (S && S.expedition && S.expedition.floor) || (node && node.floor) || 1;
    var roster = (S && S.heroes) || [];
    var party = ((S && S.party) || []).map(function (id) {
      for (var i = 0; i < roster.length; i++) if (roster[i].id === id) return roster[i];
      return null;
    }).filter(function (h) { return h && h.hp > 0; });

    if (!party.length) {
      done(mkSummary('The room waits. The party has no one to send in.'));
      return;
    }

    var ev = pickEvent(party);
    var env = {
      floor: floor,
      party: party,
      flags: { mimic: ev.id === 'chest' && Math.random() < 0.25 } // 25% mimic
    };

    function hasGrievers() {
      return party.some(function (h) { return typeof h.grieving === 'number' && h.grieving > 0; });
    }

    function optionsFor(e) {
      var hasRogue = party.some(function (h) { return h.cls === 'Rogue'; });
      return e.options.filter(function (o) {
        if (o.rogueOnly && !hasRogue) return false;
        if (o.grievingOnly && !hasGrievers()) return false;
        if (o.needsPair && party.length < 2) return false;
        return true;
      });
    }

    function renderOptions() {
      /* V0.10: costs may be paid from carried (unbanked) or secured gold too */
      var gold = (S && S.gold) || 0;
      if (S && S.expedition) {
        gold += (S.expedition.tally && S.expedition.tally.gold) || 0;
        gold += (S.expedition.bank && S.expedition.bank.gold) || 0;
      }
      var html = '<div class="ev-wrap"><div class="ev-card">' +
        '<div class="ev-kicker">Floor ' + floor + (ev.campfire ? ' · A moment\'s rest' : ' · Something waits') + '</div>' +
        '<h3 class="ev-title">' + esc(ev.title) + '</h3>' +
        '<p class="ev-text">' + esc(ev.text) + '</p>' +
        '<div class="ev-opts">';
      optionsFor(ev).forEach(function (o) {
        var short = o.cost && gold < o.cost;
        var sub = '';
        if (o.cost) sub = o.cost + ' gold' + (short ? ' — you are short' : '');
        else if (o.rogueOnly) sub = 'Rogue instinct';
        else if (o.sub) sub = o.sub;
        html += '<button type="button" class="ev-opt" data-opt="' + o.id + '"' + (short ? ' disabled' : '') + '>' +
          esc(o.label) + (sub ? '<span class="ev-sub">' + esc(sub) + '</span>' : '') + '</button>';
      });
      html += '</div></div></div>';
      containerEl.innerHTML = html;
      Array.prototype.forEach.call(containerEl.querySelectorAll('.ev-opt'), function (btn) {
        btn.addEventListener('click', function () {
          var id = btn.getAttribute('data-opt'), o = null;
          ev.options.forEach(function (x) { if (x.id === id) o = x; });
          if (!o) return;
          if (o.needsPair) renderPairFirst(o);
          else if (o.grievingOnly) renderGrievePick(o);
          else if (o.needsHero) renderPick(o);
          else campfireBeat(o, 'The fire cracks. Nobody talks. Nobody has to.', '');
        });
      });
    }

    function renderPick(opt) {
      var html = '<div class="ev-wrap"><div class="ev-card">' +
        '<div class="ev-kicker">Send who?</div>' +
        '<h3 class="ev-title">' + esc(opt.label) + '</h3>' +
        '<div class="ev-picks">';
      party.forEach(function (h) {
        var C = IT && IT.DATA && IT.DATA.CLASSES[h.cls];
        var icon = (C && C.icon) || '·';
        var col = CLASS_COLORS[h.cls] || '#8b94a7';
        html += '<button type="button" class="ev-hero" data-id="' + h.id + '" style="border-left-color:' + col + '">' +
          '<span class="ev-hname">' + icon + ' ' + esc(h.name) + ' <span class="ev-hcls">Lv.' + h.lvl + ' ' + esc(h.cls) + '</span></span>' +
          '<span class="ev-haxes">Courage ' + h.courage + ' · Greed ' + h.greed + ' · Loyalty ' + h.loyalty + ' · Fear ' + h.fear + '</span>' +
          '<span class="ev-hsub">' + esc(h.personality || '') + ' · HP ' + Math.max(0, Math.round(h.hp)) + '/' + h.maxHp + '</span>' +
          '</button>';
      });
      html += '</div><button type="button" class="ev-back">← Choose differently</button></div></div>';
      containerEl.innerHTML = html;
      Array.prototype.forEach.call(containerEl.querySelectorAll('.ev-hero'), function (btn) {
        btn.addEventListener('click', function () {
          var id = Number(btn.getAttribute('data-id')), hero = null;
          party.forEach(function (h) { if (h.id === id) hero = h; });
          if (hero) send(opt, hero);
        });
      });
      var back = containerEl.querySelector('.ev-back');
      if (back) back.addEventListener('click', renderOptions);
    }

    /* ---- v0.4 campfire flow: pair / griever pickers, no hero decision ---- */
    function heroListHtml(kicker, title, list, backLabel) {
      var html = '<div class="ev-wrap"><div class="ev-card">' +
        '<div class="ev-kicker">' + esc(kicker) + '</div>' +
        '<h3 class="ev-title">' + esc(title) + '</h3>' +
        '<div class="ev-picks">';
      list.forEach(function (h) {
        var C = IT && IT.DATA && IT.DATA.CLASSES[h.cls];
        var icon = (C && C.icon) || '·';
        var col = CLASS_COLORS[h.cls] || '#8b94a7';
        html += '<button type="button" class="ev-hero" data-id="' + h.id + '" style="border-left-color:' + col + '">' +
          '<span class="ev-hname">' + icon + ' ' + esc(h.name) + ' <span class="ev-hcls">Lv.' + h.lvl + ' ' + esc(h.cls) + '</span></span>' +
          '<span class="ev-haxes">Courage ' + h.courage + ' · Greed ' + h.greed + ' · Loyalty ' + h.loyalty + ' · Fear ' + h.fear + '</span>' +
          '<span class="ev-hsub">' + esc(h.personality || '') + ' · HP ' + Math.max(0, Math.round(h.hp)) + '/' + h.maxHp + '</span>' +
          '</button>';
      });
      html += '</div>' + (backLabel ? '<button type="button" class="ev-back">← ' + esc(backLabel) + '</button>' : '') +
        '</div></div>';
      return html;
    }

    function wireHeroPicks(list, cb) {
      Array.prototype.forEach.call(containerEl.querySelectorAll('.ev-hero'), function (btn) {
        btn.addEventListener('click', function () {
          var id = Number(btn.getAttribute('data-id')), hero = null;
          list.forEach(function (h) { if (h.id === id) hero = h; });
          if (hero) cb(hero);
        });
      });
    }

    function renderPairFirst(o) {
      containerEl.innerHTML = heroListHtml('Who by the fire?', o.label, party, 'Choose differently');
      wireHeroPicks(party, function (a) { renderPairSecond(o, a); });
      var back = containerEl.querySelector('.ev-back');
      if (back) back.addEventListener('click', renderOptions);
    }

    function renderPairSecond(o, a) {
      var rest = party.filter(function (h) { return h.id !== a.id; });
      containerEl.innerHTML = heroListHtml(a.name + ' — and who beside them?', o.label, rest, 'Choose differently');
      wireHeroPicks(rest, function (b) {
        env.campPair = [a, b];
        campfireBeat(o, 'Neither says anything important. Something eases anyway.', a.name + ' & ' + b.name);
      });
      var back = containerEl.querySelector('.ev-back');
      if (back) back.addEventListener('click', function () { renderPairFirst(o); });
    }

    function renderGrievePick(o) {
      var gri = party.filter(function (h) { return typeof h.grieving === 'number' && h.grieving > 0; });
      containerEl.innerHTML = heroListHtml('Who carries the dead?', o.label, gri, 'Choose differently');
      wireHeroPicks(gri, function (g) {
        env.campGriever = g;
        campfireBeat(o, '"Say their names. All of them."', g.name);
      });
      var back = containerEl.querySelector('.ev-back');
      if (back) back.addEventListener('click', renderOptions);
    }

    /* campfire resolves like any event — same beat pacing, no verdict card */
    function campfireBeat(o, line, who) {
      containerEl.innerHTML = '<div class="ev-wrap"><div class="ev-card ev-beatcard">' +
        '<div class="ev-verdict ev-v-alt">' + esc(line) + '</div>' +
        (who ? '<div class="ev-vname">— ' + esc(who) + '</div>' : '') +
        '</div></div>';
      setTimeout(function () {
        showOutcome(resolve(ev, o, null, 'comply', '', env));
      }, 900);
    }

    function send(opt, hero) {
      var d = (IT && typeof IT.decide === 'function')
        ? IT.decide(hero, opt.action, opt.alt ? { alt: true } : {})
        : { verdict: 'comply', line: '"Fine."', score: 50 };
      d = overrideVerdict(ev, opt, hero, d);
      renderBeat(opt, hero, d);
    }

    function renderBeat(opt, hero, d) {
      containerEl.innerHTML = '<div class="ev-wrap"><div class="ev-card ev-beatcard">' +
        '<div class="ev-verdict ev-v-' + esc(d.verdict) + '">' + esc(d.line) + '</div>' +
        '<div class="ev-vname">— ' + esc(hero.name) + '</div>' +
        '</div></div>';
      setTimeout(function () {
        showOutcome(resolve(ev, opt, hero, d.verdict, d.line, env));
      }, 900); // dramatic beat, then the outcome
    }

    /* v0.7.1 fix: outcomes were applied invisibly (fear/loyalty/gold/memory) and
       the screen jumped straight back to the map — events felt like no-ops.
       Show the player exactly what changed, then Continue. */
    function showOutcome(summary) {
      summary = summary || {};
      var eff = summary.effects || {};
      var nameOf = function (id) {
        for (var i = 0; i < roster.length; i++) if (roster[i].id === Number(id)) return roster[i].name;
        return 'someone';
      };
      var lines = [];
      if (eff.gold) lines.push('<li>' + (eff.gold > 0 ? '💰 +' : '💰 −') + Math.abs(eff.gold) + ' gold</li>');
      if (eff.permits) lines.push('<li>🎟️ +' + eff.permits + ' permit' + (eff.permits > 1 ? 's' : '') + '</li>');
      var fearMap = eff.fearD || eff.fear || null, loyMap = eff.loyaltyD || eff.loyalty || null;
      if (fearMap) for (var f in fearMap) lines.push('<li>' + esc(nameOf(f)) + ' — fear ' + (fearMap[f] > 0 ? '+' : '−') + Math.abs(fearMap[f]) + '</li>');
      if (loyMap) for (var l in loyMap) lines.push('<li>' + esc(nameOf(l)) + ' — loyalty ' + (loyMap[l] > 0 ? '+' : '−') + Math.abs(loyMap[l]) + '</li>');
      if (eff.hpDmg) for (var h in eff.hpDmg) lines.push('<li>' + esc(nameOf(h)) + ' — <b class="ev-hurt">' + eff.hpDmg[h] + ' HP lost</b></li>');
      if (eff.bondΔ) for (var b in eff.bondΔ) {
        var parts = String(b).split('|');
        lines.push('<li>' + esc(nameOf(parts[0])) + ' & ' + esc(nameOf(parts[1])) + (eff.bondΔ[b] >= 0 ? ' — closer</li>' : ' — strained</li>'));
      }
      if (eff.memory) for (var m in eff.memory) lines.push('<li>' + esc(nameOf(m)) + ' will remember this</li>');
      if (eff.reveal) lines.push('<li>🗺️ The floor\'s layout is revealed</li>');
      var combat = eff.combat;
      if (combat) lines.push('<li>⚔️ Something stirs —</li>');
      var body = (summary.text ? '<div class="ev-outtext">' + esc(summary.text) + '</div>' : '');
      body += (lines.length ? '<ul class="ev-outlist">' + lines.join('') + '</ul>' : '<div class="ev-outtext dim">Nothing changes. The Tower does not always answer.</div>');
      containerEl.innerHTML = '<div class="ev-wrap"><div class="ev-card ev-outcard">' +
        '<div class="ev-kicker">THE RESULT</div>' + body +
        '<button type="button" class="ev-continue">Continue</button></div></div>';
      var go = function () { containerEl.innerHTML = ''; done(summary); };
      var btn = containerEl.querySelector('.ev-continue');
      if (btn) btn.addEventListener('click', go);
      if (combat) setTimeout(go, 1100); // combat events march on without a click
    }

    renderOptions();
  }

  /* ============================ EXPORT ============================ */

  E.pool = POOL;
  E.run = run;
  E.resolve = resolve; // exported for headless verification / reuse
  E.pickEvent = pickEvent; // v0.4: exported for headless verification of the campfire weighting

})(window.IT.events);
