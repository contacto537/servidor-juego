const http=require("http");
const {Server}=require("socket.io");
const ADMIN_KEY="vikingo537";
const HISTORY=[];
function hist(action,name,room){
const h={t:new Date().toISOString(),action,name,room:room||""}; 
HISTORY.push(h);
if(HISTORY.length>1000)HISTORY.shift();
console.log(h.t,action.toUpperCase(),name,h.room?("room "+h.room):"");
}
const srv=http.createServer((req,res)=>{
const u=new URL(req.url,"http://x");
if(u.pathname==="/names"){
if(u.searchParams.get("key")!==ADMIN_KEY){
res.writeHead(403,{"Content-Type":"text/plain; charset=utf-8"});
res.end("Forbidden");
return;
}
res.writeHead(200,{"Content-Type":"text/plain; charset=utf-8"});
res.end(HISTORY.length?HISTORY.map(h=>h.t+"  "+h.action.toUpperCase().padEnd(7)+"  "+h.name+(h.room?"  ["+h.room+"]":"")).join("\n"):"(no players yet since the last server restart)");
return;
}
res.writeHead(200,{"Content-Type":"text/plain; charset=utf-8"});
res.end("Water Escape server OK");
});
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
return r.players.map(p=>({idx:p.idx,name:p.name,cos:p.cos||null}));
}
function lobby(r){
return{code:r.code,players:pmap(r),started:r.started,mode:r.mode||"ffa"};
}
function finalize(room,pl){
if(!rooms[room.code])return;
if(pl.tm){clearTimeout(pl.tm);pl.tm=null}
if(!room.players.includes(pl))return;
const wasHost=pl.idx===0;
room.players=room.players.filter(p=>p!==pl);
if(sessions[pl.sid]&&sessions[pl.sid].code===room.code)delete sessions[pl.sid];
if(!room.players.length){
delete rooms[room.code];
return;
}
if(wasHost){
io.to(room.code).emit("hostLeft");
for(const p of room.players){
if(sessions[p.sid]&&sessions[p.sid].code===room.code)delete sessions[p.sid];
if(p.tm){clearTimeout(p.tm);p.tm=null}
}
delete rooms[room.code];
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
let n,sid,cos=null;
if(raw&&typeof raw==="object"){
n=raw.name;
sid=String(raw.sid||"").replace(/[^\w-]/g,"").slice(0,24);
if(raw.cos&&typeof raw.cos==="object")cos={s:raw.cos.s?1:0,w:raw.cos.w?1:0,g:raw.cos.g?1:0};
}else{
n=raw;
sid="";
}
n=String(n||"").replace(/[^\wÁÉÍÓÚÑÜáéíóúñü\- ]/g,"").trim().slice(0,12);
if(!n)n="Frog_"+Math.floor(Math.random()*90+10);
if(names.has(n.toLowerCase())&&!(sid&&sessions[sid]))return cb({ok:false,err:"That nickname is already taken"});
names.add(n.toLowerCase());
me={name:n,sid:sid||("a"+sock.id.replace(/[^\w-]/g,"").slice(0,20)),cos};
hist("hello",n);
cb({ok:true,name:n});
});
sock.on("create",cb=>{
if(typeof cb!=="function")return;
if(!me)return cb({ok:false,err:"Pick a nickname first"});
if(room)return cb({ok:false,err:"You are already in a room"});
const c=makeCode();
player={id:sock.id,idx:0,name:me.name,sid:me.sid,cos:me.cos,again:false,ghost:false,tm:null};
room=rooms[c]={code:c,hostId:sock.id,players:[player],started:false,mode:"ffa"};
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
player={id:sock.id,idx,name:me.name,sid:me.sid,cos:me.cos,again:false,ghost:false,tm:null};
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
pl.tm=setTimeout(()=>{
if(pl.ghost)finalize(r,pl);
},r.started?15000:120000);
});
});
const PORT=process.env.PORT||3000;
srv.listen(PORT,()=>console.log("Water Escape server listening on "+PORT));
