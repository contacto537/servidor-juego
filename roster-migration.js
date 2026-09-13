/* Retired IDs exist only here to transfer previously earned characters.
   Migration never changes stars, ad progress, cosmetics or store entitlements. */
(function(root,factory){
 if(typeof module==='object'&&module.exports)module.exports=factory();
 else root.RosterMigration=factory();
})(typeof globalThis!=='undefined'?globalThis:this,function(){
 'use strict';
 const aliases=Object.freeze({"frogtech":"raccoonmechanic","coralguard":"mossbot","mantarogue":"shellcourier","koisamurai":"coppergriffin","stormmage":"mintwisp","lotusoracle":"petalranger","jellywitch":"clockworkscout","dragonrider":"fernfox","turtlesage":"aquabot","krakenking":"raccoonmechanic","reefpirate":"ironwanderer","firefighter":"embertinker","bubblemonk":"willowranger","tideblade":"cobaltstrider","axolotlpurple":"copperbotanist","ghostsailor":"miner","abysswalker":"miner","crabbrawler":"miner","penguinpilot":"miner","sharkguard":"miner"});
 const roster=Object.freeze(["miner","axolotlcyan","copperbotanist","axolotlgold","axolotlpink","ironwanderer","embertinker","willowranger","cobaltstrider","raccoonmechanic","mossbot","shellcourier","coppergriffin","mintwisp","petalranger","clockworkscout","fernfox","aquabot","valvewarden","mossscout","brassengineer","steambruiser","aurumtitan","jadeancient","magmalord","abyssknight"]);
 const valid=new Set(roster),owns=(object,key)=>Object.prototype.hasOwnProperty.call(object,key);
 function resolve(value){
  const id=typeof value==='string'?(owns(aliases,value)?aliases[value]:value):'miner';
  return valid.has(id)?id:'miner';
 }
 function normalize(value){
  const input=value&&typeof value==='object'?value:{},own={miner:1};
  if(input.own&&typeof input.own==='object')for(const [key,earned] of Object.entries(input.own)){
   if(!earned)continue;
   const id=owns(aliases,key)?aliases[key]:key;
   if(valid.has(id))own[id]=1;
  }
  const selected=resolve(input.sel);
  return {own,sel:own[selected]?selected:'miner'};
 }
 function merge(current,incoming){
  const a=normalize(current),b=normalize(incoming),own={...a.own,...b.own};
  return {own,sel:a.sel!=='miner'?a.sel:b.sel};
 }
 return Object.freeze({resolve,normalize,merge,ids:()=>roster.slice()});
});
