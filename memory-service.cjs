/* Memory API adapter for the existing Water Escape HTTP server. No listener or npm dependencies. */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const Rules = require('./memory-core.js');
const RosterMigration = require('./roster-migration.js');
const codeChars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const cleanName = value => String(value || 'PLAYER').normalize('NFC').replace(/[<>\x00-\x1f]/g, '').trim().slice(0, 12) || 'PLAYER';
const hash = token => crypto.createHash('sha256').update(token).digest('hex');
const secret = () => crypto.randomBytes(32).toString('hex');
function createService(options = {}) {
  const env = options.env || process.env;
  const dataFile = options.dataFile || env.MEMORY_DATA_FILE || path.join(__dirname, 'data', 'memory.json');
  const logger = options.logger || (typeof options.log === 'function' ? { error: options.log } : options.log) || console;
  let storageError = null, lastErrorLog = 0;
  function report(error, context) {
    const now = Date.now();
    if (!lastErrorLog || now - lastErrorLog >= 10000) {
      lastErrorLog = now;
      try { logger.error('Memory service ' + context + ':', error.message); } catch (_) {}
    }
  }
  let data = { accounts: {}, records: [] };
  if (fs.existsSync(dataFile)) data = JSON.parse(fs.readFileSync(dataFile, 'utf8'));
  // Never replace an unreadable or malformed account file with an empty store.
  if (!data || typeof data !== 'object' || !data.accounts || typeof data.accounts !== 'object' ||
      Array.isArray(data.accounts) || !Array.isArray(data.records) ||
      Object.values(data.accounts).some(p => !p || typeof p !== 'object' || Array.isArray(p)) ||
      data.records.some(p => !p || typeof p !== 'object' || Array.isArray(p))) {
    throw new Error('Invalid Memory data file. Restore or repair the existing file before enabling Memory.');
  }
  const rooms = new Map(), limits = new Map();
  const save = () => {
    try {
      fs.mkdirSync(path.dirname(dataFile), { recursive: true });
      fs.writeFileSync(dataFile + '.tmp', JSON.stringify(data), { mode: 0o600 });
      fs.renameSync(dataFile + '.tmp', dataFile);
      storageError = null;
    } catch (error) { storageError = error; throw error; }
  };
  const err = (message, status = 400) => Object.assign(new Error(message), { status });
  const chars = new Set(RosterMigration.ids());
  const character = value => {
    const id = RosterMigration.resolve(value);
    return chars.has(id) ? id : 'miner';
  };
  const normalizeCharacter = player => {
    const id = character(player.char), changed = player.char !== id;
    player.char = id;
    return changed;
  };
  // Upgrade portraits in place; account identities, tokens and all record
  // statistics keep their existing values. The next restart is a no-op.
  let rosterChanged = false;
  for (const user of Object.values(data.accounts)) if (normalizeCharacter(user)) rosterChanged = true;
  for (const row of data.records) if (normalizeCharacter(row)) rosterChanged = true;
  if (rosterChanged) save();
  function account(req) {
    const token = String(req.headers.authorization || '').replace(/^Bearer /, '');
    const value = token && data.accounts[hash(token)];
    if (!value) throw err('Your session expired. Please sign in again.', 401);
    normalizeCharacter(value);
    return value;
  }
  function rateLimit(req, key, limit, interval) {
    const token=key==='all'?String(req.headers.authorization||'').replace(/^Bearer /,''):'';
    const user=token&&data.accounts[hash(token)];
    // Eight friends on one Wi-Fi connection must not share one polling budget.
    const k = (user?'account:'+user.id:(req.socket.remoteAddress || 'local')) + ':' + key;
    const now = Date.now(), item = limits.get(k);
    if (!item || now - item.at > interval) { limits.set(k, { at: now, n: 1 }); return; }
    if (++item.n > limit) throw err('Too many attempts. Please wait a moment.', 429);
  }
  function member(room, user) {
    const p = room.members.find(p => p.id === user.id);
    if (!p) throw err('You are not a member of this lobby.', 403);
    normalizeCharacter(p);
    p.lastSeen = Date.now(); p.connected = true; p.offlineAt = 0;
    if (room.match) {
      const mp = room.match.players.find(p => p.id === user.id);
      if (mp) { normalizeCharacter(mp); mp.connected = true; mp.lastSeen = p.lastSeen; }
    }
    return p;
  }
  function newCode() {
    let code;
    do { code = Array.from(crypto.randomBytes(6), b => codeChars[b % codeChars.length]).join(''); } while (rooms.has(code));
    return code;
  }
  function start(room, now) {
    room.members = room.members.filter(p => p.connected);
    room.members.forEach(normalizeCharacter);
    room.match = Rules.makeMatch(room.members, room.difficulty, now, Math.random, room.solo);
    room.match.players.forEach(p => { p.lastSeen = now; });
    room.saved = false; room.rematch = new Set(); room.updated = now;
    for (const p of room.members) p.ready = false;
  }
  function record(room) {
    if (room.saved || !room.match || room.match.phase !== 'finished') return;
    for (const result of room.match.results) {
      const row = { id: result.id, name: result.name, char: character(result.char), round: result.round,
        score: result.score, cleared: result.cleared, difficulty: room.difficulty, at: Date.now() };
      const old = data.records.find(r => r.id === row.id && r.difficulty === row.difficulty);
      if (!old) data.records.push(row);
      else if (row.round > old.round || row.round === old.round && row.score > old.score) Object.assign(old, row);
    }
    save();
    room.saved = true;
  }
  function view(room, id, now) {
    room.members.forEach(normalizeCharacter);
    if (room.match) {
      room.match.players.forEach(normalizeCharacter);
      if (room.match.results) room.match.results.forEach(normalizeCharacter);
    }
    if (room.match) { Rules.tick(room.match, now); record(room); }
    return { rulesVersion: Rules.RULES_VERSION, lobbyVersion: 3, code: room.code, owner: room.owner, difficulty: room.difficulty, solo: room.solo,
      serverNow: now, self: id, phase: !room.match ? 'lobby' : room.match.phase,
      members: !room.match || room.match.phase === 'finished' ? room.members.map(p => ({
        id: p.id, idx: p.idx, name: p.name, char: p.char, ready: p.ready, connected: p.connected,
        rematch: room.rematch.has(p.id) })) : [],
      match: room.match ? Rules.snapshot(room.match, id, now) : null };
  }
  function leave(room, user, now) {
    const p = room.members.find(p => p.id === user.id);
    if (p) { p.connected = false; p.ready = false; }
    if (room.match) Rules.disconnect(room.match, user.id, now);
    else room.members = room.members.filter(p => p.id !== user.id);
    if (room.owner === user.id) room.owner = (room.members.find(p => p.connected) || {}).id || '';
    if (!room.members.some(p => p.connected)) room.emptyAt = now;
  }
  function maintain(now = Date.now()) {
    for (const [code, room] of rooms) {
      try {
        for (const p of room.members) {
          const absent = now - p.lastSeen;
          // A brief lost connection reserves the same identity and portrait slot.
          // Explicit LEAVE still frees a lobby slot immediately.
          if (absent > 75000 && (p.connected || p.offlineAt)) {
            p.offlineAt = 0; leave(room, p, now);
          } else if (p.connected && absent > 15000) {
            p.connected = false; p.offlineAt = now; p.ready = false;
            const mp = room.match && room.match.players.find(q => q.id === p.id);
            if (mp) mp.connected = false;
          }
        }
        if (room.match) { Rules.tick(room.match, now); record(room); }
        if (room.emptyAt && now - room.emptyAt > 60000 || now - room.updated > 3 * 60 * 60 * 1000) rooms.delete(code);
      } catch (error) { report(error, 'maintenance'); }
    }
    for (const [key, value] of limits) if (now - value.at > 120000) limits.delete(key);
  }
  const timer = setInterval(() => {
    try { maintain(); } catch (error) { report(error, 'maintenance'); }
  }, 100);
  timer.unref();
  async function body(req) {
    if (!String(req.headers['content-type'] || '').startsWith('application/json')) throw err('JSON is required.', 415);
    let raw = '';
    for await (const chunk of req) { raw += chunk; if (raw.length > 4096) throw err('Request too large.', 413); }
    try { return raw ? JSON.parse(raw) : {}; } catch (_) { throw err('Invalid request.'); }
  }
  const allowed = new Set(['https://localhost', 'http://localhost', 'capacitor://localhost', 'ionic://localhost',
    ...String(env.MEMORY_ALLOWED_ORIGINS || '').split(',').map(value => value.trim()).filter(value => value && value !== '*')]);
  const json = (res, code, value) => { res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(value)); };
  async function handler(req, res) {
    const origin = req.headers.origin;
    res.setHeader('Vary', 'Origin');
    // The adapter owns Memory CORS even if a parent added a generic header.
    res.removeHeader('Access-Control-Allow-Origin');
    if (origin) {
      let same = false;
      try {
        const source = new URL(origin);
        same = ['http:', 'https:'].includes(source.protocol) && source.origin === origin &&
          !source.username && !source.password && source.host === req.headers.host;
      } catch (_) {}
      if (!same && !allowed.has(origin)) return json(res, 403, { error: 'Origin is not allowed.' });
      res.setHeader('Access-Control-Allow-Origin', origin); res.setHeader('Vary', 'Origin');
      res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    }
    let url;
    try { url = new URL(req.url, 'http://memory.local'); } catch (_) { return json(res, 400, { error: 'Invalid request URL.' }); }
    if (!url.pathname.startsWith('/api/memory/')) return json(res, 404, { error: 'Route not found.' });
    if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }
    const now = Date.now();
    try {
      rateLimit(req, 'all', 1800, 60000);
      const route = url.pathname.slice('/api/memory/'.length);
      if (route === 'health' && req.method === 'GET') return json(res, storageError ? 503 : 200, {
        ok: !storageError, version: 6, rulesVersion: Rules.RULES_VERSION,
        ...(storageError ? { error: 'Memory storage is temporarily unavailable.' } : {}) });
      if (route === 'session' && req.method === 'POST') {
        rateLimit(req, 'session', 60, 60000);
        const b = await body(req);
        let token = typeof b.token === 'string' ? b.token : '', user = token && data.accounts[hash(token)];
        if (!user) { token = secret(); user = { id: crypto.randomUUID() }; data.accounts[hash(token)] = user; }
        user.name = cleanName(b.name); user.char = character(b.char); save();
        return json(res, 200, { token, id: user.id });
      }
      if (route === 'ranking' && req.method === 'GET') {
        const difficulty = url.searchParams.get('difficulty') === 'insane' ? 'insane' : 'normal';
        const rows = data.records.filter(r => r.difficulty === difficulty).sort((a, b) => b.round - a.round || b.score - a.score || a.at - b.at).slice(0, 50);
        return json(res, 200, { difficulty, rows: rows.map((r, i) => ({ name: r.name, char: character(r.char), round: r.round, score: r.score, place: i + 1 })) });
      }
      const user = account(req);
      if (route === 'rooms' && req.method === 'POST') {
        rateLimit(req, 'create', 30, 60000);
        const b = await body(req), code = newCode();
        // Leaving a prior seat prevents one device from occupying multiple seats.
        for (const room of rooms.values()) if (room.members.some(p => p.id === user.id && p.connected)) leave(room, user, now);
        const room = { code, owner: user.id, solo: !!b.solo, difficulty: b.difficulty === 'insane' ? 'insane' : 'normal',
          updated: now, members: [{ ...user, idx: 0, connected: true, ready: false, lastSeen: now }], match: null, rematch: new Set() };
        rooms.set(code, room); if (room.solo) start(room, now);
        return json(res, 201, view(room, user.id, now));
      }
      const match = route.match(/^rooms\/([A-Z2-9]{6})(?:\/(join|ready|settings|start|move|emote|spectate|leave|rematch))?$/);
      if (!match) throw err('Route not found.', 404);
      const room = rooms.get(match[1]); if (!room) throw err('This lobby does not exist or has expired.', 404);
      if (match[2] === 'join' && req.method === 'POST') {
        await body(req);
        let p = room.members.find(p => p.id === user.id);
        if (room.solo) throw err('This is a solo match.', 403);
        if (room.match && !p) throw err('The match has already started.', 409);
        if (!p) {
          if (room.members.length >= 8) throw err('This lobby is full (8/8).', 409);
          for (const other of rooms.values()) if (other !== room && other.members.some(q => q.id === user.id && q.connected)) leave(other, user, now);
          const idx = Array.from({length:8},(_,i)=>i).find(i=>!room.members.some(q=>q.idx===i));
          p = { ...user, idx, connected: true, ready: false, lastSeen: now }; room.members.push(p);
        }
        if (!room.match) { p.name = user.name; p.char = user.char; }
        member(room, user); room.emptyAt = 0; room.updated = now;
        if (!room.owner) room.owner = user.id;
        return json(res, 200, view(room, user.id, now));
      }
      const p = member(room, user); room.emptyAt = 0; room.updated = now;
      if (!match[2] && req.method === 'GET') return json(res, 200, view(room, user.id, now));
      if (req.method !== 'POST') throw err('Method not allowed.', 405);
      const b = await body(req);
      if (room.match) Rules.tick(room.match, now);
      switch (match[2]) {
        case 'settings':
          if (room.owner !== user.id) throw err('Only the host can change difficulty.', 403);
          if (room.match) throw err('The match has already started.', 409);
          if (!['normal','insane'].includes(b.difficulty)) throw err('Choose Normal or Insane.');
          room.difficulty = b.difficulty; break;
        case 'ready':
          if (room.match) throw err('The match has already started.', 409);
          p.ready = !!b.ready; break;
        case 'start':
          if (room.owner !== user.id) throw err('Only the host can start the match.', 403);
          if (room.match) throw err('The match has already started.', 409);
          if (room.members.filter(p=>p.connected).length < 2 || room.members.length > 8) throw err('Between 2 and 8 connected players are required.', 409);
          start(room, now); break;
        case 'move':
          if (!room.match) throw err('The match has not started yet.', 409);
          Rules.move(room.match, user.id, b.dx, b.dy, now); break;
        case 'emote':
          if(!room.match||!Rules.emote(room.match,user.id,b.value,now))throw err('Emote unavailable.',409);break;
        case 'spectate':
          if(!room.match||!Rules.spectate(room.match,user.id,b.target))throw err('Spectator unavailable.',403);break;
        case 'leave': leave(room, user, now); return json(res, 200, { ok: true });
        case 'rematch':
          if (!room.match || room.match.phase !== 'finished') throw err('The match is still in progress.', 409);
          record(room); room.rematch.add(user.id);
          if (room.members.filter(p => p.connected).length >= (room.solo ? 1 : 2) &&
            room.members.filter(p => p.connected).every(p => room.rematch.has(p.id))) start(room, now);
          break;
        default: throw err('Action not found.', 404);
      }
      return json(res, 200, view(room, user.id, now));
    } catch (e) {
      if (!e.status) report(e, 'request');
      if (!res.headersSent) json(res, e.status || 500, { error: e.status ? e.message : 'Could not complete the action. Please try again.' });
    }
  }
  return { handler, rooms, data, maintain, close: () => clearInterval(timer) };
}
module.exports = { createService };
