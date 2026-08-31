/* ============================================================
   INFINITE TOWER v0.3 — js/ui.js (AGENT-E; v0.4 AGENT-H; v0.5 AGENT-H2)
   UI shell + game flow: wires core / map / events / combat.
   Every cross-module call is guarded (siblings may be mid-write):
   a missing module fails LOUDLY via console.error + toast.
   V0.5 "The Deep Tower": floors 11-20 w/ rule labels + MASTER locks,
   lobby MASTER panel, master exp on clear, battle rule chip,
   Hollow King analysis, core cost/cap APIs w/ fallbacks.
   V0.6 "Skills" (AGENT-H3): hero kit + reaction rows on the profile
   (IT.SKILLS / IT.DATA.REACTIONS, hidden gracefully pre-F3), master
   command rail PROTECT/OVERDRIVE/SACRIFICE above combat's own footer
   bar — only as a fallback when combat does NOT own the buttons
   (G3's combat renders them itself once it exposes useCommand);
   disabled w/ note while no command API exists, Executioner analysis
   note (Bulwark vs the axe), skills-used line on results
   (IT.combat.lastUsage).
   V0.7 "Full Roster" (AGENT-H4): TRAIT row on the profile (IT.TRAITS /
   hero.trait — derivation-free, hidden when absent), Warrior/Rogue kits
   render automatically now that core ships them (the "kit to come"
   placeholder shows only for genuinely kit-less heroes: skills = the
   shared swing only), light telemetry hooks at the flow points
   (run_started / second_run / scout_used / floor_cleared / run_ended —
   all guarded via IT.track), header version bumped to v0.7 from here
   (index.html is not ui's to edit).
   V0.8 "game feel" (AGENT-FEEL-A): presentation-only pass — stone &
   candle art direction on the lobby / hero / tower / memorial screens.
   UI.go() now breathes each screen in via .beat-in (0ms under
   prefers-reduced-motion, fully DOM-guarded so headless runs are
   unchanged). heroSpriteHtml() is the shared .hero-sprite figure
   system (exposed as IT.ui.heroSprite for FEEL-B/FEEL-C). No flow,
   ids or mechanics changed: every button id and wiring below keeps
   its v0.7 contract.
   ============================================================ */
window.IT = window.IT || {};
(function(){
'use strict';

/* ======================= local fallbacks ======================= */
/* Display-only metadata so rendering never crashes if core is mid-write. */
var CLS_META = {
  Warrior:{icon:'⚔️',col:'var(--cWarrior)',desc:'Power Strike: 30% chance for 180% dmg.'},
  Tank:{icon:'🛡️',col:'var(--cTank)',desc:'Draws fire. 30% chance to intercept a hit for an ally.'},
  Rogue:{icon:'🗡️',col:'var(--cRogue)',desc:'Targets the weakest foe. 25% crit for 170%.'},
  Mage:{icon:'🔮',col:'var(--cMage)',desc:'Fireball: 40% chance to hit ALL enemies for 65%.'},
  Healer:{icon:'✨',col:'var(--cHealer)',desc:'Heals the most wounded ally each turn.'}
};
var PERS_DESC = {
  Brave:'Fights harder at death\'s door.',
  Coward:'May freeze when fear takes hold.',
  Greedy:'Came for the loot. Stays for the loot.',
  Loyal:'Avenges fallen allies.',
  Reckless:'Hits hard. Gets hit harder.',
  Cautious:'Keeps their head down.'
};
var AXES = [
  {key:'courage', lab:'COURAGE', col:'var(--axCourage)'},
  {key:'greed',   lab:'GREED',   col:'var(--axGreed)'},
  {key:'loyalty', lab:'LOYALTY', col:'var(--axLoyalty)'},
  {key:'fear',    lab:'FEAR',    col:'var(--axFear)'}
];

/* ======================= tiny utils ======================= */
function esc(s){
  return String(s==null?'':s).replace(/&/g,'&amp;').replace(/</g,'&lt;')
    .replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;');
}
function clamp(v,a,b){ v=Number(v); if(isNaN(v))v=a; return Math.max(a,Math.min(b,v)); }
function rnd(a,b){ return a+Math.random()*(b-a); }
function ri(a,b){ return Math.floor(rnd(a,b+1)); }
function pick(arr){ return arr[Math.floor(Math.random()*arr.length)]; }
function starsHtml(n){
  n=clamp(Math.round(Number(n)||1),1,4);
  return '<span class="stars r'+n+'">'+'★'.repeat(n)+'☆'.repeat(4-n)+'</span>';
}
/* V0.7: the version span lives in index.html (not this file's to edit), so
   ui.js owns the bump. Idempotent + DOM-guarded; called from updateHeader. */
var VER='v0.27';
function stampVersion(){
  try{
    var hdr=(typeof document!=='undefined'&&typeof document.getElementById==='function')
      ?document.getElementById('hdr'):null;
    var sp=(hdr&&typeof hdr.querySelector==='function')?hdr.querySelector('h1 .ver'):null;
    if(sp&&sp.textContent!==VER) sp.textContent=VER;
  }catch(e){}
}

/* ======================= guards ======================= */
function hardFail(msg){
  try{ console.error('[IT.ui] '+msg); }catch(e){}
  UI.toast('⚠ Integration error — '+msg);
}
/* call a core fn defensively: core('gacha')(...); returns undefined + hardFail if absent */
function core(fn){
  if(window.IT && typeof IT[fn]==='function') return IT[fn];
  hardFail('core.js missing API IT.'+fn+' — is js/core.js loaded?');
  return null;
}
function mod(name, fn){
  if(window.IT && IT[name] && typeof IT[name][fn]==='function') return IT[name][fn];
  hardFail(name+'.js missing API IT.'+name+'.'+fn+' — is js/'+name+'.js loaded?');
  return null;
}
function S(){ return (window.IT && IT.S) ? IT.S : null; }
function heroById(id){
  var s=S(); if(!s||!s.heroes) return null;
  for(var i=0;i<s.heroes.length;i++) if(s.heroes[i].id===id) return s.heroes[i];
  return null;
}
function partyHeroes(){
  var s=S(); if(!s) return [];
  return (s.party||[]).map(heroById).filter(function(h){return h && h.hp>0;});
}
function clsIcon(cls){ return (CLS_META[cls]||{icon:'❔'}).icon; }
function persDesc(label){
  if(window.IT && IT.DATA && IT.DATA.PERSONALITIES && IT.DATA.PERSONALITIES[label])
    return IT.DATA.PERSONALITIES[label];
  return PERS_DESC[label] || 'The Tower will learn what they are.';
}
/* contract personality derivation — display fallback only */
function labelOf(h){
  if(window.IT && typeof IT.label==='function'){ try{ return IT.label(h)||'Unknown'; }catch(e){} }
  if(!h) return 'Unknown';
  var c=h.courage||0,g=h.greed||0,l=h.loyalty||0,f=h.fear||0;
  if(c>=70) return 'Brave';
  if(f>=70) return 'Coward';
  if(g>=70) return 'Greedy';
  if(l>=80) return 'Loyal';
  if(g>=60&&c>=60) return 'Reckless';
  if(f<=30&&c<=40) return 'Cautious';
  var best='Brave',bv=-1,ax={Brave:c,Greedy:g,Loyal:l,Coward:f};
  for(var k in ax) if(ax[k]>bv){bv=ax[k];best=k;}
  return best;
}

/* ======================= V0.4 memory layer (guarded) =======================
   core.js may not expose the V0.4 APIs yet (bonds / inventory). Every call
   below falls back to a local equivalent so the UI renders fine against a
   V0.3 core and against pre-migration saves. */
function bondOf(aId,bId){
  if(window.IT&&typeof IT.bond==='function'){
    try{ var v=IT.bond(aId,bId); if(typeof v==='number') return v; }catch(e){}
  }
  var h=heroById(aId);
  return (h&&h.rel&&typeof h.rel[bId]==='number')?h.rel[bId]:0;
}
function addBondValue(aId,bId,d){
  d=Number(d)||0; if(!d) return;
  if(window.IT&&typeof IT.addBond==='function'){
    try{ IT.addBond(aId,bId,d); return; }
    catch(e){ hardFail('IT.addBond() threw: '+(e&&e.message)); return; }
  }
  /* fallback: symmetric clamped write on hero.rel */
  [aId,bId].forEach(function(x){
    var h=heroById(x); if(!h) return;
    var other=(x===aId)?bId:aId;
    h.rel=h.rel||{};
    h.rel[other]=clamp((Number(h.rel[other])||0)+d,-100,100);
  });
}
function invAdd(item){
  if(!item) return;
  var s=S(); if(!s) return;
  if(window.IT&&typeof IT.addItemToInventory==='function'){
    try{ IT.addItemToInventory(item); return; }
    catch(e){ hardFail('IT.addItemToInventory() threw: '+(e&&e.message)); return; }
  }
  s.inventory=Array.isArray(s.inventory)?s.inventory:[];
  s.inventory.push(item);
}
function addMemoryFlow(h,floor,text){
  if(!h) return;
  var f=core('addMemory');
  if(f){ try{ f.call(IT,h,floor,text); }catch(e){ hardFail('IT.addMemory() threw: '+(e&&e.message)); } }
  else{ h.memories=h.memories||[]; h.memories.push({floor:floor,text:text}); }
}
/* Item.slot per contract is 'weapon'|'armor'|'trick' — 'trick' means trinket */
var EQ_SLOTS=[
  {k:'weapon', label:'WEAPON',  icon:'⚔️'},
  {k:'armor',  label:'ARMOR',   icon:'🛡️'},
  {k:'trinket',label:'TRINKET', icon:'📿'}
];
function slotKeyOf(it){
  var s=(it&&it.slot!=null)?String(it.slot):'';
  if(s==='trick') s='trinket';
  return (s==='weapon'||s==='armor'||s==='trinket')?s:null;
}
function slotLabelOf(it){
  var k=slotKeyOf(it);
  for(var i=0;i<EQ_SLOTS.length;i++) if(EQ_SLOTS[i].k===k) return EQ_SLOTS[i].label;
  return 'ODD GEAR';
}
function itemStats(it){
  if(!it) return '';
  var bits=[];
  if(it.atk) bits.push('ATK+'+it.atk);
  if(it.def) bits.push('DEF+'+it.def);
  if(it.hp)  bits.push('HP+'+it.hp);
  return bits.length?bits.join(' · '):'no stats';
}
function equipItemFlow(h,it){
  var s=S(); if(!s||!h||!it) return;
  var k=slotKeyOf(it);
  if(!k){ UI.toast('That gear fits nowhere.'); return; }
  h.items=h.items||{};
  var old=h.items[k];
  h.items[k]=it;
  s.inventory=(s.inventory||[]).filter(function(x){return x!==it;});
  if(old) invAdd(old);
  var sv=core('save'); if(sv) sv.call(IT);
  UI.toast(esc(h.name)+' takes up '+esc(it.name)+(old?' — '+esc(old.name)+' back to the pack':'')+'.');
  UI.go('hero',h.id);
}

/* ======================= V0.5: the Deep Tower (floors 11-20) =======================
   Rule labels + Master progression. Every cross-module read is guarded:
   a pre-V0.5 core.js/map.js falls back to the V0.3/V0.4 constants (and the
   contract formulas for floors 11-20), so the UI keeps working mid-merge. */
var FLOOR_RULES=[
  {id:'dark',  min:11,max:13,icon:'🌑',name:'DARKNESS',
   desc:'scout 50g · fear +5 on entry · enemies hit harder'},
  {id:'blood', min:14,max:16,icon:'🌕',name:'BLOOD MOON',
   desc:'heroes under 30% HP deal ×1.30, take ×1.15'},
  {id:'betray',min:17,max:19,icon:'🐍',name:'BETRAYAL',
   desc:'loyalty under 45 may refuse · rites bind double'},
  {id:'king',  min:20,max:20,icon:'👑',name:'THE HOLLOW KING',
   desc:'he drinks doubt — the loyal resist'}
];
function floorRule(f){
  f=Number(f); if(!(f>=1)) return null;
  for(var i=0;i<FLOOR_RULES.length;i++){
    var r=FLOOR_RULES[i]; if(f>=r.min&&f<=r.max) return r;
  }
  return null;
}
function ruleLabel(f){ var r=floorRule(f); return r?(r.icon+' '+r.name):null; }

/* ---- Master progression (S.master migrated by core; guarded defaults) ---- */
function masterState(){
  var s=S(); if(!s) return {level:1,exp:0};
  if(!s.master||typeof s.master!=='object') s.master={level:1,exp:0};
  if(typeof s.master.level!=='number'||s.master.level<1) s.master.level=1;
  if(typeof s.master.exp!=='number'||s.master.exp<0) s.master.exp=0;
  return s.master;
}
function masterLv(){ return masterState().level; }
function masterNeed(lvl){
  if(window.IT&&typeof IT.masterExpNeed==='function'){
    try{ var n=IT.masterExpNeed(lvl); if(typeof n==='number'&&n>0) return n; }catch(e){}
  }
  return 100*lvl; /* contract: 100 × level */
}
/* ML2 → floors 11-15 (+roster cap 30) · ML3 → 16-20 · ML4 → rest ×0.6 · ML5 → recruit 90g */
function floorMasterNeed(f){ f=Number(f); return f>=16?3:(f>=11?2:0); }
function masterNextText(lvl){
  if(lvl<2)  return 'Next — Lv 2: Floors 11–15 open · roster cap 30';
  if(lvl===2) return 'Next — Lv 3: Floors 16–20 open';
  if(lvl===3) return 'Next — Lv 4: Rest costs ×0.6';
  if(lvl===4) return 'Next — Lv 5: Recruit cost 120 → 90g';
  return 'The Master knows every stair of the Tower.';
}
function masterUnlockText(lvl){
  if(lvl===2) return 'Floors 11–15 open. Roster cap 30.';
  if(lvl===3) return 'Floors 16–20 open.';
  if(lvl===4) return 'Rest costs ×0.6.';
  if(lvl===5) return 'Recruit cost drops to 90g.';
  return '';
}
/* grant + level-up loop; returns {from,to} when a level was gained, else null */
function grantMasterExpFlow(amt){
  var m=masterState(); amt=Number(amt)||0; if(amt<=0) return null;
  var from=m.level;
  if(window.IT&&typeof IT.grantMasterExp==='function'){
    try{ IT.grantMasterExp(amt); }
    catch(e){ hardFail('IT.grantMasterExp() threw: '+(e&&e.message)); }
    m=masterState(); /* the API owns the math; re-read defensively */
  }else{
    m.exp+=amt;
    var guard=0;
    while(m.exp>=masterNeed(m.level)&&guard++<50){ m.exp-=masterNeed(m.level); m.level++; }
  }
  if(m.level>from){
    UI.toast('👑 <b>MASTER reaches Lv '+m.level+'.</b> '+masterUnlockText(m.level));
    return {from:from,to:m.level};
  }
  return null;
}
/* ---- V0.5 clear bounties (core API first, contract values as fallback) ---- */
function floorClearGold(n){
  n=Number(n)||0;
  if(window.IT&&typeof IT.floorClearGold==='function'){
    try{ var g=IT.floorClearGold(n); if(typeof g==='number'&&g>=0) return Math.round(g); }catch(e){}
  }
  if(n===20) return 900;
  if(n===10) return 600;
  return 40+25*n;
}
function floorClearPermits(n){
  n=Number(n)||0;
  if(window.IT&&typeof IT.floorClearPermits==='function'){
    try{ var p=IT.floorClearPermits(n); if(typeof p==='number'&&p>=0) return Math.round(p); }catch(e){}
  }
  if(n===20) return 4;
  if(n===10) return 3;
  return (n===3||n===6||n===9||n===12||n===15||n===18)?1:0;
}
/* ---- roster cap / recruit cost / rest multiplier (core API first) ---- */
function rosterCap(){
  if(window.IT&&typeof IT.rosterCap==='function'){
    try{ var c=IT.rosterCap(); if(typeof c==='number'&&c>=3) return c; }catch(e){}
  }
  return 24;
}
function recruitCost(){
  if(window.IT&&typeof IT.recruitCost==='function'){
    try{ var c=IT.recruitCost(); if(typeof c==='number'&&c>0) return c; }catch(e){}
  }
  return 120;
}
function restMult(){
  if(window.IT&&typeof IT.restMult==='function'){
    try{ var m=IT.restMult(); if(typeof m==='number'&&m>0) return m; }catch(e){}
  }
  return 1;
}

/* ======================= V0.6: skill kits + reactions (AGENT-H3) =======================
   V0.7 (AGENT-H4): reads IT.SKILLS / IT.DATA.REACTIONS / IT.TRAITS +
   hero.skills / hero.reaction / hero.trait fully guarded — against an
   older core the sections hide gracefully. No class is special-cased any
   more: the moment core (AGENT-F4) inscribes a class's kit ids the rows
   render by themselves — Warrior/Rogue included. The "kit to come"
   placeholder now shows only for GENUINELY kit-less heroes: ones whose
   entire skill list is the shared basic swing (see isKitless). */

var BASIC_SKILL_IDS={basic:1,basicattack:1,attack:1,strike:1}; /* fallback swing — not kit (F3 gives Warrior/Rogue ['strike']) */

function skillsTable(){
  return (window.IT && IT.SKILLS && typeof IT.SKILLS==='object') ? IT.SKILLS : null;
}
/* the hero's kit = hero.skills ids that resolve to real skills, basic attack filtered */
function heroKit(h){
  var T=skillsTable(); if(!T||!h||!Array.isArray(h.skills)) return null;
  var out=[];
  h.skills.forEach(function(id){
    var s=T[id];
    if(s && !BASIC_SKILL_IDS[String(id).toLowerCase()]) out.push(s);
  });
  return out.length?out:null;
}
/* V0.7: genuinely kit-less = every skill id the hero carries is the shared
   basic swing (V0.6's Warrior/Rogue ['strike']; any class whose core kit
   has not shipped yet). Pure data — needs no IT.SKILLS, and the moment F4
   lands real kit ids on the hero, heroKit wins and rows render instead. */
function isKitless(h){
  if(!h||!Array.isArray(h.skills)||!h.skills.length) return false;
  return h.skills.every(function(id){ return !!BASIC_SKILL_IDS[String(id).toLowerCase()]; });
}
/* one-line desc from the spec (F3 may ship its own s.desc — that wins) */
function skillDesc(s){
  if(!s) return '';
  if(s.desc) return String(s.desc);
  var ACT={attack:'Strikes',heal:'Mends',protect:'Shields',buff:'Rallies',utility:'Works'};
  var TGT={allEnemies:'every enemy',enemy:'one enemy',lowestAlly:'the most wounded ally',
    anyAllyBelow35:'the ally who drops below 35% HP',self:'themself',party:'the whole party'};
  var bits=[(ACT[s.type]||'Acts on')+' '+(TGT[s.target]||'the field')+
    ((s.type!=='heal'&&Number(s.power)>0)?(' for '+Math.round(Number(s.power)*100)+'% ATK'):'')];
  (Array.isArray(s.effects)?s.effects:[]).forEach(function(f){
    if(!f||!f.kind) return;
    var K={burn:'burn 🔥',barrier:'barrier 🛡️',taunt:'taunt 🎯',stun:'stun 😵',redirect:'redirect ➡️',stress:'dread 🧠'};
    bits.push((K[f.kind]||f.kind)+(f.dur?(' '+f.dur+'t'):''));
  });
  return bits.join(' · ')+'.';
}
function skillConditionNote(s){
  var c=s&&s.condition;
  if(!c||typeof c!=='object') return '';
  if(c.selfHpBelow!=null)  return 'only under '+Math.round(Number(c.selfHpBelow)*100)+'% own HP';
  if(c.allyDiedThisBattle) return 'only after an ally falls this battle';
  if(c.anyAllyBelow!=null) return 'only while an ally is under '+Math.round(Number(c.anyAllyBelow)*100)+'% HP';
  return 'conditional';
}
function skillChipsHtml(s){
  var out=[], p=Number(s.power);
  if(p>0) out.push('<span class="chip '+(s.type==='heal'?'heal':'pwr')+'">'+(s.type==='heal'?'HEAL':'PWR')+' ×'+p+'</span>');
  out.push('<span class="chip cd">CD '+((Number(s.cd)>0)?Number(s.cd):'—')+'</span>');
  if(s.once||s.oncePerBattle||s.once_per_battle) out.push('<span class="chip once">ONCE / battle</span>');
  if(s.cost&&Number(s.cost.hpPct)>0) out.push('<span class="chip cost">−'+Math.round(Number(s.cost.hpPct)*100)+'% own HP</span>');
  var cnd=skillConditionNote(s);
  if(cnd) out.push('<span class="chip cond">'+esc(cnd)+'</span>');
  return out.join('');
}
/* REACTION row data — prefers hero.reaction (set at recruit/migration by F3);
   otherwise derives display-only from the axes using the contract precedence
   (courage→loyalty→fear→greed→steady). Needs IT.DATA.REACTIONS for name+desc. */
function reactionOf(h){
  var R=(window.IT&&IT.DATA&&IT.DATA.REACTIONS&&typeof IT.DATA.REACTIONS==='object')
    ?IT.DATA.REACTIONS:null;
  if(!R||!h) return null;
  var rid=(typeof h.reaction==='string'&&h.reaction)?h.reaction
    :(h.courage>=70)?'laststand':(h.loyalty>=80)?'protective'
    :(h.fear>=70)?'cowardretreat':(h.greed>=70)?'killer':'steady';
  var m=R[rid];
  return m?{id:rid,name:(m.name||rid),desc:(m.desc||m.flavor||'')}:null;
}
/* V0.7: TRAIT row data — one rolled quirk per hero (AGENT-F4's IT.TRAITS
   spec {id,name,desc,hooks}; hero.trait stores the rolled id — an object
   with .id is tolerated). Derivation-free by design: no trait on the hero,
   no table, or an id the table does not know → null → the row simply hides.
   No axis math here — traits are data, not derived. */
function traitOf(h){
  var T=(window.IT&&IT.TRAITS&&typeof IT.TRAITS==='object')?IT.TRAITS:null;
  if(!T||!h) return null;
  var tid=(h.trait&&typeof h.trait==='object')?h.trait.id:h.trait;
  if(!tid) return null;
  var t=T[tid];
  return (t&&t.name)?{id:tid,name:String(t.name),desc:String(t.desc||t.flavor||'')}:null;
}
/* V0.8: chapters — a book page, not a table. Roman numeral + kicker. */
var ROMAN=['I','II','III','IV','V','VI','VII','VIII','IX','X'];
function chapterHtml(num,kicker,inner){
  return '<section class="chapter">'+
    '<div class="chapter-kicker"><span class="chn">'+(ROMAN[num]||('§'+(num+1)))+'</span><span>'+kicker+'</span></div>'+
    inner+'</section>';
}
/* the profile's kit chapter (was "Skills & Reaction" box); '' = hidden */
function kitBoxHtml(h){
  var T=skillsTable();
  var kit=T?heroKit(h):null;      /* class-agnostic: W/R render once core ships their kits */
  var rx=reactionOf(h);
  var tr=traitOf(h);              /* V0.7 */
  var kitless=isKitless(h);       /* placeholder only for genuinely kit-less heroes */
  if(!kit&&!rx&&!tr&&!kitless) return '';
  var out='';
  if(kit){
    kit.forEach(function(s){
      out+='<div class="kitrow">'+
        '<div class="kitname">'+esc(s.name||s.id)+'</div>'+
        '<div class="kitdesc">'+esc(skillDesc(s))+'</div>'+
        '<div class="kitchips">'+skillChipsHtml(s)+'</div>'+
        '</div>';
    });
  }else if(kitless){
    out+='<div class="kit-empty">Basic training only — kit to come.</div>';
  }else if(T){
    out+='<div class="kit-empty">The Tower has not inscribed their kit yet.</div>';
  }else{
    out+='<div class="kit-empty">Kit records unavailable.</div>';
  }
  if(rx) out+='<div class="reactionrow"><span class="rx-tag">REACTION</span><b>'+esc(rx.name)+'</b> — '+esc(rx.desc)+'</div>';
  if(tr) out+='<div class="reactionrow traitrow"><span class="rx-tag">TRAIT</span><b>'+esc(tr.name)+'</b> — '+esc(tr.desc)+'</div>';
  return chapterHtml(0,'The Kit',out);
}

/* ======================= V0.7: light telemetry (AGENT-H4) =======================
   Anonymous play-test counters — AGENT-F4's IT.track(evt, n) + S.telemetry
   storage. Every call is guarded and SILENT: against a pre-V0.7 core nothing
   is collected and no flow may break (no hardFail — counters are optional).
   second_run = a run_started that begins <60s after the previous run_ended —
   the "อยากกดอีกไหม" metric. The timestamp lives in this module var, not in
   S: it is session pacing, not save data. */
var TELE={lastRunEndedAt:null};
function trackIt(evt){
  if(!(window.IT&&typeof IT.track==='function')) return;
  try{ IT.track(evt); }catch(e){}
}

/* ---- V0.6: master commands (PROTECT / OVERDRIVE / SACRIFICE) ----
   Ownership resolved by probe at render time:
   · G3's combat.js renders the command buttons + hero-card pickers itself
     (data-cmd mc_*) and exposes IT.combat.useCommand(id, heroId) as the
     public entry — when that API exists, combat owns the buttons and we
     mount NOTHING (no duplicate rail).
   · Against a pre-V0.6 combat (no command API), a slim ui-owned rail is
     mounted directly ABOVE the battle view's footer (#cb-bar, a sibling —
     combat's re-renders never touch it) and clicks invoke whatever
     combat-exposed API exists (per-command IT.combat.protect(heroId) etc.,
     or a generic masterCommand(name, heroId)); with none exposed the
     buttons render DISABLED with a note — combat's private state (its B
     object, its bar DOM) is never touched.
   Status tags on unit cards (🔥🛡🎯😵➡🧠) are combat's own renderer (no
   hook is exposed to ui); G3 ships them inside tagsHtml — nothing added here. */
var MC_CMDS=[
  {id:'protect',  label:'🛡 PROTECT',  hero:true,
   hint:'Choose who intercepts ALL damage to the party for 2 turns. They take it in full — pair them with a Healer or a Tank.'},
  {id:'overdrive',label:'⚡ OVERDRIVE',hero:false,
   hint:'Party hits ×1.25 for 2 rounds. When it ends, every hero frays (fear +15).'},
  {id:'sacrifice',label:'🔥 SACRIFICE',hero:true,
   hint:'Choose who taunts every enemy for 2 turns and deals +30% damage. Only a Tank cannot die from it.'}
];
var MC_GENERIC=['useCommand','masterCommand','masterCmd','useMasterCommand','command'];
var MC={used:{},buttons:{},rail:null}; /* per-battle; RENDER.battle resets */
/* G3's combat owns the PROTECT/OVERDRIVE/SACRIFICE buttons + pickers when it
   exposes useCommand — then ui must not render a second set (returns true). */
function combatOwnsCommandButtons(){
  return !!(window.IT&&IT.combat&&typeof IT.combat.useCommand==='function');
}

function combatCmdFn(name){
  var c=window.IT&&IT.combat; if(!c) return null;
  if(typeof c[name]==='function') return function(heroId){ return c[name](heroId); };
  for(var i=0;i<MC_GENERIC.length;i++){
    if(typeof c[MC_GENERIC[i]]==='function'){
      var g=c[MC_GENERIC[i]];
      return function(heroId){ return g.call(c,name,heroId); };
    }
  }
  return null;
}
function mcFire(cmd,heroId){
  var fn=combatCmdFn(cmd.id);
  if(!fn){ UI.toast('The Tower has not answered this command yet.'); return false; }
  var r;
  try{ r=fn(heroId===undefined?null:heroId); }
  catch(e){ hardFail('combat command "'+cmd.id+'" threw: '+(e&&e.message)); return false; }
  if(r===false){ UI.toast('Not now — the moment has passed.'); return false; }
  MC.used[cmd.id]=true;
  mcSpendButton(cmd);
  return true;
}
function mcSpendButton(cmd){
  var b=MC.buttons[cmd.id]||UI.el('mcr-'+cmd.id);
  if(b){ b.disabled=true; b.textContent=cmd.label+' ✓'; }
  if(MC.rail&&MC.rail.note) MC.rail.note.textContent=
    (Object.keys(MC.used).length>=MC_CMDS.length)
    ?'All commands spent for this battle.'
    :'Commanded: '+cmd.label+'. Each command once per battle.';
}
function mcPickHero(cmd){
  var party=partyHeroes();
  if(!party.length){ UI.toast('No one left to choose.'); return; }
  var btns=party.map(function(h){
    return {id:'pick-'+h.id,
      label:clsIcon(h.cls)+' '+esc(h.name)+' — '+Math.max(0,Math.round(h.hp))+'/'+h.maxHp+' HP',
      cls:'',cb:function(close){
        close();
        if(mcFire(cmd,h.id)) UI.toast(cmd.label+' — '+esc(h.name)+' answers the call.');
      }};
  });
  btns.push({id:'cancel',label:'Never mind',cls:'',cb:function(close){ close(); }});
  UI.overlay('<h3>'+cmd.label+'</h3><p>'+esc(cmd.hint)+'</p>',btns);
}
function mountCommandRail(view){
  if(!view||typeof document.createElement!=='function') return null;
  var rail=document.createElement('div');
  rail.id='it-cmdrail';
  var btns=document.createElement('div');
  btns.className='mcr-btns';
  var missing=0;
  MC.buttons={};
  MC_CMDS.forEach(function(cmd){
    var b=document.createElement('button');
    b.id='mcr-'+cmd.id;
    b.className='mcr-btn';
    b.type='button';
    b.textContent=cmd.label;
    b.title=cmd.hint;
    var hasApi=!!combatCmdFn(cmd.id);
    if(!hasApi) missing++;
    b.disabled=!hasApi;   /* explicit — DOM default is false, stubs have none */
    b.onclick=function(){
      if(MC.used[cmd.id]) return;
      if(!combatCmdFn(cmd.id)){
        UI.toast('Command not wired — the combat engine exposes no API for '+cmd.label+' yet.');
        return;
      }
      if(cmd.hero){ mcPickHero(cmd); return; }
      mcFire(cmd);
    };
    btns.appendChild(b);
    MC.buttons[cmd.id]=b;
  });
  var note=document.createElement('div');
  note.className='mcr-note';
  note.textContent=missing
    ?missing+' command'+(missing>1?'s':'')+' disabled — combat engine support pending (V0.6).'
    :'Master commands — each usable once per battle.';
  rail.appendChild(btns);
  rail.appendChild(note);
  rail.note=note; /* mcSpendButton updates it in place */
  /* directly above the battle view footer (#cb-bar); append as fallback */
  var anchor=null;
  try{ anchor=(typeof view.querySelector==='function')?view.querySelector('#cb-bar'):null; }catch(e){ anchor=null; }
  if(anchor&&anchor.parentNode===view&&typeof view.insertBefore==='function'){
    view.insertBefore(rail,anchor);
  }else if(typeof view.appendChild==='function'){
    view.appendChild(rail);
  }else return null;
  MC.rail=rail;
  return rail;
}

/* ======================= V0.8: shared hero sprite (AGENT-FEEL-A) =======================
   The single figure system every screen uses (lobby stage, roster strip,
   hero page portrait, reveal; FEEL-B/C may call IT.ui.heroSprite too).
   size: '' (default) | 'lg' | 'sm'; css owns frame/bob/.dead styling.
   hp<=0 renders the dead figure — desaturated, head-bowed, never removed. */
function heroSpriteHtml(h,size,extra){
  var icon=clsIcon(h&&h.cls);
  var dead=!!(h&&Number(h.hp)<=0);
  return '<div class="hero-sprite'+(size?' '+size:'')+(dead?' dead':'')+(extra||'')+'">'+
    pxImg(h&&h.cls,h&&h.id,icon,hMarks(h))+'</div>';
}
/* V0.14: sprite marks — legacy scar, pact red eyes, iron brand */
function hMarks(h){
  return h?{legacy:!!h.legacy,pact:!!h.pact,brand:!!h.branded}:null;
}
/* V0.9.2: pixel figure (from scene.js's sprite generator) as an <img>;
   falls back to the class emoji when scene/canvas is unavailable. */
function pxImg(cls,id,iconFallback,marks){
  var url='';
  try{
    url=(window.IT&&IT.scene&&typeof IT.scene.heroSpriteURL==='function')
      ?IT.scene.heroSpriteURL(cls,id,marks):'';
  }catch(e){ url=''; }
  return url
    ?'<img class="spr-px" alt="" draggable="false" src="'+url+'">'
    :'<span class="spr-emoji">'+(iconFallback!=null?iconFallback:clsIcon(cls))+'</span>';
}
/* V0.9.2: roster browsing — session filter/sort state (not saved). */
var CLS_ORDER=['Warrior','Tank','Rogue','Mage','Healer'];
var ROS={cls:'All',sort:'lv'};
function rosterSorter(){
  if(ROS.sort==='rarity') return function(a,b){return (b.rarity-a.rarity)||(b.lvl-a.lvl);};
  if(ROS.sort==='name') return function(a,b){return String(a.name).localeCompare(String(b.name));};
  return function(a,b){return (b.lvl-a.lvl)||(b.rarity-a.rarity);};
}
/* V0.11/16: supplies — one shop builder, two doors (lobby fallback + PREPARE sheet) */
var SUPS=[
  {k:'potion',icon:'🧪',name:'Potion',price:40,desc:'Heals the most-wounded hero 45% HP (in battle)'},
  {k:'torch', icon:'🔥',name:'Torch', price:30,desc:'Dread −20 (on the climb)'},
  {k:'escape',icon:'🏃',name:'Escape Kit',price:90,desc:'Guaranteed withdrawal — no one refuses, loot rides out'}
];
function supShopHtml(){
  var s=S(); if(!s) return '';
  var sp=(s.supplies||{potion:0,torch:0,escape:0});
  return SUPS.map(function(u){
    var n=sp[u.k]||0, can=s.gold>=u.price;
    return '<div class="suprow">'+
      '<span class="sup-ic">'+u.icon+'</span>'+
      '<span class="sup-info"><b>'+u.name+'</b><em>'+u.desc+'</em></span>'+
      '<span class="sup-n'+(n>0?'':' none')+'">×'+n+'</span>'+
      '<button class="act sup-buy'+(can?'':' off')+'" data-sup="'+u.k+'" '+(can?'':'disabled')+'>'+u.price+'g</button>'+
      '</div>';
  }).join('')+'<div class="sup-note">Carried into the Tower. A wipe takes them all.</div>';
}
function buySupply(k){
  var st=S(); if(!st) return;
  var def=null; SUPS.forEach(function(x){ if(x.k===k) def=x; });
  if(!def||st.gold<def.price){ UI.toast('Not enough gold.'); return; }
  st.gold-=def.price;
  st.supplies=st.supplies||{potion:0,torch:0,escape:0};
  st.supplies[k]=(st.supplies[k]||0)+1;
  trackIt('supply_bought');
  var svq=core('save'); if(svq) svq.call(IT);
  UI.updateHeader();
}
/* V0.16: PREPARE — the supplies sheet over the hall */
function supSheet(){
  UI.overlay('<h3>🎒 PREPARE</h3><div class="supshop inlay">'+supShopHtml()+'</div>',
    [{id:'ok',label:'Done',cls:'big gold',cb:function(close){ close(); }}]);
  wireSupBuys(document.getElementById('overlay'));
}
function wireSupBuys(scope){
  if(!scope||!scope.querySelectorAll) return;
  scope.querySelectorAll('.sup-buy').forEach(function(el){
    el.onclick=function(){
      buySupply(el.getAttribute('data-sup'));
      var box=scope.querySelector('.supshop');
      if(box) box.innerHTML=supShopHtml();
      wireSupBuys(scope);
    };
  });
}

/* V0.9.5: volume meter popup (header 🔊 → slider, live, persisted) */
function syncSndIcon(){
  var sb=UI.el('h-snd'); if(!sb) return;
  var lv=(window.IT&&IT.snd)?IT.snd.level:1;
  sb.textContent=(lv<=0.001)?'🔇':(lv<0.6?'🔉':'🔊');
}
function syncVolPop(){
  var r=UI.el('vp-r'); if(!r) return;
  var lv=(window.IT&&IT.snd)?IT.snd.level:1;
  r.value=String(Math.round(lv*100));
  var v=UI.el('vp-v'); if(v) v.textContent=r.value;
}
function volPop(){
  var el=document.getElementById('volpop');
  if(el){ el.classList.toggle('hidden'); syncVolPop(); return; }
  el=document.createElement('div'); el.id='volpop';
  el.innerHTML='<div class="vp-lab">VOLUME</div>'+
    '<input type="range" id="vp-r" min="0" max="100" step="5">'+
    '<div class="vp-val"><b id="vp-v">100</b></div>'+
    '<div class="vp-presets">'+
    '<button type="button" class="rfchip" data-v="0">MUTE</button>'+
    '<button type="button" class="rfchip" data-v="0.5">50</button>'+
    '<button type="button" class="rfchip" data-v="1">100</button>'+
    '</div>';
  document.body.appendChild(el);
  var r=document.getElementById('vp-r');
  function apply(){
    if(window.IT&&IT.snd) IT.snd.setLevel((+r.value)/100);
    var v=document.getElementById('vp-v'); if(v) v.textContent=r.value;
    syncSndIcon();
  }
  /* 'change' covers iOS where 'input' can arrive only on release */
  r.addEventListener('input',apply);
  r.addEventListener('change',apply);
  Array.prototype.forEach.call(el.querySelectorAll('.vp-presets .rfchip'),function(b){
    b.addEventListener('click',function(){
      r.value=String(Math.round((+b.getAttribute('data-v'))*100));
      apply();
      if(window.IT&&IT.snd) IT.snd.play('tap');   // audible confirmation
    });
  });
  /* tap anywhere else closes it */
  document.addEventListener('pointerdown',function(ev){
    var p=document.getElementById('volpop');
    if(!p||p.classList.contains('hidden')) return;
    var t=ev.target;
    while(t&&t!==p&&t!==document.getElementById('h-snd')) t=t.parentNode;
    if(!t||t===document){ p.classList.add('hidden'); }
  });
  syncVolPop();
}
/* V0.8: .screenbeat — every UI.go() breathes the new screen in through
   near-black (~260ms css animation on #app.beat-in). 0ms under
   prefers-reduced-motion; entirely DOM-guarded so headless runs
   (no classList / no matchMedia) skip it without a sound. */
function prefersReducedMotion(){
  try{
    return !!(typeof window!=='undefined'&&window.matchMedia
      &&window.matchMedia('(prefers-reduced-motion: reduce)').matches);
  }catch(e){ return false; }
}
function beatIn(app){
  if(!app||!app.classList||typeof app.classList.add!=='function') return;
  if(prefersReducedMotion()) return;
  try{
    app.classList.remove('beat-in');
    void app.offsetWidth; /* restart the animation on rapid re-renders */
    app.classList.add('beat-in');
  }catch(e){}
}

/* ======================= UI core ======================= */
var CUR='lobby';                 // current screen id
var RENDER={};                   // screen id → renderFn(app, arg)
var NAVTABS=[['lobby','HOME','🏠'],['tower','TOWER','⚔'],['roster','HEROES','👥']];
/* session (non-persisted) expedition trackers */
var RUN={ deaths:[], lvls:[], bossFought:false, blindWall:false };

var UI = {
  el:function(id){ return document.getElementById(id); },

  toast:function(msg){
    var box=UI.el('toasts'); if(!box){ try{console.log('[toast]',msg);}catch(e){} return; }
    var t=document.createElement('div');
    t.className='toast'; t.innerHTML=msg;
    box.appendChild(t);
    setTimeout(function(){
      try{
        t.style.opacity='0'; t.style.transition='opacity .5s';
        setTimeout(function(){ if(t.parentNode) t.parentNode.removeChild(t); },500);
      }catch(e){}
    },3800);
  },

  updateHeader:function(){
    var s=S();
    var g=UI.el('h-gold'), p=UI.el('h-permit'), m=UI.el('h-mem');
    if(g) g.textContent = s ? (s.gold||0) : '—';
    if(p) p.textContent = s ? (s.permits||0) : '—';
    if(m) m.textContent = s ? ((s.memorial&&s.memorial.length)||0) : '—';
    var hdr=UI.el('hdr');
    if(hdr && s && s.expedition){ hdr.classList.add('exped'); }
    else if(hdr){ hdr.classList.remove('exped'); }
    /* V0.9.5: sound button opens the volume meter (icon reflects the level) */
    var sb=UI.el('h-snd');
    if(sb){
      syncSndIcon();
      sb.title='volume — tap to adjust';
      sb.onclick=function(){ volPop(); };
    }
    stampVersion(); /* V0.7: header span says v0.7 (set from js — index.html untouched) */
  },

  /* screens: lobby, hero, tower, map, event, battle, result, memorial */
  go:function(screen,arg){
    CUR=String(screen||'lobby');
    renderNav();
    var app=UI.el('app'); if(!app){ hardFail('#app element missing'); return; }
    var fn=RENDER[CUR];
    if(!fn){ hardFail('unknown screen "'+CUR+'"'); CUR='lobby'; fn=RENDER.lobby; if(!fn) return; }
    app.innerHTML='';
    /* V0.17: the shell owns the viewport — the lobby is a fixed composition
       (header / scene-flex-1 / drawer / nav), everything else scrolls
       INSIDE #app on purpose. No more manual height budgeting. */
    try{
      app.classList.remove('fixed-page','scroll-page');
      app.classList.add((CUR==='lobby'||CUR==='expedition') ? 'fixed-page' : 'scroll-page');
    }catch(e){}
    try{ fn(app,arg); }
    catch(e){ hardFail('screen "'+CUR+'" crashed: '+(e&&e.message)); try{console.error(e);}catch(e2){} }
    beatIn(app); /* V0.8: fade through near-black — visual only, no timing change */
    /* V0.9.3: town music on every non-battle screen (battle sets its own on
       start; clearView stops it — returning here restarts the town loop) */
    if(window.IT&&IT.snd&&CUR!=='battle'){ try{ IT.snd.music('lobby'); }catch(e){} }
  },

  /* generic overlay: html + button defs [{id,label,cls,cb}] — cb receives close() */
  overlay:function(html,btns){
    var ov=UI.el('overlay'); if(!ov){ hardFail('#overlay element missing'); return; }
    var bhtml=(btns||[]).map(function(b){
      return '<button class="act '+(b.cls||'')+'" id="ov-'+b.id+'">'+b.label+'</button>';
    }).join('');
    ov.innerHTML='<div class="obox">'+html+'<div class="obtns">'+bhtml+'</div></div>';
    ov.classList.remove('hidden');
    (btns||[]).forEach(function(b){
      var el=UI.el('ov-'+b.id);
      if(el) el.onclick=function(){
        var close=function(){ UI.closeOverlay(); };
        if(b.cb) b.cb(close); else close();
      };
    });
  },
  closeOverlay:function(){
    var ov=UI.el('overlay');
    if(ov){ ov.classList.add('hidden'); ov.innerHTML=''; }
  }
};

function renderNav(){
  var nav=UI.el('nav'); if(!nav) return;
  var s=S();
  if(s && s.expedition){ nav.classList.add('hidden'); nav.innerHTML=''; return; }
  nav.classList.remove('hidden');
  var cur=CUR;
  if(cur!=='lobby'&&cur!=='tower'&&cur!=='roster'&&cur!=='memorial'&&cur!=='hero') cur='lobby';
  var html='';
  NAVTABS.forEach(function(t){
    html+='<button data-t="'+t[0]+'" data-ic="'+t[2]+'" class="'+(cur===t[0]?'on':'')+'">'+t[1]+'</button>';
  });
  nav.innerHTML=html;
  NAVTABS.forEach(function(t){
    var b=nav.querySelector?nav.querySelector('button[data-t="'+t[0]+'"]'):null;
    if(b) b.onclick=function(){ UI.go(t[0]); };
  });
}

/* ======================= shared card fragments ======================= */
function hpBar(h){
  var pct=clamp(Math.round((h.hp/h.maxHp)*100),0,100);
  return '<div class="bar slim"><i class="'+(pct<35?'low':'')+'" style="width:'+pct+'%"></i></div>';
}
/* ======================= SCREEN: lobby (V0.8 "the company stands") =======================
   Open composition: the PARTY stands together center (sprites +
   nameplates, tap a member → their page); the roster below is a quiet
   horizontal strip of small portraits; Recruit/Rest/Tower live in ONE
   bottom action bar; the MASTER panel is a slim parchment strip.
   Flow ids kept verbatim: pstrip, mpanel, roster, b-recruit, b-rest,
   b-tower (+ data-id on members/slots). */
RENDER.lobby=function(app){
  var s=S(); if(!s){ app.innerHTML='<p class="hint">State not loaded.</p>'; return; }
  var cap=rosterCap();
  var full=(s.heroes||[]).length>=cap;
  var html='<h2 class="scr">The Company</h2>';

  /* V0.13: the camp — a living canvas scene (fire, wanderers, candles for
     the fallen) when scene.js can run it; the DOM stage stays as fallback. */
  var canCamp=!!(window.IT&&IT.scene&&typeof IT.scene.lobbyAttach==='function');
  var standing=0;
  (s.party||[]).forEach(function(pid){ if(heroById(pid)) standing++; });
  if(canCamp){
    /* V0.16: the hall IS the screen — world first, UI on demand */
    html+='<div id="lobby-scene"></div>'+
      '<div id="hero-drawer" class="drawer-hint">Tap a hero — or a corner of the hall.</div>'+
      '<div class="lobby-fabs">'+
      '<button class="act" id="b-prepare">🎒 Prepare</button>'+
      '<button class="act gold" id="b-recruit" '+(full?'disabled':'')+'>🎴 Recruit · '+recruitCost()+'g</button>'+
      '</div>';
  }else{
  /* the party stands together — dead members stay standing, bowed */
  html+='<div class="party-stage" id="pstrip">';
  (s.party||[]).forEach(function(pid){
    var h=(pid!=null)?heroById(pid):null;
    if(!h) return;
    var down=Number(h.hp)<=0;
    var pct=clamp(Math.round((h.hp/h.maxHp)*100),0,100);
    html+='<div class="party-member'+(down?' down':'')+'" data-id="'+h.id+'">'+
      heroSpriteHtml(h)+
      '<button class="pm-x" data-id="'+h.id+'" title="Remove from the party">✕</button>'+
      '<div class="nameplate">'+
        '<span class="np-name">'+esc(h.name)+'</span>'+
        starsHtml(h.rarity)+
        '<span class="np-sub'+(pct<35?' low':'')+'">'+
          (down?'fallen — they need rest':(Math.max(0,Math.round(h.hp))+'/'+h.maxHp+' HP'))+
        '</span>'+
      '</div>'+
      '</div>';
  });
  for(var e=standing;e<3;e++){
    html+='<div class="party-member empty">'+
      '<div class="hero-sprite ghost"><span class="spr-emoji">🕯️</span></div>'+
      '<div class="nameplate"><span class="np-name" style="color:var(--dim)">—</span>'+
      '<span class="np-sub">the place is kept</span></div>'+
      '</div>';
  }
  html+='</div>';
  }
  html+='<p class="hint" style="text-align:center;margin:2px 0 0">THE EXPEDITION PARTY · <b>'+standing+'/3</b> — tap a companion to open their page</p>';

  /* V0.16: master panel lives on the Tower screen now; the hall keeps the world */
  if(!canCamp){

  /* V0.11: SUPPLIES — finite, bought here, carried into the Tower, lost on a wipe */
  html+='<h2 class="scr" style="margin-top:16px">Supplies</h2>';
  html+='<div class="supshop" id="supshop">'+supShopHtml()+'</div>';

  /* roster — a quiet horizontal strip of small portraits.
     V0.9.2: class filter chips + sort + Lv/★ on every slot (session state,
     not saved — ROS lives for the lobby's lifetime). */
  html+='<h2 class="scr" style="margin-top:16px">The Roster <span style="color:var(--dim);letter-spacing:.1em">'+((s.heroes||[]).length)+'/'+cap+'</span></h2>';
  if((s.heroes||[]).length){
    var all=s.heroes||[];
    var shown=all;
    if(ROS.cls!=='All') shown=shown.filter(function(h){return h.cls===ROS.cls;});
    shown=shown.slice().sort(rosterSorter());
    var sorts={lv:'Lv ▼',rarity:'★ ▼',name:'A–Z'};
    html+='<div class="rfilters" id="rfilters">'+
      ['All'].concat(CLS_ORDER).map(function(c){
        var n=(c==='All')?all.length:all.filter(function(x){return x.cls===c;}).length;
        return '<button class="rfchip'+(ROS.cls===c?' on':'')+'" data-cls="'+c+'">'+
          (c==='All'?'ALL':clsIcon(c)+' '+c.toUpperCase())+' <b>'+n+'</b></button>';
      }).join('')+
      '<button class="rfchip sort" data-cmd="sort">'+sorts[ROS.sort]+'</button>'+
      '</div>';
    if(shown.length){
      html+='<div class="roster-strip" id="roster">'+shown.map(function(h){
        var inP=(s.party||[]).indexOf(h.id)>=0;
        return '<div class="rslot'+(inP?' inparty':'')+'" data-id="'+h.id+'">'+
          heroSpriteHtml(h,'sm')+
          '<span class="rnm">'+esc(h.name)+'</span>'+
          '<span class="rmeta">Lv'+h.lvl+' <i class="r'+h.rarity+'">'+'★'.repeat(h.rarity)+'</i></span>'+
          '</div>';
      }).join('')+'</div>';
    }else{
      html+='<p class="hint">No '+esc(ROS.cls)+'s under contract right now.</p>';
    }
  }else{
    html+='<p class="hint">No one under contract yet. Recruit below — the Tower does not climb itself.</p>';
  }

  /* the ONE bottom action bar */
  html+='<div class="lobby-actions">'+
    '<button class="act" id="b-recruit" '+(full?'disabled':'')+'>🎴 Recruit · '+recruitCost()+'g</button>'+
    '<button class="act" id="b-rest">💤 Rest · '+(0.4*restMult()).toFixed(2).replace(/0+$/,'').replace(/\.$/,'')+'g/HP</button>'+
    '<button class="act gold" id="b-tower">🏰 Tower</button>'+
    '</div>';
  if(full) html+='<p class="hint">Roster full ('+cap+'). The Tower decides who leaves.</p>';
  } /* end !canCamp tail */
  app.innerHTML=html;

  /* wire: tap a standing member → their page; the small ✕ → step out */
  var strip=UI.el('pstrip');
  if(strip && strip.querySelectorAll){
    strip.querySelectorAll('.party-member:not(.empty)').forEach(function(el){
      el.onclick=function(){ IT.flow.heroProfile(Number(el.getAttribute('data-id'))); };
    });
    strip.querySelectorAll('.pm-x').forEach(function(el){
      el.onclick=function(ev){
        if(ev&&ev.stopPropagation){ try{ ev.stopPropagation(); }catch(e2){} }
        var id=Number(el.getAttribute('data-id'));
        var st=S(); if(!st) return;
        st.party=(st.party||[]).filter(function(x){return x!==id;});
        var f=core('save'); if(f) f.call(IT);
        var h=heroById(id);
        UI.toast(h?esc(h.name)+' steps out of the party.':'Removed from party.');
        UI.updateHeader();
        UI.go('lobby');
      };
    });
  }
  /* wire: roster portraits → profile */
  var ros=UI.el('roster');
  if(ros && ros.querySelectorAll){
    ros.querySelectorAll('.rslot').forEach(function(el){
      el.onclick=function(){ IT.flow.heroProfile(Number(el.getAttribute('data-id'))); };
    });
  }
  /* V0.9.2: wire the roster filter chips + sort toggle */
  var rfs=UI.el('rfilters');
  if(rfs && rfs.querySelectorAll){
    rfs.querySelectorAll('.rfchip[data-cls]').forEach(function(el){
      el.onclick=function(){ ROS.cls=el.getAttribute('data-cls'); UI.go('lobby'); };
    });
    var sb=rfs.querySelector('.rfchip[data-cmd="sort"]');
    if(sb) sb.onclick=function(){
      ROS.sort=(ROS.sort==='lv')?'rarity':(ROS.sort==='rarity')?'name':'lv';
      UI.go('lobby');
    };
  }
  /* wire: V0.11 supply shop (shared builder/wiring with the PREPARE sheet) */
  wireSupBuys(UI.el('supshop'));
  /* wire: V0.13/15 camp scene + hero drawer + V0.16 zone actions */
  if(canCamp){
    var bp=UI.el('b-prepare');
    if(bp) bp.onclick=supSheet;
    try{
      var campBox=UI.el('lobby-scene');
      if(campBox){
        IT.scene.lobbyAttach(campBox, function(heroId, activity){
          var h=heroById(heroId);
          var d=UI.el('hero-drawer');
          if(!h||!d) return;
          var st=S(); if(!st) return;
          var inP=(st.party||[]).indexOf(h.id)>=0;
          var pct=clamp(Math.round((h.hp/h.maxHp)*100),0,100);
          var marks=(h.legacy?' 🩸':'')+(h.pact?' 🩸PACT':'')+(h.branded?' 🔥':'');
          d.className='hero-drawer';
          d.innerHTML=
            '<div class="hd-main">'+
              '<span class="hd-name">'+clsIcon(h.cls)+' '+esc(h.name)+marks+'</span>'+
              '<span class="hd-lv">Lv.'+(h.lvl||1)+' '+starsHtml(h.rarity)+'</span>'+
            '</div>'+
            '<div class="hd-rows">'+
              '<span>HP <b class="'+(pct<35?'low':'')+'">'+Math.max(0,Math.round(h.hp))+'/'+h.maxHp+'</b></span>'+
              '<span>Status <b>'+((h.grieving||0)>0?'Grieving':(pct<45?'Recovering':'Healthy'))+'</b></span>'+
              '<span>Now <b class="hd-act">'+esc(activity||'—')+'</b></span>'+
              (inP?'<span>Party <b>Yes</b></span>':'<span>Party <b>No</b></span>')+
            '</div>'+
            '<div class="hd-btns">'+
              '<button class="act" id="hd-view">View Hero</button>'+
              (inP?'<button class="act danger" id="hd-x">Step out of party</button>':'')+
            '</div>';
          var vb=UI.el('hd-view');
          if(vb) vb.onclick=function(){ IT.flow.heroProfile(h.id); };
          var xb=UI.el('hd-x');
          if(xb) xb.onclick=function(){
            var st2=S(); if(!st2) return;
            st2.party=(st2.party||[]).filter(function(x){return x!==h.id;});
            var svq=core('save'); if(svq) svq.call(IT);
            UI.toast(esc(h.name)+' steps out of the party.');
            UI.go('lobby');
          };
        }, function(zone){
          /* V0.16: the hall's corners do things — context, not menus */
          if(zone==='rest'){ doRestAction(); }
          else if(zone==='mem'){ IT.flow.openMemorial(); }
          else if(zone==='fire'){ supSheet(); }
          else if(zone==='tower'){ IT.flow.openTower(); }   /* V0.18: the door is the destination */
          else if(zone==='train'){ UI.toast('🥋 Drills, footwork, and the sound of wood on wood.'); }
          else if(zone==='work'){ UI.toast('⚒ Whetstones, oil, and armor that will matter tomorrow.'); }
        });
      }
    }catch(e){ /* presentation only */ }
  }
  /* wire: buttons */
  var br=UI.el('b-recruit');
  if(br) br.onclick=doRecruit;
  var bt=UI.el('b-tower');
  if(bt) bt.onclick=function(){ IT.flow.openTower(); };
  var be=UI.el('b-rest');
  if(be) be.onclick=doRestAction;
};

/* V0.16: rest — from the bedrolls zone or the fallback button */
function doRestAction(){
  var st=S(); if(!st) return;
  var missing=(st.heroes||[]).reduce(function(sum,h){return sum+Math.max(0,h.maxHp-h.hp);},0);
  if(missing<1){ UI.toast('No wounds to treat.'); return; }
  var f=core('rest');
  if(!f) return;
  var r;
  try{ r=f.call(IT); }catch(e){ hardFail('IT.rest() threw: '+(e&&e.message)); return; }
  if(!r){ UI.toast('Not enough gold to rest.'); return; }
  UI.toast('💤 The party rests. Wounds close. Nerves settle. (−'+(r.cost||0)+'g)');
  var sv=core('save'); if(sv) sv.call(IT);
  UI.updateHeader();
  if(CUR==='lobby') UI.go('lobby');
}

/* ======================= SCREEN: roster (V0.16 — cards, the Heroes tab) =======================
   Card answers only: who / rarity / level / condition. Depth lives one tap
   deeper (the profile). Filter chips shared with the old lobby strip. */
RENDER.roster=function(app){
  var s=S(); if(!s){ app.innerHTML='<p class="hint">State not loaded.</p>'; return; }
  var cap=rosterCap();
  var html='<h2 class="scr">The Company <span style="color:var(--dim);letter-spacing:.1em">'+((s.heroes||[]).length)+'/'+cap+'</span></h2>';
  var all=s.heroes||[];
  if(all.length){
    var shown=all;
    if(ROS.cls!=='All') shown=shown.filter(function(h){return h.cls===ROS.cls;});
    shown=shown.slice().sort(rosterSorter());
    var sorts={lv:'Lv ▼',rarity:'★ ▼',name:'A–Z'};
    html+='<div class="rfilters" id="rfilters">'+
      ['All'].concat(CLS_ORDER).map(function(c){
        var n=(c==='All')?all.length:all.filter(function(x){return x.cls===c;}).length;
        return '<button class="rfchip'+(ROS.cls===c?' on':'')+'" data-cls="'+c+'">'+
          (c==='All'?'ALL':clsIcon(c)+' '+c.toUpperCase())+' <b>'+n+'</b></button>';
      }).join('')+
      '<button class="rfchip sort" data-cmd="sort">'+sorts[ROS.sort]+'</button>'+
      '</div>';
    html+='<div class="rgrid">'+shown.map(function(h){
      var inP=(s.party||[]).indexOf(h.id)>=0;
      var pct=clamp(Math.round((h.hp/h.maxHp)*100),0,100);
      var cond=(h.grieving||0)>0?'Grieving':(pct<45?'Recovering':'Healthy');
      var marks=(h.legacy?' 🩸':'')+(h.pact?' 🩸':'')+(h.branded?' 🔥':'');
      return '<div class="rcard'+(inP?' inparty':'')+'" data-id="'+h.id+'">'+
        (inP?'<span class="rc-party">PARTY</span>':'')+
        '<div class="rc-fig">'+heroSpriteHtml(h)+'</div>'+
        '<div class="rc-name">'+esc(h.name)+marks+'</div>'+
        '<div class="rc-meta"><i class="r'+h.rarity+'">'+'★'.repeat(h.rarity)+'</i> Lv'+h.lvl+'</div>'+
        '<div class="rc-cond'+(pct<45?' low':'')+'">'+(pct<100?'❤ '+pct+'%':'❤ '+cond)+'</div>'+
        '</div>';
    }).join('')+'</div>';
  }else{
    html+='<p class="hint">No one under contract yet. Recruit from the hall — the Tower does not climb itself.</p>';
  }
  app.innerHTML=html;
  var grid=app.querySelector('.rgrid');
  if(grid&&grid.querySelectorAll){
    grid.querySelectorAll('.rcard').forEach(function(el){
      el.onclick=function(){ IT.flow.heroProfile(Number(el.getAttribute('data-id'))); };
    });
  }
  var rfs=UI.el('rfilters');
  if(rfs&&rfs.querySelectorAll){
    rfs.querySelectorAll('.rfchip[data-cls]').forEach(function(el){
      el.onclick=function(){ ROS.cls=el.getAttribute('data-cls'); UI.go('roster'); };
    });
    var sb=rfs.querySelector('.rfchip[data-cmd="sort"]');
    if(sb) sb.onclick=function(){
      ROS.sort=(ROS.sort==='lv')?'rarity':(ROS.sort==='rarity')?'name':'lv';
      UI.go('roster');
    };
  }
};

/* recruit: gacha + character-introduction reveal */
function doRecruit(){
  var s=S(); if(!s) return;
  if((s.heroes||[]).length>=rosterCap()){ UI.toast('Roster full ('+rosterCap()+'). Recruit blocked.'); return; }
  var f=core('gacha');
  if(!f) return;
  var r;
  try{ r=f.call(IT); }catch(e){ hardFail('IT.gacha() threw: '+(e&&e.message)); return; }
  if(!r||!r.hero){ return; } /* core already toasted the reason */
  var h=r.hero;
  var sv=core('save'); if(sv) sv.call(IT);
  UI.updateHeader();
  var label=labelOf(h);
  var axes=AXES.map(function(a){
    var v=clamp(Math.round(h[a.key]||0),0,100);
    return '<div class="axline"><span class="lab" style="color:'+a.col+'">'+a.lab+'</span>'+
      '<div class="axisbar"><div class="fill" style="width:'+v+'%;background:'+a.col+'"></div><div class="ticks"></div></div>'+
      '<span class="num">'+v+'</span></div>';
  }).join('');
  /* V0.12: the name belongs to the memorial — THE TOWER REMEMBERS */
  /* V0.16: the summon is a CEREMONY — silhouette first, hold to reveal.
     rarity → silhouette → identity → numbers, never a stats wall. */
  UI.overlay(
    '<div class="summon">'+
    '<div class="su-kicker">SUMMON'+((h.rarity||1)>=3?' — THE AIR CHANGES':'')+'</div>'+
    '<div class="su-q">?</div>'+
    '<div class="su-unknown">UNKNOWN</div>'+
    (h.legacy?'<div class="su-tease">…the name feels familiar.</div>':'<div class="su-tease dim">someone answers the call</div>')+
    '<div class="su-holdwrap"><button type="button" class="su-hold" id="su-hold">HOLD TO REVEAL</button>'+
    '<div class="su-fill" id="su-fill"></div></div>'+
    '</div>',
    [{id:'skip',label:'Reveal',cls:'',cb:function(close){ close(); showReveal(); }}]
  );
  (function(){
    var btn=document.getElementById('su-hold');
    var fill=document.getElementById('su-fill');
    if(!btn||!fill) return;
    var p=0, timer=null, done=false;
    function start(ev){
      if(done) return;
      if(ev&&ev.preventDefault) ev.preventDefault();
      timer=setInterval(function(){
        p+=0.07;
        fill.style.width=Math.min(100,p*100)+'%';
        if(p>=1&&!done){
          done=true; clearInterval(timer);
          UI.closeOverlay(); showReveal();
        }
      },50);
    }
    function stop(){
      if(done) return;
      clearInterval(timer); p=0; fill.style.width='0%';
    }
    btn.addEventListener('pointerdown',start);
    btn.addEventListener('pointerup',stop);
    btn.addEventListener('pointerleave',stop);
  })();

  function showReveal(){
  var label=labelOf(h);
  var leg=h.legacy||null;
  var legHtml=leg
    ?'<div class="rv-legacy">'+
      '<div class="rvl-kicker">THE TOWER REMEMBERS</div>'+
      '<div class="rvl-name">'+esc(h.name)+' has returned.</div>'+
      '<div class="rvl-count">LEGACY '+String(leg.count).padStart(2,'0')+' · died Floor '+leg.floor+'</div>'+
      (leg.epitaph?'<div class="rvl-quote">"'+esc(leg.epitaph)+'"</div>':'')+
      '<div class="rvl-scar">They touch the scar on their cheek and say nothing about it.</div>'+
      '</div>'
    :'';
  var tag=leg?'THE TOWER SENDS THEM BACK':(esc(r.used||'recruited')+' — A NEW FACE AT THE GATE');
  var quote=leg
    ?pick(['"I remember the stair. All of it."','"You buried me at the camp. I kept the shirt."','"Second time. I intend to be harder to kill."','"The Tower and I have an arrangement now."'])
    :'"'+esc(recruitQuote(h,label))+'"';
  UI.overlay(
    '<div class="reveal">'+
    '<div class="rv-tag">'+tag+'</div>'+
    '<div class="rv-sprite">'+heroSpriteHtml(h,'lg')+'</div>'+
    legHtml+
    '<div class="rv-name">'+esc(h.name)+'</div>'+
    '<div class="rv-cls" style="color:'+((CLS_META[h.cls]||{}).col||'var(--dim)')+'">'+esc(h.cls)+' · Lv.'+(h.lvl||1)+'</div>'+
    starsHtml(h.rarity)+
    '<div class="rv-stats"><span>HP <b>'+h.maxHp+'</b></span><span>ATK <b>'+(h.atk||0)+'</b></span><span>DEF <b>'+(h.def||0)+'</b></span><span>AGI <b>'+(h.agi||0)+'</b></span></div>'+
    '<div class="rv-line"><b>'+esc(label)+'.</b> '+esc(persDesc(label))+'</div>'+
    '<div class="rv-line">'+quote+'</div>'+
    '<div class="axwrap">'+axes+'</div>'+
    '</div>',
    [{id:'ok',label:leg?'They are back':'Welcome, '+esc(h.name),cls:'big gold',cb:function(close){
      close(); UI.go('lobby');
    }}]
  );
  if(leg){ trackIt('legacy_return'); UI.toast('🩸 <b>'+esc(h.name)+' returns.</b> The Tower remembers.'); }
  else UI.toast('🎴 '+esc(h.name)+' joins the roster.');
  }
}
function recruitQuote(h,label){
  var q={
    Brave:['Point me at something that bleeds.','I came to climb. Not to kneel.'],
    Coward:['I... I promise to run in useful directions.','Just — stay close to me, alright?'],
    Greedy:['So. Where does the Tower keep its gold?','I fight best when paid. Pay often.'],
    Loyal:['Your name on the contract, Master. My blade follows.','Orders. Just give me orders.'],
    Reckless:['Floors, monsters, walls — I\'ve broken worse.','Rules are for people with patience.'],
    Cautious:['I count exits first. Always.','Live long enough to spend it. That\'s the plan.']
  };
  return pick(q[label]||['The Tower is tall. So is my resolve.']);
}

/* ======================= SCREEN: hero profile (V0.8 — a page in the book) =======================
   Large arched portrait, Cinzel name, stats DEMOTED to one quiet line,
   then the kit / gear / mind / bonds / memories as book chapters
   (kicker + prose). Flow ids kept verbatim: pf-party, pf-un-{slot},
   pf-eq-{i}. */
RENDER.hero=function(app,id){
  var h=heroById(id);
  if(!h){ app.innerHTML='<h2 class="scr">Hero</h2><p class="hint">That hero is gone — perhaps to the Memorial.</p>'; return; }
  var label=labelOf(h);
  var meta=CLS_META[h.cls]||{icon:'❔',col:'var(--dim)',desc:''};
  var inP=(S().party||[]).indexOf(h.id)>=0;
  var down=Number(h.hp)<=0;

  var html='<h2 class="scr">The Hero</h2>';

  /* the portrait — large arched sprite, the name in Cinzel */
  html+='<div class="pf-portrait">'+
    heroSpriteHtml(h,'lg')+
    '<div class="pf-name" style="color:'+meta.col+'">'+esc(h.name)+'</div>'+
    '<div class="pf-cls">'+esc(h.cls)+' · Lv.'+(h.lvl||1)+'</div>'+
    '<div class="pf-stars">'+starsHtml(h.rarity)+'</div>'+
    (h.legacy?'<div class="pf-legacy">🩸 LEGACY '+String(h.legacy.count).padStart(2,'0')+
      ' — died on Floor '+h.legacy.floor+' and climbed again</div>':'')+
    (h.pact?'<div class="pf-pact">🩸 PACT '+Math.min(3,h.pact.lvl)+' — +'+(20*Math.min(3,h.pact.lvl))+'% dmg · pays 6% HP per battle · when they fall, nothing remains</div>':'')+
    (h.branded?'<div class="pf-brand">🔥 IRON BRAND — +8 ATK · will never retreat</div>':'')+
    '<div class="pf-pers"><b>'+esc(label)+'</b> — '+esc(persDesc(label))+'</div>'+
    '<div class="pf-pers" style="font-size:12.5px">'+esc(meta.desc)+'</div>'+
    (down?'<div class="pf-down">They are in no shape to fight.</div>':'')+
    '</div>';

  /* stats demoted to a single footnote line — the person is the hero */
  html+='<p class="statline">HP <b>'+Math.max(0,Math.round(h.hp))+'/'+h.maxHp+'</b>'+
    ' · ATK <b>'+(h.atk||0)+'</b> · DEF <b>'+(h.def||0)+'</b> · AGI <b>'+(h.agi||0)+'</b>'+
    '<br>'+(h.kills||0)+' kills · '+(h.floors||0)+' floors cleared</p>';

  /* chapter I — the kit (kitBoxHtml hides itself when there is nothing) */
  html+=kitBoxHtml(h);

  /* chapter II — the gear: 3 worn slots + the pack */
  var worn=h.items||{};
  var inv=Array.isArray(S().inventory)?S().inventory.slice():[];
  var gear='';
  EQ_SLOTS.forEach(function(sl){
    var it=worn[sl.k];
    gear+='<div class="eqslot">'+
      '<div class="eqi">'+
      (it
        ?'<div class="eqnm">'+sl.icon+' '+esc(it.name)+'</div>'+
         '<div class="eqst">'+itemStats(it)+'</div>'+
         (it.history?'<div class="eqhist">'+esc(it.history)+'</div>':'')
        :'<div class="eqnm dim">— nothing worn —</div>')+
      '</div>'+
      '<div class="eqmeta"><span class="slottag">'+sl.label+'</span>'+
      (it?'<button class="act" id="pf-un-'+sl.k+'">Unequip</button>':'')+
      '</div></div>';
  });
  gear+='<div class="eqinvh">The pack — '+inv.length+' item(s)</div>';
  if(inv.length){
    inv.forEach(function(it,i){
      gear+='<div class="invrow"><div class="eqi">'+
        '<div class="eqnm">'+esc(it.name||'Unknown gear')+'</div>'+
        '<div class="eqst">'+slotLabelOf(it)+' · '+itemStats(it)+'</div>'+
        '</div><button class="act" id="pf-eq-'+i+'">Equip</button></div>';
    });
  }else{
    gear+='<div class="kv" style="font-style:italic">The pack is empty.</div>';
  }
  html+=chapterHtml(1,'The Gear',gear);

  /* chapter III — the mind: axes as thin candle-gold bars */
  var mind='';
  AXES.forEach(function(a){
    var v=clamp(Math.round(h[a.key]||0),0,100);
    mind+='<div class="axline"><span class="lab">'+a.lab+'</span>'+
      '<div class="axisbar"><div class="fill" style="width:'+v+'%"></div><div class="ticks"></div></div>'+
      '<span class="num">'+v+'</span></div>';
  });
  mind+='<div class="kv" style="margin-top:6px">0 ─────── 50 ─────── 100 · these numbers decide who obeys.</div>';
  html+=chapterHtml(2,'The Mind',mind);

  /* chapter IV — the bonds: living heroes w/ bar, dead w/ bond>=30 mourned */
  var bonds='';
  var rel=h.rel||{};
  var bondsShown=0;
  Object.keys(rel).forEach(function(oid){
    var v=Number(rel[oid])||0;
    var other=heroById(Number(oid));
    if(other&&other.id!==h.id){
      bondsShown++;
      var lab=v<0?'RIVAL':(v>=60?'BONDED':'NEUTRAL');
      var lc=v<0?'rival':(v>=60?'bonded':'neutral');
      var w=Math.abs(v)/2;
      bonds+='<div class="bondrow"><span class="bnm">'+esc(other.name)+'</span>'+
        '<div class="bondbar"><i class="'+(v<0?'neg':'pos')+'" style="width:'+w+'%"></i></div>'+
        '<span class="blab '+lc+'">'+lab+'</span></div>';
    }else{
      var dm=(((S()||{}).memorial||[]).filter(function(x){return String(x.id)===String(oid);})[0])||null;
      if(dm&&v>=30){
        bondsShown++;
        bonds+='<div class="mournrow">🪦 '+esc(dm.name)+' — mourned</div>';
      }
    }
  });
  if(!bondsShown) bonds+='<div class="kv" style="font-style:italic">No bonds yet. The Tower will arrange some.</div>';
  html+=chapterHtml(3,'The Bonds',bonds);

  /* chapter V — what they remember, latest first */
  var mems=(h.memories||[]).slice(-12).reverse();
  var memHtml='';
  if(mems.length){
    mems.forEach(function(m){
      memHtml+='<div class="mem-item">"'+esc(m.text)+'" <span class="fl">— Floor '+(m.floor!=null?m.floor:'?')+'</span></div>';
    });
  }else{
    memHtml+='<div class="kv" style="font-style:italic">Nothing worth remembering. Yet.</div>';
  }
  html+=chapterHtml(4,'What They Remember',memHtml);

  html+='<div class="rowbtns"><button class="act '+(inP?'danger':'gold')+' wide big" id="pf-party">'+
    (inP?'Remove from Party':(((S().party||[]).length>=3)?'Add to Party (full)':'Add to Party'))+
    '</button></div>';
  app.innerHTML=html;

  var btn=UI.el('pf-party');
  if(btn) btn.onclick=function(){
    var st=S(); if(!st) return;
    st.party=st.party||[];
    if(st.party.indexOf(h.id)>=0){
      st.party=st.party.filter(function(x){return x!==h.id;});
      UI.toast(esc(h.name)+' steps out of the party.');
    }else{
      if(st.party.length>=3){ UI.toast('Party is full (3).'); return; }
      if(h.hp<=0){ UI.toast(esc(h.name)+' is in no shape to fight.'); return; }
      st.party.push(h.id);
      UI.toast(esc(h.name)+' joins the party.');
    }
    var f=core('save'); if(f) f.call(IT);
    UI.go('hero',h.id);
  };

  /* V0.4: unequip per worn slot / equip per pack item */
  EQ_SLOTS.forEach(function(sl){
    var ub=UI.el('pf-un-'+sl.k);
    if(ub) ub.onclick=function(){
      var it2=(h.items||{})[sl.k];
      if(!it2) return;
      h.items[sl.k]=null;
      invAdd(it2);
      var sv=core('save'); if(sv) sv.call(IT);
      UI.toast(esc(h.name)+' sets down '+esc(it2.name)+'.');
      UI.go('hero',h.id);
    };
  });
  inv.forEach(function(it,i){
    var eb=UI.el('pf-eq-'+i);
    if(eb) eb.onclick=function(){ equipItemFlow(h,it); };
  });
};

/* ======================= V0.20: SCREEN — the dungeon room =======================
   MAP decides WHERE; this screen is the EXPERIENCE: the party walks in,
   the room says what it is, the player decides. Then the existing layers
   (battle / event / treasure / rest / remains) take over underneath. */
var DN_ROOMS={
  combat:['THE HALL OF ECHOES','A WIDENING CHAMBER','THE BROKEN GATE','SOMEONE\'S LAST STAND'],
  boss:['THE CHAMBER','THE THRONE ROOM','THE HIGH DOOR'],
  event:['AN ODD ROOM','THE LEANING SHRINE','A QUIET PLACE THAT ISN\'T','SOMEONE\'S OLD CAMP'],
  treasure:['A FORGOTTEN VAULT','THE DUSTY CACHE','A LOCKED ROOM, UNLOCKED'],
  rest:['A WINDING STAIR','THE QUIET LANDING','A ROOM THAT MEANS NO HARM'],
  remains:['THE LAST CAMP','WHAT WAS LEFT','A CAIRN SOMEONE BUILT'],
  corridor:['STONE CORRIDOR','THE DARK PASSAGE','THE NARROW STAIR']
};
var DN_FLAVOR={
  combat:['Something is already here, and it has been waiting.','The torches gutter. Shapes peel off the wall.'],
  boss:['The corridor goes silent — the way a room does when its owner arrives.','The air is thicker here. It knows your name.'],
  event:['The room is wrong in a way no one has named yet.','Something here wants a decision made.'],
  treasure:['A door that should have been locked, wasn\'t.','Dust in the shape of things worth taking.'],
  rest:['The sound of the Tower fades, just a little.','Nothing here has teeth. Probably.'],
  remains:['Someone else\'s expedition ended in this room.','Gear on the floor. Its owner isn\'t using it.']
};
function dungeonRoomFor(node){
  var t=node.type==='boss'?'boss':(node.type==='combat'?'combat':node.type);
  var pool=DN_ROOMS[t]||DN_ROOMS.corridor;
  var n=pool[hashStrDn(node.id+''+(node.type||''))%pool.length];
  var f=DN_FLAVOR[t]||DN_FLAVOR.event;
  return {title:n,flavor:f[hashStrDn(node.id+'f')%f.length]};
}
function hashStrDn(s){var h=0;s=String(s);for(var i=0;i<s.length;i++)h=((h*31)+s.charCodeAt(i))>>>0;return h;}

/* ======================= SCREEN: tower ======================= */
function threatOf(floor){ return clamp(Math.ceil(floor/2),1,5); }
var TOWER_TOP=20; /* V0.5: the Deep Tower — floors 11-20 */
RENDER.tower=function(app){
  var s=S(); if(!s){ app.innerHTML='<p class="hint">State not loaded.</p>'; return; }
  /* V0.16: the Master panel lives here now — the hall keeps the world */
  var mst=masterState(), mNeed=masterNeed(mst.level);
  var mPct=clamp(Math.round((mst.exp/mNeed)*100),0,100);
  var html='<div class="mpanel" id="mpanel">'+
    '<div class="mp-row"><span class="mp-lv">👑 MASTER <b>Lv '+mst.level+'</b></span>'+
    '<span class="mp-exp">'+mst.exp+'/'+mNeed+' exp</span></div>'+
    '<div class="bar slim"><i class="gold" style="width:'+mPct+'%"></i></div>'+
    '<div class="mp-next">'+masterNextText(mst.level)+'</div>'+
    '</div>';
  /* V0.8: the climb — carved ledges, not a list of cards */
  html+='<h2 class="scr">The Tower</h2>'+
    '<p class="hint" style="margin:-6px 0 0">Twenty stairs, each carved for someone.</p>'+
    '<div class="tower">';
  var nextFloor=0;
  for(var n=1;n<=TOWER_TOP;n++){ if(!(s.cleared||{})[n]){ nextFloor=n; break; } }
  if(nextFloor===0) nextFloor=TOWER_TOP; /* all cleared */
  var mlv=masterLv();

  for(var f=1;f<=TOWER_TOP;f++){
    var cleared=(s.cleared||{})[f];
    var progOk=(f===1)||(s.cleared||{})[f-1];
    var mlNeed=floorMasterNeed(f);
    var mlOk=!mlNeed||mlv>=mlNeed;
    var wall=(f===10||f===20);
    var king=(f===20);
    var rule=floorRule(f);
    var cls='frow'+(wall?' wall':'')+(cleared?' cleared':'')+
      ((!progOk||!mlOk)?' locked':'')+(mlNeed&&!mlOk?' ml':'')+
      (progOk&&mlOk&&f===nextFloor?' next':'');
    var stars=Array.apply(null,{length:threatOf(f)}).map(function(){return '★';}).join('');
    var stat=cleared?'✓ CLEARED'
      :(!mlOk?('🔒 MASTER Lv '+mlNeed)
      :(!progOk?'🔒 LOCKED'
      :(king?'ENTER — NO ONE RETURNS':'ENTER')));
    html+='<div class="'+cls+'" data-n="'+f+'">'+
      '<div class="fmain"><span class="fname">'+(king?'F20 — THE HOLLOW KING':(f===10?'F10 — THE WALL':'FLOOR '+f))+'</span>'+
      (rule?'<span class="frule">'+rule.icon+' <b>'+rule.name+'</b> — '+rule.desc+'</span>':'')+
      '<span class="fthreat" style="color:'+(wall?'var(--red)':'var(--gold)')+'">THREAT '+stars+'</span></div>'+
      '<span class="fstat">'+stat+'</span></div>';
  }
  html+='</div>';

  /* Tower Analysis — ported from v0.2 */
  var k=s.knowledge||{};
  if(k.executioner){
    html+='<div class="panel"><h3>📖 Tower Analysis — Floor 10</h3>'+
      '<p class="kv">Boss: <b>THE EXECUTIONER</b> — its cleaver sweeps the whole party every turn. The chip never stops.</p>'+
      '<p class="kv">Known mechanic — <b>"Execution"</b>: every 3rd turn the boss marks prey, then the axe falls on the marked hero.<br>'+
      'The mark only fizzles if the marked hero is at <b>100% HP</b> when the axe falls — then it bites, but does not kill.<br>'+
      'A Healer can top off exactly one hero per turn. Choose who lives at the mark.</p>'+
      '<p class="kv">A <b>Bulwark</b> turns the cleave; a redirect cannot catch the axe.</p>'+
      '<p class="kv">'+(k.wallBroken
        ?'<b style="color:var(--green)">Your Healer now knows:</b> prioritize the marked. Keep everyone topped. The Wall breaks.'
        :'<span class="unknown">??? — your survivors cannot explain what they saw.</span>')+'</p></div>';
  }else{
    html+='<div class="panel"><h3>📖 Tower Analysis</h3><p class="kv">Floors 1–9: hostile fauna and worse.<br>Floor 10: <span class="unknown">no data. no survivors.</span></p></div>';
  }
  /* V0.5: the Deep Tower — the Hollow King section appears once faced */
  if(k.hollowKing){
    html+='<div class="panel" style="border-color:var(--red)"><h3>📖 Tower Analysis — Floor 20</h3>'+
      '<p class="kv">Boss: <b>THE HOLLOW KING</b> — 2250 HP of crown and hunger, attended by his court.</p>'+
      '<p class="kv">Known mechanic — <b>"Drain the Doubtful"</b>: the King drinks the <b>least-loyal</b> hero for ×2.2 damage and heals what he takes.<br>'+
      '<b style="color:var(--green)">The loyal resist</b> — loyalty ≥ 60 halves the drain. They know why they climb.</p>'+
      '<p class="kv">At half health <b>the court falls, and the King rises</b>: his attendants die, he hits +20% harder, and the Drain comes every other turn.</p>'+
      '<p class="kv">Counter: climb with the loyal — campfires, burial rites and clean clears raise loyalty before the throne.</p></div>';
  }else{
    html+='<div class="panel"><h3>📖 Tower Analysis — The Deep Tower</h3>'+
      '<p class="kv">Below the Wall the rules change, floor by floor: 🌑 <b>DARKNESS</b> (11–13) · 🌕 <b>BLOOD MOON</b> (14–16) · 🐍 <b>BETRAYAL</b> (17–19).<br>'+
      'Floor 20: <span class="unknown">a throne at the bottom. No one returns to say what sits on it.</span></p></div>';
  }
  html+='<p class="hint">Party of '+((s.party||[]).length)+'/3 · Deaths are permanent.</p>';
  app.innerHTML=html;

  if(app.querySelectorAll){
    app.querySelectorAll('.frow:not(.locked)').forEach(function(el){
      el.onclick=function(){
        var alive=partyHeroes();
        if(!alive.length){ UI.toast('Pick a living party in the Lobby first.'); UI.go('lobby'); return; }
        IT.flow.startExpedition(Number(el.getAttribute('data-n')));
      };
    });
    /* master-sealed rows explain themselves when tapped */
    app.querySelectorAll('.frow.ml').forEach(function(el){
      el.onclick=function(){
        var f=Number(el.getAttribute('data-n'));
        UI.toast('🔒 Floor '+f+' is sealed — <b>MASTER Lv '+floorMasterNeed(f)+'</b> required.');
      };
    });
  }
};

/* ======================= SCREEN: memorial (V0.8 — the plaque wall) =======================
   Existing memorial data, restyled: each entry an arched stone plaque. */
RENDER.memorial=function(app){
  var s=S(); if(!s){ app.innerHTML='<p class="hint">State not loaded.</p>'; return; }
  var html='<h2 class="scr">The Memorial</h2>';
  var mem=s.memorial||[];
  if(!mem.length){
    html+='<p class="hint">Empty. For now.</p>';
  }else{
    html+='<div class="memorial-wall">';
    mem.forEach(function(m,i){
      html+='<div class="plaque">'+
        '<div class="pl-ic">'+pxImg(m.cls,m.id,null,{legacy:(m.returns||0)>0})+'</div>'+
        '<div class="pl-kicker">GEN '+(i+1)+' · Lv.'+(m.lvl||1)+' '+esc(m.cls)+'</div>'+
        '<div class="pl-name">'+esc(m.name)+'</div>'+
        '<div class="dead-tag">✝ FALLEN</div>'+
        '<div style="margin-top:4px">'+starsHtml(m.rarity)+'</div>'+
        '<div class="pl-sub">Fell on Floor <b>'+(m.diedFloor||'?')+'</b> to <b style="color:var(--txt)">'+esc(m.killer||'the Tower')+'</b>'+        (m.kills?' · '+m.kills+' kills':'')+'</div>'+
        '<div class="pl-epi">"'+esc(m.epitaph||'The Tower keeps what it takes.')+'"</div>'+
        ((m.returns||0)>0?'<div class="pl-return">🩸 The Tower sent them back '+m.returns+' time'+(m.returns>1?'s':'')+'.</div>':'')+
        /* V0.4: gear held at death + mourners (fields may be absent on old saves) */
        (Array.isArray(m.items)&&m.items.length
          ?'<div class="pl-carry">Carried at the end: '+m.items.map(function(x){return esc((x&&x.name)||'?');}).join(', ')+'</div>'
          :'')+
        (Array.isArray(m.mourners)&&m.mourners.length
          ?'<div class="pl-mourn">Mourned by '+m.mourners.map(function(n){return esc(n);}).join(', ')+'</div>'
          :'')+
        '</div>';
    });
    html+='</div>';
  }
  app.innerHTML=html;
};

/* ======================= V0.8: expedition scene kit (AGENT-FEEL-C) =======================
   Presentation-only helpers for the EXPEDITION screens (map / event /
   treasure / rest / remains / result). No gameplay reads, no state writes:
   every function derives its strings from data the renderer already had.
   Beats are DOM-append + timer-remove and pointer-events:none, so they can
   never swallow a click or delay a render; prefers-reduced-motion collapses
   them to a near-instant hold. Headless harnesses never load ui.js, and
   every helper still typeof-guards document for safety. */
function prefersReduced(){
  try{
    return !!(typeof window!=='undefined'&&window.matchMedia&&
      window.matchMedia('(prefers-reduced-motion: reduce)').matches);
  }catch(e){ return true; }
}
/* floor title card memory — one card per map object (fresh arrival only) */
var FLOORCARD_SEEN=(function(){ try{ return new WeakSet(); }catch(e){ return null; } })();
function floorcardSeen(map){ try{ return !!(FLOORCARD_SEEN&&FLOORCARD_SEEN.has(map)); }catch(e){ return false; } }
function floorcardMark(map){ try{ if(FLOORCARD_SEEN) FLOORCARD_SEEN.add(map); }catch(e){} }
/* full-bleed title-card beat — rides AGENT-FEEL-A's shared .titlecard
   system (tc-kicker / tc-main / tc-sub, tcfade .9s). Mounts on <body>,
   pointer-events:none, removes itself; reduced-motion keeps the beat but
   instant (~260ms static hold). Never blocks a click or delays a render. */
function showTitleCardBeat(kicker,main,sub,cls,id){
  if(typeof document==='undefined'||typeof document.createElement!=='function'||!document.body) return;
  var cid=id||'screen-titlecard';
  var old=document.getElementById(cid);
  if(old&&old.parentNode) old.parentNode.removeChild(old);
  var card=document.createElement('div');
  card.id=cid;
  card.className='titlecard'+(cls?' '+cls:'')+(prefersReduced()?' rm':'');
  card.setAttribute('aria-hidden','true');
  card.innerHTML='<div class="tc-kicker">'+kicker+'</div>'+
    '<div class="tc-main">'+main+'</div>'+
    (sub?'<div class="tc-sub">'+sub+'</div>':'');
  document.body.appendChild(card);
  setTimeout(function(){ if(card.parentNode) card.parentNode.removeChild(card); },prefersReduced()?260:980);
}
/* the expedition's own: "FLOOR N" before the map reads */
function showFloorTitleCard(floor,rule){
  var sub=(floor===20)?'the throne at the bottom'
        :(floor===10)?'they call it the Wall'
        :(floor>=11)?'below the Wall, the rules change'
        :'the climb begins';
  showTitleCardBeat((rule?(rule.icon+' '+rule.name):'INFINITE TOWER'),
    'FLOOR '+Number(floor),sub,'','floor-titlecard');
}
/* one flavor line under the map, derived from the live map data:
   unknown rooms on the frontier → "Something waits ahead."
   a branching frontier → "The path splits here."
   the end node is on the frontier → "The way opens." */
function mapFlavorLine(ex){
  try{
    var map=ex.map, nodes=map.nodes||[];
    var reach=mod('map','reachable');
    var ids=reach?(reach.call(IT.map,map)||[]):[];
    if(!ids.length) return 'The Tower holds its breath.';
    var frontier=ids.map(function(id){
      for(var i=0;i<nodes.length;i++) if(nodes[i].id===id) return nodes[i];
      return null;
    }).filter(Boolean);
    if(frontier.some(function(n){ return n.id===map.endId; })) return 'The way opens.';
    if(frontier.some(function(n){ return !n.scouted; }))      return 'Something waits ahead.';
    if(frontier.length>=2)                                    return 'The path splits here.';
    return 'The stair is close.';
  }catch(e){ return 'Something waits ahead.'; }
}
/* marching party strip — sprites + HP slivers (display-only; .hero-sprite
   is styled from AGENT-FEEL-C's scoped block so it stands alone even
   without AGENT-FEEL-A's lobby css) */
function marchStripHtml(){
  var s=S(); if(!s) return '';
  var ids=s.party||[];
  var html='<div class="march-strip" id="march-strip">';
  for(var i=0;i<3;i++){
    var h=(ids[i]!=null)?heroById(ids[i]):null;
    if(h){
      var pct=clamp(Math.round((h.hp/h.maxHp)*100),0,100);
      var down=(h.hp<=0);
      html+='<div class="march-fig'+(down?' down':'')+'">'+
        '<div class="hero-sprite'+(down?' dead':'')+'" aria-hidden="true">'+pxImg(h.cls,h.id,null,hMarks(h))+'</div>'+
        '<div class="march-name">'+esc(h.name)+'</div>'+
        '<div class="march-hp" title="HP '+Math.max(0,Math.round(h.hp))+'/'+h.maxHp+'">'+
        '<i class="'+(pct<35?'low':'')+'" style="width:'+pct+'%"></i></div>'+
        '</div>';
    }else{
      /* a gap in the line — a candle only when the run has actually lost
         someone (RUN.deaths is the session tracker, display-only read) */
      var mourn=(RUN.deaths||[]).length>0;
      html+='<div class="march-fig vacant">'+
        '<div class="hero-sprite ghost" aria-hidden="true"><span class="spr-emoji">'+(mourn?'🕯️':'·')+'</span></div>'+
        '<div class="march-name">'+(mourn?'gone':'—')+'</div>'+
        '<div class="march-hp"><i style="width:0%"></i></div>'+
        '</div>';
    }
  }
  return html+'</div>';
}

/* ======================= SCREEN: expedition map ======================= */
/* V0.5: scout cost is a function of the floor (🌑 DARKNESS 11-13 costs more).
 * Falls back to the map module's flat constant, then to the V0.3 value. */
function scoutCost(floor){
  if(window.IT&&IT.map&&typeof IT.map.scoutCost==='function'){
    try{ var c=IT.map.scoutCost(floor); if(typeof c==='number'&&c>=0) return c; }catch(e){}
  }
  if(window.IT&&IT.map&&IT.map.ScoutCost) return IT.map.ScoutCost;
  return 25;
}
/* ======================= V0.21: SCREEN — expedition (SCENE + ROUTE) =======================
   ONE persistent screen: TOP = the current room (party walks in, decisions
   happen ON the scene, node cards render INTO the scene pane) · MID = the
   horizontal route map (interactive, always visible) · BOTTOM = the party
   + Scout/Torch/Leave. No screen switching — only battle takes the full
   view, and it hands back here. */
var EXPSC={node:null};

RENDER.expedition=function(app,arg){
  var s=S(); if(!s||!s.expedition||!s.expedition.map){ app.innerHTML='<p class="hint">No active expedition.</p>'; return; }
  var ex=s.expedition;
  var rule=floorRule(ex.floor);
  var fresh=false;
  try{
    fresh=(ex.curId===ex.map.startId)&&
      !((ex.map.nodes||[]).some(function(n){ return n.cleared; }))&&
      !floorcardSeen(ex.map);
  }catch(e){ fresh=false; }
  if(fresh) floorcardMark(ex.map);

  EXPSC.node=(arg&&arg.node)||null;
  var dt=dreadTierOf(ex.dread||0);
  var cost=scoutCost(ex.floor);
  var canScout=(s.gold>=cost);
  var torches=((s.supplies&&s.supplies.torch)||0);
  var canTorch=torches>0&&(ex.dread||0)>0;

  var html='<div class="exp-shell">';
  /* ---- TOP: the scene (status strip + room + overlay) ---- */
  html+='<div class="exp-top">'+
    '<div class="exp-status">'+
      '<div class="exp-kicker"><span class="k-floor">F'+ex.floor+'</span>'+
      (rule?'<span class="k-rule">'+rule.icon+'</span>':'')+
      '<span class="k-rule" style="color:'+dt.col+'">'+dt.lab+' '+(ex.dread||0)+'</span></div>'+
      '<div class="exp-tally"><span>SECURED <b>'+((ex.bank&&ex.bank.gold)||0)+'g</b></span>'+
      '<span class="at-risk">UNBANKED <b>'+((ex.tally&&ex.tally.gold)||0)+'g</b>'+
      (((ex.tally&&ex.tally.gold)||0)>0?' ⚠':'')+'</span></div>'+
    '</div>'+
    '<div id="exp-canvas"></div>'+
    '<div class="dn-title" id="exp-title"></div>'+
    '<div id="exp-content"></div>'+
    '</div>';
  /* ---- MID: the route ---- */
  html+='<div class="exp-route">'+
    '<div class="climb-frame route-frame"><div id="map-box"></div></div>'+
    '<div class="map-flavor">'+esc(mapFlavorLine(ex))+'</div></div>';
  /* ---- BOTTOM: party + commands ---- */
  html+='<div class="exp-bottom">'+
    marchStripHtml()+
    '<div class="map-actions">'+
    '<button class="act" id="m-scout" '+(canScout?'':'disabled')+'>🔭 Scout — '+cost+'g</button>'+
    '<button class="act" id="m-torch" '+(canTorch?'':'disabled')+'>🔥 Torch ×'+torches+'</button>'+
    '<button class="act gold" id="m-abandon">🏦 Leave — take the loot</button>'+
    '</div></div>';
  html+='</div>';
  app.innerHTML=html;

  /* the route map itself (horizontal, interactive) */
  var box=UI.el('map-box');
  var rl=mod('map','relayout');
  if(rl && !ex.map.grid){ try{ rl.call(IT.map,ex.map); }catch(e){} }
  var r=mod('map','render');
  if(r&&box){
    try{ r.call(IT.map,ex.map,box,function(nodeId){ IT.flow.enterNode(nodeId); }); }
    catch(e){
      hardFail('IT.map.render() threw: '+(e&&e.message));
      box.innerHTML='<div class="moderr"><b>MAP MODULE ERROR</b><br>'+esc(e&&e.message)+'</div>';
    }
  }else if(box){
    box.innerHTML='<div class="moderr"><b>MAP MODULE MISSING</b><br>js/map.js is not loaded. You can still leave with your loot.</div>';
  }

  var sb=UI.el('m-scout');
  if(sb) sb.onclick=function(){ scoutRandom(true); };
  var tb=UI.el('m-torch');
  if(tb) tb.onclick=function(){
    var st=S(); if(!st||!st.expedition) return;
    if(!(st.supplies&&st.supplies.torch>0)||(st.expedition.dread||0)<=0) return;
    st.supplies.torch--;
    applyDread(st.expedition,-20);
    trackIt('torch_used');
    var svt=core('save'); if(svt) svt.call(IT);
    UI.toast('🔥 Torchlight pushes the dark back. (dread −20, '+st.supplies.torch+' left)');
    UI.go('expedition');
  };
  var ab=UI.el('m-abandon');
  if(ab) ab.onclick=confirmAbandon;

  /* scene state: arriving at a node, or standing between rooms */
  if(EXPSC.node){ expEnter(EXPSC.node); }
  else { expIdle(); }

  if(fresh) showFloorTitleCard(ex.floor,rule);
};

RENDER.map=RENDER.expedition;   /* V0.21: 'map' is the expedition screen now */

/* the party enters a node: walk-in canvas + the room's decision */
function expEnter(node){
  var s=S(); if(!s||!s.expedition) return;
  var ex=s.expedition;
  var room=dungeonRoomFor(node);
  var titleEl=UI.el('exp-title');
  if(titleEl) titleEl.textContent=room.title;
  var content=UI.el('exp-content');
  if(content) content.innerHTML='<p class="dn-flavor">'+esc(room.flavor)+'</p>'+
    '<div class="dn-choices"><span class="dn-walking">the party moves up…</span></div>';

  function proceed(){
    if(window.IT&&IT.scene&&IT.scene.dungeonDetach) IT.scene.dungeonDetach();
    if(node.type==='combat'||node.type==='boss'){
      var cfg=makeCombatCfg(node,ex);
      UI.go('battle',cfg);
    }else if(node.type==='event'){ expEvent(node); }
    else if(node.type==='treasure'){ showTreasure(node,ex); }
    else if(node.type==='rest'){ showRest(node,ex); }
    else if(node.type==='remains'){ showRemains(node,ex); }
    else{ completeNode(node.id); }
  }
  function avoid(){
    if(window.IT&&IT.scene&&IT.scene.dungeonDetach) IT.scene.dungeonDetach();
    completeNode(node.id,'You leave it where it lay.');
  }
  function showChoices(){
    var box=UI.el('exp-content');
    if(!box){ proceed(); return; }
    var btns='<p class="dn-flavor">'+esc(room.flavor)+'</p><div class="dn-choices">';
    if(node.type==='treasure'){
      btns+='<button class="act gold" id="dn-a">💰 Approach the cache</button>'+
            '<button class="act" id="dn-b">Leave it buried</button>';
    }else if(node.type==='rest'){
      btns+='<button class="act gold" id="dn-a">🔥 Make camp here</button>';
    }else if(node.type==='remains'){
      btns+='<button class="act gold" id="dn-a">⚰ Approach the remains</button>'+
            '<button class="act" id="dn-b">Let them rest</button>';
    }else if(node.type==='boss'||node.type==='combat'){
      btns+='<button class="act danger" id="dn-a">⚔ '+(node.type==='boss'?'Enter the chamber':'Advance')+'</button>';
    }else if(node.type==='event'){
      btns+='<button class="act gold" id="dn-a">❓ Approach</button>';
    }else{
      btns+='<button class="act" id="dn-a">Move on</button>';
    }
    box.innerHTML=btns+'</div>';
    var a=UI.el('dn-a'); if(a) a.onclick=proceed;
    var b=UI.el('dn-b'); if(b) b.onclick=avoid;
  }

  var attached=false;
  if(window.IT&&IT.scene&&typeof IT.scene.dungeonAttach==='function'){
    try{
      var holder=UI.el('exp-canvas');
      var dt=dreadTierOf(ex.dread||0);
      attached=holder&&IT.scene.dungeonAttach(holder,{
        room:(node.type==='boss'?'boss':node.type),
        floor:ex.floor, dreadTier:dt.id, party:partyHeroes(),
        onArrived:showChoices
      });
    }catch(e){ attached=false; }
  }
  if(!attached){ proceed(); }   /* headless / no canvas → old direct flow */
}

/* between rooms: the scene rests, the route waits */
function expIdle(){
  var titleEl=UI.el('exp-title');
  if(titleEl) titleEl.textContent='';
  var content=UI.el('exp-content');
  if(content) content.innerHTML='<p class="dn-idle">The room is quiet now. Choose the next door on the route.</p>';
  /* a calm corridor scene behind the words */
  if(window.IT&&IT.scene&&typeof IT.scene.dungeonAttach==='function'){
    try{
      var s=S();
      var holder=UI.el('exp-canvas');
      if(holder&&s&&s.expedition){
        IT.scene.dungeonAttach(holder,{room:'corridor',floor:s.expedition.floor,
          dreadTier:dreadTierOf(s.expedition.dread||0).id,
          party:partyHeroes(),onArrived:null});
      }
    }catch(e){ /* presentation */ }
  }
}

/* events run INSIDE the scene pane — the map stays under them */
function expEvent(node){
  var s=S(); if(!s||!s.expedition) return;
  var content=UI.el('exp-content')||UI.el('app');
  content.innerHTML='<div class="event-scene">'+
    '<div class="exp-kicker"><span>FLOOR '+s.expedition.floor+'</span><i class="dot"></i><span>SOMETHING HAPPENS</span></div>'+
    '<div id="event-box"></div></div>';
  var box=UI.el('event-box');
  var run=mod('events','run');
  if(run&&box){
    try{
      run.call(IT.events,node,box,function(summary){ IT.flow.nodeDone(summary||{}); });
    }catch(e){
      hardFail('IT.events.run() threw: '+(e&&e.message));
      box.innerHTML='<div class="moderr"><b>EVENT MODULE ERROR</b><br>'+esc(e&&e.message)+
        '</div><div class="rowbtns"><button class="act" id="ev-skip">Move on</button></div>';
      var b=UI.el('ev-skip');
      if(b) b.onclick=function(){ IT.flow.nodeDone({text:'The party moves on.'}); };
    }
  }else if(box){
    box.innerHTML='<div class="moderr"><b>EVENT MODULE MISSING</b><br>js/events.js is not loaded.</div>'+
      '<div class="rowbtns"><button class="act" id="ev-skip">Move on</button></div>';
    var b2=UI.el('ev-skip');
    if(b2) b2.onclick=function(){ IT.flow.nodeDone({text:'The party moves on.'}); };
  }
}

/* pick a random unscouted node (reachable first) and scout it */
function scoutRandom(announce){
  var s=S(); if(!s||!s.expedition) return;
  var map=s.expedition.map;
  var nodes=(map&&map.nodes)||[];
  var unscouted=nodes.filter(function(n){ return !n.scouted && !n.cleared; });
  if(!unscouted.length){ UI.toast('Nothing left to scout.'); return; }
  var target=null;
  var reach=mod('map','reachable');
  if(reach){
    try{
      var ids=reach.call(IT.map,map)||[];
      for(var i=0;i<ids.length;i++){
        var n=nodes.filter(function(x){return x.id===ids[i];})[0];
        if(n&&!n.scouted&&!n.cleared){ target=n; break; }
      }
    }catch(e){ hardFail('IT.map.reachable() threw: '+(e&&e.message)); }
  }
  if(!target) target=pick(unscouted);
  var f=mod('map','scout');
  if(!f) return;
  var ok;
  try{ ok=f.call(IT.map,map,target.id); }catch(e){ hardFail('IT.map.scout() threw: '+(e&&e.message)); return; }
  if(!ok){ UI.toast('Not enough gold to scout ('+scoutCost(s.expedition.floor)+'g).'); return; }
  trackIt('scout_used'); /* V0.7: every real scout — map button + scout offer both land here */
  var sv=core('save'); if(sv) sv.call(IT);
  UI.updateHeader();
  if(announce!==false) UI.toast('🔭 Scouted: '+nodeTypeName(target)+' · threat '+target.threat);
  UI.go('expedition');
}
function nodeTypeName(n){
  var t={combat:'⚔ Combat',event:'❓ Event',treasure:'💰 Treasure',rest:'🔥 Rest',boss:'👹 BOSS',start:'▶ Start',end:'🏁 Exit',remains:'⚰️ Remains'};
  return t[n&&n.type]||'Unknown';
}

function confirmAbandon(){
  var s=S(); if(!s||!s.expedition) return;
  var ex=s.expedition;
  /* V0.10: this is the extraction — walking out ALIVE keeps everything,
     banked and unbanked. The price is the floor itself (no clear rewards). */
  var banked=(ex.bank&&ex.bank.gold)||0, unbanked=(ex.tally&&ex.tally.gold)||0;
  var dt=dreadTierOf(ex.dread||0);
  /* V0.16: the moment of greed — the numbers ARE the drama */
  UI.overlay(
    '<h3>BANK THE RUN?</h3>'+
    '<div class="ex-split">'+
    '<div class="ex-col"><span>Secured</span><b>'+banked+'g</b></div>'+
    '<div class="ex-col risk"><span>Unbanked</span><b>'+unbanked+'g</b></div>'+
    '</div>'+
    (unbanked>0?'<p class="ex-warn">⚠ Walking out keeps ALL of it — the floor is the price.</p>':'<p>The floor stays uncleared. The Tower keeps the stairs.</p>')+
    (dt.id!=='calm'?'<p>Dread '+dt.lab+' ('+(ex.dread||0)+') — pushing on invites its attention.</p>':''),
    [
      {id:'stay',label:'PUSH ON',cls:'danger',cb:function(close){ close(); }},
      {id:'go',label:'EXTRACT — take '+(banked+unbanked)+'g',cls:'gold',cb:function(close){ close(); IT.flow.finishExpedition(false); }}
    ]
  );
}

/* ======================= SCREEN: battle ======================= */
RENDER.battle=function(app,cfg){
  var s=S(); if(!s||!s.expedition){ app.innerHTML='<p class="hint">No active expedition.</p>'; return; }
  MC.used={}; MC.buttons={}; MC.rail=null;   /* V0.6: fresh once-per-battle command state */
  /* V0.5: active floor rule banner (floors 11-20) — combat logs its own line */
  var rule=floorRule(cfg&&cfg.floor);
  var chip=rule
    ?'<div class="rulechip rc-'+rule.id+'"><b>'+rule.icon+' '+rule.name+'</b><span>'+rule.desc+'</span></div>'
    :'';
  app.innerHTML=chip+'<div id="battle-view"></div>';
  var view=UI.el('battle-view');
  var start=mod('combat','start');
  if(!start){
    if(view) view.innerHTML='<div class="moderr"><b>COMBAT MODULE MISSING</b><br>js/combat.js is not loaded. The fight is skipped (no loot).</div>'+
      '<div class="rowbtns"><button class="act" id="bt-skip">Back to map</button></div>';
    var b=UI.el('bt-skip');
    if(b) b.onclick=function(){ IT.flow.nodeDone({text:'No battle engine — node left uncleared.'}); };
    return;
  }
  var p;
  try{ p=start.call(IT.combat,cfg); }
  catch(e){
    hardFail('IT.combat.start() threw: '+(e&&e.message));
    if(view) view.innerHTML='<div class="moderr"><b>COMBAT MODULE ERROR</b><br>'+esc(e&&e.message)+'</div>';
    return;
  }
  if(p&&typeof p.then==='function'){
    /* V0.6: ui rail only when combat does NOT own the command buttons */
    if(!combatOwnsCommandButtons()) mountCommandRail(view);
    p.then(function(result){ IT.flow._afterCombat(result||{},cfg); })
     .catch(function(err){
       hardFail('combat promise rejected: '+(err&&err.message||err));
       IT.flow._afterCombat({win:true,retreated:false,deaths:[],expGained:{},killsGained:{}},cfg);
     });
  }else{
    hardFail('IT.combat.start() did not return a Promise.');
  }
};

/* ======================= SCREEN: result ======================= */
RENDER.result=function(app,info){
  var i=info||{};
  /* title card — the outcome gets the full-bleed treatment */
  var title,sub,cls;
  if(i.wonWall){
    title='THE WALL BREAKS'; cls='win';
    sub=(i.blind?'Floor '+i.floor+' · beaten blind. Legendary.':'Floor '+i.floor+' — beyond it, the Tower keeps climbing');
  }else if(i.hollowWon){
    title='THE HOLLOW KING FALLS'; cls='win';
    sub='Floor '+i.floor+' — the throne at the bottom stands empty';
  }else if(i.win){
    title='FLOOR CLEARED'; cls='win';
    sub='Floor '+i.floor+(ruleLabel(i.floor)?' · '+ruleLabel(i.floor):'');
  }else if(i.wiped){
    title='THE PARTY IS LOST'; cls='lose';
    sub='Floor '+i.floor+' keeps them all';
  }else{
    title='WITHDRAWN'; cls='mid';
    sub='Floor '+i.floor+' · the Tower keeps the stairs';
  }
  var html='<div class="exp-scene result-scene">';
  html+='<div class="res-titlecard '+cls+'">'+
    '<div class="rtc-kicker">EXPEDITION LEDGER</div>'+
    '<div class="rtc-big">'+title+'</div>'+
    '<div class="rtc-sub">'+esc(sub)+'</div>'+
    '</div>';

  /* the ledger — parchment rows, gold hairlines */
  html+='<section class="res-ledger">';
  html+='<h3 class="res-kicker">THE LEDGER — FLOOR '+i.floor+(ruleLabel(i.floor)?' · '+ruleLabel(i.floor):'')+'</h3>';
  html+='<div class="rline"><span>Gold recovered</span><b class="gold">+'+(i.lootGold||0)+'g</b></div>';
  if(i.lootPermits) html+='<div class="rline"><span>Permits found</span><b>+'+i.lootPermits+'</b></div>';
  /* V0.10: what the Tower kept */
  if(i.lostGold||i.lostPermits){
    html+='<div class="rline"><span>💀 Lost with the party</span><b style="color:var(--red)">−'+
      (i.lostGold||0)+'g'+((i.lostPermits||0)?' · −'+i.lostPermits+' permit(s)':'')+'</b></div>';
  }
  if(i.lostSup>0){
    html+='<div class="rline"><span>💀 Supplies lost</span><b style="color:var(--red)">−'+i.lostSup+' item(s) — the bag died with them</b></div>';
  }
  if(i.dreadPeak>=76) html+='<div class="rline"><span>🩸 Dread reached</span><b style="color:var(--red)">PANIC ('+i.dreadPeak+')</b></div>';
  if(i.clearGold) html+='<div class="rline"><span>Clear bounty (Floor '+i.floor+')</span><b class="gold">+'+i.clearGold+'g</b></div>';
  if(i.clearPermits) html+='<div class="rline"><span>Clear permits</span><b>+'+i.clearPermits+'</b></div>';
  if(i.masterGain) html+='<div class="rline"><span>👑 Master exp</span><b class="gold">+'+i.masterGain+' exp</b></div>';
  if(i.masterTo) html+='<div class="rline"><span>👑 MASTER</span><b style="color:var(--gold)">reaches Lv '+i.masterTo+'</b></div>';
  /* V0.6: what the party leaned on — combat's lastUsage from the final battle */
  if(i.skillUsage&&i.skillUsage.length){
    var top3=i.skillUsage.slice().sort(function(a,b){return b[1]-a[1];}).slice(0,3);
    var T=skillsTable();
    html+='<div class="rline"><span>⚡ The party leaned on</span><b class="lean">'+
      top3.map(function(t){
        var sk=T?(T[t[0]]||null):null;
        return esc(sk&&sk.name?sk.name:t[0])+' ×'+t[1];
      }).join(' · ')+'</b></div>';
  }
  if(i.execUnlocked) html+='<div class="rline"><span>📖 Tower Analysis</span><b>unlocked — the Lobby remembers now</b></div>';
  if(i.hollowUnlocked) html+='<div class="rline"><span>📖 Tower Analysis — Floor 20</span><b>the survivors can explain the throne</b></div>';
  html+='</section>';

  if((i.expRows||[]).length||(i.lvls||[]).length){
    html+='<section class="res-ledger">';
    html+='<h3 class="res-kicker">EXPERIENCE</h3>';
    (i.expRows||[]).forEach(function(r){
      html+='<div class="rline"><span>'+clsIcon(r.cls)+' '+esc(r.name)+'</span><b>+'+r.exp+' exp'+(r.lvl?' · Lv.'+r.lvl:'')+'</b></div>';
    });
    (i.lvls||[]).forEach(function(l){
      html+='<div class="rline"><span>⬆ '+esc(l.name)+'</span><b style="color:var(--green)">Lv.'+l.from+' → Lv.'+l.to+'</b></div>';
    });
    html+='</section>';
  }

  if((i.deaths||[]).length){
    html+='<section class="res-ledger deaths">';
    html+='<h3 class="res-kicker">🪦 THE TOWER COLLECTS</h3>';
    i.deaths.forEach(function(d){
      html+='<div class="res-death">'+
        '<div class="rd-nm">'+clsIcon(d.cls)+' '+esc(d.name)+' <span class="dead-tag">FALLEN</span></div>'+
        '<div class="rd-sub">Lv.'+(d.lvl||1)+' '+esc(d.cls)+' — fell on Floor '+(d.floor||i.floor)+' to <b>'+esc(d.killer)+'</b></div>'+
        '<div class="rd-epi">"'+esc(d.epitaph)+'"</div>'+
        '</div>';
    });
    html+='</section>';
  }

  /* V0.4: survivors carrying grief home */
  if((i.changed||[]).length){
    html+='<section class="res-ledger">';
    html+='<h3 class="res-kicker">🖤 AFTER THE CLIMB</h3>';
    i.changed.forEach(function(c){
      html+='<div class="rline grief"><span>🖤 '+esc(c.name)+'</span><b>returns changed</b></div>';
    });
    html+='</section>';
  }

  html+='<div class="rowbtns"><button class="act big wide gold" id="r-back">Return to Lobby</button></div>';
  html+='</div>';
  app.innerHTML=html;
  /* the outcome gets the full-bleed beat too — pure overlay, r-back stays live */
  showTitleCardBeat('EXPEDITION LEDGER',title,sub,cls,'result-titlecard');
  var b=UI.el('r-back');
  if(b) b.onclick=function(){ IT.flow.toLobby(); };
};


/* ======================= enemies (ported from v0.2 makeEnemies) ======================= */
var LOCAL_MOBS=['Plague Rat','Cave Bat','Goblin Scrapper','Dire Wolf','Bandit','Rattling Skeleton','Orc Raider','Tower Cultist','Flesh Ogre'];
var LOCAL_EPITAPHS=[
  'They went up. They did not come down.',
  'The Tower keeps what it takes.',
  'Somewhere below, a candle burns out.',
  'The Tower remembers.',
  'Their name still echoes in the stairwell.',
  'The Tower was hungrier today.'
];
function mobList(){
  if(window.IT&&IT.DATA&&Array.isArray(IT.DATA.MOBS)&&IT.DATA.MOBS.length) return IT.DATA.MOBS;
  return LOCAL_MOBS;
}
/* node combat encounter; threat 1-5 scales mob power (0.925x … 1.225x).
 * V0.5: floor 20 boss = THE HOLLOW KING; F19 elites ×1.1 like F9;
 * mob names for 11-19 come from IT.DATA.MOBS once core lands them. */
function makeEnemies(floor,node,isBoss){
  node=node||{};
  floor=Number(floor)||1;
  if(isBoss||node.type==='boss'){
    if(floor>=20) return [{name:'THE HOLLOW KING 👑',maxHp:2250,hp:2250,atk:52,def:12,boss:true}];
    return [{name:'THE EXECUTIONER 👹',maxHp:1300,hp:1300,atk:46,def:10,boss:true}];
  }
  var MOBS=mobList();
  var scale=1+(floor-1)*0.28, ascale=1+(floor-1)*0.26, dscale=1+(floor-1)*0.22;
  var count=floor<=4?2:3;
  var tm=0.85+clamp(node.threat||3,1,5)*0.075;
  var list=[];
  for(var i=0;i<count;i++){
    var nm=MOBS[clamp(floor-1,0,MOBS.length-1)], m=tm;
    if(floor>=6&&i===0){ nm='Elite '+nm; m*=1.5; }
    if(floor===9||floor===19) m*=1.1;
    list.push({name:nm,maxHp:Math.round(40*scale*m),hp:Math.round(40*scale*m),
      atk:Math.round(8*ascale*m),def:Math.round(2*dscale*m)});
  }
  return list;
}
function killerLabel(floor){
  if(floor===20) return 'The Hollow King';
  return floor===10?'The Executioner':'Floor '+floor+' denizens';
}

/* ======================= name lookup (roster or memorial) ======================= */
function nameOf(id){
  var h=heroById(id); if(h) return h;
  var s=S();
  var m=((s&&s.memorial)||[]).filter(function(x){return x.id===id;})[0];
  return m||{name:'Hero '+id,cls:'Warrior'};
}

/* ======================= effects application (EXACTLY per contract) ======================= */
function rederive(h){
  if(window.IT&&typeof IT.label==='function'){ try{ h.personality=IT.label(h); }catch(e){} }
  else { h.personality=labelOf(h); }
}
function recordDeathFlow(hero,floor,killer){
  var s=S(); if(!s) return null;
  var wasFirstBlood=!!(s.knowledge&&s.knowledge.firstBlood);
  var mem=null;
  var f=core('recordDeath');
  if(f){
    try{ mem=f.call(IT,hero,floor,killer)||null; }catch(e){ hardFail('IT.recordDeath() threw: '+(e&&e.message)); }
  }
  if(!mem){ /* last-resort fallback so the game never deadlocks */
    mem=Object.assign({},hero,{diedFloor:floor,killer:killer,epitaph:pick(LOCAL_EPITAPHS)});
    s.memorial=s.memorial||[]; s.memorial.push(mem);
    s.heroes=(s.heroes||[]).filter(function(x){return x.id!==hero.id;});
    s.party=(s.party||[]).filter(function(x){return x!==hero.id;});
  }
  RUN.deaths.push({name:hero.name,cls:hero.cls,lvl:hero.lvl||1,floor:floor,
    killer:killer,epitaph:mem.epitaph||pick(LOCAL_EPITAPHS)});
  /* grief: survivors fear +15, loyalty −8 */
  partyHeroes().forEach(function(x){
    x.fear=clamp((x.fear||0)+15,0,100);
    x.loyalty=clamp((x.loyalty||0)-8,0,100);
    rederive(x);
  });
  UI.toast('🪦 '+esc(hero.name)+' falls to '+esc(killer)+'. The survivors look away.');
  if(!wasFirstBlood){
    UI.toast('🪦 <b>"First Time?"</b> — the Tower always collects.');
    s.knowledge=s.knowledge||{}; s.knowledge.firstBlood=true;
  }
  return mem;
}
/* returns array of heroIds that died from hpDmg */
function applyEffects(summary){
  var s=S(); if(!s||!s.expedition) return [];
  var ex=s.expedition, floor=ex.floor;
  var eff=(summary&&summary.effects)||{};
  var died=[];

  /* V0.10 PRESSURE & GREED: found gold/permits ride UNBANKED in the tally —
     they only touch the purse when the party banks (campsite) or walks out
     alive (finishExpedition merges). A wipe drops them. Costs pay from the
     purse first, then carried (unbanked), then secured. */
  if(eff.gold){
    if(eff.gold>0){ ex.tally.gold=(ex.tally.gold||0)+eff.gold; }
    else{
      var need=-eff.gold;
      var fromPurse=Math.min(s.gold,need); s.gold-=fromPurse; need-=fromPurse;
      if(need>0){ var fromCarried=Math.min((ex.tally.gold||0),need); ex.tally.gold=(ex.tally.gold||0)-fromCarried; need-=fromCarried; }
      if(need>0){ ex.bank=ex.bank||{gold:0,permits:0}; var fromBank=Math.min(ex.bank.gold,need); ex.bank.gold-=fromBank; }
    }
  }
  if(eff.permits>0){ ex.tally.permits=(ex.tally.permits||0)+eff.permits; }
  else if(eff.permits<0){ s.permits=Math.max(0,s.permits+eff.permits); }

  function deltas(map,delta){
    if(!map) return;
    for(var id in map){
      var h=heroById(Number(id));
      if(!h) continue;
      h[delta]=clamp((h[delta]||0)+Number(map[id])||0,0,100);
      rederive(h);
    }
  }
  deltas(eff.fear!=null?eff.fear:eff['fearΔ'],'fear');
  deltas(eff.loyalty!=null?eff.loyalty:eff['loyaltyΔ'],'loyalty');

  /* V0.4: bond deltas {'aId|bId': d} — applied through IT.addBond.
     V0.5 BETRAYAL (F17-19): bonds forged under suspicion run deeper — double. */
  var bondMap=eff['bondΔ'];
  if(bondMap){
    var betrayal=(floor>=17&&floor<=19)?2:1;
    for(var bkey in bondMap){
      var bparts=String(bkey).split('|');
      if(bparts.length<2) continue;
      addBondValue(Number(bparts[0]),Number(bparts[1]),(Number(bondMap[bkey])||0)*betrayal);
    }
  }

  var dmg=eff.hpDmg||eff.hp||null;
  if(dmg){
    for(var hid in dmg){
      var h2=heroById(Number(hid));
      if(!h2) continue;
      h2.hp=Math.max(0,h2.hp-Number(dmg[hid]));
      if(h2.hp<=0){ recordDeathFlow(h2,floor,'Floor '+floor+' peril'); died.push(h2.id); }
    }
  }
  if(eff.memory){
    for(var mid in eff.memory){
      var mh=heroById(Number(mid));
      var m=eff.memory[mid]||{};
      if(!mh) continue;
      /* events.js already wrote its memories at resolve time — skip duplicates */
      if((mh.memories||[]).some(function(x){return x&&x.text===String(m.text||'');})) continue;
      var af=core('addMemory');
      if(af){ try{ af.call(IT,mh,m.floor!=null?m.floor:floor,String(m.text||'')); }catch(e){ hardFail('IT.addMemory() threw: '+(e&&e.message)); } }
    }
  }
  if(summary&&summary.reveal||eff.reveal){
    ((ex.map&&ex.map.nodes)||[]).forEach(function(n){ n.scouted=true; });
  }
  var sv=core('save'); if(sv) sv.call(IT);
  UI.updateHeader();
  return died;
}

/* ======================= node completion ======================= */
function completeNode(nodeId,flavor){
  var s=S(); if(!s||!s.expedition){ IT.flow.toLobby(); return; }
  var ex=s.expedition;
  var node=(ex.map.nodes||[]).filter(function(n){return n.id===nodeId;})[0]||{id:nodeId};
  node.cleared=true;
  ex.done=ex.done||{}; ex.done[nodeId]=true;
  ex.lastClearedId=nodeId;
  var sv=core('save'); if(sv) sv.call(IT);
  if(flavor) UI.toast(flavor);
  if(nodeId===ex.map.endId){ IT.flow.finishExpedition(true); }
  else { UI.go('expedition'); }
}

/* ======================= V0.10: PRESSURE & GREED =======================
   DREAD (0-100) + UNBANKED LOOT — one loop, not two features.
   - Every step forward adds dread (combat +12, treasure +7, event +6,
     remains +5); a campsite is the only relief (−30, and it BANKS).
   - Dread TIERS change the situation, not just a stat bar:
       calm 0-25 · uneasy 26-50 (ambush chance) · dread 51-75 (ambush +
     elite) · panic 76-100 (the Tower's attention — empowered enemies).
   - Loot found on the way is UNBANKED: a wipe loses it. A campsite banks
     it. Leaving (anyone alive) keeps it. The map screen shows both numbers
     and the at-risk callout — the player should feel greedy in 1 second. */
var DREAD_TIERS=[
  {id:'calm',  lo:0,  hi:25, lab:'CALM',   col:'#5fbf77'},
  {id:'uneasy',lo:26, hi:50, lab:'UNEASY', col:'#e8b04b'},
  {id:'dread', lo:51, hi:75, lab:'DREAD',  col:'#e0843b'},
  {id:'panic', lo:76, hi:100,lab:'PANIC',  col:'#e05263'}
];
function dreadTierOf(d){
  d=Number(d)||0;
  for(var i=DREAD_TIERS.length-1;i>=0;i--){ if(d>=DREAD_TIERS[i].lo) return DREAD_TIERS[i]; }
  return DREAD_TIERS[0];
}
function applyDread(ex,delta,why){
  if(!ex||!delta) return;
  var before=dreadTierOf(ex.dread||0);
  ex.dread=clamp((ex.dread||0)+delta,0,100);
  var after=dreadTierOf(ex.dread);
  if(after.id!==before.id){
    if(after.id==='panic'){
      trackIt('dread_panic');
      UI.toast('🩸 <b>The Tower\'s attention has found the party.</b> Enemies grow stronger.');
    }else if(after.id==='dread'){
      UI.toast('⚠ The air thickens. Ambushes are possible — camp to bank and breathe.');
    }else if(after.id==='uneasy'&&before.id==='calm'){
      UI.toast('The quiet stops being quiet.');
    }
  }
}
/* campsite: unbanked → secured (a wipe can no longer touch it) */
function bankLoot(ex){
  if(!ex) return {gold:0,permits:0};
  ex.bank=ex.bank||{gold:0,permits:0};
  var g=(ex.tally&&ex.tally.gold)||0, p=(ex.tally&&ex.tally.permits)||0;
  ex.bank.gold+=g; ex.bank.permits+=p;
  if(ex.tally){ ex.tally.gold=0; ex.tally.permits=0; }
  return {gold:g,permits:p};
}

/* ======================= FLOW ======================= */
var FLOW={
  toLobby:function(){ UI.go('lobby'); },
  openTower:function(){ UI.go('tower'); },
  openMemorial:function(){ UI.go('memorial'); },
  heroProfile:function(id){ UI.go('hero',Number(id)); },

  startExpedition:function(floor){
    var s=S();
    if(!s){ UI.toast('No state — cannot start.'); return; }
    floor=Number(floor);
    if(!(floor>=1&&floor<=TOWER_TOP)){ UI.toast('That floor does not exist.'); return; }
    if(s.expedition){ UI.toast('Already on an expedition — finish it first.'); UI.go('expedition'); return; }
    if(floor>1 && !(s.cleared||{})[floor-1]){ UI.toast('Floor '+(floor-1)+' must be cleared first.'); return; }
    var mlNeed=floorMasterNeed(floor);
    if(mlNeed&&masterLv()<mlNeed){
      UI.toast('🔒 Floor '+floor+' is sealed — <b>MASTER Lv '+mlNeed+'</b> required.');
      return;
    }
    var alive=partyHeroes();
    if(!alive.length){ UI.toast('You need at least one living hero in the party.'); UI.go('lobby'); return; }
    var gen=mod('map','gen');
    if(!gen) return;
    var map;
    try{ map=gen.call(IT.map,floor); }catch(e){ hardFail('IT.map.gen() threw: '+(e&&e.message)); return; }
    if(!map||!Array.isArray(map.nodes)||!map.nodes.length||map.startId==null){
      hardFail('IT.map.gen() returned an invalid map.');
      return;
    }
    RUN.deaths=[]; RUN.lvls=[]; RUN.bossFought=false;
    RUN.blindWall=(floor===10 && !(s.knowledge&&s.knowledge.executioner));
    s.expedition={floor:floor,map:map,curId:map.startId,done:{},
      tally:{gold:0,permits:0,exp:{}},
      dread:0, bank:{gold:0,permits:0}};   /* V0.10: pressure & greed */
    /* V0.7 telemetry: the run is live — count it, plus the <60s comeback
       metric (a start hot on the heels of the previous run's end). */
    trackIt('run_started');
    if(TELE.lastRunEndedAt!=null && (Date.now()-TELE.lastRunEndedAt)<60000) trackIt('second_run');
    /* 🌑 DARKNESS (F11-13): every hero fear+5 the moment they step in */
    var rule=floorRule(floor);
    if(rule&&rule.id==='dark'){
      partyHeroes().forEach(function(h){
        h.fear=clamp((h.fear||0)+5,0,100);
        rederive(h);
      });
      UI.toast('🌑 The dark is absolute. Fear creeps in. (fear +5)');
    }
    var sv=core('save'); if(sv) sv.call(IT);
    UI.updateHeader();
    UI.go('expedition');
    scoutOffer();
    /* V0.30b: the party walks into the FIRST node on its own — the player
       commands, they don't click through the start tile. (1.6s lets the
       floor title card finish its beat first.) */
    setTimeout(function(){
      var st=S();
      if(st&&st.expedition&&st.expedition.map===map&&!st.expedition.done[map.startId]){
        IT.flow.enterNode(map.startId);
      }
    },1600);
  },

  enterNode:function(id){
    var s=S();
    if(!s||!s.expedition){ UI.toast('No active expedition.'); IT.flow.toLobby(); return; }
    /* map.render fires onEnter(nodeObject); callers may also pass a bare id */
    if(id&&typeof id==='object') id=id.id;
    var ex=s.expedition;
    var node=(ex.map.nodes||[]).filter(function(n){return n.id===id;})[0];
    if(!node){ UI.toast('Unknown node.'); return; }
    if(node.cleared||(ex.done||{})[id]){ UI.toast('Already cleared.'); return; }
    var reach=mod('map','reachable');
    if(reach){
      try{
        var ids=reach.call(IT.map,ex.map)||[];
        if(ids.indexOf(id)<0){ UI.toast('Not reachable — clear the path first.'); return; }
      }catch(e){ hardFail('IT.map.reachable() threw: '+(e&&e.message)); }
    }
    ex.curId=id;
    /* V0.10: every step forward feeds the Tower's attention (rest is the
       only relief — handled in showRest) */
    var dAdd={'combat':12,'boss':12,'treasure':7,'event':6,'remains':5}[node.type]||0;
    if(dAdd) applyDread(ex,dAdd);
    var sv=core('save'); if(sv) sv.call(IT);

    /* V0.20: the party WALKS IN first — the map chose where, the room is
       the experience, the decision is the player's. */
    UI.go('expedition',{node:node});
  },

  nodeDone:function(summary){
    summary=summary||{};
    var s=S();
    if(!s||!s.expedition){ IT.flow.toLobby(); return; }
    var ex=s.expedition;
    var nodeId=ex.curId;
    var node=(ex.map.nodes||[]).filter(function(n){return n.id===nodeId;})[0];
    var died=applyEffects(summary);
    if(died.length && !partyHeroes().length){ IT.flow.finishExpedition(false); return; }
    var c=summary.combat;
    if(c && Array.isArray(c.enemies) && c.enemies.length){
      var cfg={enemies:c.enemies,floor:ex.floor,kind:(c.kind||'event'),canRetreat:true,node:node||{id:nodeId},
        dread:(ex.dread||0)};   /* V0.10 */
      if(c.enemies.filter(function(e){return e&&e.boss;}).length) RUN.bossFought=true;
      UI.go('battle',cfg);
      return;
    }
    completeNode(nodeId);
  },

  /* called by the battle screen when IT.combat.start resolves */
  _afterCombat:function(result,cfg){
    result=result||{};
    cfg=cfg||{};
    var s=S();
    if(!s||!s.expedition){ IT.flow.toLobby(); return; }
    var ex=s.expedition;
    var floor=ex.floor;

    /* deaths first (record + grief inside) */
    (result.deaths||[]).forEach(function(id){
      var h=heroById(id);
      if(h) recordDeathFlow(h,floor,killerLabel(floor));
    });

    /* exp + kills for survivors; combat reports bounty only — win bonus is ours (v0.2 parity) */
    var winBonus=result.win?floor*15:0;
    partyHeroes().forEach(function(h){
      var amt=(Number((result.expGained||{})[h.id])||0)+winBonus;
      if(amt>0){
        ex.tally.exp=ex.tally.exp||{};
        ex.tally.exp[h.id]=(ex.tally.exp[h.id]||0)+amt;
        var gf=core('grantExp');
        if(gf){
          var before=h.lvl||1, gained=0;
          try{ gained=gf.call(IT,h,amt)||0; }catch(e){ hardFail('IT.grantExp() threw: '+(e&&e.message)); }
          if(gained>0){
            RUN.lvls.push({name:h.name,from:before,to:h.lvl});
            UI.toast('⬆ '+esc(h.name)+' reaches Lv.'+h.lvl);
          }
        }
      }
      var kg=Number((result.killsGained||{})[h.id])||0;
      if(kg>0) h.kills=(h.kills||0)+kg;
    });

    var sv=core('save'); if(sv) sv.call(IT);
    UI.updateHeader();

    if(!partyHeroes().length){ IT.flow.finishExpedition(false); return; }

    if(result.retreated){
      UI.toast('🏳 The party pulls back. The node stays uncleared.');
      ex.curId=ex.lastClearedId||ex.map.startId;
      var sv2=core('save'); if(sv2) sv2.call(IT);
      UI.go('expedition');
      return;
    }
    if(result.win){
      var nodeId=(cfg.node&&cfg.node.id!=null)?cfg.node.id:ex.curId;
      completeNode(nodeId);
      return;
    }
    /* neither win nor retreat but party alive → treat as withdrawal to map */
    UI.go('expedition');
  },

  finishExpedition:function(win){
    var s=S();
    if(!s||!s.expedition){ IT.flow.toLobby(); return; }
    var ex=s.expedition;
    var floor=ex.floor;
    var wiped=partyHeroes().length===0;

    /* V0.7 telemetry: the run ends here whatever the outcome (run_ended —
       also arms the second_run clock); a win additionally marks the floor
       itself cleared. Early-return paths above mean no run was live. */
    if(win) trackIt('floor_cleared');
    trackIt('run_ended');
    TELE.lastRunEndedAt=Date.now();

    var clearGold=0, clearPermits=0, masterGain=0, masterLvl=null;
    if(win){
      clearGold=floorClearGold(floor);        /* V0.5: IT.floorClearGold(n), fallback contract */
      clearPermits=floorClearPermits(floor);  /* V0.5: IT.floorClearPermits(n) */
      s.gold+=clearGold; s.permits+=clearPermits;
      s.cleared=s.cleared||{}; s.cleared[floor]=true;
      /* V0.5 master exp: n×8, +60 extra on the milestone floors 10 and 20 */
      masterGain=floor*8+((floor===10||floor===20)?60:0);
      masterLvl=grantMasterExpFlow(masterGain); /* {from,to} when a level was gained */
    }else if(floor===10 && !(RUN.deaths||[]).length){
      /* economy-sim fix: the Wall bankrupted careful players — a no-casualty
         attempt walks away with a survivor's purse */
      clearGold=175; clearPermits=1;
      s.gold+=clearGold; s.permits+=clearPermits;
      UI.toast('💰 The Tower respects a retreat without casualties. (+175g, +1 permit)');
    }
    var execUnlocked=false;
    if(floor===10 && RUN.bossFought && !(s.knowledge&&s.knowledge.executioner)){
      s.knowledge=s.knowledge||{}; s.knowledge.executioner=true; execUnlocked=true;
    }
    var hollowUnlocked=false;
    if(floor===20 && RUN.bossFought && !(s.knowledge&&s.knowledge.hollowKing)){
      s.knowledge=s.knowledge||{}; s.knowledge.hollowKing=true; hollowUnlocked=true;
    }
    var hollowWon=false;
    if(win&&floor===20){
      hollowWon=true;
      UI.toast('👑 <b>The Hollow King falls.</b>');
    }
    var wonWall=false;
    if(win&&floor===10&&!(s.knowledge&&s.knowledge.wallBroken)){
      s.knowledge=s.knowledge||{}; s.knowledge.wallBroken=true; wonWall=true;
      UI.toast('🏆 <b>The Wall Breaks.</b>');
      if(RUN.blindWall) UI.toast('😱 You beat Floor 10 BLIND. Legendary.');
    }
    if(RUN.deaths.length && !(s.knowledge&&s.knowledge.firstBlood)){
      s.knowledge=s.knowledge||{}; s.knowledge.firstBlood=true;
      UI.toast('🪦 <b>"First Time?"</b> — the Tower always collects.');
    }

    /* exp ledger rows (names survive via roster or memorial) */
    var expRows=[];
    var tex=ex.tally.exp||{};
    for(var hid in tex){
      var amt=tex[hid];
      if(!amt) continue;
      var who=nameOf(Number(hid));
      var lv=null;
      RUN.lvls.forEach(function(l){ if(l.name===who.name) lv=l.to; });
      expRows.push({name:who.name,cls:who.cls,exp:amt,lvl:lv});
    }

    /* V0.4: survivors still grieving when the run ends */
    var changed=[];
    partyHeroes().forEach(function(h2){ if((h2.grieving||0)>0) changed.push({name:h2.name}); });

    /* V0.6: skills the party leaned on (combat telemetry, guarded — final battle) */
    var skillUsage=null;
    try{
      var lu=(window.IT&&IT.combat&&IT.combat.lastUsage)||null;
      if(lu&&typeof lu==='object'){
        skillUsage=[];
        for(var sk in lu){ var cnt=Number(lu[sk])||0; if(cnt>0) skillUsage.push([sk,cnt]); }
        if(!skillUsage.length) skillUsage=null;
      }
    }catch(e){ skillUsage=null; }

    /* V0.10: settle the loot. Alive (win / leave / retreat) = the party
       carried it out: bank + unbanked both merge into the purse. WIPED =
       the Tower keeps what they were carrying — only secured gold survives. */
    ex.bank=ex.bank||{gold:0,permits:0};
    var lostGold=0, lostPermits=0;
    if(wiped){
      lostGold=(ex.tally.gold||0); lostPermits=(ex.tally.permits||0);
      if(lostGold>0||lostPermits>0) trackIt('unbanked_lost');
      ex.tally.gold=0; ex.tally.permits=0;
      /* V0.11: the bag dies with the party */
      var lostSup=(s.supplies&&((s.supplies.potion||0)+(s.supplies.torch||0)+(s.supplies.escape||0)))||0;
      if(lostSup>0){ s.supplies={potion:0,torch:0,escape:0}; trackIt('supplies_lost'); }
    }
    s.gold+=(ex.bank.gold||0)+((ex.tally.gold||0));
    s.permits+=(ex.bank.permits||0)+((ex.tally.permits||0));
    /* the result ledger shows what was actually carried OUT (lost shown separately) */
    ex.tally.gold=(ex.bank.gold||0)+(ex.tally.gold||0);
    ex.tally.permits=(ex.bank.permits||0)+(ex.tally.permits||0);

    s.expedition=null;
    var sv=core('save'); if(sv) sv.call(IT);
    UI.updateHeader();
    UI.go('result',{
      win:!!win, wiped:wiped, floor:floor,
      lootGold:ex.tally.gold||0, lootPermits:ex.tally.permits||0,
      lostGold:lostGold, lostPermits:lostPermits, dreadPeak:ex.dread||0, lostSup:lostSup||0,
      clearGold:clearGold, clearPermits:clearPermits,
      masterGain:masterGain, masterTo:(masterLvl?masterLvl.to:0),
      expRows:expRows, lvls:RUN.lvls.slice(), deaths:RUN.deaths.slice(),
      wonWall:wonWall, blind:(wonWall&&RUN.blindWall), execUnlocked:execUnlocked,
      hollowWon:hollowWon, hollowUnlocked:hollowUnlocked,
      changed:changed, skillUsage:skillUsage
    });
  }
};

function makeCombatCfg(node,ex){
  /* V0.5: the F20 exit is the throne room even if the map labels it 'combat' */
  var isBoss=node.type==='boss'||(ex.floor===20&&node.id===ex.map.endId);
  var enemies=makeEnemies(ex.floor,node,isBoss);
  if(enemies.filter(function(e){return e&&e.boss;}).length) RUN.bossFought=true;
  /* V0.10: the Tower's attention rides into the fight */
  return {enemies:enemies,floor:ex.floor,kind:(isBoss?'boss':'node'),canRetreat:true,node:node,
    dread:(ex.dread||0)};
}

/* ======================= treasure & rest nodes ======================= */
var TREASURE_FLAVOR=[
  'A dead adventurer\'s purse. He won\'t mind.',
  'Coins fused to a melted shield. Still spendable.',
  'Someone stashed this and never came back.',
  'The chest opens easy. That\'s the suspicious part — but nothing moves.',
  'Old gold, older bloodstains.'
];
function showTreasure(node,ex){
  var rf=core('rnd');
  var g=Math.round(rf?rf.call(IT,30,70):rnd(30,70));
  var s=S();
  var greedy=null;
  partyHeroes().forEach(function(h){ if(!greedy||(h.greed||0)>(greedy.greed||0)) greedy=h; });
  var hasGreedy=greedy&&(greedy.greed||0)>=70;
  var flavor=pick(TREASURE_FLAVOR);
  var memHtml='';
  var app=UI.el('exp-content')||UI.el('app');
  app.innerHTML='<div class="exp-scene node-scene treasure-scene">'+
    '<div class="exp-kicker"><span>FLOOR '+ex.floor+'</span><i class="dot"></i><span>A CACHE</span></div>'+
    '<div class="node-moment">'+
    '<div class="node-icon" aria-hidden="true">💰</div>'+
    '<div class="node-title">TREASURE</div>'+
    '<div class="node-amount">+'+g+'<small>g</small></div>'+
    '<p class="node-prose">'+esc(flavor)+'</p>'+
    (hasGreedy?'<p class="node-prose node-quote">"Mine." — '+esc(greedy.name)+' pockets a share before anyone speaks.</p>':'')+
    '<p class="risk-line">⚠ UNBANKED — kept only if the party walks out alive. Camp to secure.</p>'+
    '</div>'+
    '<div class="rowbtns"><button class="act big wide gold" id="t-take">Take it and move on</button></div>'+
    '</div>';
  var b=UI.el('t-take');
  if(b) b.onclick=function(){
    var effects={gold:g};
    if(hasGreedy){
      effects.memory={};
      effects.memory[greedy.id]={floor:ex.floor,text:'Found a cache of '+g+' gold on Floor '+ex.floor+'. It shone like a promise.'};
    }
    IT.flow.nodeDone({text:'The party loots a cache (+'+g+'g).',effects:effects});
  };
}
function showRest(node,ex){
  var s=S();
  var healed=partyHeroes();
  healed.forEach(function(h){
    h.hp=Math.min(h.maxHp,h.hp+Math.round(h.maxHp*0.35));
    h.fear=clamp((h.fear||0)-10,0,100);
    rederive(h);
  });
  /* V0.10: the campsite is the save point — loot banks, dread eases */
  var bankedNow=bankLoot(ex);
  applyDread(ex,-30);
  var sv0=core('save'); if(sv0) sv0.call(IT);
  var names=healed.map(function(h){return esc(h.name);}).join(', ');
  var app=UI.el('exp-content')||UI.el('app');
  app.innerHTML='<div class="exp-scene node-scene rest-scene">'+
    '<div class="exp-kicker"><span>FLOOR '+ex.floor+'</span><i class="dot"></i><span>A MOMENT&rsquo;S PEACE</span></div>'+
    '<div class="node-moment">'+
    '<div class="node-icon fire" aria-hidden="true">🔥</div>'+
    '<div class="node-title">CAMPSITE</div>'+
    '<p class="node-prose">Wounds bound. Watch set. Nobody talks about the stairs.</p>'+
    (healed.length?'<p class="node-prose node-quiet">Healed 35% · fear eases — '+names+'.</p>':'')+
    ((bankedNow.gold||bankedNow.permits)?'<p class="node-prose banked-line">🔒 Secured <b>'+bankedNow.gold+'g</b>'+
      (bankedNow.permits?' and <b>'+bankedNow.permits+' permit(s)</b>':'')+' — a wipe can no longer take it. DREAD eases.</p>':
      '<p class="node-prose banked-line">DREAD eases. The Tower looks elsewhere, for now.</p>')+
    '</div>'+
    '<div class="rowbtns"><button class="act big wide" id="r-go">Break camp</button></div>'+
    '</div>';
  var b=UI.el('r-go');
  if(b) b.onclick=function(){ IT.flow.nodeDone({text:'The party rests by the fire (+35% HP, fear −10).',effects:{}}); };
}

/* ======================= V0.4: remains node =======================
   "WHAT WAS LEFT" — recover a fallen hero's gear or bury them.
   Shown only when S.remains[floor] has an entry; otherwise the node
   degrades to a plain event. */
function showRemains(node,ex){
  var s=S(); if(!s) return;
  var floor=ex.floor;
  var list=(s.remains&&Array.isArray(s.remains[floor]))?s.remains[floor]:[];
  var entry=list[0]||null;
  if(!entry){ /* nothing actually left here — behave as a plain event node */
    UI.go('event',node);
    return;
  }
  var items=Array.isArray(entry.items)?entry.items:[];
  var deadName=entry.heroName||'A fallen hero';
  /* taker: highest-loyalty party member (keeps it simple, per contract) */
  var taker=null;
  partyHeroes().forEach(function(x){ if(!taker||(x.loyalty||0)>(taker.loyalty||0)) taker=x; });

  var gearHtml;
  if(items.length){
    gearHtml='<div class="node-gear">'+items.map(function(it){
      return '<div class="ng-row"><span>'+esc(it.name||'Unknown gear')+'</span>'+
        '<span class="ng-st">'+itemStats(it)+'</span></div>';
    }).join('')+'</div>';
  }else{
    gearHtml='<div class="node-gear"><div class="ng-row"><span>Nothing but rags and a name</span><span class="ng-st"></span></div></div>';
  }

  var app=UI.el('exp-content')||UI.el('app');
  app.innerHTML='<div class="exp-scene node-scene remains-scene">'+
    '<div class="exp-kicker"><span>FLOOR '+floor+'</span><i class="dot"></i><span>WHAT REMAINS</span></div>'+
    '<div class="node-moment">'+
    '<div class="node-icon dim" aria-hidden="true">⚰️</div>'+
    '<div class="node-title small">WHAT WAS LEFT</div>'+
    '<div class="node-name">'+esc(deadName)+'</div>'+
    '<div class="node-sub">Lv.'+(entry.lvl||1)+(entry.cls?' '+esc(entry.cls):'')+' — fell on Floor '+(entry.floor||floor)+'</div>'+
    (entry.epitaph?'<p class="node-quote big">"'+esc(entry.epitaph)+'"</p>':'')+
    gearHtml+
    '</div>'+
    '<div class="map-actions solemn">'+
    '<button class="act" id="rm-take">Take the gear</button>'+
    '<button class="act" id="rm-bury">Bury them properly</button>'+
    '</div>'+
    '</div>';

  function consumeRemains(){
    var arr=(s.remains&&s.remains[floor])||[];
    var idx=arr.indexOf(entry);
    if(idx>=0) arr.splice(idx,1);
    if(arr.length===0&&s.remains) delete s.remains[floor];
  }

  var bt=UI.el('rm-take');
  if(bt) bt.onclick=function(){
    items.forEach(invAdd);
    partyHeroes().forEach(function(x){
      x.fear=clamp((x.fear||0)+5,0,100);
      rederive(x);
    });
    addMemoryFlow(taker,floor,"Recovered "+deadName+"'s gear on F"+floor+".");
    consumeRemains();
    var sv=core('save'); if(sv) sv.call(IT);
    UI.toast('⚰️ The gear is claimed. Nobody meets anyone\'s eyes. (fear +5)');
    completeNode(node.id);
  };
  var bb=UI.el('rm-bury');
  if(bb) bb.onclick=function(){
    /* 🐍 BETRAYAL (F17-19): burial rites bind double */
    var r=floorRule(floor);
    var loyGain=(r&&r.id==='betray')?10:5;
    partyHeroes().forEach(function(x){
      x.fear=clamp((x.fear||0)-10,0,100);
      x.loyalty=clamp((x.loyalty||0)+loyGain,0,100);
      rederive(x);
    });
    addMemoryFlow(taker,floor,'Buried '+deadName+' properly on F'+floor+'.');
    consumeRemains();
    var sv=core('save'); if(sv) sv.call(IT);
    UI.toast('🪦 They buried '+esc(deadName)+'. The Tower lets them. (fear −10, loyalty +'+loyGain+')');
    completeNode(node.id);
  };
}

/* ======================= scout offer ======================= */
function scoutOffer(){
  var s=S(); if(!s||!s.expedition) return;
  var cost=scoutCost(s.expedition.floor);
  if(s.gold<cost){ UI.toast('No gold to scout — entering blind.'); return; }
  UI.overlay(
    '<h3>🔭 SCOUT OFFER</h3>'+
    '<p>Scout a node — <b>'+cost+' gold</b>.<br>Reveal its type and threat before your party commits.</p>'+
    '<p style="font-style:italic">Blind floors are cheaper. And shorter.</p>',
    [
      {id:'scout',label:'🔭 Scout random — '+cost+'g',cls:'gold big',cb:function(close){ close(); scoutRandom(true); }},
      {id:'blind',label:'Enter blind',cls:'',cb:function(close){ close(); }}
    ]
  );
}

/* ======================= intro & boot ======================= */
function showIntro(){
  UI.overlay(
    '<h3>INFINITE TOWER</h3>'+
    '<p>You are the <b style="color:var(--gold)">Master</b>. You do not fight.</p>'+
    '<p>You recruit. You command. You bury.</p>'+
    '<p class="warn">Heroes who fall in the Tower are gone. Forever.</p>'+
    '<p>Floor 10 is called <b style="color:var(--red)">The Wall</b>.<br>No one has come back to explain why.</p>'+
    '<p>Below it, the <b style="color:var(--red)">Deep Tower</b> waits — and it changes the rules.</p>',
    [{id:'go',label:'I UNDERSTAND',cls:'big gold',cb:function(close){
      close();
      UI.toast('The gate is open. Recruit your first hero.');
      UI.go('lobby');
    }}]
  );
}
function normalizeState(){
  var s=S(); if(!s) return;
  s.heroes=Array.isArray(s.heroes)?s.heroes:[];
  s.party=Array.isArray(s.party)?s.party:[];
  s.memorial=Array.isArray(s.memorial)?s.memorial:[];
  s.cleared=s.cleared||{};
  s.knowledge=s.knowledge||{};
  /* V0.5: master progression (core migrates too; belt-and-suspenders for old saves) */
  masterState();
  if(s.expedition){
    var m=s.expedition.map;
    if(!m||!Array.isArray(m.nodes)||!m.nodes.length||m.startId==null){
      UI.toast('⚠ Saved expedition was unreadable — it was discarded.');
      s.expedition=null;
    }
  }
}
function init(){
  var loaded=null;
  if(window.IT&&typeof IT.loadGame==='function'){
    try{ loaded=IT.loadGame(); }catch(e){ hardFail('IT.loadGame() threw: '+(e&&e.message)); }
  }else{
    hardFail('IT.loadGame missing — is js/core.js loaded before js/ui.js?');
  }
  if(loaded&&Array.isArray(loaded.heroes)){ IT.S=loaded; }
  else{
    var ng=core('newGame');
    if(ng){
      var ns=null;
      try{ ns=ng.call(IT); }catch(e){ hardFail('IT.newGame() threw: '+(e&&e.message)); }
      if(ns&&ns.heroes) IT.S=ns;
    }
  }
  if(!IT.S){ hardFail('No game state — boot aborted.'); return; }
  normalizeState();
  UI.updateHeader();
  if(IT.S.expedition){
    UI.toast('Resuming Floor '+IT.S.expedition.floor+' expedition.');
    UI.go('expedition');
  }else{
    UI.go('lobby');
  }
  if(!(IT.S.heroes||[]).length && !IT.S.expedition){ showIntro(); }
}
UI.init=init;

/* ======================= export ======================= */
UI.heroSprite=heroSpriteHtml; /* V0.8: shared sprite figure for FEEL-B/FEEL-C */
IT.ui=UI;
IT.flow=FLOW;
})();

/* bootstrap — scripts sit at end of <body>, so the DOM is already parsed */
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', function () { IT.ui.init(); });
} else {
  IT.ui.init();
}
