"use strict";

// Existing rooms, authentication and Supabase endpoints are preserved.
// Memory Run shares this HTTP listener; no extra Render service is needed.
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

  // These are SOLO leaderboards only. No socket event submits multiplayer scores.
  const LB_MODES = ["normal", "rush", "memory"];
  const LB_MAX = { normal: 5000, rush: 5000, memory: 2000 };
  const LB_MEM = { normal: new Map(), rush: new Map(), memory: new Map() };
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
          // Avoid unlimited work if a proxy ignores the pagination parameter.
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
      // An insert cannot overwrite a concurrent record. The conditional PATCH
      // updates the maximum atomically in Postgres, including across instances.
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
    // Saving succeeded even if a separate rank lookup times out.
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
      // null is an explicit REMOVE, not a missing selection to restore later.
      if (id === null || (typeof id === "string" && has(out.own,id))) out.eq[map] = id;
    }
    return out;
  }
  function progClean(d) {
    if (!d || typeof d !== "object" || Array.isArray(d)) return null;
    const hasThemes = Object.prototype.hasOwnProperty.call(d,"tileThemes");
    if (hasThemes && (!d.tileThemes || typeof d.tileThemes !== "object" || Array.isArray(d.tileThemes))) return null;
    const ch = record(d.char), fx = record(d.fx), cos = record(d.cos);
    return { v: 1, ts: now(), stars: Math.max(0, Math.min(10000000, Number(d.stars) || 0)),
      best: Math.max(0, Number(d.best) | 0), bestSoloN: Math.max(0, Number(d.bestSoloN) | 0), bestSoloR: Math.max(0, Number(d.bestSoloR) | 0),
      name: String(d.name || "").slice(0,12), nameTyped: !!d.nameTyped, soloSeen: !!d.soloSeen,
      inv: record(d.inv), char: { own: record(ch.own), sel: String(ch.sel || "miner") },
      fx: { own: record(fx.own), sel: record(fx.sel) }, cos: { own: record(cos.own), eq: record(cos.eq) },
      ...(hasThemes ? {tileThemes:progThemes(d.tileThemes)} : {}) };
  }
  async function progGet(uid) {
    if (!DB_ON) throw new Error("Persistent cloud storage is not configured");
    const result = await httpsReqFull("GET", "/rest/v1/progress?select=data&uid=eq." + encodeURIComponent(uid) + "&limit=1", null);
    const rows = JSON.parse(result.body || "[]"); dbGood();
    return rows.length ? rows[0].data || null : null;
  }
  async function progPut(uid, provider, data) {
    if (!DB_ON) throw new Error("Persistent cloud storage is not configured");
    // Older app builds omit this field. Preserve its stored value instead of
    // erasing purchased themes when the rest of that build's progress is saved.
    // Current builds keep the existing single-write path; no database migration.
    if (!Object.prototype.hasOwnProperty.call(data,"tileThemes")) {
      const previous = await progGet(uid);
      data = {...data,tileThemes:progThemes(previous && previous.tileThemes)};
    }
    await httpsReqFull("POST", "/rest/v1/progress?on_conflict=uid", { uid, provider, data, updated_at: new Date(now()).toISOString() },
      { Prefer: "resolution=merge-duplicates,return=minimal" });
    dbGood(); return true;
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
  function rateIP(req) {
    const ip = String(req.headers["x-forwarded-for"] || req.socket.remoteAddress || "").split(",")[0].trim();
    // The deployment proxy must replace x-forwarded-for. This is a load limit,
    // not proof of identity or proof that a solo score was legitimately earned.
    for (const [key, value] of LB_RATE) if (now() - value.at > 60000) LB_RATE.delete(key);
    const r = LB_RATE.get(ip) || { n: 0, at: now() }; r.n++; LB_RATE.set(ip, r);
    return r.n <= 30;
  }
  async function handleHttp(req, res) {
    try {
      const u = new URL(req.url, "http://localhost");
      // Delegate before generic CORS/body handling: Memory owns its native-app
      // origin checks and private, per-player snapshots.
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
      if (u.pathname === "/time") { send(res,200,{t:now()}); return; }
      send(res,200,"Water Escape server OK",{"Content-Type":"text/plain; charset=utf-8"});
    } catch (e) { dbError(e); send(res,503,{ok:false,err:"temporarily unavailable"}); }
  }

  let memory = null;
  try {
    const createMemory = options.createMemoryService || require("./memory-service.cjs").createService;
    memory = createMemory(Object.assign({}, options.memory || {}, {env, log}));
  } catch (e) {
    // A damaged or unavailable Memory data file must not take existing
    // multiplayer, purchases/cloud credentials or rankings offline.
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
      team:p.team == null ? null : p.team,connected:live(p),inMatch:!!p.inMatch }));
  }
  function lobby(r) { return {code:r.code,players:pmap(r),started:r.started,mode:r.mode,map:r.map,teams:r.mode === "teams",match:r.match,hostConnected:r.players.some(p => p.idx === 0 && live(p))}; }
  function startPayload(r) { return {code:r.code,players:pmap(r,true),mode:r.mode,teams:r.mode === "teams",map:r.map,match:r.match}; }
  function sessionPayload(r,p) { return {ok:true,code:r.code,idx:p.idx,host:p.idx === 0,started:r.started,mode:r.mode,map:r.map,team:p.team,match:r.match,
    pid:p.pid,resumeToken:p.resumeToken,participant:!!p.inMatch,players:pmap(r,true),protocol:2}; }
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
    if (r.players.some(p => p.idx === 0)) return;
    const next = r.players.find(live);
    if (!next) { r.hostId = null; return; }
    next.idx = 0; r.hostId = next.id;
    // The original game has no complete simulation transfer. A permanent host
    // departure returns everybody to the SAME room instead of inventing a match.
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
      const hp = room.players.find(p => p.idx === 0);
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
      hist("hello",name); cb({ok:true,name,protocol:2,rejoin:!!prior});
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
    sock.on("rejoin",cb => {
      if (typeof cb !== "function") return;
      const p=me&&sessions.get(me.sid),r=p&&rooms.get(p.code);
      if (!p || !r || !verifyResume(p)) { cb({ok:false,err:"SESSION_EXPIRED"}); return; }
      if (room && room!==r) { cb({ok:false,err:"You are already in another room"}); return; }
      const old=io.sockets.sockets.get(p.id);
      if(p.tm){cancel(p.tm);p.tm=null;}
      // Transfer ownership BEFORE closing the previous socket. Its disconnect
      // callback then cannot mark the replacement connection as a ghost.
      p.id=sock.id;p.ghost=false;p.char=me.char;p.cos=me.cos;
      room=r;player=p;sock.join(r.code);
      if(p.idx===0)r.hostId=sock.id;
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
    sock.on("backToLobby",() => {if(host())returnLobby(room,"host_returned");});
    for(const event of ["input","chain","escape"])sock.on(event,d=>{if(!playing())return;const dir=unitDir(d);if(dir)relay(event,{idx:player.idx,d:dir});});
    sock.on("tp",d=>{if(!playing()||!Array.isArray(d)||d.length!==2||!d.every(Number.isFinite))return;relay("tp",{idx:player.idx,d:[d[0]|0,d[1]|0]});});
    sock.on("aim",d=>{if(playing()&&Number.isFinite(d))relay("aim",{idx:player.idx,d:(d|0)<0?-1:1});});
    sock.on("throw",d=>{if(!playing())return;if(Array.isArray(d)&&d.length===2&&d.every(Number.isFinite))relay("throw",{idx:player.idx,d:[d[0]|0,d[1]|0]});else if(Number.isFinite(d))relay("throw",{idx:player.idx,d:d|0});});
    sock.on("chainArm",d=>{if(playing())relay("chainArm",{idx:player.idx,d:d?1:0});});
    sock.on("rush",()=>{if(playing())relay("rush",{idx:player.idx});});
    sock.on("emote",k=>{if(!playing()||!Number.isInteger(k)||k<0||k>6)return;relay("emote",{idx:player.idx,k});});
    sock.on("state",s=>{
      if(!host()||!room.started||!s||typeof s!=="object"||Array.isArray(s)||!Array.isArray(s.pl)||s.pl.length>8||!s.w)return;
      if(![s.bo,s.ho,s.fr].every(a=>Array.isArray(a)&&a.length<=1024)||s.pl.some(p=>!p||!Number.isInteger(p.i)||p.i<0||p.i>7))return;
      if(s.room&&s.room!==room.code)return;
      if(s.match!==undefined&&s.match!==room.match)return;
      if(!allowed("state",60,90))return;
      const firstEnd=!!s.end&&!room.lastState?.end;
      const state={...s,room:room.code,match:room.match,seq:++room.seq};room.lastState=state;
      // Replaceable snapshots must not pile up behind a slow mobile connection.
      // The first final result remains reliable; cumulative awards stay in state.
      if(firstEnd)sock.to(room.code).emit("state",state);
      else sock.to(room.code).volatile.emit("state",state);
    });
    sock.on("again",()=>{if(!owns()||!room.started||!player.inMatch||player.again)return;player.again=true;againCount(room);});
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
