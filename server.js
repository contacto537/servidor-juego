const http=require("http");
const {Server}=require("socket.io");
const ADMIN_KEY=process.env.ADMIN_KEY||"vikingo537";
const https=require("https");
const SUPABASE_URL=(process.env.SUPABASE_URL||"").trim().replace(/\/$/,"");
const SUPABASE_KEY=(process.env.SUPABASE_KEY||"").trim();
const DB_ON=!!(SUPABASE_URL&&SUPABASE_KEY);
let DB_LAST_ERR="";
let DB_OK_ONCE=false;
const HISTORY=[];
console.log("=== Water Escape server starting ===");
console.log("Node version:",process.version);
console.log("SUPABASE_URL set:",SUPABASE_URL?("yes ("+SUPABASE_URL.slice(0,28)+"...)"):"NO");
console.log("SUPABASE_KEY set:",SUPABASE_KEY?("yes, length "+SUPABASE_KEY.length):"NO");
console.log("Database mode:",DB_ON?"ON (persistent)":"OFF (memory only)");
function httpsReq(method,path,bodyObj){
return new Promise((resolve,reject)=>{
let host,base,port;
try{const u=new URL(SUPABASE_URL);host=u.hostname;port=u.port||443;base=u.pathname.replace(/\/$/,"")}catch(e){return reject(new Error("Bad SUPABASE_URL"))}
const body=bodyObj?JSON.stringify(bodyObj):null;
const headers={
"apikey":SUPABASE_KEY,
"Authorization":"Bearer "+SUPABASE_KEY,
"Content-Type":"application/json"
};
if(method==="POST")headers["Prefer"]="return=minimal";
if(body)headers["Content-Length"]=Buffer.byteLength(body);
const req=https.request({hostname:host,port:port,path:base+path,method,headers},res=>{
let data="";
res.on("data",c=>data+=c);
res.on("end",()=>{
if(res.statusCode>=200&&res.statusCode<300)resolve(data);
else reject(new Error("HTTP "+res.statusCode+": "+data.slice(0,200)));
});
});
req.on("error",e=>reject(e));
if(body)req.write(body);
req.end();
});
}
async function dbInsert(row){
if(!DB_ON)return;
try{
await httpsReq("POST","/rest/v1/plays",row);
DB_OK_ONCE=true;
DB_LAST_ERR="";
}catch(e){DB_LAST_ERR=e.message;console.log("DB insert error:",e.message)}
}
async function dbFetch(){
if(!DB_ON)return null;
try{
const data=await httpsReq("GET","/rest/v1/plays?select=*&order=t.desc&limit=2000",null);
DB_OK_ONCE=true;
try{
const parsed=JSON.parse(data);
DB_LAST_ERR="";
return parsed;
}catch(pe){
DB_LAST_ERR="Response was not JSON. Got: "+String(data).slice(0,120)+" — this usually means the URL is wrong (not pointing to Supabase) or the table 'plays' does not exist.";
return null;
}
}catch(e){DB_LAST_ERR=e.message;console.log("DB fetch error:",e.message);return null}
}
function hist(action,name,room){
const h={t:new Date().toISOString(),action,name,room:room||""};
HISTORY.push(h);
if(HISTORY.length>1000)HISTORY.shift();
console.log(h.t,action.toUpperCase(),name,h.room?("room "+h.room):"");
dbInsert(h);
}
const srv=http.createServer(async(req,res)=>{
const u=new URL(req.url,"http://x");
if(u.pathname==="/names"||u.pathname==="/stats"){
if(u.searchParams.get("key")!==ADMIN_KEY){
res.writeHead(403,{"Content-Type":"text/plain; charset=utf-8"});
res.end("Forbidden");
return;
}
let rows=await dbFetch();
const persisted=rows!==null;
if(!persisted)rows=HISTORY.slice();
rows.sort((a,b)=>String(b.t).localeCompare(String(a.t)));
const uniq=new Map();
let creates=0,joins=0;
for(const h of rows){
const key=String(h.name||"").toLowerCase();
if(!uniq.has(key))uniq.set(key,{name:h.name,first:h.t,last:h.t,plays:0});
const u2=uniq.get(key);
if(String(h.t)<u2.first)u2.first=h.t;
if(String(h.t)>u2.last)u2.last=h.t;
if(h.action==="hello"||h.action==="create"||h.action==="join")u2.plays++;
if(h.action==="create")creates++;
if(h.action==="join")joins++;
}
const players=[...uniq.values()].sort((a,b)=>String(b.last).localeCompare(String(a.last)));
if(u.pathname==="/stats"){
res.writeHead(200,{"Content-Type":"text/html; charset=utf-8"});
let html='<!doctype html><meta charset=utf-8><meta name=viewport content="width=device-width,initial-scale=1"><title>Water Escape · Players</title>';
html+='<style>body{background:#0a0716;color:#eafaff;font-family:monospace;padding:20px;max-width:900px;margin:0 auto}h1{color:#5fe6ff}.s{display:flex;gap:14px;flex-wrap:wrap;margin:16px 0}.c{background:#161b24;border:2px solid #2a5a86;border-radius:8px;padding:12px 18px}.c b{color:#ffd23f;font-size:22px;display:block}table{width:100%;border-collapse:collapse;margin-top:16px}th,td{text-align:left;padding:8px;border-bottom:1px solid #223}th{color:#8fe0f5}tr:hover{background:#111a2b}.tag{color:#37e08a}.warn{color:#ff8c6a;font-size:13px}</style>';
html+='<h1>🎮 Water Escape — Players</h1>';
html+='<div style="background:#0d1420;border:1px solid #223;border-radius:8px;padding:12px;margin:12px 0;font-size:13px">';
html+='<b style="color:#8fe0f5">Diagnostic:</b><br>';
html+='Node version: '+esc(process.version)+'<br>';
html+='SUPABASE_URL configured: '+(SUPABASE_URL?'<span class=tag>yes</span>':'<span class=warn>NO — missing</span>')+'<br>';
html+='URL host: <span class=tag>'+esc((()=>{try{return new URL(SUPABASE_URL).hostname}catch(e){return"(invalid URL)"}})())+'</span><br>';
html+='URL looks like Supabase: '+((/supabase\.(co|in|com)$/i.test((()=>{try{return new URL(SUPABASE_URL).hostname}catch(e){return""}})()))?'<span class=tag>yes ✓</span>':'<span class=warn>NO — should end in .supabase.co</span>')+'<br>';
html+='SUPABASE_KEY configured: '+(SUPABASE_KEY?('<span class=tag>yes (length '+SUPABASE_KEY.length+')</span>'):'<span class=warn>NO — missing</span>')+'<br>';
html+='Database mode: '+(DB_ON?'<span class=tag>ON</span>':'<span class=warn>OFF</span>')+'<br>';
html+='Connection test: '+(DB_OK_ONCE?'<span class=tag>✓ connected successfully</span>':(DB_ON?'<span class=warn>✗ failed</span>':'not attempted (no keys)'))+'<br>';
if(DB_LAST_ERR)html+='Last error: <span class=warn>'+esc(DB_LAST_ERR)+'</span><br>';
html+='</div>';
if(!persisted)html+='<p class="warn">⚠ Showing in-memory data only (resets when the server restarts). See diagnostic above.</p>';
else html+='<p class="tag">✓ Persistent history (survives restarts)</p>';
html+='<div class="s"><div class="c"><b>'+uniq.size+'</b>unique players</div><div class="c"><b>'+rows.length+'</b>total events</div><div class="c"><b>'+creates+'</b>rooms created</div><div class="c"><b>'+joins+'</b>joins</div></div>';
html+='<table><tr><th>Nickname</th><th>Times played</th><th>First seen</th><th>Last seen</th></tr>';
for(const p of players){
const f=new Date(p.first).toLocaleString();
const l=new Date(p.last).toLocaleString();
html+='<tr><td>'+esc(p.name)+'</td><td>'+p.plays+'</td><td>'+f+'</td><td>'+l+'</td></tr>';
}
html+='</table>';
res.end(html);
return;
}
res.writeHead(200,{"Content-Type":"text/plain; charset=utf-8"});
res.end(rows.length?rows.map(h=>h.t+"  "+String(h.action).toUpperCase().padEnd(7)+"  "+h.name+(h.room?"  ["+h.room+"]":"")).join("\n"):"(no players logged yet)");
return;
}
res.writeHead(200,{"Content-Type":"text/plain; charset=utf-8"});
res.end("Water Escape server OK");
});
function esc(s){return String(s).replace(/[&<>"]/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[c]))}
const io=new Server(srv,{cors:{origin:"*"}});
const rooms={};
const names=new Set();
const sessions={};
const ABC="ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
function makeCode(){
let c="";
do{
c="";
for(let i=0;i<4;i++)c+=ABC[Math.floor(Math.random()*ABC.length)];
}while(rooms[c]);
return c;
}
function pmap(r){
return r.players.map(p=>({idx:p.idx,name:p.name,cos:p.cos||null,char:p.char||"miner"}));
}
function lobby(r){
return{code:r.code,players:pmap(r),started:r.started,mode:r.mode||"ffa",map:r.map||"waterescape"};
}
function finalize(room,pl){
if(!rooms[room.code])return;
if(pl.tm){clearTimeout(pl.tm);pl.tm=null}
if(!room.players.includes(pl))return;
const wasHost=pl.idx===0;
room.players=room.players.filter(p=>p!==pl);
if(sessions[pl.sid]&&sessions[pl.sid].code===room.code)delete sessions[pl.sid];
if(!room.players.length){
if(room.graceUntil&&Date.now()<room.graceUntil){
return;
}
delete rooms[room.code];
return;
}
if(wasHost){
const next=room.players[0];
next.idx=0;
room.hostId=next.id;
sessions[next.sid]={code:room.code,idx:0};
io.to(room.code).emit("lobby",lobby(room));
io.to(room.code).emit("left",{name:pl.name});
return;
}
io.to(room.code).emit("lobby",lobby(room));
io.to(room.code).emit("left",{name:pl.name});
io.to(room.hostId).emit("peerLeft",{idx:pl.idx});
if(room.started){
const a=room.players.filter(p=>p.again).length;
io.to(room.code).emit("againCount",a,room.players.length);
if(room.players.length&&room.players.every(p=>p.again)){
room.players.forEach(p=>p.again=false);
io.to(room.code).emit("restart",{players:pmap(room),mode:room.mode||"ffa"});
}
}
}
io.on("connection",sock=>{
let room=null;
let player=null;
let me=null;
sock.on("hello",(raw,cb)=>{
if(typeof cb!=="function")return;
let n,sid,cos=null,ch="";
if(raw&&typeof raw==="object"){
n=raw.name;
sid=String(raw.sid||"").replace(/[^\w-]/g,"").slice(0,24);
ch=String(raw.char||"").replace(/[^\w-]/g,"").slice(0,24);
if(raw.cos&&typeof raw.cos==="object")cos={s:raw.cos.s?1:0,w:raw.cos.w?1:0,g:raw.cos.g?1:0};
}else{
n=raw;
sid="";
}
n=String(n||"").replace(/[^\wÁÉÍÓÚÑÜáéíóúñü\- ]/g,"").trim().slice(0,12);
if(!n)n="Frog_"+Math.floor(Math.random()*90+10);
if(names.has(n.toLowerCase())&&!(sid&&sessions[sid]))return cb({ok:false,err:"That nickname is already taken"});
names.add(n.toLowerCase());
me={name:n,sid:sid||("a"+sock.id.replace(/[^\w-]/g,"").slice(0,20)),cos,char:ch||"miner"};
hist("hello",n);
cb({ok:true,name:n});
});
sock.on("create",cb=>{
if(typeof cb!=="function")return;
if(!me)return cb({ok:false,err:"Pick a nickname first"});
if(room)return cb({ok:false,err:"You are already in a room"});
const c=makeCode();
player={id:sock.id,idx:0,name:me.name,sid:me.sid,cos:me.cos,char:me.char,again:false,ghost:false,tm:null};
room=rooms[c]={code:c,hostId:sock.id,players:[player],started:false,mode:"ffa",map:"waterescape"};
sessions[me.sid]={code:c,idx:0};
sock.join(c);
hist("create",me.name,c);
cb({ok:true,code:c,idx:0});
io.to(c).emit("lobby",lobby(room));
});
sock.on("join",(c,cb)=>{
if(typeof cb!=="function")return;
if(!me)return cb({ok:false,err:"Pick a nickname first"});
if(room)return cb({ok:false,err:"You are already in a room"});
c=String(c||"").toUpperCase().replace(/[^A-Z0-9]/g,"").slice(0,4);
const r=rooms[c];
if(!r)return cb({ok:false,err:"That room does not exist"});
if(r.started)return cb({ok:false,err:"The match already started"});
if(r.players.length>=8)return cb({ok:false,err:"Room is full (max 8)"});
const used=r.players.map(p=>p.idx);
let idx=0;
while(used.includes(idx))idx++;
player={id:sock.id,idx,name:me.name,sid:me.sid,cos:me.cos,char:me.char,again:false,ghost:false,tm:null};
room=r;
r.players.push(player);
sessions[me.sid]={code:c,idx};
sock.join(c);
hist("join",me.name,c);
cb({ok:true,code:c,idx});
io.to(c).emit("lobby",lobby(r));
});
sock.on("rejoin",cb=>{
if(typeof cb!=="function")return;
if(!me)return cb({ok:false});
const ses=sessions[me.sid];
if(!ses)return cb({ok:false});
const r=rooms[ses.code];
if(!r)return cb({ok:false});
const pl=r.players.find(p=>p.sid===me.sid&&p.idx===ses.idx);
if(!pl)return cb({ok:false});
if(pl.tm){clearTimeout(pl.tm);pl.tm=null}
pl.ghost=false;
pl.id=sock.id;
if(me.char)pl.char=me.char;
if(pl.idx===0)r.hostId=sock.id;
room=r;
player=pl;
sock.join(r.code);
hist("rejoin",me.name,r.code);
cb({ok:true,code:r.code,idx:pl.idx,host:pl.idx===0,started:r.started});
io.to(r.code).emit("lobby",lobby(r));
});
sock.on("mode",m=>{
if(!room||room.hostId!==sock.id||room.started)return;
if(m!=="ffa"&&m!=="surv")return;
room.mode=m;
io.to(room.code).emit("lobby",lobby(room));
});
sock.on("map",m=>{
if(!room||room.hostId!==sock.id||room.started)return;
m=String(m||"").replace(/[^\w-]/g,"").slice(0,24);
if(!m)return;
room.map=m;
io.to(room.code).emit("lobby",lobby(room));
});
sock.on("start",()=>{
if(!room||room.hostId!==sock.id||room.players.length<2)return;
room.started=true;
room.players.forEach(p=>p.again=false);
io.to(room.code).emit("start",{players:pmap(room),mode:room.mode||"ffa"});
});
sock.on("input",d=>{
if(!room||!player||!room.started)return;
if(!Array.isArray(d)||d.length!==2)return;
const dx=Math.max(-1,Math.min(1,d[0]|0));
const dy=Math.max(-1,Math.min(1,d[1]|0));
if(Math.abs(dx)+Math.abs(dy)!==1)return;
io.to(room.hostId).emit("input",{idx:player.idx,d:[dx,dy]});
});
sock.on("tp",d=>{
if(!room||!player||!room.started)return;
if(!Array.isArray(d)||d.length!==2)return;
const tc=d[0]|0,tr=d[1]|0;
io.to(room.hostId).emit("tp",{idx:player.idx,d:[tc,tr]});
});
sock.on("aim",d=>{
if(!room||!player||!room.started)return;
const dir=(d|0)<0?-1:1;
io.to(room.hostId).emit("aim",{idx:player.idx,d:dir});
});
sock.on("throw",d=>{
if(!room||!player||!room.started)return;
let payload;
if(Array.isArray(d)&&d.length===2)payload=[d[0]|0,d[1]|0];
else payload=d|0;
io.to(room.hostId).emit("throw",{idx:player.idx,d:payload});
});
sock.on("state",s=>{
if(!room||room.hostId!==sock.id)return;
sock.to(room.code).emit("state",s);
});
sock.on("again",()=>{
if(!room||!player||!room.started)return;
if(player.again)return;
player.again=true;
const a=room.players.filter(p2=>p2.again).length;
io.to(room.code).emit("againCount",a,room.players.length);
if(room.players.every(p2=>p2.again)){
room.players.forEach(p2=>p2.again=false);
io.to(room.code).emit("restart",{players:pmap(room),mode:room.mode||"ffa"});
}
});
sock.on("leave",()=>{
if(!room||!player)return;
const r=room,pl=player;
room=null;
player=null;
finalize(r,pl);
});
sock.on("disconnect",()=>{
if(me)names.delete(me.name.toLowerCase());
if(!room||!player)return;
const r=room,pl=player;
room=null;
player=null;
pl.ghost=true;
r.graceUntil=Date.now()+60000;
pl.tm=setTimeout(()=>{
if(pl.ghost)finalize(r,pl);
},60000);
});
});
const PORT=process.env.PORT||3000;
srv.listen(PORT,()=>console.log("Water Escape server listening on "+PORT));
