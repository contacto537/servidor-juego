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
var BAD_ROOTS=["fuck","fuk","fck","fvck","phuck","shit","sh1t","bitch","bich","cunt","dick","cock","pussy","pusy","porn","pron","p0rn","sex","nigga","nigger","niga","fag","faggot","whore","slut","rape","tits","boob","penis","vagina","nazi","hitler","kkk","cum","dildo","horny","hentai","xxx","puta","puto","mierda","verga","vrga","pendejo","pendeja","culo","culero","chinga","chingar","chingada","cabron","cabrona","joder","conyo","conyi","conya","pinche","mamada","maricon","marica","zorra","perra","pito","pija","polla","teta","tetas","pene","follar","putazo","mamon","mamona","carajo","chupa","chupame","panoch","nalga","nalgas","hijodeputa","hdp","ptm","mrd","wtf","fokin","fucking","motherfucker","asshole","bastard","retard","onlyfans","sexo","desnuda","desnudo","violar","violador","pornografia"];
var BAD_SAFE_SUBS=["analy","analysis","canal","banal","cumbia","cumple","cumbre","documento","circum","scum","assis","assum","assoc","classic","pass","glass","grass","bass","mass","cassie","essex","sussex","peninsula","pitos","pitón","piton","pitoresc","dickens","cockatoo","cockpit","hancock","peacock","kkkk","conoc","culomb","articulo","curriculo","vinculo","circulo","calculo","mayuscula","minuscula","nalgada","sexto","sexta","sextet","capitol","cockroach"];
function badNormalize(s){
var t=String(s||"").toLowerCase();
t=t.replace(/ñ/g,"ny").replace(/[áàäâã]/g,"a").replace(/[éèëê]/g,"e").replace(/[íìïî]/g,"i").replace(/[óòöôõ]/g,"o").replace(/[úùüû]/g,"u");
t=t.replace(/0/g,"o").replace(/1/g,"i").replace(/3/g,"e").replace(/4/g,"a").replace(/5/g,"s").replace(/7/g,"t").replace(/8/g,"b").replace(/9/g,"g").replace(/@/g,"a").replace(/\$/g,"s").replace(/!/g,"i").replace(/\|/g,"l").replace(/\+/g,"t").replace(/€/g,"e").replace(/¢/g,"c").replace(/ß/g,"ss");
t=t.replace(/[^a-z]/g,"");
return t;
}
function badCollapse(t){return t.replace(/(.)\1+/g,"$1");}
function isBadName(s){
var forms=[badNormalize(s)];
forms.push(badCollapse(forms[0]));
forms.push(forms[0].replace(/v/g,"u"));
forms.push(forms[0].replace(/ck/g,"k").replace(/q/g,"k").replace(/x/g,"ks").replace(/ph/g,"f"));
for(var f=0;f<forms.length;f++){
var t=forms[f];
if(!t)continue;
for(var i=0;i<BAD_ROOTS.length;i++){
var w=BAD_ROOTS[i];
var pos=t.indexOf(w);
while(pos>=0){
var safe=false;
for(var k=0;k<BAD_SAFE_SUBS.length&&!safe;k++){var sws=[BAD_SAFE_SUBS[k],badCollapse(BAD_SAFE_SUBS[k])];for(var m=0;m<2;m++){var sw=sws[m];var sp=t.indexOf(sw);while(sp>=0){if(pos>=sp&&pos+w.length<=sp+sw.length){safe=true;break;}sp=t.indexOf(sw,sp+1);}if(safe)break;}}
if(!safe)return true;
pos=t.indexOf(w,pos+1);
}
}
}
return false;
}
const LB_MODES=["normal","rush","memory"];
const LB_MAX={normal:5000,rush:5000,memory:2000};
const LB_MEM={normal:new Map(),rush:new Map(),memory:new Map()};
const LB_CACHE={};
const LB_RATE=new Map();
function httpsReqFull(method,path,bodyObj,extraHeaders){
return new Promise((resolve,reject)=>{
let host,base,port;
try{const u=new URL(SUPABASE_URL);host=u.hostname;port=u.port||443;base=u.pathname.replace(/\/$/,"")}catch(e){return reject(new Error("Bad SUPABASE_URL"))}
const body=bodyObj?JSON.stringify(bodyObj):null;
const headers=Object.assign({"apikey":SUPABASE_KEY,"Authorization":"Bearer "+SUPABASE_KEY,"Content-Type":"application/json"},extraHeaders||{});
if(body)headers["Content-Length"]=Buffer.byteLength(body);
const req=https.request({hostname:host,port:port,path:base+path,method,headers},res=>{
let data="";
res.on("data",c=>data+=c);
res.on("end",()=>{
if(res.statusCode>=200&&res.statusCode<300)resolve({body:data,headers:res.headers});
else reject(new Error("HTTP "+res.statusCode+": "+data.slice(0,200)));
});
});
req.on("error",e=>reject(e));
if(body)req.write(body);
req.end();
});
}
function lbClean(name){
let n=String(name||"").replace(/[^\wÁÉÍÓÚÑÜáéíóúñü\- ]/g,"").trim().slice(0,12);
if(!n||isBadName(n))return null;
return n;
}
async function lbSubmit(dev,name,mode,score){
score=Math.max(0,Math.min(LB_MAX[mode],score|0));
const t=new Date().toISOString();
if(DB_ON){
try{
const cur=await httpsReqFull("GET","/rest/v1/scores?select=score&dev=eq."+encodeURIComponent(dev)+"&mode=eq."+mode+"&limit=1",null);
const rows=JSON.parse(cur.body||"[]");
const prev=rows.length?(rows[0].score|0):-1;
if(score>prev){
await httpsReqFull("POST","/rest/v1/scores?on_conflict=dev,mode",{dev,name,mode,score,t},{"Prefer":"resolution=merge-duplicates,return=minimal"});
}else if(rows.length){
await httpsReqFull("PATCH","/rest/v1/scores?dev=eq."+encodeURIComponent(dev)+"&mode=eq."+mode,{name},{"Prefer":"return=minimal"});
}
const best=Math.max(prev,score);
const cnt=await httpsReqFull("GET","/rest/v1/scores?select=dev&mode=eq."+mode+"&score=gt."+best+"&limit=1",null,{"Prefer":"count=exact","Range":"0-0"});
let above=0;
const cr=String(cnt.headers["content-range"]||"");
const m=cr.match(/\/(\d+)/);
if(m)above=parseInt(m[1],10)||0;
delete LB_CACHE[mode];
DB_OK_ONCE=true;
return {ok:true,rank:above+1,best};
}catch(e){DB_LAST_ERR=e.message;console.log("LB db error:",e.message);}
}
const M=LB_MEM[mode];
const prev=M.get(dev);
if(!prev||score>prev.score)M.set(dev,{name,score,t});
else M.set(dev,{name,score:prev.score,t:prev.t});
const best=M.get(dev).score;
let above=0;
for(const v of M.values())if(v.score>best)above++;
delete LB_CACHE[mode];
return {ok:true,rank:above+1,best};
}
async function lbTop(mode){
const c=LB_CACHE[mode];
if(c&&Date.now()-c.at<15000)return c.list;
let list=null;
if(DB_ON){
try{
const r=await httpsReqFull("GET","/rest/v1/scores?select=name,score,dev&mode=eq."+mode+"&order=score.desc,t.asc&limit=10",null);
list=JSON.parse(r.body||"[]").map(x=>({name:x.name,score:x.score|0,dev:x.dev}));
DB_OK_ONCE=true;
}catch(e){DB_LAST_ERR=e.message;console.log("LB top error:",e.message);list=null;}
}
if(!list){
list=[...LB_MEM[mode].entries()].map(([dev,v])=>({name:v.name,score:v.score,dev,t:v.t})).sort((a,b)=>b.score-a.score||String(a.t).localeCompare(String(b.t))).slice(0,10);
}
LB_CACHE[mode]={at:Date.now(),list};
return list;
}
function readBody(req){
return new Promise((resolve)=>{
let d="";
req.on("data",c=>{d+=c;if(d.length>4096)req.destroy();});
req.on("end",()=>{try{resolve(JSON.parse(d||"{}"))}catch(e){resolve(null)}});
req.on("error",()=>resolve(null));
});
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
try{
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
if(u.pathname==="/top"||u.pathname==="/score"){
const cors={"Content-Type":"application/json; charset=utf-8","Access-Control-Allow-Origin":"*","Access-Control-Allow-Methods":"GET,POST,OPTIONS","Access-Control-Allow-Headers":"Content-Type","Cache-Control":"no-store"};
if(req.method==="OPTIONS"){res.writeHead(204,cors);res.end();return;}
if(u.pathname==="/top"){
const mode=String(u.searchParams.get("mode")||"normal");
if(!LB_MODES.includes(mode)){res.writeHead(400,cors);res.end(JSON.stringify({ok:false}));return;}
const list=await lbTop(mode);
res.writeHead(200,cors);
res.end(JSON.stringify({ok:true,mode,list:list.map(x=>({name:x.name,score:x.score,dev:x.dev}))}));
return;
}
if(req.method!=="POST"){res.writeHead(405,cors);res.end(JSON.stringify({ok:false}));return;}
const ip=String(req.headers["x-forwarded-for"]||req.socket.remoteAddress||"").split(",")[0].trim();
const now=Date.now();
const rl=LB_RATE.get(ip)||{n:0,at:now};
if(now-rl.at>60000){rl.n=0;rl.at=now;}
rl.n++;LB_RATE.set(ip,rl);
if(rl.n>30){res.writeHead(429,cors);res.end(JSON.stringify({ok:false,err:"slow down"}));return;}
const b=await readBody(req);
if(!b){res.writeHead(400,cors);res.end(JSON.stringify({ok:false}));return;}
const dev=String(b.dev||"").replace(/[^\w-]/g,"").slice(0,24);
const mode=String(b.mode||"");
const score=Number(b.score);
if(!dev||dev.length<6||!LB_MODES.includes(mode)||!isFinite(score)){res.writeHead(400,cors);res.end(JSON.stringify({ok:false,err:"bad request"}));return;}
const name=lbClean(b.name);
if(!name){res.writeHead(200,cors);res.end(JSON.stringify({ok:false,err:"name not allowed"}));return;}
const out=await lbSubmit(dev,name,mode,Math.floor(score));
res.writeHead(200,cors);
res.end(JSON.stringify(out));
return;
}
if(u.pathname==="/time"){
res.writeHead(200,{"Content-Type":"application/json; charset=utf-8","Access-Control-Allow-Origin":"*","Cache-Control":"no-store"});
res.end(JSON.stringify({t:Date.now()}));
return;
}
res.writeHead(200,{"Content-Type":"text/plain; charset=utf-8"});
res.end("Water Escape server OK");
}catch(eH){try{res.writeHead(500,{"Content-Type":"application/json"});res.end(JSON.stringify({ok:false}))}catch(e2){}}
});
function esc(s){return String(s).replace(/[&<>"]/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[c]))}
const io=new Server(srv,{cors:{origin:"*"}});
const rooms={};
const names=new Set();
const sessions={};
const ABC="ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const MODES=["ffa","surv","teams"];
function makeCode(){
let c="";
do{
c="";
for(let i=0;i<4;i++)c+=ABC[Math.floor(Math.random()*ABC.length)];
}while(rooms[c]);
return c;
}
function pmap(r){
return r.players.map(p=>({idx:p.idx,name:p.name,cos:p.cos||null,char:p.char||"miner",team:(p.team==null?null:p.team)}));
}
function lobby(r){
return{code:r.code,players:pmap(r),started:r.started,mode:r.mode||"ffa",map:r.map||"waterescape",teams:r.mode==="teams"};
}
function startPayload(r){
return{players:pmap(r),mode:r.mode||"ffa",teams:r.mode==="teams",map:r.map||"waterescape"};
}
function relay(room,player,ev,payload){
io.to(room.hostId).emit(ev,payload);
}
function unitDir(d){
if(!Array.isArray(d)||d.length!==2)return null;
const dx=Math.max(-1,Math.min(1,d[0]|0));
const dy=Math.max(-1,Math.min(1,d[1]|0));
if(Math.abs(dx)+Math.abs(dy)!==1)return null;
return[dx,dy];
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
io.to(room.code).emit("restart",startPayload(room));
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
if(raw.cos&&typeof raw.cos==="object")cos={s:raw.cos.s?1:0,w:raw.cos.w?1:0,g:raw.cos.g?1:0,fx:String(raw.cos.fx||"").replace(/[^\w|]/g,"").slice(0,120)};
}else{
n=raw;
sid="";
}
n=String(n||"").replace(/[^\wÁÉÍÓÚÑÜáéíóúñü\- ]/g,"").trim().slice(0,12);
if(n&&isBadName(n))return cb({ok:false,err:"That nickname is not allowed"});
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
player={id:sock.id,idx:0,name:me.name,sid:me.sid,cos:me.cos,char:me.char,team:null,again:false,ghost:false,tm:null};
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
player={id:sock.id,idx,name:me.name,sid:me.sid,cos:me.cos,char:me.char,team:null,again:false,ghost:false,tm:null};
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
cb({ok:true,code:r.code,idx:pl.idx,host:pl.idx===0,started:r.started,mode:r.mode||"ffa",team:(pl.team==null?null:pl.team)});
io.to(r.code).emit("lobby",lobby(r));
});
sock.on("mode",m=>{
if(!room||room.hostId!==sock.id||room.started)return;
if(!MODES.includes(m))return;
room.mode=m;
if(m!=="teams")room.players.forEach(p=>p.team=null);
else room.players.forEach(p=>{if(p.team==null)p.team=p.idx%4});
io.to(room.code).emit("lobby",lobby(room));
});
sock.on("map",m=>{
if(!room||room.hostId!==sock.id||room.started)return;
m=String(m||"").replace(/[^\w-]/g,"").slice(0,24);
if(!m)return;
room.map=m;
io.to(room.code).emit("lobby",lobby(room));
});
sock.on("team",t=>{
if(!room||!player)return;
t=t|0;
if(t<0||t>3)return;
if(room.started&&room.hostId!==sock.id)return;
if(room.mode!=="teams"&&room.hostId!==sock.id)return;
player.team=t;
io.to(room.code).emit("lobby",lobby(room));
io.to(room.hostId).emit("peerTeam",{idx:player.idx,team:t});
});
sock.on("setTeam",d=>{
if(!room||room.hostId!==sock.id)return;
if(!d||typeof d!=="object")return;
const idx=d.idx|0,t=d.team|0;
if(t<0||t>3)return;
const pl=room.players.find(p=>p.idx===idx);
if(!pl)return;
pl.team=t;
io.to(room.code).emit("lobby",lobby(room));
});
sock.on("char",ch=>{
if(!room||!player||room.started)return;
ch=String(ch||"").replace(/[^\w-]/g,"").slice(0,24);
if(!ch)return;
player.char=ch;
if(me)me.char=ch;
io.to(room.code).emit("lobby",lobby(room));
});
sock.on("start",()=>{
if(!room||room.hostId!==sock.id||room.players.length<2)return;
if(room.mode==="teams"){
room.players.forEach(p=>{if(p.team==null)p.team=p.idx%4});
const ts=[...new Set(room.players.map(p=>p.team))];
if(ts.length<2)return;
}
room.started=true;
room.players.forEach(p=>p.again=false);
io.to(room.code).emit("start",startPayload(room));
});
sock.on("backToLobby",()=>{
if(!room||room.hostId!==sock.id)return;
room.started=false;
room.players.forEach(p=>p.again=false);
io.to(room.code).emit("hostToLobby");
io.to(room.code).emit("lobby",lobby(room));
});
sock.on("input",d=>{
if(!room||!player||!room.started)return;
const u=unitDir(d);
if(!u)return;
relay(room,player,"input",{idx:player.idx,d:u});
});
sock.on("tp",d=>{
if(!room||!player||!room.started)return;
if(!Array.isArray(d)||d.length!==2)return;
const tc=d[0]|0,tr=d[1]|0;
relay(room,player,"tp",{idx:player.idx,d:[tc,tr]});
});
sock.on("aim",d=>{
if(!room||!player||!room.started)return;
const dir=(d|0)<0?-1:1;
relay(room,player,"aim",{idx:player.idx,d:dir});
});
sock.on("throw",d=>{
if(!room||!player||!room.started)return;
let payload;
if(Array.isArray(d)&&d.length===2)payload=[d[0]|0,d[1]|0];
else payload=d|0;
relay(room,player,"throw",{idx:player.idx,d:payload});
});
sock.on("chain",d=>{
if(!room||!player||!room.started)return;
const u=unitDir(d);
if(!u)return;
relay(room,player,"chain",{idx:player.idx,d:u});
});
sock.on("chainArm",v=>{
if(!room||!player||!room.started)return;
relay(room,player,"chainArm",{idx:player.idx,d:v?1:0});
});
sock.on("escape",d=>{
if(!room||!player||!room.started)return;
const u=unitDir(d);
if(!u)return;
relay(room,player,"escape",{idx:player.idx,d:u});
});
sock.on("rush",()=>{
if(!room||!player||!room.started)return;
relay(room,player,"rush",{idx:player.idx});
});
sock.on("emote",k=>{
if(!room||!player||!room.started)return;
relay(room,player,"emote",{idx:player.idx,k:Math.max(0,Math.min(3,k|0))});
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
io.to(room.code).emit("restart",startPayload(room));
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
if(!r.started){
finalize(r,pl);
return;
}
pl.ghost=true;
r.graceUntil=Date.now()+60000;
pl.tm=setTimeout(()=>{
if(pl.ghost)finalize(r,pl);
},60000);
});
});
const PORT=process.env.PORT||3000;
srv.listen(PORT,()=>console.log("Water Escape server listening on "+PORT));
