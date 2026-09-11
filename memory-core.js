/* Shared rules: the browser uses these offline; the server owns online matches. */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.MemoryRules = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  const COLS = 5, ROWS = 9, ONLINE_ROWS = 10, INTRO_MS = 5000, RULES_VERSION = 7;
  const bounded = (v, a, b) => Math.max(a, Math.min(b, v));
  function splashDuration(count) {
    const n = Number(count);
    return 2200 + 150 * (bounded(Number.isFinite(n) ? Math.floor(n) : 1, 1, 8) - 1);
  }
  function settings(round, difficulty) {
    const n = Math.max(1, round), insane = difficulty === 'insane';
    const extra = Math.min(16, Math.floor((n - 1) / 2) + (insane ? 4 : 2));
    const length = 9 + extra;
    // Keep the original reveal curve. Only the physical collapse runs at half speed.
    const level = n + (insane ? 10 : 3), relief = n >= 15 && n % 5 === 0;
    const pace = relief ? .24 : Math.max(.06, .40 - (level - 1) * .024);
    const originalRowRate = relief ? Math.max(.44, .70 - (n - 15) * .004) : Math.max(.34, .75 - (level - 2) * .013);
    let show = Math.max(1.5, 6.6 - (level - 1) * .235);
    if (relief) show = Math.min(5.5, show + 1.1);
    show = Math.max(show, pace * length + .4);
    return { length, extra, pace, show, rowRate: originalRowRate * 2, fallDelay: 6,
      fallWarn: .8, fallGone: 1.6, limit: (3 + (ROWS - 1) * originalRowRate + .8) * 2 };
  }
  // An induced path has no touching cells except successive steps. A horizontal
  // run may continue in the same direction on the next row, but can reverse only
  // after a straight connector row. This leaves an empty row between switchbacks
  // instead of drawing confusing parallel tracks or filled 2-by-2 corners.
  const routeModels = new Map(), routeHistory = new WeakMap();
  function routeModel(extra) {
    if (routeModels.has(extra)) return routeModels.get(extra);
    const memo = new Map();
    function count(row, col, left, previousDirection) {
      if (row === 0) return left === 0 ? 1 : 0;
      if (left < 0 || left > row * (COLS - 1)) return 0;
      const key = [row, col, left, previousDirection].join(':');
      if (memo.has(key)) return memo.get(key);
      let total = 0;
      for (let target = 0; target < COLS; target++) {
        const direction = Math.sign(target - col), steps = Math.abs(target - col);
        if (steps > left || (direction && previousDirection && direction !== previousDirection)) continue;
        total += count(row - 1, target, left - steps, direction);
      }
      memo.set(key, total); return total;
    }
    const starts = Array.from({ length: COLS }, (_, col) => count(ROWS - 1, col, extra, 0));
    const total = starts.reduce((a, b) => a + b, 0);
    // A coprime stride visits unrelated ranks first and cannot repeat a rank.
    // This also keeps fallback selection useful with an injected constant RNG.
    const gcd = (a, b) => { while (b) { const next = a % b; a = b; b = next; } return a; };
    let stride = Math.max(1, Math.floor(total * .61803398875));
    while (gcd(stride, total) !== 1) stride++;
    const model = { count, starts, total, extra, stride };
    routeModels.set(extra, model); return model;
  }
  function routeIndex(model, random) {
    const value = Number(random());
    return Math.min(model.total - 1, Math.floor((Number.isFinite(value) ? bounded(value, 0, 1) : 0) * model.total));
  }
  function routeAt(model, rank) {
    let col = 0, left = model.extra, previousDirection = 0;
    while (rank >= model.starts[col]) rank -= model.starts[col++];
    const path = [[col, ROWS - 1]];
    for (let row = ROWS - 1; row >= 1; row--) {
      for (let target = 0; target < COLS; target++) {
        const direction = Math.sign(target - col), steps = Math.abs(target - col);
        if (steps > left || (direction && previousDirection && direction !== previousDirection)) continue;
        const choices = model.count(row - 1, target, left - steps, direction);
        if (rank >= choices) { rank -= choices; continue; }
        for (let i = 0; i < steps; i++) { col += direction; path.push([col, row]); }
        left -= steps; previousDirection = direction; path.push([col, row - 1]); break;
      }
    }
    return path;
  }
  function variedModel(config, random) {
    // The old exact-length target eventually filled every available turn,
    // forcing nearly identical edge-to-edge sweeps. Choose the length first,
    // rather than favouring lengths merely because they have more routes.
    // Keep short, medium and longer shapes available even on late waves; the
    // original clock/reveal settings remain independent of this choice.
    const maximum = Math.min(12, config.extra), minimum = Math.max(1, Math.floor(maximum / 3));
    const extra = minimum + routeIndex({ total: maximum - minimum + 1 }, random);
    return routeModel(extra);
  }
  function routeShape(path) {
    const runs = Array(ROWS - 1).fill(0);
    for (let i = 1; i < path.length; i++) if (path[i][1] === path[i - 1][1])
      runs[ROWS - 1 - path[i][1]] += path[i][0] - path[i - 1][0];
    const forward = runs.join(','), mirrored = runs.map(n => -n).join(',');
    return forward < mirrored ? forward : mirrored;
  }
  function chooseRoute(model, random, used, history) {
    const initial = routeIndex(model, random);
    let fallback = null;
    // Eight seats and three recent shapes per seat need only a small bounded
    // candidate pool. Prefer a new silhouette, including mirror/column shifts.
    for (let i = 0; i < Math.min(model.total, 64); i++) {
      const rank = (initial + i * model.stride) % model.total;
      if (used.has(rank)) continue;
      const path = routeAt(model, rank), shape = routeShape(path), candidate = { rank, path, shape };
      if (!fallback) fallback = candidate;
      if (!history.includes(shape)) return candidate;
    }
    return fallback;
  }
  function pattern(round, difficulty, random = Math.random) {
    const model = variedModel(settings(round, difficulty), random);
    return routeAt(model, routeIndex(model, random));
  }
  function player(info) {
    return { id: info.id, name: String(info.name || 'PLAYER').slice(0, 12), char: info.char || 'miner',
      lives: 3, score: 0, cleared: 0, progress: 0, maxProgress: 0, status: 'waiting',
      pos: [2, ROWS - 1], path: [], connected: true, lastSeen: 0 };
  }
  function makeMatch(players, difficulty, now, random = Math.random, solo = false) {
    const match = { players: players.map(player), difficulty: difficulty === 'insane' ? 'insane' : 'normal',
      solo, round: 1, phase: 'playing', sudden: false, suddenIds: [], startedAt: now, splashMs: splashDuration(players.length),
      finishedAt: 0, results: [], nextAt: 0, settleAt: 0, version: 1 };
    beginRound(match, now, random, true);
    return match;
  }
  function beginRound(m, now, random = Math.random, first = false) {
    m.config = settings(m.round, m.difficulty);
    m.config.rows = m.solo ? ROWS : ONLINE_ROWS; m.config.safeRows = m.solo ? 0 : 2;
    // The identity splash precedes Don't Blink. Both client and server retain
    // the full reveal/solve time; later waves keep their original transition.
    m.showAt = now + (first ? m.splashMs + INTRO_MS : 700);
    m.runAt = m.showAt + m.config.show * 1000;
    m.phase = 'playing'; m.nextAt = 0; m.settleAt = 0;
    // Every participant receives the same step budget on this wave, with a
    // separate private path. Length varies between waves, never between seats.
    const used = new Set(), model = variedModel(m.config, random);
    m.config.pathLength = ROWS + model.extra;
    for (const p of m.players) {
      if (p.lives <= 0) continue;
      const history = routeHistory.get(p) || [], route = chooseRoute(model, random, used, history);
      used.add(route.rank); p.path = route.path;
      routeHistory.set(p, [route.shape, ...history].slice(0, 3));
      if (!m.solo) p.path = p.path.map(([c,r]) => [c,r+1]);
      p.pos = p.path[0].slice();
      p.progress = 0; p.maxProgress = 0; p.status = 'solving'; p.readyAt = m.runAt;
      p.showAt = m.showAt; p.deadline = m.runAt + m.config.limit * 1000;
      p.emote = null; p.spectating = null; p.lastMoveAt = -Infinity; p.failedAt = 0; p.failedPos = null; p.fallElapsed = 0;
    }
    m.version++;
  }
  function finish(m, now, candidates) {
    const preferred = candidates || m.players.filter(p => p.lives > 0);
    const ids = new Set(preferred.map(p => p.id));
    const order = m.players.slice().sort((a, b) => Number(ids.has(b.id)) - Number(ids.has(a.id)) ||
      (b.eliminatedRound || m.round) - (a.eliminatedRound || m.round) || b.maxProgress - a.maxProgress ||
      b.score - a.score || a.id.localeCompare(b.id));
    const top = order[0];
    const winners = preferred.length === 1 ? [preferred[0]] : preferred.filter(p =>
      p.maxProgress === top.maxProgress && p.score === top.score);
    m.winnerIds = winners.map(p => p.id);
    m.results = order.map((p, i) => ({ id: p.id, name: p.name, char: p.char,
      place: m.winnerIds.includes(p.id) ? 1 : i + 1, winner: m.winnerIds.includes(p.id),
      round: p.eliminatedRound || m.round, cleared: p.cleared, score: p.score, lives: p.lives,
      progress: p.maxProgress, total: Math.max(1, p.path.length - 1) }));
    m.phase = 'finished'; m.finishedAt = now; m.version++;
  }
  function fail(m, p, now) {
    if (p.status !== 'solving') return;
    p.lives--; p.failedAt = now; p.fallElapsed = Math.max(0, (now - p.readyAt) / 1000 - m.config.fallDelay);
    p.failedPos = p.pos.slice();
    if (p.lives <= 0) {
      p.status = 'eliminated'; p.eliminatedAt = now; p.eliminatedRound = m.round;
      if (m.players.filter(q => q.lives > 0).length <= 1 && !m.settleAt) m.settleAt = now + 350;
    } else p.status = 'out';
    // One attempt per wave: retain the failed position only for the brief blast,
    // then wait (or watch) until everyone has either arrived or lost this attempt.
    p.spectating = null; p.emote = null;
    m.version++;
  }
  function rowAge(config, row, elapsed) {
    if (row < (config.safeRows || 0)) return -Infinity;
    return elapsed - config.fallDelay - ((config.rows || ROWS) - 1 - row) * config.rowRate;
  }
  function hasFallen(m, p, row, now) {
    return rowAge(m.config, row, (now - p.readyAt) / 1000) >= m.config.fallGone;
  }
  function tick(m, now, random = Math.random) {
    if (m.phase === 'finished') return;
    for (const p of m.players) {
      if (p.status === 'solving' && now >= p.readyAt && hasFallen(m, p, p.pos[1], now)) fail(m, p, now);
    }
    const alive = m.players.filter(p => p.lives > 0);
    if (m.solo && !alive.length) { finish(m, now, [m.players[0]]); return; }
    // Resolve the final elimination before scheduling or entering another wave.
    // The 350 ms window still lets simultaneous final failures share sudden death.
    if (!m.solo && m.settleAt && alive.length <= 1) {
      if (now < m.settleAt) return;
      if (alive.length === 1) { finish(m, now, alive); return; }
      const last = Math.max(...m.players.map(p => p.eliminatedAt || 0));
      const tied = m.players.filter(p => last - (p.eliminatedAt || 0) <= 350 && p.connected);
      if (tied.length > 1 && !m.sudden) {
        m.sudden = true; m.suddenIds = tied.map(p => p.id);
        for (const p of tied) { p.lives = 1; delete p.eliminatedRound; }
        m.round++; beginRound(m, now, random); m.showAt += 1200; m.runAt += 1200;
        for (const p of tied) { p.showAt += 1200; p.readyAt += 1200; p.deadline += 1200; }
      } else finish(m, now, tied.length ? tied : m.players.filter(p => p.eliminatedAt === last));
      return;
    }
    if (m.phase === 'transition') {
      if (now >= m.nextAt) { m.round++; beginRound(m, now, random); }
      return;
    }
    if (alive.length && alive.every(p => p.status === 'cleared' || p.status === 'out')) {
      m.phase = 'transition'; m.nextAt = now + (m.solo ? 850 : 1100); m.version++;
    }
  }
  function move(m, id, dx, dy, now) {
    const p = m.players.find(p => p.id === id);
    if (!p || m.phase === 'finished' || !Number.isInteger(dx) || !Number.isInteger(dy) || Math.abs(dx) + Math.abs(dy) !== 1) return false;
    if (now - p.lastMoveAt < 80) return false;
    if (!m.solo && p.status === 'cleared' && m.phase === 'playing') {
      const next = [p.pos[0]+dx,p.pos[1]+dy];
      if (next[0]<0 || next[0]>=COLS || next[1]<0 || next[1]>=2) return false;
      p.pos=next;p.lastMoveAt=now;m.version++;return true;
    }
    if (m.phase !== 'playing' || p.status !== 'solving' || now < p.readyAt) return false;
    if (hasFallen(m, p, p.pos[1], now)) { fail(m, p, now); return false; }
    const next = [p.pos[0] + dx, p.pos[1] + dy];
    if (next[0] < 0 || next[0] >= COLS || next[1] < 0 || next[1] >= (m.config.rows || ROWS)) return false;
    p.lastMoveAt = now;
    const expected = p.path[p.progress + 1];
    if (!expected || next[0] !== expected[0] || next[1] !== expected[1] || hasFallen(m, p, next[1], now)) {
      p.pos = next; fail(m, p, now); return false;
    }
    p.progress++; p.maxProgress = Math.max(p.maxProgress, p.progress); p.pos = next;
    if (next[1] === (m.solo ? 0 : 1)) {
      p.status = 'cleared'; p.cleared++;
      if (!m.solo) { const slot=m.players.indexOf(p); p.pos=[slot%COLS,Math.floor(slot/COLS)]; } p.finishedAt = now;
      p.score += 100 * m.round + p.lives * 25 + Math.floor(Math.max(0, p.deadline - now) / 100);
    }
    m.version++; return true;
  }
  function disconnect(m, id, now) {
    const p = m.players.find(p => p.id === id); if (!p || m.phase === 'finished') return;
    p.connected = false;
    if (p.lives > 0) { p.lives = 1; p.status = 'solving'; fail(m, p, now); }
  }
  // Original game's seven circular emote sprites, in its original picker order.
  const EMOTES = [0,4,1,3,2,5,6];
  function emote(m,id,value,now) {
    const p=m.players.find(p=>p.id===id);
    if(m.solo||m.phase!=='playing'||!p||p.status!=='cleared'||!Number.isInteger(value)||!EMOTES.includes(value)||now-(p.emoteAt||0)<1200)return false;
    p.emote={value,at:now,until:now+2600};p.emoteAt=now;m.version++;return true;
  }
  function spectate(m,id,target) {
    const p=m.players.find(p=>p.id===id),q=m.players.find(p=>p.id===target&&p.lives>0&&(p.status==='solving'||p.status==='cleared'));
    if(m.solo||!p||(p.status!=='eliminated'&&p.status!=='out'&&p.status!=='cleared')||!q)return false;
    p.spectating=q.id;return true;
  }
  function snapshot(m, id, now) {
    const me = m.players.find(p => p.id === id); if (!me) return null;
    const social = me.status === 'cleared' || me.status === 'out' || me.status === 'eliminated' || m.phase === 'finished';
    const alive = m.players.filter(p=>p.lives>0), below=alive.filter(p=>p.status==='solving');
    const watchable = alive.filter(p=>p.status==='solving'||p.status==='cleared');
    const publicPlayer = p => ({ id:p.id,name:p.name,char:p.char,lives:p.lives,status:p.status,
      pos:p.pos.slice(),connected:p.connected,score:p.score,
      emote:p.emote&&p.emote.until>now?{...p.emote}:null });
    const board = p => ({...publicPlayer(p),path:now<p.readyAt||m.phase==='finished'?p.path.map(c=>c.slice()):null,
      round:p.eliminatedRound||m.round,progress:p.progress,maxProgress:p.maxProgress,
      showAt:p.showAt,readyAt:p.readyAt,deadline:p.deadline,failedAt:p.failedAt||0,
      failedPos:p.failedPos||null,fallElapsed:p.fallElapsed||0,cleared:p.cleared});
    // Winners of this wave may observe another player's board, including its
    // collapse, but never receive their answer or route progress.
    const publicBoard = p => ({...publicPlayer(p),round:p.eliminatedRound||m.round,
      showAt:p.showAt,readyAt:p.readyAt,deadline:p.deadline,failedAt:p.failedAt||0,
      failedPos:p.failedPos?p.failedPos.slice():null,fallElapsed:p.fallElapsed||0});
    // A player whose attempt ended can only watch participants still on this
    // wave. No failed player's old answer can become a spectator target.
    let watching=null;
    if(!m.solo&&(me.status==='eliminated'||me.status==='out'||me.status==='cleared')&&watchable.length){
      let target=watchable.find(p=>p.id===me.spectating);
      if(!target){const candidates=below.length?below:watchable;target=candidates[Math.floor(Math.random()*candidates.length)];me.spectating=target.id;}
      watching=me.status==='cleared'?publicBoard(target):board(target);
    }
    return {rulesVersion:RULES_VERSION,version:m.version,startedAt:m.startedAt,splashMs:m.splashMs,serverNow:now,phase:m.phase,difficulty:m.difficulty,solo:m.solo,
      introRoster:m.players.map(p=>({id:p.id,name:p.name,char:p.char})),
      ...(m.vsCpu !== undefined ? {vsCpu:!!m.vsCpu,cpuDifficulty:m.cpuDifficulty} : {}),
      round:m.round,sudden:m.sudden,showAt:m.showAt,runAt:m.runAt,nextAt:m.nextAt,
      alive:alive.length,pending:below.length,total:m.players.length,config:m.config,me:board(me),watching,
      safePlayers:!m.solo?m.players.filter(p=>p.status==='cleared').map(publicPlayer):[],
      roster:social?m.players.map(p=>({...publicPlayer(p),pos:null})):[],
      lastRunner:!m.solo&&me.status==='cleared'&&below.length===1?publicBoard(below[0]):null,
      results:m.phase==='finished'?m.results:[],winnerIds:m.winnerIds||[]};
  }

  return { COLS, ROWS, ONLINE_ROWS, INTRO_MS, RULES_VERSION, splashDuration, EMOTES, emote, spectate, settings, pattern, rowAge, makeMatch, move, tick, disconnect, snapshot };
});
