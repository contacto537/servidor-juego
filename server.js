const http=require("http");
const {Server}=require("socket.io");
const srv=http.createServer((req,res)=>{
res.writeHead(200,{"Content-Type":"text/plain; charset=utf-8"});
res.end("Water Escape server OK");
});
const io=new Server(srv,{cors:{origin:"*"}});
const rooms={};
const names=new Set();
const ABC="ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
function makeCode(){
let c="";
do{
c="";
for(let i=0;i<4;i++)c+=ABC[Math.floor(Math.random()*ABC.length)];
}while(rooms[c]);
return c;
}
function lobby(r){
return{code:r.code,players:r.players.map(p=>({idx:p.idx,name:p.name})),started:r.started};
}
function idxOf(r,id){
const p=r.players.find(p2=>p2.id===id);
return p?p.idx:-1;
}
io.on("connection",sock=>{
let room=null;
let me=null;
sock.on("hello",(n,cb)=>{
if(typeof cb!=="function")return;
n=String(n||"").replace(/[^\wÁÉÍÓÚÑÜáéíóúñü\- ]/g,"").trim().slice(0,12);
if(!n)n="Frog_"+Math.floor(Math.random()*90+10);
if(names.has(n.toLowerCase()))return cb({ok:false,err:"That nickname is already taken"});
names.add(n.toLowerCase());
me={name:n};
cb({ok:true,name:n});
});
sock.on("create",cb=>{
if(typeof cb!=="function")return;
if(!me)return cb({ok:false,err:"Pick a nickname first"});
if(room)return cb({ok:false,err:"You are already in a room"});
const c=makeCode();
room=rooms[c]={code:c,hostId:sock.id,players:[{id:sock.id,idx:0,name:me.name,again:false}],started:false};
sock.join(c);
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
if(r.players.length>=4)return cb({ok:false,err:"Room is full (max 4)"});
const used=r.players.map(p=>p.idx);
let idx=0;
while(used.includes(idx))idx++;
room=r;
r.players.push({id:sock.id,idx,name:me.name,again:false});
sock.join(c);
cb({ok:true,code:c,idx});
io.to(c).emit("lobby",lobby(r));
});
sock.on("start",()=>{
if(!room||room.hostId!==sock.id||room.players.length<2)return;
room.started=true;
room.players.forEach(p=>p.again=false);
io.to(room.code).emit("start",{players:room.players.map(p=>({idx:p.idx,name:p.name}))});
});
sock.on("input",d=>{
if(!room||!room.started)return;
if(!Array.isArray(d)||d.length!==2)return;
const dx=Math.max(-1,Math.min(1,d[0]|0));
const dy=Math.max(-1,Math.min(1,d[1]|0));
if(Math.abs(dx)+Math.abs(dy)!==1)return;
io.to(room.hostId).emit("input",{idx:idxOf(room,sock.id),d:[dx,dy]});
});
sock.on("state",s=>{
if(!room||room.hostId!==sock.id)return;
sock.to(room.code).emit("state",s);
});
sock.on("again",()=>{
if(!room||!room.started)return;
const p=room.players.find(p2=>p2.id===sock.id);
if(!p||p.again)return;
p.again=true;
const a=room.players.filter(p2=>p2.again).length;
io.to(room.code).emit("againCount",a,room.players.length);
if(room.players.every(p2=>p2.again)){
room.players.forEach(p2=>p2.again=false);
io.to(room.code).emit("restart",{players:room.players.map(p2=>({idx:p2.idx,name:p2.name}))});
}
});
sock.on("disconnect",()=>{
if(me)names.delete(me.name.toLowerCase());
if(!room)return;
const wasHost=room.hostId===sock.id;
room.players=room.players.filter(p=>p.id!==sock.id);
if(!room.players.length){
delete rooms[room.code];
room=null;
return;
}
if(wasHost){
io.to(room.code).emit("hostLeft");
delete rooms[room.code];
}else{
io.to(room.code).emit("lobby",lobby(room));
io.to(room.hostId).emit("peerLeft",{});
if(room.started&&room.players.every(p=>p.again)){
room.players.forEach(p=>p.again=false);
io.to(room.code).emit("restart",{players:room.players.map(p=>({idx:p.idx,name:p.name}))});
}
}
room=null;
});
});
const PORT=process.env.PORT||3000;
srv.listen(PORT,()=>console.log("Water Escape server listening on "+PORT));