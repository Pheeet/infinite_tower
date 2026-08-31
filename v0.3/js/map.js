'use strict';
/* Infinite Tower v0.3/v0.5 — js/map.js (AGENT-B; v0.5 AGENT-F2)
 * Expedition map: generation, scouting, reachability, rendering.
 * v0.5: floors 1-20 (boss end node on 10 AND 20), DARKNESS scout cost
 * (floors 11-13 pay 50g — M.scoutCost(floor); M.ScoutCost stays 25 back-compat).
 * Tokens per CONTRACT.md — bg #0b0d12 card #141822 card2 #1b2130 line #262d3d
 * txt #d7dce6 dim #8b94a7 gold #e8b04b red #e05263 green #5fbf77 blue #5aa2e8
 * No dependencies. No top-level cross-module calls. MapObj survives JSON.
 */

window.IT = window.IT || {};
window.IT.map = window.IT.map || {};

(function (M) {
  var ICONS = { start: '▲', event: '❓', combat: '⚔️', treasure: '💎', rest: '🔥', boss: '👹', remains: '⚰️' };
  var TYPE_BIAS = { combat: 0.6, treasure: 0.3, event: 0, rest: -0.2 }; // threat bias by type
  var STYLE_ID = 'it-map-style';

  var ri = function (a, b) { return a + Math.floor(Math.random() * (b - a + 1)); };
  var clamp = function (v, a, b) { return Math.max(a, Math.min(b, v)); };
  function byId(map, id) {
    for (var i = 0; i < map.nodes.length; i++) if (map.nodes[i].id === id) return map.nodes[i];
    return null;
  }

  /* ============================ GENERATION ============================ */

  // Mid node type roll: event 40% / combat 30% / treasure 15% / rest 15%.
  function rollType() {
    var r = Math.random();
    if (r < 0.40) return 'event';
    if (r < 0.70) return 'combat';
    if (r < 0.85) return 'treasure';
    return 'rest';
  }

  // Threat 1-5, scales with floor (F1 ≈ 1-2, F9-10 ≈ 4-5), slight per-type bias.
  function threatFor(floor, bias) {
    var base = 1 + (floor - 1) * 0.44 + (bias || 0);
    return clamp(Math.round(base + (Math.random() * 1.4 - 0.7)), 1, 5);
  }

  function mkNode(id, type, x, y, threat) {
    return {
      id: id, type: type,
      x: Math.round(x * 10) / 10, y: Math.round(y * 10) / 10,
      threat: clamp(Math.round(threat), 1, 5),
      scouted: false, cleared: false
    };
  }

  // V0.30: grid lanes — 1 node rides the center lane, 2 nodes take the
  // flanks. No jitter: nodes NEVER overlap, the route reads balanced.
  function rowY(count) {
    if (count < 2) return [50];
    return [20, 80];
  }

  /* gen(floor) → MapObj.
   * V0.21 HORIZONTAL ROUTE: start (LEFT) → 3-5 mid COLUMNS × 1-2 nodes
   * (branch up/down) → end (RIGHT; 'boss' on 10/20). Progression reads
   * left→right — the party moves rightward through the Tower, branches go
   * up-right / down-right. Edges still connect adjacent columns only, so
   * every node sits on a start→end path by construction.
   */
  function gen(floor) {
    floor = clamp(Math.floor(Number(floor) || 1), 1, 20);

    var rows = ri(3, 5);
    var minMids = rows === 5 ? 5 : 4;
    var totalMids = ri(minMids, 6);
    var counts = [];
    var i, r;
    for (i = 0; i < rows; i++) counts.push(1);
    var extras = totalMids - rows, guard = 40;
    var preferFirst = true; // bias the extra node toward col 0 → an early fork
    while (extras > 0 && guard-- > 0) {
      var k = (preferFirst && counts[0] < 2) ? 0 : ri(0, rows - 1);
      if (k === 0) preferFirst = false;
      if (counts[k] < 2) { counts[k]++; extras--; }
    }

    var nodes = [];
    var rowIds = [];
    var id = 0;

    var start = mkNode('n' + (id++), 'start', 5, 50, 1);
    start.scouted = true; // you know where you stand
    nodes.push(start);

    var step = (78 - 22) / (rows - 1);
    for (r = 0; r < rows; r++) {
      var x = Math.round(22 + r * step);      // progression → right, grid columns
      var ys = rowY(counts[r]);               // grid lanes: 26 / 50 / 74
      var ids = [];
      for (i = 0; i < counts[r]; i++) {
        var type = rollType();
        var n = mkNode('n' + (id++), type, x, ys[i], threatFor(floor, TYPE_BIAS[type] || 0));
        nodes.push(n);
        ids.push(n.id);
      }
      rowIds.push(ids);
    }

    var bossFloor = (floor === 10 || floor === 20);
    var endType = bossFloor ? 'boss' : 'combat';
    var end = mkNode('n' + (id++), endType, 95, 50, bossFloor ? 5 : threatFor(floor, 1));
    end.scouted = true; // the exit is no secret — only mid rooms hide their nature
    nodes.push(end);

    var edges = [];
    var seen = Object.create(null);
    function E(a, b) {
      if (a === b) return;
      var key = a < b ? a + '|' + b : b + '|' + a;
      if (seen[key]) return;
      seen[key] = 1;
      edges.push([a, b]);
    }
    // Connect row `below` to row `above`. Every above-node gains a parent,
    // every below-node gains a child → no orphans, every node on a start→end path.
    function connect(below, above) {
      if (below.length === 1) { above.forEach(function (b) { E(below[0], b); }); return; } // branch
      if (above.length === 1) { below.forEach(function (a) { E(a, above[0]); }); return; } // merge
      E(below[0], above[0]);
      E(below[1], above[1]);
      if (Math.random() < 0.6) { var j = ri(0, 1); E(below[j], above[1 - j]); } // crossing path
    }

    connect([start.id], rowIds[0]);
    for (r = 0; r < rows - 1; r++) connect(rowIds[r], rowIds[r + 1]);
    connect(rowIds[rows - 1], [end.id]);

    /* v0.4 memory layer: if the fallen wait on this floor, ONE mid node becomes
     * their resting place (type 'remains', icon ⚰️). Prefer the LAST 'event'
     * room — it reads as a quiet chamber; if the floor rolled no events at all,
     * fall back to the last mid node so recovery stays possible. Node keeps its
     * threat/position; reachable/render treat 'remains' like any enterable type. */
    (function placeRemains() {
      var g = (typeof IT !== 'undefined') ? IT : window.IT;
      var st = g && g.S;
      var rem = st && st.remains && st.remains[floor];
      if (!rem || !rem.length) return;
      var mids = nodes.filter(function (n) { return n.id !== start.id && n.id !== end.id; });
      var evs = mids.filter(function (n) { return n.type === 'event'; });
      var pool = evs.length ? evs : mids;
      if (pool.length) pool[pool.length - 1].type = 'remains';
    })();

    return { floor: floor, nodes: nodes, edges: edges, startId: start.id, endId: end.id, grid: 2 };   /* grid v2: lanes 20/50/80 */
  }

  /* V0.30b: relayout(map) — snap an already-generated (or old saved) map
   * onto the grid: column = BFS depth from start, lane = 26/50/74. Purely
   * visual — types, edges, cleared flags untouched. Fixes overlapping nodes
   * from pre-grid saves. */
  function relayout(map) {
    if (!map || !map.nodes || !map.edges) return;
    var adj = Object.create(null);
    map.edges.forEach(function (e) {
      (adj[e[0]] = adj[e[0]] || []).push(e[1]);
      (adj[e[1]] = adj[e[1]] || []).push(e[0]);
    });
    var depth = Object.create(null);
    depth[map.startId] = 0;
    var q = [map.startId];
    while (q.length) {
      var cur = q.shift();
      (adj[cur] || []).forEach(function (nx) {
        if (depth[nx] == null) { depth[nx] = depth[cur] + 1; q.push(nx); }
      });
    }
    var byDepth = Object.create(null), maxD = 0;
    map.nodes.forEach(function (n) {
      if (depth[n.id] == null) depth[n.id] = 1;
      maxD = Math.max(maxD, depth[n.id]);
      (byDepth[depth[n.id]] = byDepth[depth[n.id]] || []).push(n);
    });
    var LANES = [[50], [20, 80], [20, 50, 80]];
    var step = maxD > 1 ? (78 - 22) / (maxD - 1) : 0;
    map.nodes.forEach(function (n) {
      var d = depth[n.id];
      if (n.id === map.startId) { n.x = 5; n.y = 50; return; }
      if (n.id === map.endId) { n.x = 95; n.y = 50; return; }
      var col = byDepth[d];
      n.x = Math.round(22 + (d - 1) * step);
      n.y = col.length <= 3 ? LANES[Math.min(2, col.length - 1)][Math.min(col.indexOf(n), col.length - 1)] : 50;
    });
    map.grid = 2;
  }

  /* ============================ SCOUT / REACHABLE ============================ */

  /* v0.5 DARKNESS rule (floors 11-13): scouting costs 50g instead of 25g.
   * M.ScoutCost stays 25 as the back-compat constant (pre-v0.5 readers);
   * everything new goes through this floor-aware fn. */
  function scoutCost(floor) {
    floor = Math.floor(Number(floor) || 1);
    return (floor >= 11 && floor <= 13) ? 25 : 10;   // economy sim: scout was a value trap at 25/50
  }

  /* scout(map, nodeId) → true/false. Costs scoutCost(map.floor) gold from
   * IT.S, flags the node scouted. False when: node missing, already scouted,
   * or the Master cannot pay. (Runtime dependency on core state only.) */
  function scout(map, nodeId) {
    var n = byId(map, nodeId);
    if (!n || n.scouted) return false;
    var g = (typeof IT !== 'undefined') ? IT : window.IT;
    var S = g && g.S;
    var cost = M.scoutCost(map && map.floor);
    if (!S || typeof S.gold !== 'number' || S.gold < cost) return false;
    S.gold -= cost;
    n.scouted = true;
    if (typeof g.save === 'function') { try { g.save(); } catch (e) { /* best effort */ } }
    return true;
  }

  /* reachable(map) → [nodeId], sorted.
   * Before the start node is cleared you may only enter the start itself.
   * After that: every node adjacent to a cleared node, not cleared itself. */
  function reachable(map) {
    var out = [];
    if (!map || !map.nodes || !map.edges) return out;
    var s = byId(map, map.startId);
    if (!s) return out;
    if (!s.cleared) return [map.startId];
    var ids = Object.create(null);
    map.edges.forEach(function (e) {
      var a = byId(map, e[0]), b = byId(map, e[1]);
      if (!a || !b) return;
      var cand = null;
      if (a.cleared && !b.cleared) cand = b;
      else if (b.cleared && !a.cleared) cand = a;
      if (cand && !ids[cand.id]) { ids[cand.id] = 1; out.push(cand.id); }
    });
    out.sort();
    return out;
  }

  /* ============================ RENDER ============================ */

  var CSS = [
    '.it-mapwrap{position:relative;width:100%;height:100%;min-height:170px;overflow:hidden;',
    'box-sizing:border-box;border:1px solid #262d3d;border-radius:12px;',
    'background:radial-gradient(130% 90% at 50% 108%,#141822 0%,#0b0d12 72%);',
    '-webkit-user-select:none;user-select:none;}',
    '.it-mapsvg{position:absolute;left:0;top:0;width:100%;height:100%;display:block;}',
    '.it-mapsvg line{stroke:#262d3d;stroke-width:.7;stroke-linecap:round;}',
    '.it-mapsvg line.e-live{stroke:#8b94a7;stroke-width:.95;opacity:.85;}',
    '.it-mapwrap .mapnode{position:absolute;transform:translate(-50%,-50%);width:48px;height:48px;',
    'margin:0;padding:0;box-sizing:border-box;border-radius:50%;display:flex;flex-direction:column;',
    'align-items:center;justify-content:center;background:#141822;border:2px solid #262d3d;color:#d7dce6;',
    'font-family:Georgia,serif;line-height:1;cursor:default;-webkit-tap-highlight-color:transparent;',
    'transition:transform .08s ease,box-shadow .15s ease;outline-offset:3px;z-index:2;}',
    '.it-mapwrap .mapnode:focus-visible{outline:2px solid #e8b04b;}',
    '.it-mapwrap .mapnode .ic{font-size:17px;}',
    '.it-mapwrap .mapnode .stars{font-size:8px;letter-spacing:-.5px;margin-top:2px;min-height:8px;}',
    '.it-mapwrap .stars.th1,.it-mapwrap .stars.th2{color:#5fbf77;}',
    '.it-mapwrap .stars.th3{color:#e8b04b;}',
    '.it-mapwrap .stars.th4,.it-mapwrap .stars.th5{color:#e05263;}',
    '.it-mapwrap .mapnode .ic.unknown{color:#8b94a7;font-size:19px;font-weight:700;}',
    '.it-mapwrap .mapnode .ic.done{color:#5fbf77;font-size:20px;}',
    '.it-mapwrap .mapnode.scouted.type-event{border-color:rgba(90,162,232,.75);}',
    '.it-mapwrap .mapnode.scouted.type-combat{border-color:rgba(224,82,99,.75);}',
    '.it-mapwrap .mapnode.scouted.type-treasure{border-color:rgba(232,176,75,.85);}',
    '.it-mapwrap .mapnode.scouted.type-rest{border-color:rgba(95,191,119,.75);}',
    '.it-mapwrap .mapnode.scouted.type-remains{border-color:rgba(139,148,167,.85);}',
    '.it-mapwrap .mapnode.type-start{border-color:#5aa2e8;}',
    '.it-mapwrap .mapnode.type-boss{border-color:#e05263;background:#26121a;}',
    '.it-mapwrap .mapnode.type-boss .ic{font-size:21px;}',
    '.it-mapwrap .mapnode[disabled]{opacity:.8;cursor:default;}',
    '.it-mapwrap .mapnode.reach{cursor:pointer;border-color:#8b94a7;',
    'box-shadow:0 0 10px rgba(139,148,167,.35);}',
    '.it-mapwrap .mapnode.type-boss.reach{box-shadow:0 0 12px rgba(224,82,99,.6);border-color:#e05263;}',
    '.it-mapwrap .mapnode.reach:active{transform:translate(-50%,-50%) scale(.92);}',
    '.it-mapwrap .mapnode.cur{border-color:#e8b04b;',
    'box-shadow:0 0 0 3px #e8b04b,0 0 16px rgba(232,176,75,.5);}',
    '.it-mapwrap .mapnode.cur.reach{box-shadow:0 0 0 3px #e8b04b,0 0 16px rgba(232,176,75,.5),0 0 10px rgba(139,148,167,.35);}',
    '.it-mapwrap .mapnode.cleared{opacity:.4;filter:grayscale(.5);}',
    '.it-mapwrap .mapnode.cleared.cur{opacity:.85;filter:none;}',
    ''
  ].join('\n');

  function injectStyle() {
    if (document.getElementById(STYLE_ID)) return;
    var st = document.createElement('style');
    st.id = STYLE_ID;
    st.textContent = CSS;
    (document.head || document.documentElement).appendChild(st);
  }

  /* render(map, containerEl, onEnter)
   * SVG edge layer (viewBox 0 0 100 100) + absolutely-positioned HTML node
   * buttons at x%/y% on top. Only reachable nodes are enabled; clicking one
   * fires onEnter(nodeObject) — re-validated against reachable() at click time.
   * Current position (gold ring) is read from IT.S.expedition.curId when the
   * expedition owns this map, else from an optional map.curId. */
  function render(map, containerEl, onEnter) {
    if (typeof document === 'undefined' || !map || !containerEl) return;
    injectStyle();

    var reach = M.reachable(map);
    var reachSet = Object.create(null);
    reach.forEach(function (id) { reachSet[id] = 1; });

    var idx = Object.create(null);
    map.nodes.forEach(function (n) { idx[n.id] = n; });

    var curId = null;
    var g = (typeof IT !== 'undefined') ? IT : window.IT;
    if (g && g.S && g.S.expedition && g.S.expedition.map === map) curId = g.S.expedition.curId || null;
    if (!curId && map.curId) curId = map.curId;

    var html = '<div class="it-mapwrap">';
    html += '<svg class="it-mapsvg" viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">';
    map.edges.forEach(function (e) {
      var a = idx[e[0]], b = idx[e[1]];
      if (!a || !b) return;
      var live = reachSet[a.id] || reachSet[b.id];
      html += '<line x1="' + a.x + '" y1="' + a.y + '" x2="' + b.x + '" y2="' + b.y + '"' +
        (live ? ' class="e-live"' : '') + '/>';
    });
    html += '</svg>';

    map.nodes.forEach(function (n) {
      var isEnd = n.id === map.endId;
      var cls = 'mapnode type-' + n.type + (n.scouted ? ' scouted' : ' unscouted');
      if (n.cleared) cls += ' cleared';
      if (n.id === curId) cls += ' cur';
      if (reachSet[n.id]) cls += ' reach';

      var inner, label;
      if (n.cleared) {
        inner = '<span class="ic done">✓</span>';
        label = 'cleared room';
      } else if (!n.scouted) {
        inner = '<span class="ic unknown">?</span>';
        label = 'unknown room';
      } else {
        var ic = (isEnd || n.type === 'boss') ? ICONS.boss : (ICONS[n.type] || '?');
        var stars = '';
        for (var s = 0; s < n.threat; s++) stars += '★';
        inner = '<span class="ic">' + ic + '</span><span class="stars th' + n.threat + '">' + stars + '</span>';
        label = (isEnd ? (n.type === 'boss' ? 'boss lair' : 'stairway fight') : n.type) + ', threat ' + n.threat;
      }

      html += '<button type="button" class="' + cls + '" data-id="' + n.id + '" data-type="' + n.type +
        '" data-threat="' + n.threat + '" style="left:' + n.x + '%;top:' + n.y + '%;"' +
        (reachSet[n.id] ? '' : ' disabled') + ' aria-label="' + label + '">' + inner + '</button>';
    });
    html += '</div>';

    containerEl.innerHTML = html;

    if (typeof onEnter !== 'function') return;
    var btns = containerEl.querySelectorAll('.mapnode');
    Array.prototype.forEach.call(btns, function (btn) {
      btn.addEventListener('click', function () {
        var n = idx[btn.getAttribute('data-id')];
        if (!n) return;
        var now = M.reachable(map); // stale-UI guard
        for (var i = 0; i < now.length; i++) {
          if (now[i] === n.id) { onEnter(n); return; }
        }
      });
    });
  }

  /* ============================ EXPORT ============================ */

  M.relayout = relayout;
  M.ScoutCost = 25;   // back-compat constant (floors 1-10 base price)
  M.scoutCost = scoutCost; // v0.5: floor-aware (DARKNESS F11-13 → 50)
  M.gen = gen;
  M.scout = scout;
  M.render = render;
  M.reachable = reachable;

})(window.IT.map);
