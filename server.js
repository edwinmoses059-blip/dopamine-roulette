const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const crypto = require("crypto");

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: process.env.ALLOWED_ORIGIN || "*" },
  pingTimeout: 20000,
  pingInterval: 25000
});
const PORT = process.env.PORT || 3000;
const rooms = new Map();
const ROUND_SECONDS = 8;
const CHOICES = new Set(["safe", "mystery", "sabotage"]);

function makeCode() {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let code;
  do {
    code = Array.from({length: 5}, () => alphabet[crypto.randomInt(alphabet.length)]).join("");
  } while (rooms.has(code));
  return code;
}
function cleanName(value) {
  return String(value || "Player").replace(/[<>]/g, "").trim().slice(0, 18) || "Player";
}
function publicRoom(room) {
  return {
    code: room.code,
    hostId: room.hostId,
    phase: room.phase,
    round: room.round,
    deadline: room.deadline,
    players: [...room.players.values()].map(p => ({
      id: p.id, name: p.name, score: p.score, connected: p.connected,
      hasChosen: room.phase === "choosing" ? room.choices.has(p.id) : false
    }))
  };
}
function broadcastRoom(room) {
  io.to(room.code).emit("room:update", publicRoom(room));
}
function getRoomForSocket(socket) {
  const code = socket.data.roomCode;
  return code ? rooms.get(code) : null;
}
function emitError(socket, message) { socket.emit("app:error", message); }

function resolveRound(room) {
  if (room.phase !== "choosing") return;
  clearTimeout(room.timer);
  const results = [];
  const mysteryValues = [0, 1, 3, 5];
  const choices = [...room.choices.entries()];
  const onlinePlayers = [...room.players.values()].filter(p => p.connected);
  for (const [playerId, choice] of choices) {
    const player = room.players.get(playerId);
    if (!player) continue;
    if (choice.type === "safe") {
      player.score += 2;
      results.push({playerId, name: player.name, choice: "safe", points: 2, message: "Steady reward: +2"});
    } else if (choice.type === "mystery") {
      const points = mysteryValues[crypto.randomInt(mysteryValues.length)];
      player.score += points;
      results.push({playerId, name: player.name, choice: "mystery", points, message: points ? `Mystery reward: +${points}` : "Empty box: +0"});
    } else if (choice.type === "sabotage") {
      const targets = onlinePlayers.filter(p => p.id !== playerId);
      if (targets.length) {
        const target = targets[crypto.randomInt(targets.length)];
        target.score = Math.max(0, target.score - 2);
        player.score += 3;
        results.push({playerId, name: player.name, choice: "sabotage", points: 3, targetId: target.id, targetName: target.name, message: `Sabotage landed: +3; ${target.name} lost 2`});
      } else {
        player.score += 1;
        results.push({playerId, name: player.name, choice: "sabotage", points: 1, message: "No target available: +1"});
      }
    }
  }
  room.phase = "reveal";
  room.lastResults = results;
  io.to(room.code).emit("round:reveal", {round: room.round, results, scoreboard: publicRoom(room).players.sort((a,b) => b.score-a.score)});
  broadcastRoom(room);
  room.timer = setTimeout(() => {
    if (!rooms.has(room.code)) return;
    room.phase = "lobby";
    room.choices.clear();
    room.deadline = null;
    broadcastRoom(room);
  }, 6500);
}

app.get("/", (_req, res) => res.type("html").send(INDEX_HTML));
app.get("/health", (_req, res) => res.json({ok: true, rooms: rooms.size}));

io.on("connection", socket => {
  socket.on("room:create", ({name} = {}) => {
    if (socket.data.roomCode) return emitError(socket, "Leave your current room first.");
    const code = makeCode();
    const player = {id: socket.id, name: cleanName(name), score: 0, connected: true};
    const room = {code, hostId: socket.id, players: new Map([[socket.id, player]]), phase: "lobby", round: 0, choices: new Map(), deadline: null, timer: null, lastResults: []};
    rooms.set(code, room);
    socket.join(code);
    socket.data.roomCode = code;
    socket.emit("room:joined", {code, playerId: socket.id});
    broadcastRoom(room);
  });

  socket.on("room:join", ({code, name} = {}) => {
    if (socket.data.roomCode) return emitError(socket, "Leave your current room first.");
    code = String(code || "").trim().toUpperCase();
    const room = rooms.get(code);
    if (!room) return emitError(socket, "Room not found. Check the code and try again.");
    if (room.players.size >= 12) return emitError(socket, "This room is full (12 players max).");
    if (room.phase === "choosing" || room.phase === "reveal") return emitError(socket, "That room is in the middle of a round. Try again shortly.");
    room.players.set(socket.id, {id: socket.id, name: cleanName(name), score: 0, connected: true});
    socket.join(code);
    socket.data.roomCode = code;
    socket.emit("room:joined", {code, playerId: socket.id});
    broadcastRoom(room);
  });

  socket.on("round:start", () => {
    const room = getRoomForSocket(socket);
    if (!room) return emitError(socket, "Join a room first.");
    if (room.hostId !== socket.id) return emitError(socket, "Only the room host can start a round.");
    if (room.phase !== "lobby") return emitError(socket, "The current round is not finished yet.");
    if ([...room.players.values()].filter(p => p.connected).length < 2) return emitError(socket, "Invite at least one other player first.");
    room.phase = "choosing";
    room.round += 1;
    room.choices.clear();
    room.deadline = Date.now() + ROUND_SECONDS * 1000;
    io.to(room.code).emit("round:started", {round: room.round, deadline: room.deadline, seconds: ROUND_SECONDS});
    broadcastRoom(room);
    room.timer = setTimeout(() => resolveRound(room), ROUND_SECONDS * 1000);
  });

  socket.on("choice:submit", ({type} = {}) => {
    const room = getRoomForSocket(socket);
    if (!room || room.phase !== "choosing") return emitError(socket, "There isn't an active choice round.");
    if (!CHOICES.has(type)) return emitError(socket, "Choose Safe, Mystery Box, or Sabotage.");
    if (room.choices.has(socket.id)) return emitError(socket, "Your choice is already locked in.");
    room.choices.set(socket.id, {type});
    socket.emit("choice:locked", {type});
    broadcastRoom(room);
    if ([...room.players.values()].filter(p => p.connected).every(p => room.choices.has(p.id))) {
      room.timer = setTimeout(() => resolveRound(room), 900);
    }
  });

  socket.on("room:leave", () => {
    const room = getRoomForSocket(socket);
    if (!room) return;
    room.players.delete(socket.id);
    room.choices.delete(socket.id);
    socket.leave(room.code);
    socket.data.roomCode = null;
    if (room.players.size === 0) {
      clearTimeout(room.timer);
      rooms.delete(room.code);
    } else {
      if (room.hostId === socket.id) room.hostId = room.players.keys().next().value;
      broadcastRoom(room);
    }
  });

  socket.on("disconnect", () => {
    const room = getRoomForSocket(socket);
    if (!room) return;
    const player = room.players.get(socket.id);
    if (player) player.connected = false;
    if (room.hostId === socket.id) {
      const next = [...room.players.values()].find(p => p.connected);
      if (next) room.hostId = next.id;
    }
    broadcastRoom(room);
    // Keep a disconnected player's score for this room; empty rooms expire.
    if (![...room.players.values()].some(p => p.connected)) {
      room.timer = setTimeout(() => {
        if (![...room.players.values()].some(p => p.connected)) rooms.delete(room.code);
      }, 60000);
    }
  });
});

const INDEX_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="theme-color" content="#09090f"><title>Dopamine Roulette</title>
<script src="https://cdn.tailwindcss.com"></script>
<script src="/socket.io/socket.io.js"></script>
<style>
:root{color-scheme:dark}body{background:radial-gradient(ellipse at top,#21113e 0%,#0b0a13 48%,#07070b 100%);min-height:100vh}
.glass{background:rgba(255,255,255,.055);border:1px solid rgba(255,255,255,.11);backdrop-filter:blur(14px)}
.glow{box-shadow:0 0 35px rgba(168,85,247,.18)}.choice{transition:transform .18s,border-color .18s,background .18s}.choice:hover{transform:translateY(-3px)}.choice:disabled{opacity:.45;cursor:not-allowed}
.pulse-ring{animation:pulse 1.5s infinite}@keyframes pulse{0%,100%{box-shadow:0 0 0 0 rgba(192,132,252,.35)}50%{box-shadow:0 0 0 12px rgba(192,132,252,0)}}
</style>
</head>
<body class="text-white">
<main class="max-w-5xl mx-auto px-4 py-7 md:py-12">
<header class="text-center mb-8">
<div class="inline-flex items-center gap-2 rounded-full border border-fuchsia-400/30 bg-fuchsia-400/10 px-3 py-1 text-xs text-fuchsia-200 mb-4"><span class="h-2 w-2 rounded-full bg-emerald-400"></span> LIVE SOCIAL EXPERIMENT</div>
<h1 class="text-4xl sm:text-6xl font-black tracking-tight">DOPAMINE <span class="text-fuchsia-400">ROULETTE</span></h1>
<p class="mt-3 text-slate-300 max-w-xl mx-auto">Risk, reward, and a little uncertainty. Make your move before the clock hits zero.</p>
</header>
<div id="notice" class="hidden mb-4 rounded-xl border border-rose-400/30 bg-rose-500/10 p-3 text-sm text-rose-200"></div>
<section id="entry" class="max-w-xl mx-auto glass glow rounded-3xl p-5 sm:p-8">
<label class="block text-sm text-slate-300 mb-2" for="name">Your player name</label><input id="name" maxlength="18" placeholder="e.g. NeonFox" class="w-full rounded-xl bg-black/30 border border-white/15 px-4 py-3 outline-none focus:border-fuchsia-400 mb-5">
<button id="create" class="w-full rounded-xl bg-fuchsia-500 hover:bg-fuchsia-400 text-black font-bold py-3 mb-4">Create a room</button>
<div class="flex items-center gap-3 my-4 text-slate-500 text-xs uppercase"><span class="h-px bg-white/10 flex-1"></span>or join with a code<span class="h-px bg-white/10 flex-1"></span></div>
<div class="flex gap-2"><input id="code" maxlength="5" placeholder="ROOM CODE" class="min-w-0 flex-1 uppercase tracking-[.25em] text-center rounded-xl bg-black/30 border border-white/15 px-3 py-3 outline-none focus:border-fuchsia-400"><button id="join" class="rounded-xl bg-white/10 hover:bg-white/20 px-5 font-semibold">Join</button></div>
<p class="mt-5 text-xs text-slate-500 text-center">No account needed · Up to 12 players · Works on mobile and desktop</p>
</section>

<section id="game" class="hidden">
<div class="grid md:grid-cols-[1.3fr_.7fr] gap-4">
<div class="glass glow rounded-3xl p-5 sm:p-7">
<div class="flex items-center justify-between gap-3 mb-6"><div><p class="text-xs text-slate-400 uppercase tracking-widest">Room code</p><div class="flex items-center gap-3"><span id="roomCode" class="text-3xl font-black tracking-[.2em]">-----</span><button id="copy" class="text-xs rounded-lg bg-white/10 px-3 py-2">Copy invite</button></div></div><div class="text-right"><p class="text-xs text-slate-400">ROUND</p><p id="round" class="text-2xl font-bold">0</p></div></div>
<div id="stage" class="rounded-2xl border border-white/10 bg-black/20 p-5 sm:p-7 text-center min-h-[210px] flex flex-col justify-center">
<div id="timer" class="text-5xl font-black text-fuchsia-300 mb-2">∞</div><h2 id="stageTitle" class="text-xl sm:text-2xl font-bold">Waiting for players</h2><p id="stageText" class="text-slate-400 text-sm mt-2">Share your room code to bring others in.</p>
</div>
<div id="choices" class="grid sm:grid-cols-3 gap-3 mt-4">
<button data-choice="safe" class="choice rounded-2xl border border-emerald-300/25 bg-emerald-400/10 p-4 text-left"><span class="text-2xl">🛡️</span><h3 class="font-bold mt-2">Safe</h3><p class="text-xs text-slate-400 mt-1">Reliable +2 points</p></button>
<button data-choice="mystery" class="choice rounded-2xl border border-fuchsia-300/25 bg-fuchsia-400/10 p-4 text-left"><span class="text-2xl">🎁</span><h3 class="font-bold mt-2">Mystery Box</h3><p class="text-xs text-slate-400 mt-1">Random reward: 0, 1, 3 or 5</p></button>
<button data-choice="sabotage" class="choice rounded-2xl border border-rose-300/25 bg-rose-400/10 p-4 text-left"><span class="text-2xl">🌀</span><h3 class="font-bold mt-2">Sabotage</h3><p class="text-xs text-slate-400 mt-1">Gain +3; another player loses 2</p></button>
</div>
<div class="mt-4 flex gap-3"><button id="start" class="hidden flex-1 rounded-xl bg-fuchsia-500 hover:bg-fuchsia-400 text-black font-bold py-3">Start next round</button><button id="leave" class="rounded-xl bg-white/10 hover:bg-white/20 px-5 py-3">Leave room</button></div>
</div>
<aside class="glass rounded-3xl p-5">
<div class="flex items-center justify-between mb-4"><h2 class="font-bold text-lg">Live scoreboard</h2><span id="playerCount" class="text-xs text-slate-400">0 players</span></div>
<div id="players" class="space-y-2"></div>
<div class="mt-6 rounded-xl bg-white/5 p-4"><h3 class="font-semibold text-sm mb-2">How to play</h3><ol class="text-xs text-slate-400 space-y-2 list-decimal list-inside"><li>Host starts a round.</li><li>Choose secretly before the timer ends.</li><li>Choices reveal together.</li><li>Highest score wins. Trust is optional.</li></ol></div>
<p class="mt-4 text-[11px] leading-relaxed text-slate-500">Game points only. The uncertainty is part of the game—not a clinical measure of dopamine or a promise of psychological effects.</p>
</aside>
</div>
<div id="reveal" class="hidden mt-4 glass rounded-3xl p-5"><h2 class="text-xl font-black mb-3">🎭 The reveal</h2><div id="results" class="grid sm:grid-cols-2 gap-2"></div></div>
</section>
<footer class="text-center text-xs text-slate-600 mt-8">Dopamine Roulette · Play fair-ish.</footer>
</main>
<script>
const socket = io();
const $ = id => document.getElementById(id);
let myId = null, room = null, locked = false, countdown = null;
function showError(msg){$('notice').textContent=msg;$('notice').classList.remove('hidden');setTimeout(()=>$('notice').classList.add('hidden'),4500)}
function enterRoom(data){myId=data.playerId;$('entry').classList.add('hidden');$('game').classList.remove('hidden');$('roomCode').textContent=data.code}
$('create').onclick=()=>socket.emit('room:create',{name:$('name').value});
$('join').onclick=()=>socket.emit('room:join',{code:$('code').value,name:$('name').value});
$('code').addEventListener('input',e=>e.target.value=e.target.value.toUpperCase().replace(/[^A-Z0-9]/g,''));
$('copy').onclick=async()=>{const text=location.href.split('?')[0]+'?room='+room.code;try{await navigator.clipboard.writeText(text);$('copy').textContent='Copied!'}catch{prompt('Copy this room invite:',text)}setTimeout(()=>$('copy').textContent='Copy invite',1600)};
$('start').onclick=()=>socket.emit('round:start');
$('leave').onclick=()=>{socket.emit('room:leave');location.href=location.pathname};
document.querySelectorAll('[data-choice]').forEach(btn=>btn.onclick=()=>{if(locked)return;socket.emit('choice:submit',{type:btn.dataset.choice})});
socket.on('connect',()=>{const code=new URLSearchParams(location.search).get('room');if(code){$('code').value=code.toUpperCase()}});
socket.on('room:joined',data=>enterRoom(data));
socket.on('app:error',showError);
socket.on('room:update',data=>{
 room=data;$('roomCode').textContent=data.code;$('round').textContent=data.round;$('playerCount').textContent=data.players.length+' player'+(data.players.length===1?'':'s');
 $('players').innerHTML=data.players.slice().sort((a,b)=>b.score-a.score).map((p,i)=>'<div class="flex items-center gap-3 rounded-xl bg-white/5 p-3"><div class="w-8 h-8 rounded-full flex items-center justify-center text-sm font-bold '+(i===0?'bg-amber-300 text-black':'bg-white/10')+'">'+(i+1)+'</div><div class="min-w-0 flex-1"><div class="truncate text-sm font-semibold">'+escapeHtml(p.name)+(p.id===myId?' <span class="text-fuchsia-300">(you)</span>':'')+'</div><div class="text-[11px] text-slate-500">'+(p.connected?'online':'disconnected')+(data.phase==='choosing'&&p.hasChosen?' · locked in':'')+'</div></div><div class="font-black text-lg">'+p.score+'</div></div>').join('');
 const isHost=data.hostId===myId;
 $('start').classList.toggle('hidden',!isHost||data.phase!=='lobby');
 $('choices').classList.toggle('hidden',data.phase!=='choosing');
 if(data.phase==='lobby'){$('stageTitle').textContent=data.players.length<2?'Waiting for players':'Ready when you are';$('stageText').textContent=isHost?'Start a round when everyone is ready.':'Waiting for the host to start a round.';$('timer').textContent='∞';locked=false;setChoiceDisabled(false)}
 if(data.phase==='choosing'){$('stageTitle').textContent=locked?'Your choice is locked':'Choose your move';$('stageText').textContent=locked?'Your choice is secret until the reveal. Make your choice before time runs out.':'Everyone chooses privately. No peeking.';setChoiceDisabled(locked);startCountdown(data.deadline)}
 if(data.phase==='reveal'){$('stageTitle').textContent='The choices are revealed';$('stageText').textContent='Check the reveal below to see what happened.';$('timer').textContent='✦'}
});
socket.on('round:started',data=>{locked=false;$('reveal').classList.add('hidden');$('stageTitle').textContent='Make your move';startCountdown(data.deadline)});
socket.on('choice:locked',data=>{locked=true;$('stageTitle').textContent='Choice locked 🔒';$('stageText').textContent='The others cannot see your choice. Waiting for reveal…';setChoiceDisabled(true)});
socket.on('round:reveal',data=>{
 $('reveal').classList.remove('hidden');
 $('results').innerHTML=data.results.length?data.results.map(r=>{const icon={safe:'🛡️',mystery:'🎁',sabotage:'🌀'}[r.choice];return '<div class="rounded-xl border border-white/10 bg-black/20 p-4"><div class="flex items-center justify-between"><span class="font-bold">'+icon+' '+escapeHtml(r.name)+'</span><span class="text-xs uppercase text-slate-400">'+r.choice+'</span></div><p class="text-sm mt-2 '+(r.points>2?'text-emerald-300':'text-slate-300')+'">'+escapeHtml(r.message)+'</p></div>'}).join(''):'<p class="text-sm text-slate-400">No choices were submitted this round.</p>';
 $('stageTitle').textContent='And the results are in…';$('stageText').textContent='Round '+data.round+' complete. Next round begins when the host is ready.';$('timer').textContent='✦';setChoiceDisabled(true);
});
function setChoiceDisabled(disabled){document.querySelectorAll('[data-choice]').forEach(b=>b.disabled=disabled)}
function startCountdown(deadline){clearInterval(countdown);const tick=()=>{const left=Math.max(0,Math.ceil((deadline-Date.now())/1000));$('timer').textContent=left;$('timer').classList.toggle('pulse-ring',left>0&&left<=4);if(left===0)clearInterval(countdown)};tick();countdown=setInterval(tick,200)}
function escapeHtml(s){return String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]))}
</script>
</body></html>`;

server.listen(PORT, () => console.log(`Dopamine Roulette running on port ${PORT}`));
