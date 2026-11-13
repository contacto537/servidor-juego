"use strict";

const http = require("http");
const https = require("https");
const crypto = require("crypto");
const RosterMigration = require("./roster-migration.js");

function createWaterEscapeServer(options = {}) {
  const env = options.env || process.env;
  const log = options.log || console.log;
  const now = options.now || Date.now;
  const later = options.setTimeout || setTimeout;
  const cancel = options.clearTimeout || clearTimeout;
  const transport = options.https || https;
  const ADMIN_KEY = String(env.ADMIN_KEY || "").trim();
  const SUPABASE_URL = String(env.SUPABASE_URL || "").trim().replace(/\/$/, "");
  const SUPABASE_KEY = String(env.SUPABASE_KEY || "").trim();
  const DB_ON = !!(SUPABASE_URL && SUPABASE_KEY);
  const JWT_SECRET = String(env.JWT_SECRET || "").trim();
  const APPLE_BUNDLE_ID = String(env.APPLE_BUNDLE_ID || "studio.wtdigital.waterescape").trim();
  const GOOGLE_CLIENT_ID = String(env.GOOGLE_CLIENT_ID || "").trim();
  const GRACE_MS = 60000;
  const DB_TIMEOUT_MS = 4500;
  const HISTORY = [];
  let DB_LAST_ERR = "", DB_OK_ONCE = false, JOSE = null;
  let APPLE_JWKS = null, GOOGLE_JWKS = null;
  const joseReady = (options.jose ? Promise.resolve(options.jose) : import("jose"))
    .then(j => {
      JOSE = j;
      APPLE_JWKS = j.createRemoteJWKSet(new URL("https://appleid.apple.com/auth/keys"), { timeoutDuration: 5000 });
      GOOGLE_JWKS = j.createRemoteJWKSet(new URL("https://www.googleapis.com/oauth2/v3/certs"), { timeoutDuration: 5000 });
    }).catch(e => { JOSE = null; log("Cloud auth unavailable:", e.message); });

  log("=== Water Escape server starting ===");
  log("Node version:", process.version);
  log("Database mode:", DB_ON ? "ON (persistent)" : "OFF (solo scores in memory only)");
  if (!ADMIN_KEY) log("Admin pages disabled: set ADMIN_KEY in the server environment.");

  function httpsReqFull(method, path, bodyObj, extraHeaders) {
    return new Promise((resolve, reject) => {
      let base;
      try { base = new URL(SUPABASE_URL); if (base.protocol !== "https:") throw new Error(); }
      catch (_) { reject(new Error("Bad SUPABASE_URL")); return; }
      const body = bodyObj == null ? null : JSON.stringify(bodyObj);
      const headers = Object.assign({ apikey: SUPABASE_KEY, Authorization: "Bearer " + SUPABASE_KEY,
        "Content-Type": "application/json" }, extraHeaders || {});
      if (body) headers["Content-Length"] = Buffer.byteLength(body);
      let settled = false, req, timer;
      const finish = (err, value) => {
        if (settled) return;
        settled = true; cancel(timer);
        if (err) reject(err); else resolve(value);
      };
      timer = later(() => {
        const error = new Error("Database request timed out");
        finish(error); if (req) req.destroy(error);
      }, DB_TIMEOUT_MS);
      try {
        req = transport.request({ hostname: base.hostname, port: base.port || 443,
          path: base.pathname.replace(/\/$/, "") + path, method, headers }, res => {
          let data = "", bytes = 0;
          res.setEncoding("utf8");
          res.on("data", c => {
            bytes += Buffer.byteLength(c);
            if (bytes > 8 * 1024 * 1024) {
              const error = new Error("Database response too large"); finish(error); req.destroy(error); return;
            }
            data += c;
          });
          res.on("error", e => finish(e));
          res.on("aborted", () => finish(new Error("Database response interrupted")));
          res.on("end", () => {
            if (res.statusCode >= 200 && res.statusCode < 300) finish(null, { body: data, headers: res.headers });
            else finish(new Error("HTTP " + res.statusCode + ": " + data.slice(0, 200)));
          });
        });
        req.on("error", e => finish(e));
        if (body) req.write(body);
        req.end();
      } catch (e) { finish(e); }
    });
  }
  async function httpsReq(method, path, bodyObj) {
    return (await httpsReqFull(method, path, bodyObj, method === "POST" ? { Prefer: "return=minimal" } : null)).body;
  }
  function dbGood() { DB_OK_ONCE = true; DB_LAST_ERR = ""; }
  function dbError(e) { DB_LAST_ERR = e.message; log("Database error:", e.message); }
  async function dbInsert(row) {
    if (!DB_ON) return;
    try { await httpsReq("POST", "/rest/v1/plays", row); dbGood(); } catch (e) { dbError(e); }
  }
  async function dbFetch() {
    if (!DB_ON) return null;
    try {
      const rows = JSON.parse(await httpsReq("GET", "/rest/v1/plays?select=*&order=t.desc&limit=2000", null));
      if (!Array.isArray(rows)) throw new Error("Invalid plays response");
      dbGood(); return rows;
    } catch (e) { dbError(e); return null; }
  }

  const BAD_ROOTS = ["fuck","fuk","fck","fvck","phuck","shit","sh1t","bitch","bich","cunt","dick","cock","pussy","pusy","porn","pron","p0rn","sex","nigga","nigger","niga","fag","faggot","whore","slut","rape","tits","boob","penis","vagina","nazi","hitler","kkk","cum","dildo","horny","hentai","xxx","puta","puto","mierda","verga","vrga","pendejo","pendeja","culo","culero","chinga","chingar","chingada","cabron","cabrona","joder","conyo","conyi","conya","pinche","mamada","maricon","marica","zorra","perra","pito","pija","polla","teta","tetas","pene","follar","putazo","mamon","mamona","carajo","chupa","chupame","panoch","nalga","nalgas","hijodeputa","hdp","ptm","mrd","wtf","fokin","fucking","motherfucker","asshole","bastard","retard","onlyfans","sexo","desnuda","desnudo","violar","violador","pornografia"];
  const BAD_SAFE_SUBS = ["analy","analysis","canal","banal","cumbia","cumple","cumbre","documento","circum","scum","assis","assum","assoc","classic","pass","glass","grass","bass","mass","cassie","essex","sussex","peninsula","pitos","pitón","piton","pitoresc","dickens","cockatoo","cockpit","hancock","peacock","kkkk","conoc","culomb","articulo","curriculo","vinculo","circulo","calculo","mayuscula","minuscula","nalgada","sexto","sexta","sextet","capitol","cockroach"];
  function badNormalize(s) {
    return String(s || "").toLowerCase().replace(/ñ/g,"ny").replace(/[áàäâã]/g,"a").replace(/[éèëê]/g,"e")
      .replace(/[íìïî]/g,"i").replace(/[óòöôõ]/g,"o").replace(/[úùüû]/g,"u")
      .replace(/0/g,"o").replace(/1/g,"i").replace(/3/g,"e").replace(/4/g,"a").replace(/5/g,"s")
      .replace(/7/g,"t").replace(/8/g,"b").replace(/9/g,"g").replace(/@/g,"a").replace(/\$/g,"s")
      .replace(/!/g,"i").replace(/\|/g,"l").replace(/\+/g,"t").replace(/€/g,"e").replace(/¢/g,"c")
      .replace(/ß/g,"ss").replace(/[^a-z]/g, "");
  }
  function badCollapse(t) { return t.replace(/(.)\1+/g, "$1"); }
  function isBadName(s) {
    const n = badNormalize(s);
    const forms = [n, badCollapse(n), n.replace(/v/g,"u"), n.replace(/ck/g,"k").replace(/q/g,"k").replace(/x/g,"ks").replace(/ph/g,"f")];
    for (const t of forms) for (const w of BAD_ROOTS) {
      let pos = t.indexOf(w);
      while (pos >= 0) {
        let safe = false;
        for (const entry of BAD_SAFE_SUBS) {
          for (const sw of [entry, badCollapse(entry)]) {
            let sp = t.indexOf(sw);
            while (sp >= 0) {
              if (pos >= sp && pos + w.length <= sp + sw.length) { safe = true; break; }
              sp = t.indexOf(sw, sp + 1);
            }
            if (safe) break;
          }
          if (safe) break;
        }
        if (!safe) return true;
        pos = t.indexOf(w, pos + 1);
      }
    }
    return false;
  }
  const cleanId = s => String(s || "").replace(/[^\w-]/g, "").slice(0, 24);
  const cleanName = s => String(s || "").replace(/[^\wÁÉÍÓÚÑÜáéíóúñü\- ]/g, "").trim().slice(0, 12);
  function lbClean(s) { const n = cleanName(s); return n && !isBadName(n) ? n : null; }

  const LB_MODES = ["normal", "rush", "memory", "adventure"];
  const LB_MAX = { normal: 5000, rush: 5000, memory: 2000, adventure: 100000000 };
  const LB_MEM = { normal: new Map(), rush: new Map(), memory: new Map(), adventure: new Map() };
  const LB_CACHE = new Map(), LB_PENDING = new Map(), LB_REV = new Map(), LB_RATE = new Map();
  function lbInvalidate(mode) { LB_CACHE.delete(mode); LB_REV.set(mode, (LB_REV.get(mode) || 0) + 1); }
  function lbDedupe(rows) {
    const seen = new Set();
    return rows.filter(r => { const k = String(r.name || "").toLowerCase(); if (seen.has(k)) return false; seen.add(k); return true; });
  }
  async function lbRows(mode) {
    const cached = LB_CACHE.get(mode), revision = LB_REV.get(mode) || 0;
    if (cached && cached.revision === revision && now() - cached.at < 15000) return cached.rows;
    const pending = LB_PENDING.get(mode);
    if (pending && pending.revision === revision) return pending.promise;
    const task = { revision, promise: null };
    task.promise = (async () => {
      let rows;
      if (DB_ON) {
        rows = [];
        for (let offset = 0; ; offset += 1000) {
          const result = await httpsReqFull("GET", "/rest/v1/scores?select=name,score,dev,t&mode=eq." + mode + "&order=score.desc,t.asc,dev.asc&limit=1000&offset=" + offset, null);
          const page = JSON.parse(result.body || "[]");
          if (!Array.isArray(page)) throw new Error("Invalid scores response");
          rows.push(...page);
          if (page.length < 1000) break;

          if (offset >= 199000) throw new Error("Leaderboard paging limit reached");
        }
        dbGood();
      } else rows = [...LB_MEM[mode]].map(([dev, row]) => ({ dev, ...row }));
      rows.sort((a,b) => b.score - a.score || String(a.t).localeCompare(String(b.t)) || String(a.dev).localeCompare(String(b.dev)));
      const list = lbDedupe(rows);
      if ((LB_REV.get(mode) || 0) === revision) LB_CACHE.set(mode, { at: now(), revision, rows: list });
      return list;
    })().finally(() => { if (LB_PENDING.get(mode) === task) LB_PENDING.delete(mode); });
    LB_PENDING.set(mode, task);
    return task.promise;
  }
  async function lbRankName(mode, name, best) {
    const rows = await lbRows(mode), key = String(name || "").toLowerCase();
    let rank = 1;
    for (const r of rows) {
      if (String(r.name || "").toLowerCase() === key) return { rank, best: Math.max(best, r.score) };
      if (r.score > best) rank++;
    }
    return { rank, best };
  }
  async function lbSubmit(dev, name, mode, score) {
    score = Math.max(0, Math.min(LB_MAX[mode], Math.floor(score)));
    const t = new Date(now()).toISOString();
    let best;
    if (DB_ON) {
      const query = "/rest/v1/scores?dev=eq." + encodeURIComponent(dev) + "&mode=eq." + mode;

      await httpsReqFull("POST", "/rest/v1/scores?on_conflict=dev,mode", { dev, name, mode, score, t },
        { Prefer: "resolution=ignore-duplicates,return=minimal" });
      await httpsReqFull("PATCH", query + "&score=lt." + score, { name, score, t }, { Prefer: "return=minimal" });
      await httpsReqFull("PATCH", query, { name }, { Prefer: "return=minimal" });
      const result = await httpsReqFull("GET", query + "&select=score&limit=1", null);
      const rows = JSON.parse(result.body || "[]");
      if (!rows.length) throw new Error("Score was not persisted");
      best = Number(rows[0].score); dbGood();
    } else {
      const prev = LB_MEM[mode].get(dev);
      LB_MEM[mode].set(dev, !prev || score > prev.score ? { name, score, t } : { name, score: prev.score, t: prev.t });
      best = LB_MEM[mode].get(dev).score;
    }
    lbInvalidate(mode);

    let rank = null;
    try { rank = (await lbRankName(mode, name, best)).rank; } catch (e) { dbError(e); }
    return { ok: true, best, rank, persistent: DB_ON };
  }

  function readBody(req, limit = 4096) {
    return new Promise(resolve => {
      let chunks = [], size = 0, done = false;
      function finish(value) { if (done) return; done = true; chunks = []; cancel(timer); resolve(value); }
      const timer = later(() => { finish(null); req.destroy(); }, 10000);
      req.on("data", chunk => { size += chunk.length; if (size > limit) { finish(null); req.destroy(); } else if (!done) chunks.push(chunk); });
      req.on("end", () => { let parsed = null; try { parsed = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}"); } catch (_) {} finish(parsed); });
      req.on("error", () => finish(null));
      req.on("aborted", () => finish(null));
      req.on("close", () => { if (!req.complete) finish(null); });
    });
  }
  const progSecret = () => new TextEncoder().encode(JWT_SECRET);
  async function progVerify(provider, idToken) {
    if (provider === "google" && !GOOGLE_CLIENT_ID) throw new Error("Google not configured");
    const apple = provider === "apple";
    const { payload } = await JOSE.jwtVerify(idToken, apple ? APPLE_JWKS : GOOGLE_JWKS, {
      issuer: apple ? "https://appleid.apple.com" : ["https://accounts.google.com", "accounts.google.com"],
      audience: apple ? APPLE_BUNDLE_ID : GOOGLE_CLIENT_ID, algorithms: ["RS256"]
    });
    if (!payload.sub) throw new Error("No subject");
    return provider + ":" + payload.sub;
  }
  async function progAuth(req) {
    const h = String(req.headers.authorization || ""), token = h.startsWith("Bearer ") ? h.slice(7) : "";
    if (!token || !JOSE || !JWT_SECRET) return null;
    try {
      const { payload } = await JOSE.jwtVerify(token, progSecret(), { algorithms: ["HS256"] });
      return typeof payload.uid === "string" && /^(apple|google):/.test(payload.uid) ? payload : null;
    } catch (_) { return null; }
  }
  const record = v => v && typeof v === "object" && !Array.isArray(v) ? v : {};
  const TILE_THEME_IDS = ["neon_district", "nebula", "autumn_grove", "frostpeak", "golden_dunes", "amethyst", "mushroom_grove"];
  function progThemes(raw) {
    const input = record(raw), owned = record(input.own), equipped = record(input.eq), out = {own:{},eq:{}};
    const has = (object,key) => Object.prototype.hasOwnProperty.call(object,key);
    for (const id of TILE_THEME_IDS) if (has(owned,id) && (owned[id] === true || owned[id] === 1)) out.own[id] = true;
    for (const map of ["original","volcano","jungle"]) {
      if (!has(equipped,map)) continue;
      const id = equipped[map];

      if (id === null || (typeof id === "string" && has(out.own,id))) out.eq[map] = id;
    }
    return out;
  }
  function progClean(d) {
    if (!d || typeof d !== "object" || Array.isArray(d)) return null;
    const hasThemes = Object.prototype.hasOwnProperty.call(d,"tileThemes");
    if (hasThemes && (!d.tileThemes || typeof d.tileThemes !== "object" || Array.isArray(d.tileThemes))) return null;
    const ch = record(d.char), fx = record(d.fx), cos = record(d.cos), adventure = progAdventure(d.adventure);
    return { v: 1, ts: now(), stars: Math.max(0, Math.min(10000000, Number(d.stars) || 0)),
      best: Math.max(0, Number(d.best) | 0), bestSoloN: Math.max(0, Number(d.bestSoloN) | 0), bestSoloR: Math.max(0, Number(d.bestSoloR) | 0),
      name: String(d.name || "").slice(0,12), nameTyped: !!d.nameTyped, soloSeen: !!d.soloSeen,
      inv: record(d.inv), char: { own: record(ch.own), sel: String(ch.sel || "miner") },
      fx: { own: record(fx.own), sel: record(fx.sel) }, cos: { own: record(cos.own), eq: record(cos.eq) },
      ...(hasThemes ? {tileThemes:progThemes(d.tileThemes)} : {}),
      ...(Object.prototype.hasOwnProperty.call(d,"fireworkLauncher") ? progFireworks(d) : {}),
      ...(adventure ? {adventure} : {}) };
  }
  function progAdventure(a) {
    if (!a || typeof a !== "object" || Array.isArray(a) || typeof a.data !== "string" || !a.data || a.data.length > 120000) return null;
    const num = (v, max) => { v = Number(v); return Number.isFinite(v) ? Math.max(0, Math.min(max, Math.floor(v))) : 0; };
    return { t: num(a.t, 8640000000000000), lvl: num(a.lvl, 100000), score: num(a.score, 1000000000000), data: a.data };
  }
  function progFireworks(d) {
    d = record(d);
    const stamp = Number(d.fireworkEquipTs);
    return {fireworkLauncher:d.fireworkLauncher === true, fireworkEquipped:d.fireworkEquipped !== false,
      fireworkEquipTs:Number.isFinite(stamp) ? Math.max(0,Math.min(8640000000000000,stamp)) : 0};
  }
  async function progGet(uid) {
    if (!DB_ON) throw new Error("Persistent cloud storage is not configured");
    const result = await httpsReqFull("GET", "/rest/v1/progress?select=data&uid=eq." + encodeURIComponent(uid) + "&limit=1", null);
    const rows = JSON.parse(result.body || "[]"); dbGood();
    return rows.length ? rows[0].data || null : null;
  }
  async function progPut(uid, provider, data) {
    if (!DB_ON) throw new Error("Persistent cloud storage is not configured");

    const previous = await progGet(uid), oldFireworks = progFireworks(previous);
    const incomingFireworks = Object.prototype.hasOwnProperty.call(data,"fireworkLauncher") ? progFireworks(data) : oldFireworks;
    const equipment = incomingFireworks.fireworkEquipTs >= oldFireworks.fireworkEquipTs ? incomingFireworks : oldFireworks;
    data = {...data,...equipment,fireworkLauncher:oldFireworks.fireworkLauncher || incomingFireworks.fireworkLauncher};

    if (!Object.prototype.hasOwnProperty.call(data,"tileThemes")) {
      data = {...data,tileThemes:progThemes(previous && previous.tileThemes)};
    }
    const oldAdventure = progAdventure(previous && previous.adventure);
    if (oldAdventure && (!data.adventure || data.adventure.score < oldAdventure.score)) data = {...data,adventure:oldAdventure};
    await httpsReqFull("POST", "/rest/v1/progress?on_conflict=uid", { uid, provider, data, updated_at: new Date(now()).toISOString() },
      { Prefer: "resolution=merge-duplicates,return=minimal" });
    dbGood(); return true;
  }
  const WORLD_ABC = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const WORLD_TTL = 600000, WORLD_CACHE_MAX = 400, WORLD_MEMBERS = 32, WORLD_MEMBER_BYTES = 60000, WORLD_DAY_MAX = 12, WORLD_IDLE_MS = 30 * 86400000;
  const WORLDS = new Map(), WORLD_Q = new Map(), WORLD_MADE = new Map();
  const worldCode = s => { const c = String(s == null ? "" : s).toUpperCase(); return c.length === 6 && [...c].every(ch => WORLD_ABC.includes(ch)) ? c : ""; };
  const worldId = s => { s = typeof s === "string" ? s : ""; return /^[a-z0-9]{12,32}$/.test(s) ? s : ""; };
  const worldSecret = s => { s = typeof s === "string" ? s : ""; return /^[A-Za-z0-9]{24,64}$/.test(s) ? s : ""; };
  const worldName = s => String(s == null ? "" : s).replace(/[^\wÁÉÍÓÚÑÜáéíóúñü\- ]/g, "").replace(/\s+/g, " ").trim().slice(0, 16);
  const worldHash = key => crypto.createHash("sha256").update("water-escape-world:" + key).digest("hex");
  const worldSame = (a, b) => a.length === b.length && crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
  function worldInt(v, lo, hi) { v = Number(v); return Number.isFinite(v) ? Math.max(lo, Math.min(hi, Math.round(v))) : null; }
  function worldNums(raw, pattern, hi, max) {
    const out = {};
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return out;
    let n = 0;
    for (const k of Object.keys(raw)) {
      if (n >= max) break;
      if (!pattern.test(k)) continue;
      const v = worldInt(raw[k], 0, hi);
      if (v) { out[k] = v; n++; }
    }
    return out;
  }
  function worldPairs(raw) {
    const out = {};
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return out;
    let n = 0;
    for (const k of Object.keys(raw)) {
      if (n >= 24) break;
      const v = raw[k];
      if (!/^\d,\d$/.test(k) || !Array.isArray(v) || v.length < 2) continue;
      const a = worldInt(v[0], 0, 255), b = worldInt(v[1], 0, 255);
      if (a === null || b === null) continue;
      out[k] = [a, b]; n++;
    }
    return out;
  }
  function worldItems(raw) {
    const out = [];
    if (!Array.isArray(raw)) return out;
    for (const q of raw) {
      if (out.length >= 700) break;
      if (!Array.isArray(q) || q.length < 3) continue;
      const id = worldInt(q[0], 0, 4095), lx = worldInt(q[1], 0, 63), ly = worldInt(q[2], 0, 63), st = worldInt(q[3] || 0, 0, 7);
      if (id === null || lx === null || ly === null || st === null) continue;
      out.push([id, lx, ly, st]);
    }
    return out;
  }
  function worldHome(raw, yacht) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw) || raw.x == null || raw.y == null) return null;
    const x = worldInt(raw.x, -4000000, 4000000), y = worldInt(raw.y, -4000000, 4000000);
    if (x === null || y === null) return null;
    const out = { x, y };
    if (yacht) out.type = worldInt(raw.type, 0, 7) || 0;
    else { out.lvl = worldInt(raw.lvl, 1, 9) || 1; out.ext = worldNums(raw.ext, /^[a-z]{1,8}$/, 255, 16); }
    out.tex = worldPairs(raw.tex); out.dark = worldNums(raw.dark, /^\d,\d$/, 255, 24); out.it = worldItems(raw.it);
    return out;
  }
  function worldMember(raw) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
    return { name: lbClean(raw.name) || "Player", char: cleanId(raw.char) || "miner", base: worldHome(raw.base, false), yacht: worldHome(raw.yacht, true) };
  }
  function worldFromRow(row) {
    const data = record(row.data), raw = record(data.members), used = new Set();
    const w = { code: String(row.code || ""), name: worldName(row.name) || "World", rev: Math.max(0, Math.floor(Number(data.rev)) || 0), owner: worldId(data.owner), members: Object.create(null) };
    for (const mid of Object.keys(raw)) {
      const m = record(raw[mid]), n = Number(m.n);
      if (!worldId(mid) || !Number.isInteger(n) || n < 0 || n >= WORLD_MEMBERS || used.has(n) || typeof m.kh !== "string" || !/^[0-9a-f]{64}$/.test(m.kh)) continue;
      used.add(n);
      w.members[mid] = { n, kh: m.kh, r: Math.max(0, Math.floor(Number(m.r)) || 0), ts: Math.max(0, Number(m.ts) || 0), ...worldMember(m) };
    }
    return w;
  }
  function worldPublic(w) {
    const members = {};
    for (const mid of Object.keys(w.members)) {
      const m = w.members[mid];
      members[mid] = { n: m.n, r: m.r, name: m.name, char: m.char, ts: m.ts, base: m.base, yacht: m.yacht };
    }
    return { code: w.code, name: w.name, rev: w.rev, members };
  }
  function worldTask(code, fn) {
    const run = (WORLD_Q.get(code) || Promise.resolve()).then(() => fn());
    const tail = run.then(() => {}, () => {});
    WORLD_Q.set(code, tail);
    tail.then(() => { if (WORLD_Q.get(code) === tail) WORLD_Q.delete(code); });
    return run;
  }
  function worldCache(w, dirty) {
    WORLDS.delete(w.code);
    const entry = { w, at: now(), dirty: !!dirty };
    WORLDS.set(w.code, entry);
    if (WORLDS.size > WORLD_CACHE_MAX) {
      for (const [code, old] of WORLDS) {
        if (WORLDS.size <= WORLD_CACHE_MAX) break;
        if (code !== w.code && !rooms.has(code) && !WORLD_Q.has(code) && !old.dirty) WORLDS.delete(code);
      }
    }
    return entry;
  }
  async function worldRead(code) {
    const hit = WORLDS.get(code);
    if (hit && (!DB_ON || hit.dirty || rooms.has(code) || now() - hit.at < WORLD_TTL)) return hit.w;
    if (!DB_ON) return null;
    const result = await httpsReqFull("GET", "/rest/v1/worlds?select=code,name,data&code=eq." + code + "&limit=1", null);
    const rows = JSON.parse(result.body || "[]");
    if (!Array.isArray(rows)) throw new Error("Invalid worlds response");
    dbGood();
    if (!rows.length || !rows[0] || rows[0].code !== code) { WORLDS.delete(code); return null; }
    return worldCache(worldFromRow(rows[0]), false).w;
  }
  async function worldWrite(w) {
    w.rev++;
    const entry = worldCache(w, DB_ON);
    if (!DB_ON) return;
    await httpsReqFull("POST", "/rest/v1/worlds?on_conflict=code", { code: w.code, name: w.name,
      data: { v: 1, rev: w.rev, owner: w.owner, members: w.members }, updated_at: new Date(now()).toISOString() },
      { Prefer: "resolution=merge-duplicates,return=minimal" });
    entry.dirty = false; dbGood();
  }
  function worldSeat(w) {
    const mids = Object.keys(w.members), used = new Set(mids.map(mid => w.members[mid].n));
    if (mids.length >= WORLD_MEMBERS) {
      let idle = "";
      for (const mid of mids) {
        const m = w.members[mid];
        if (mid !== w.owner && now() - m.ts > WORLD_IDLE_MS && (!idle || m.ts < w.members[idle].ts)) idle = mid;
      }
      if (!idle) return -1;
      used.delete(w.members[idle].n); delete w.members[idle];
    }
    for (let n = 0; n < WORLD_MEMBERS; n++) if (!used.has(n)) return n;
    return -1;
  }
  function worldQuota(req) {
    const ip = String(req.headers["x-forwarded-for"] || req.socket.remoteAddress || "").split(",")[0].trim(), day = Math.floor(now() / 86400000);
    for (const [key, value] of WORLD_MADE) if (value.day !== day) WORLD_MADE.delete(key);
    const q = WORLD_MADE.get(ip) || { n: 0, day };
    if (q.n >= WORLD_DAY_MAX) return false;
    q.n++; WORLD_MADE.set(ip, q); return true;
  }
  async function worldCreate(name, mid, key) {
    for (let attempt = 0; attempt < 6; attempt++) {
      const code = Array.from({ length: 6 }, () => WORLD_ABC[crypto.randomInt(WORLD_ABC.length)]).join("");
      const made = await worldTask(code, async () => {
        if (rooms.has(code) || await worldRead(code)) return null;
        const w = { code, name, rev: 0, owner: mid, members: Object.create(null) };
        w.members[mid] = { n: 0, kh: worldHash(key), r: 1, ts: now(), name: "Player", char: "miner", base: null, yacht: null };
        try { await worldWrite(w); } catch (e) { WORLDS.delete(code); throw e; }
        return w;
      });
      if (made) return made;
    }
    throw new Error("No free world code");
  }
  function worldPut(code, mid, key, raw) {
    return worldTask(code, async () => {
      const w = await worldRead(code);
      if (!w) return { status: 404, body: { ok: false, err: "NOT_FOUND" } };
      const clean = worldMember(raw), kh = worldHash(key);
      if (!clean) return { status: 400, body: { ok: false, err: "bad request" } };
      if (Buffer.byteLength(JSON.stringify(clean)) > WORLD_MEMBER_BYTES) return { status: 413, body: { ok: false, err: "TOO_LARGE" } };
      let m = w.members[mid];
      if (m && !worldSame(m.kh, kh)) return { status: 403, body: { ok: false, err: "WRONG_KEY" } };
      if (clean.base) for (const other of Object.keys(w.members)) {
        const b = other === mid ? null : w.members[other].base;
        if (b && Math.abs(b.x - clean.base.x) < 10 && Math.abs(b.y - clean.base.y) < 8) return { status: 409, body: { ok: false, err: "SITE_TAKEN" } };
      }
      const fresh = !m;
      if (fresh) {
        const n = worldSeat(w);
        if (n < 0) return { status: 409, body: { ok: false, err: "WORLD_MEMBERS_FULL" } };
        m = w.members[mid] = { n, kh, r: 0, ts: 0, name: "", char: "", base: null, yacht: null };
      }
      const same = !fresh && JSON.stringify(clean) === JSON.stringify({ name: m.name, char: m.char, base: m.base, yacht: m.yacht });
      m.ts = now();
      if (!same) {
        Object.assign(m, clean); m.r = w.rev + 1;
        await worldWrite(w);
        const r = fresh ? rooms.get(code) : null;
        if (r && r.world) emitLobby(r);
      }
      return { status: 200, body: { ok: true, rev: w.rev, n: m.n } };
    });
  }
  function worldEnter(code, mid, key, who) {
    return worldTask(code, async () => {
      const w = await worldRead(code);
      if (!w) return { err: "That world does not exist" };
      const kh = worldHash(key), m = w.members[mid];
      if (m) {
        if (!worldSame(m.kh, kh)) return { err: "This world belongs to another save" };
        m.ts = now(); return { w };
      }
      const n = worldSeat(w);
      if (n < 0) return { err: "This world has too many members" };
      w.members[mid] = { n, kh, r: w.rev + 1, ts: now(), name: lbClean(who.name) || "Player", char: cleanId(who.char) || "miner", base: null, yacht: null };
      try { await worldWrite(w); } catch (e) { dbError(e); }
      return { w };
    });
  }
  async function worldHttp(req, res, u) {
    if (req.method === "OPTIONS") { send(res,204,""); return; }
    if (!rateIP(req,"world:",90)) { send(res,429,{ok:false,err:"slow down"}); return; }
    try {
      const member = u.pathname === "/world/member";
      if (req.method === "GET" && !member) {
        const code = worldCode(u.searchParams.get("code"));
        if (!code) { send(res,400,{ok:false,err:"bad request"}); return; }
        const w = await worldTask(code, () => worldRead(code));
        if (!w) { send(res,404,{ok:false,err:"NOT_FOUND"}); return; }
        const r = rooms.get(code);
        send(res,200,{ok:true,world:worldPublic(w),online:r && r.world ? r.players.filter(live).length : 0,persistent:DB_ON}); return;
      }
      if (req.method === "POST" && !member) {
        const b = await readBody(req,2048);
        if (!b || typeof b !== "object" || Array.isArray(b)) { send(res,400,{ok:false,err:"bad request"}); return; }
        const name = worldName(b.name), mid = worldId(b.mid), key = worldSecret(b.key);
        if (!mid || !key) { send(res,400,{ok:false,err:"bad request"}); return; }
        if (!name || isBadName(name)) { send(res,200,{ok:false,err:"name not allowed"}); return; }
        if (!worldQuota(req)) { send(res,429,{ok:false,err:"WORLD_LIMIT"}); return; }
        const w = await worldCreate(name,mid,key);
        send(res,200,{ok:true,code:w.code,name:w.name,persistent:DB_ON}); return;
      }
      if (req.method === "PUT" || (req.method === "POST" && member)) {
        const b = await readBody(req,200000);
        if (!b || typeof b !== "object" || Array.isArray(b)) { send(res,400,{ok:false,err:"bad request"}); return; }
        const code = worldCode(b.code), mid = worldId(b.mid), key = worldSecret(b.key);
        if (!code || !mid || !key) { send(res,400,{ok:false,err:"bad request"}); return; }
        const out = await worldPut(code,mid,key,b.member);
        send(res,out.status,out.body); return;
      }
      send(res,405,{ok:false}); return;
    } catch (e) { dbError(e); send(res,503,{ok:false,err:"WORLDS_STORAGE"}); }
  }
  function hist(action, name, room) {
    const item = { t: new Date(now()).toISOString(), action, name, room: room || "" };
    HISTORY.push(item); if (HISTORY.length > 1000) HISTORY.shift();
    log(item.t, action.toUpperCase(), name, item.room ? "room " + item.room : "");
    void dbInsert(item);
  }
  const cors = { "Content-Type": "application/json; charset=utf-8", "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET,POST,PUT,OPTIONS", "Access-Control-Allow-Headers": "Content-Type, Authorization", "Cache-Control": "no-store" };
  function send(res, status, body, headers = cors) {
    if (res.destroyed || res.writableEnded) return;
    res.writeHead(status, headers); res.end(typeof body === "string" ? body : JSON.stringify(body));
  }
  const esc = s => String(s).replace(/[&<>"]/g, c => ({ "&":"&amp;", "<":"&lt;", ">":"&gt;", '"':"&quot;" }[c]));
  function rateIP(req, bucket = "", limit = 30) {
    const ip = bucket + String(req.headers["x-forwarded-for"] || req.socket.remoteAddress || "").split(",")[0].trim();

    for (const [key, value] of LB_RATE) if (now() - value.at > 60000) LB_RATE.delete(key);
    const r = LB_RATE.get(ip) || { n: 0, at: now() }; r.n++; LB_RATE.set(ip, r);
    return r.n <= limit;
  }
  async function handleHttp(req, res) {
    try {
      const u = new URL(req.url, "http://localhost");

      if (u.pathname === "/api/memory" || u.pathname.startsWith("/api/memory/")) {
        if (memory) return await memory.handler(req, res);
        send(res, 503, {error:"Memory Run is temporarily unavailable. Please try again."}); return;
      }
      if (u.pathname === "/names" || u.pathname === "/stats") {
        if (!ADMIN_KEY || u.searchParams.get("key") !== ADMIN_KEY) { send(res, 403, "Forbidden", { "Content-Type":"text/plain; charset=utf-8" }); return; }
        let rows = await dbFetch(); const persisted = rows !== null; if (!persisted) rows = HISTORY.slice();
        rows.sort((a,b) => String(b.t).localeCompare(String(a.t)));
        if (u.pathname === "/names") {
          send(res, 200, rows.length ? rows.map(h => h.t + "  " + String(h.action).toUpperCase().padEnd(7) + "  " + h.name + (h.room ? "  [" + h.room + "]" : "")).join("\n") : "(no players logged yet)", { "Content-Type":"text/plain; charset=utf-8" }); return;
        }
        const unique = new Map(); let creates = 0, joins = 0;
        for (const h of rows) {
          const key = String(h.name || "").toLowerCase();
          if (!unique.has(key)) unique.set(key, { name:h.name, first:h.t, last:h.t, plays:0 });
          const p = unique.get(key); if (String(h.t) < p.first) p.first = h.t; if (String(h.t) > p.last) p.last = h.t;
          if (["hello","create","join"].includes(h.action)) p.plays++;
          if (h.action === "create") creates++; if (h.action === "join") joins++;
        }
        const players = [...unique.values()].sort((a,b) => String(b.last).localeCompare(String(a.last)));
        let host = "(not configured)"; try { host = new URL(SUPABASE_URL).hostname; } catch (_) {}
        let html = '<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Water Escape · Players</title>';
        html += '<style>body{background:#0a0716;color:#eafaff;font-family:monospace;padding:20px;max-width:900px;margin:0 auto}h1{color:#5fe6ff}.s{display:flex;gap:14px;flex-wrap:wrap;margin:16px 0}.c{background:#161b24;border:2px solid #2a5a86;border-radius:8px;padding:12px 18px}.c b{color:#ffd23f;font-size:22px;display:block}table{width:100%;border-collapse:collapse;margin-top:16px}th,td{text-align:left;padding:8px;border-bottom:1px solid #223}th{color:#8fe0f5}tr:hover{background:#111a2b}.tag{color:#37e08a}.warn{color:#ff8c6a;font-size:13px}</style>';
        html += '<h1>🎮 Water Escape — Players</h1><div style="background:#0d1420;border:1px solid #223;border-radius:8px;padding:12px;margin:12px 0;font-size:13px"><b>Diagnostic:</b><br>Node version: ' + esc(process.version) + '<br>SUPABASE_URL configured: ' + !!SUPABASE_URL + '<br>URL host: ' + esc(host) + '<br>SUPABASE_KEY configured: ' + !!SUPABASE_KEY + '<br>Database mode: ' + (DB_ON ? 'ON' : 'OFF') + '<br>Connection test: ' + (DB_OK_ONCE ? 'connected successfully' : 'no successful connection yet');
        if (DB_LAST_ERR) html += '<br>Last error: <span class="warn">' + esc(DB_LAST_ERR) + '</span>';
        html += '</div><p class="' + (persisted ? 'tag' : 'warn') + '">' + (persisted ? '✓ Persistent history (survives restarts)' : 'Showing in-memory history only; it resets when the server restarts.') + '</p><div class="s">';
        for (const [value,label] of [[unique.size,'unique players'],[rows.length,'total events'],[creates,'rooms created'],[joins,'joins']]) html += '<div class="c"><b>' + value + '</b>' + label + '</div>';
        html += '</div><table><tr><th>Nickname</th><th>Times played</th><th>First seen</th><th>Last seen</th></tr>';
        for (const p of players) html += '<tr><td>' + esc(p.name) + '</td><td>' + p.plays + '</td><td>' + esc(new Date(p.first).toLocaleString()) + '</td><td>' + esc(new Date(p.last).toLocaleString()) + '</td></tr>';
        send(res, 200, html + '</table>', { "Content-Type":"text/html; charset=utf-8", "Cache-Control":"no-store" }); return;
      }
      if (["/top","/score","/me"].includes(u.pathname)) {
        if (req.method === "OPTIONS") { send(res,204,""); return; }
        if (u.pathname === "/score") {
          if (req.method !== "POST") { send(res,405,{ok:false}); return; }
          if (!rateIP(req)) { send(res,429,{ok:false,err:"slow down"}); return; }
          const b = await readBody(req);
          if (!b) { send(res,400,{ok:false}); return; }
          const dev = cleanId(b.dev), mode = String(b.mode || ""), score = Number(b.score), name = lbClean(b.name);
          if (dev.length < 6 || !LB_MODES.includes(mode) || !Number.isFinite(score)) { send(res,400,{ok:false,err:"bad request"}); return; }
          if (!name) { send(res,200,{ok:false,err:"name not allowed"}); return; }
          send(res,200,await lbSubmit(dev,name,mode,score)); return;
        }
        const mode = String(u.searchParams.get("mode") || "normal");
        if (!LB_MODES.includes(mode)) { send(res,400,{ok:false}); return; }
        if (u.pathname === "/top") {
          const list = (await lbRows(mode)).slice(0,10).map(x => ({name:x.name,score:x.score,dev:x.dev}));
          send(res,200,{ok:true,mode,list,persistent:DB_ON}); return;
        }
        const dev = cleanId(u.searchParams.get("dev"));
        if (dev.length < 6) { send(res,400,{ok:false}); return; }
        let item;
        if (DB_ON) {
          const result = await httpsReqFull("GET", "/rest/v1/scores?select=name,score&dev=eq." + encodeURIComponent(dev) + "&mode=eq." + mode + "&limit=1",null);
          item = JSON.parse(result.body || "[]")[0]; dbGood();
        } else item = LB_MEM[mode].get(dev);
        send(res,200,item ? {ok:true,...await lbRankName(mode,item.name,item.score)} : {ok:true,best:null,rank:null}); return;
      }
      if (u.pathname === "/api/auth" || u.pathname === "/api/progress") {
        if (req.method === "OPTIONS") { send(res,204,""); return; }
        await joseReady;
        if (!JOSE || !JWT_SECRET) { send(res,503,{ok:false,err:"cloud save not configured"}); return; }
        if (u.pathname === "/api/auth") {
          if (req.method !== "POST") { send(res,405,{ok:false}); return; }
          const b = await readBody(req,200000);
          if (!b || !["apple","google"].includes(b.provider)) { send(res,400,{ok:false,err:"provider"}); return; }
          try {
            const uid = await progVerify(b.provider,String(b.idToken || ""));
            const tok = await new JOSE.SignJWT({uid,provider:b.provider}).setProtectedHeader({alg:"HS256"}).setIssuedAt().setExpirationTime("365d").sign(progSecret());
            hist("cloud",uid.slice(0,20)); send(res,200,{ok:true,uid,tok});
          } catch (e) { log("Auth error:",e.message); send(res,401,{ok:false,err:"invalid token"}); }
          return;
        }
        const session = await progAuth(req);
        if (!session) { send(res,401,{ok:false}); return; }
        if (req.method === "GET") { send(res,200,{ok:true,data:await progGet(session.uid)}); return; }
        if (req.method === "PUT" || req.method === "POST") {
          const data = progClean(await readBody(req,200000));
          if (!data) { send(res,400,{ok:false}); return; }
          await progPut(session.uid,String(session.provider || ""),data);
          send(res,200,{ok:true}); return;
        }
        send(res,405,{ok:false}); return;
      }
      if (u.pathname === "/world" || u.pathname === "/world/member") { await worldHttp(req,res,u); return; }
      if (u.pathname === "/time") { send(res,200,{t:now(),worlds:1,cast:1}); return; }
      send(res,200,"Water Escape server OK",{"Content-Type":"text/plain; charset=utf-8"});
    } catch (e) { dbError(e); send(res,503,{ok:false,err:"temporarily unavailable"}); }
  }

  let memory = null;
  try {
    const createMemory = options.createMemoryService || require("./memory-service.cjs").createService;
    memory = createMemory(Object.assign({}, options.memory || {}, {env, log}));
  } catch (e) {

    log("Memory Run initialization failed:", e.message);
  }
  const srv = http.createServer(handleHttp);
  srv.on("close", () => { if (memory) memory.close(); });
  const Server = options.Server || require("socket.io").Server;
  const io = new Server(srv, { cors: { origin: "*" }, maxHttpBufferSize: 1000000 });
  const rooms = new Map(), sessions = new Map(), names = new Map();
  let closing = false;
  const ABC = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789", MODES = ["ffa","surv","teams"], MAPS = ["waterescape","volcano","jungle"];
  const token = () => crypto.randomBytes(24).toString("hex");
  const live = p => !p.ghost && !!io.sockets.sockets.get(p.id)?.connected;
  function makeCode() { let code; do { code = Array.from({length:4}, () => ABC[crypto.randomInt(ABC.length)]).join(""); } while (rooms.has(code)); return code; }
  function pmap(r, participants = false) {
    return r.players.filter(p => !participants || p.inMatch).map(p => ({ idx:p.idx,pid:p.pid,name:p.name,cos:p.cos || null,char:RosterMigration.resolve(p.char),
      team:p.team == null ? null : p.team,connected:live(p),inMatch:!!p.inMatch,...(r.world ? worldTag(r,p) : {}) }));
  }
  function worldTag(r,p) { const entry = WORLDS.get(r.code), m = entry && p.mid ? entry.w.members[p.mid] : null; return {mid:p.mid || "",seat:m ? m.n : -1}; }
  function worldHost(r) {
    if (r.players.some(p => p.id === r.hostId && live(p))) return;
    const next = r.players.find(live);
    r.hostId = next ? next.id : null;
    if (next) identity(r);
  }
  function lobby(r) { return {code:r.code,players:pmap(r),started:r.started,mode:r.mode,map:r.map,teams:r.mode === "teams",match:r.match,hostConnected:r.players.some(p => p.idx === 0 && live(p))}; }
  function startPayload(r) { return {code:r.code,players:pmap(r,true),mode:r.mode,teams:r.mode === "teams",map:r.map,match:r.match}; }
  function sessionPayload(r,p) { return {ok:true,code:r.code,idx:p.idx,host:r.world ? r.hostId === p.id : p.idx === 0,started:r.started,mode:r.mode,map:r.map,team:p.team,match:r.match,
    pid:p.pid,resumeToken:p.resumeToken,participant:!!p.inMatch,players:pmap(r,true),protocol:2,...(r.world ? {world:1} : {})}; }
  function emitLobby(r) { io.to(r.code).emit("lobby",lobby(r)); }
  function identity(r) { for (const p of r.players) if (live(p)) io.to(p.id).emit("roomSession",sessionPayload(r,p)); }
  function releaseName(sid) {
    for (const [name, entry] of names) if (entry.sid === sid && !entry.ids.size && !sessions.has(sid)) names.delete(name);
  }
  function restart(r) {
    r.match++; r.lastState = null; r.seq = 0;
    r.players.forEach(p => { p.again = false; p.inMatch = live(p); });
    io.to(r.code).emit("restart",startPayload(r));
  }
  function againCount(r) {
    const voters = r.players.filter(p => p.inMatch);
    const count = voters.filter(p => p.again).length;
    io.to(r.code).emit("againCount",count,voters.length);
    if (voters.length && voters.every(p => p.again && live(p)) && r.players.filter(live).length >= 2) restart(r);
  }
  function returnLobby(r, reason) {
    r.started = false; r.lastState = null; r.seq = 0;
    r.players.forEach(p => { p.again = false; p.inMatch = false; });
    identity(r);
    io.to(r.code).emit("hostToLobby",{code:r.code,reason});
    emitLobby(r);
  }
  function ensureHost(r) {
    if (r.world) { worldHost(r); return; }
    if (r.players.some(p => p.idx === 0)) return;
    const next = r.players.find(live);
    if (!next) { r.hostId = null; return; }
    next.idx = 0; r.hostId = next.id;

    returnLobby(r,"host_left");
  }
  function finalize(r,p) {
    if (rooms.get(r.code) !== r || !r.players.includes(p)) return;
    if (p.tm) { cancel(p.tm); p.tm = null; }
    const wasHost = p.idx === 0;
    r.players = r.players.filter(x => x !== p);
    if (sessions.get(p.sid) === p) sessions.delete(p.sid);
    io.sockets.sockets.get(p.id)?.leave(r.code);
    releaseName(p.sid);
    if (!r.players.length) { rooms.delete(r.code); return; }
    io.to(r.code).emit("left",{name:p.name,idx:p.idx,pid:p.pid});
    if (r.world) { worldHost(r); emitLobby(r); return; }
    if (wasHost) {
      r.hostId = null;
      if (!r.players.some(live)) { r.started = false; r.lastState = null; }
      ensureHost(r); emitLobby(r); return;
    }
    emitLobby(r);
    if (r.hostId) io.to(r.hostId).emit("peerLeft",{idx:p.idx});
    if (r.started) againCount(r);
  }
  function unitDir(d) {
    if (!Array.isArray(d) || d.length !== 2 || !d.every(Number.isFinite)) return null;
    const dx = Math.max(-1,Math.min(1,d[0]|0)), dy = Math.max(-1,Math.min(1,d[1]|0));
    return Math.abs(dx) + Math.abs(dy) === 1 ? [dx,dy] : null;
  }
  io.on("connection", sock => {
    let room = null, player = null, me = null;
    const buckets = new Map();
    function allowed(key, perSecond, capacity) {
      const time = now(), b = buckets.get(key) || {at:time,n:capacity};
      b.n = Math.min(capacity,b.n + Math.max(0,time - b.at)*perSecond/1000); b.at = time;
      buckets.set(key,b); if (b.n < 1) return false; b.n--; return true;
    }
    function owns() { return room && player && rooms.get(room.code) === room && room.players.includes(player) && player.id === sock.id && !player.ghost; }
    function playing() { return owns() && room.started && player.inMatch && allowed("play",120,180); }
    function host() { return owns() && room.hostId === sock.id; }
    function relay(event, data) {
      const hp = room.players.find(p => room.world ? p.id === room.hostId : p.idx === 0);
      if (hp && live(hp)) io.to(room.hostId).emit(event,data);
    }
    function verifyResume(p) { return !p.requiresToken || (me && typeof me.resumeToken === "string" && me.resumeToken === p.resumeToken); }
    function addPlayer(r,idx) {
      const p = {id:sock.id,idx,name:me.name,sid:me.sid,cos:me.cos,char:me.char,team:null,again:false,ghost:false,tm:null,
        pid:crypto.randomBytes(8).toString("hex"),resumeToken:/^[0-9a-f]{48}$/i.test(me.resumeToken)?me.resumeToken:token(),requiresToken:me.protocol >= 2,code:r.code,inMatch:false};
      r.players.push(p); sessions.set(p.sid,p); room = r; player = p; sock.join(r.code); return p;
    }
    sock.on("hello",(raw,cb) => {
      if (typeof cb !== "function") return;
      if (!allowed("hello",2,6)) { cb({ok:false,err:"Please wait a moment"}); return; }
      const data = raw && typeof raw === "object" ? raw : {name:raw};
      let name = cleanName(data.name);
      const sid = cleanId(data.sid) || ("a" + sock.id.replace(/[^\w-]/g,"").slice(0,20));
      const prior = sessions.get(sid), supplied = String(data.resumeToken || "").slice(0,96);
      if (prior && prior.requiresToken && supplied !== prior.resumeToken && prior.id !== sock.id) { cb({ok:false,err:"Session belongs to another connection"}); return; }
      if (prior) name = prior.name;
      if (name && isBadName(name)) { cb({ok:false,err:"That nickname is not allowed"}); return; }
      if (!name) {
        const a=["Salty","Sneaky","Rusty","Zippy","Mossy","Frosty","Turbo","Jolly","Grumpy","Bouncy","Pixel","Rogue","Crispy","Swift"],b=["Otter","Newt","Squid","Gecko","Yeti","Comet","Pickle","Noodle","Waffle","Walrus","Puffin","Sloth","Kraken","Goblin"];
        name=(a[crypto.randomInt(a.length)]+b[crypto.randomInt(b.length)]).slice(0,12);
      }
      const key = name.toLowerCase(), reservation = names.get(key);
      if (reservation && reservation.sid !== sid) { cb({ok:false,err:"That nickname is already taken"}); return; }
      if (me && (me.sid !== sid || me.name !== name)) {
        if (owns()) { cb({ok:false,err:"Leave the room before changing profile"}); return; }
        names.get(me.name.toLowerCase())?.ids.delete(sock.id); releaseName(me.sid);
      }
      const entry = reservation || {sid,ids:new Set()}; entry.ids.add(sock.id); names.set(key,entry);
      me={name,sid,char:RosterMigration.resolve(cleanId(data.char)),protocol:data.protocol|0,resumeToken:supplied,
        cos:data.cos&&typeof data.cos==="object"?{s:data.cos.s?1:0,w:data.cos.w?1:0,g:data.cos.g?1:0,fx:String(data.cos.fx||"").replace(/[^\w|]/g,"").slice(0,120)}:null};
      hist("hello",name); cb({ok:true,name,protocol:2,rejoin:!!prior,worlds:1,cast:1});
    });
    sock.on("create",cb => {
      if (typeof cb !== "function") return;
      if (!me) { cb({ok:false,err:"Pick a nickname first"}); return; }
      if (owns()) { cb(sessionPayload(room,player)); return; }
      if (sessions.has(me.sid)) { cb({ok:false,err:"Rejoin your existing room first"}); return; }
      const code=makeCode(),r={code,hostId:sock.id,players:[],started:false,mode:"ffa",map:"waterescape",match:0,seq:0,lastState:null};
      rooms.set(code,r); addPlayer(r,0); hist("create",me.name,code); cb(sessionPayload(r,player)); emitLobby(r);
    });
    sock.on("join",(code,cb) => {
      if (typeof cb !== "function") return;
      if (!me) { cb({ok:false,err:"Pick a nickname first"}); return; }
      code=String(code||"").toUpperCase().replace(/[^A-Z0-9]/g,"").slice(0,4);
      if (owns()) { cb(room.code===code?sessionPayload(room,player):{ok:false,err:"You are already in a room"}); return; }
      if (sessions.has(me.sid)) { cb({ok:false,err:"Rejoin your existing room first"}); return; }
      const r=rooms.get(code);
      if (!r) { cb({ok:false,err:"That room does not exist"}); return; }
      if (r.started) { cb({ok:false,err:"The match already started"}); return; }
      if (r.players.length>=8) { cb({ok:false,err:"Room is full (max 8)"}); return; }
      let idx=0; while(r.players.some(p=>p.idx===idx))idx++;
      addPlayer(r,idx); ensureHost(r); hist("join",me.name,code); cb(sessionPayload(r,player)); emitLobby(r);
    });
    sock.on("world",(raw,cb) => {
      if (typeof cb !== "function") return;
      if (!me) { cb({ok:false,err:"Pick a nickname first"}); return; }
      if (!allowed("world",1,6)) { cb({ok:false,err:"Please wait a moment"}); return; }
      const data=raw&&typeof raw==="object"&&!Array.isArray(raw)?raw:{},code=worldCode(data.code),mid=worldId(data.mid),key=worldSecret(data.key),who=me;
      if (!code) { cb({ok:false,err:String(data.code == null ? "" : data.code).length === 6 ? "That world does not exist" : "World codes have 6 characters"}); return; }
      if (!mid||!key) { cb({ok:false,err:"World identity missing"}); return; }
      const inside=()=>room.world&&room.code===code&&player.mid===mid?sessionPayload(room,player):{ok:false,err:"You are already in a room"};
      if (owns()) { cb(inside()); return; }
      worldEnter(code,mid,key,who).then(found => {
        if (found.err) { cb({ok:false,err:found.err}); return; }
        if (closing||!sock.connected||me!==who) { cb({ok:false,err:"Connection changed"}); return; }
        if (owns()) { cb(inside()); return; }
        const prior=sessions.get(me.sid),old=prior&&rooms.get(prior.code);
        if (old&&(!old.world||!verifyResume(prior))) { cb({ok:false,err:"Rejoin your existing room first"}); return; }
        if (old) finalize(old,prior); else if (prior) sessions.delete(me.sid);
        let r=rooms.get(code);
        if (!r) { r={code,hostId:null,players:[],started:true,mode:"ffa",map:"waterescape",match:1,seq:0,lastState:null,world:true}; rooms.set(code,r); }
        if (!r.world||r.players.length>=8) { cb({ok:false,err:"World is full (max 8)"}); return; }
        let idx=0; while(r.players.some(p=>p.idx===idx))idx++;
        const p=addPlayer(r,idx); p.inMatch=true; p.mid=mid;
        worldHost(r); hist("world",me.name,code); cb(sessionPayload(r,p)); emitLobby(r);
      }).catch(e => { dbError(e); cb({ok:false,err:"WORLDS_STORAGE"}); });
    });
    sock.on("rejoin",cb => {
      if (typeof cb !== "function") return;
      const p=me&&sessions.get(me.sid),r=p&&rooms.get(p.code);
      if (!p || !r || !verifyResume(p)) { cb({ok:false,err:"SESSION_EXPIRED"}); return; }
      if (room && room!==r) { cb({ok:false,err:"You are already in another room"}); return; }
      const old=io.sockets.sockets.get(p.id);
      if(p.tm){cancel(p.tm);p.tm=null;}

      p.id=sock.id;p.ghost=false;p.char=me.char;p.cos=me.cos;
      room=r;player=p;sock.join(r.code);
      if(p.idx===0&&!r.world)r.hostId=sock.id;
      if(old&&old!==sock){old.leave(r.code);old.disconnect(true);}
      ensureHost(r);hist("rejoin",me.name,r.code);cb(sessionPayload(r,p));emitLobby(r);
      if(r.started&&p.inMatch&&p.idx!==0&&r.lastState)sock.emit("state",r.lastState);
    });
    sock.on("mode",mode => {if(!host()||room.started||!MODES.includes(mode))return;room.mode=mode;room.players.forEach(p=>{p.team=mode==="teams"?(p.team==null?p.idx%4:p.team):null;});emitLobby(room);});
    sock.on("map",map => {if(!host()||room.started||!MAPS.includes(map))return;room.map=map;emitLobby(room);});
    sock.on("team",team => {if(!owns()||room.started||room.mode!=="teams"||!Number.isInteger(team)||team<0||team>3)return;player.team=team;emitLobby(room);io.to(room.hostId).emit("peerTeam",{idx:player.idx,team});});
    sock.on("setTeam",d => {if(!host()||room.started||!d||!Number.isInteger(d.team)||d.team<0||d.team>3)return;const p=room.players.find(x=>x.idx===d.idx);if(p){p.team=d.team;emitLobby(room);}});
    sock.on("char",ch => {if(!owns()||room.started)return;ch=cleanId(ch);if(ch){player.char=RosterMigration.resolve(ch);me.char=player.char;emitLobby(room);}});
    sock.on("start",() => {
      if(!host()||room.started)return;
      const active=room.players.filter(live);if(active.length<2)return;
      if(room.mode==="teams"){
        active.forEach(p=>{if(p.team==null)p.team=p.idx%4;});
        if(new Set(active.map(p=>p.team)).size<2)return;
      }
      room.started=true;room.match++;room.seq=0;room.lastState=null;
      room.players.forEach(p=>{p.again=false;p.inMatch=live(p);});
      io.to(room.code).emit("start",startPayload(room));
    });
    sock.on("backToLobby",() => {if(host()&&!room.world)returnLobby(room,"host_returned");});
    for(const event of ["input","chain","escape"])sock.on(event,d=>{if(!playing())return;const dir=unitDir(d);if(dir)relay(event,{idx:player.idx,d:dir});});
    sock.on("tp",d=>{if(!playing()||!Array.isArray(d)||d.length!==2||!d.every(Number.isFinite))return;relay("tp",{idx:player.idx,d:[d[0]|0,d[1]|0]});});
    sock.on("aim",d=>{if(playing()&&Number.isFinite(d))relay("aim",{idx:player.idx,d:(d|0)<0?-1:1});});
    sock.on("throw",d=>{if(!playing())return;if(Array.isArray(d)&&d.length===2&&d.every(Number.isFinite))relay("throw",{idx:player.idx,d:[d[0]|0,d[1]|0]});else if(Number.isFinite(d))relay("throw",{idx:player.idx,d:d|0});});
    sock.on("cast",d=>{if(!playing()||!Array.isArray(d)||d.length!==2||!d.every(Number.isFinite))return;sock.to(room.code).emit("cast",{idx:player.idx,d:[d[0]|0,d[1]|0]});});
    sock.on("chainArm",d=>{if(playing())relay("chainArm",{idx:player.idx,d:d?1:0});});
    sock.on("rush",()=>{if(playing())relay("rush",{idx:player.idx});});
    sock.on("emote",k=>{if(!playing()||!Number.isInteger(k)||k<0||k>6)return;relay("emote",{idx:player.idx,k});});
    sock.on("firework",packet=>{
      if(!playing()||!packet||typeof packet!=="object"||Array.isArray(packet))return;
      const state=room.lastState;

      if(!state||state.end||!state.sp||typeof state.sp.key!=="string"||state.sp.left>0)return;
      if(packet.v!==1||typeof packet.id!=="string"||!/^[a-zA-Z0-9_-]{1,80}$/.test(packet.id)||
        !Number.isInteger(packet.mn)||packet.mn!==state.mn||typeof packet.key!=="string"||packet.key!==state.sp.key||
        !Number.isInteger(packet.seed)||packet.seed<0||packet.seed>4294967295||
        !Number.isInteger(packet.color)||packet.color<0||packet.color>=48||
        !Number.isFinite(packet.at)||packet.at<0)return;
      const position=state.pl.find(p=>p.i===player.idx);
      if(!position||position.d||position.h<=0||!Number.isInteger(position.c)||position.c<0||position.c>=6||
        !Number.isInteger(position.r)||position.r<0||position.r>=11)return;
      if(!room.fireworks||room.fireworks.match!==room.match)room.fireworks={match:room.match,seen:new Set(),shots:new Map(),introEnded:false};
      const fireworks=room.fireworks,seen=fireworks.seen;
      if(seen.has(packet.id))return;

      if(!Number.isFinite(state.it)||state.it>=4)fireworks.introEnded=true;
      if(fireworks.introEnded){
        const time=now(),recent=(fireworks.shots.get(player.idx)||[]).filter(at=>time-at<10000);
        if(recent.length>=3)return;
        recent.push(time);fireworks.shots.set(player.idx,recent);
      }
      seen.add(packet.id);
      if(seen.size>2048)seen.delete(seen.values().next().value);

      sock.to(room.code).emit("firework",{v:1,id:packet.id,by:player.idx,mn:state.mn,key:state.sp.key,
        seed:packet.seed,color:packet.color,c:position.c,r:position.r,at:packet.at});
    });
    sock.on("state",s=>{
      if(!host()||!room.started||!s||typeof s!=="object"||Array.isArray(s)||!Array.isArray(s.pl)||s.pl.length>8||!s.w)return;
      if(![s.bo,s.ho,s.fr].every(a=>Array.isArray(a)&&a.length<=1024)||s.pl.some(p=>!p||!Number.isInteger(p.i)||p.i<0||p.i>7))return;
      if(s.room&&s.room!==room.code)return;
      if(s.match!==undefined&&s.match!==room.match)return;
      if(!allowed("state",60,90))return;
      const firstEnd=!!s.end&&!room.lastState?.end;
      const state={...s,room:room.code,match:room.match,seq:++room.seq};room.lastState=state;

      if(firstEnd)sock.to(room.code).emit("state",state);
      else sock.to(room.code).volatile.emit("state",state);
    });
    sock.on("again",()=>{if(!owns()||room.world||!room.started||!player.inMatch||player.again)return;player.again=true;againCount(room);});
    sock.on("leave",cb=>{
      if(!owns()){if(typeof cb==="function")cb({ok:true});return;}
      const r=room,p=player;room=null;player=null;
      sock.leave(r.code);finalize(r,p);
      if(typeof cb==="function")cb({ok:true});
    });
    sock.on("disconnect",()=>{
      if(me){names.get(me.name.toLowerCase())?.ids.delete(sock.id);releaseName(me.sid);}
      if(closing||!room||!player||player.id!==sock.id||!room.players.includes(player))return;
      const r=room,p=player;room=null;player=null;
      p.ghost=true;
      if(p.tm)cancel(p.tm);
      p.tm=later(()=>{p.tm=null;if(p.ghost)finalize(r,p);},GRACE_MS);
      if(p.tm&&p.tm.unref)p.tm.unref();
      if(r.world)worldHost(r);
      emitLobby(r);
    });
  });
  function close() {
    closing = true;
    if (memory) memory.close();
    for(const r of rooms.values())for(const p of r.players)if(p.tm)cancel(p.tm);
    return new Promise(resolve=>io.close(resolve));
  }
  return {srv,io,close,joseReady,handleHttp,rooms,sessions,memory,
    diagnostics:{httpsReqFull,lbSubmit,lbRows,progPut,progGet,progClean,isBadName,finalize}};
}

if(require.main===module){
  const app=createWaterEscapeServer();
  const port=Number(process.env.PORT)||3000;
  app.srv.listen(port,"0.0.0.0",()=>console.log("Water Escape server listening on "+port));
}
module.exports={createWaterEscapeServer};
