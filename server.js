/*
 * Lügen — autoritativer Online-Multiplayer-Server.
 *
 * - Express liefert die statischen Client-Dateien aus /public.
 * - WebSocket (ws) verwaltet Räume, Spielzüge und Echtzeit-Sync.
 * - Die gesamte Spiellogik läuft hier serverseitig (engine.js) -> schummelsicher:
 *   Jeder Client bekommt NUR seine eigenen Karten zu sehen, der verdeckte
 *   Stapel und fremde Hände bleiben verborgen (bis zum Aufdecken).
 *
 * Ein einziger Prozess, ein Port (process.env.PORT) -> ideal für Render/Railway/Fly.
 */
"use strict";

const path = require("path");
const http = require("http");
const express = require("express");
const { WebSocketServer } = require("ws");
const E = require("./engine.js");
const MIN_PLAYERS = E.MIN_PLAYERS;

const PORT = process.env.PORT || 3000;
const app = express();

app.disable("x-powered-by");
app.use(express.static(__dirname, { extensions: ["html"], dotfiles: "ignore" }));
app.get("/healthz", (_req, res) => res.type("text").send("ok"));

const server = http.createServer(app);
const wss = new WebSocketServer({ server });

// --------------------------------------------------------------------- Räume
const rooms = new Map(); // code -> room
// Timings (per Umgebungsvariable übersteuerbar — v. a. für schnelle Tests; Standard bleibt unverändert).
const REVEAL_MS = +process.env.LUEGEN_REVEAL_MS || 1900;
const PICKUP_MS = +process.env.LUEGEN_PICKUP_MS || 2000;
const BOT_MS = +process.env.LUEGEN_BOT_MS || 1600;
const DISC_MS = +process.env.LUEGEN_DISC_MS || 3500; // getrennter Spieler wird nach dieser Zeit automatisch gespielt
const EMPTY_ROOM_TTL = 3 * 60e3;                     // Raum ohne verbundene Menschen nach 3 min löschen

const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // ohne 0/O/1/I
function makeCode() {
  let code;
  do {
    code = "";
    for (let i = 0; i < 4; i++) code += CODE_ALPHABET[Math.floor(Math.random() * CODE_ALPHABET.length)];
  } while (rooms.has(code));
  return code;
}
function makeId() { return Math.random().toString(36).slice(2, 10); }
function makeToken() { return makeId() + makeId(); }

function sanitizeName(s, fallback) {
  s = String(s == null ? "" : s).replace(/[\u0000-\u001F]/g, "").trim().slice(0, 14);
  return s || fallback;
}

function createRoom(variant) {
  const code = makeCode();
  const room = {
    code,
    variant: variant === "asc" ? "asc" : "same",
    status: "lobby",          // 'lobby' | 'playing' | 'over'
    hostId: null,
    botLevel: "mittel",       // 'leicht' | 'mittel' | 'schwer'
    seats: [],                // { id, name, color, isBot, connected, token, ws }
    game: null,
    chat: [],
    stats: {},              // seatId -> { name, color, places:{1:n,2:n,3:n,...}, games }
    statsRecorded: false,
    timers: { auto: null, reveal: null, pickup: null, cleanup: null },
    lastActivity: Date.now(),
  };
  rooms.set(code, room);
  return room;
}

function nextColor(room) { return E.PALETTE[room.seats.length % E.PALETTE.length]; }

function botName(room) {
  const used = new Set(room.seats.map((s) => s.name));
  const free = E.BOTNAMES.filter((n) => !used.has(n));
  const pool = free.length ? free : E.BOTNAMES;
  return pool[Math.floor(Math.random() * pool.length)];
}

function clearTimers(room) {
  for (const k of Object.keys(room.timers)) {
    if (k === "cleanup") continue;
    if (room.timers[k]) { clearTimeout(room.timers[k]); room.timers[k] = null; }
  }
}

function destroyRoom(room) {
  for (const k of Object.keys(room.timers)) if (room.timers[k]) clearTimeout(room.timers[k]);
  rooms.delete(room.code);
}

// ----------------------------------------------------------------- Netzwerk
function send(ws, obj) {
  if (ws && ws.readyState === ws.OPEN) {
    try { ws.send(JSON.stringify(obj)); } catch (_e) {}
  }
}

// Redigierter Zustand für genau einen Sitzplatz (verbirgt fremde Karten + Stapel).
function redactFor(room, seatIndex) {
  const g = room.game;
  const players = room.seats.map((s, i) => ({
    index: i,
    name: s.name,
    color: s.color,
    isBot: s.isBot,
    connected: s.connected,
    isHost: s.id === room.hostId,
    count: g ? g.players[i].hand.length : 0,
    out: g ? g.players[i].out : false,
    place: g ? g.players[i].place : null,
  }));

  const out = {
    code: room.code,
    variant: room.variant,
    status: room.status,
    you: { index: seatIndex },
    players,
    chat: room.chat.slice(-60),
    minPlayers: MIN_PLAYERS,
    maxPlayers: 6,
    canStart: room.status === "lobby" && room.seats.length >= MIN_PLAYERS,
    botLevel: room.botLevel,
    hasBots: room.seats.some((s) => s.isBot),
    stats: statsList(room),
  };

  if (g) {
    out.turn = g.turn;
    out.phase = g.phase;
    out.round = g.round;
    out.currentRank = g.currentRank;
    out.roundRank = g.roundRank;
    out.pileCount = g.pile.length;
    out.lastPlay = g.lastPlay ? { player: g.lastPlay.player, count: g.lastPlay.count, rank: g.lastPlay.rank } : null;
    out.pendingFinish = g.pendingFinish;
    out.finishOrder = g.finishOrder;
    out.standings = g.standings;          // erst am Rundenende gesetzt
    out.winner = g.winner;
    out.hand = (seatIndex != null && g.players[seatIndex]) ? g.players[seatIndex].hand : [];

    out.reveal = (g.phase === "reveal" && g.reveal)
      ? { cards: g.reveal.cards, honest: g.reveal.honest, loser: g.reveal.loser, winner: g.reveal.winner, rank: g.reveal.rank, by: g.reveal.by, claimer: g.reveal.claimer, claimerPending: g.reveal.claimerPending }
      : null;
    // Aufnehmen verdeckt: nur der aufnehmende Spieler sieht die Karten.
    out.pickup = (g.phase === "pickup" && g.pickup)
      ? { player: g.pickup.player, count: g.pickup.cards.length, cards: (seatIndex === g.pickup.player ? g.pickup.cards : null) }
      : null;

    const meOut = g.players[seatIndex] && g.players[seatIndex].out;
    out.yourTurn = g.turn === seatIndex && g.phase === "play" && room.status === "playing" && !meOut;
    out.canChallenge = room.status === "playing" && g.phase === "play" && !!g.lastPlay && g.lastPlay.player !== seatIndex && !meOut;
  }
  return out;
}

// Session-Statistik als sortierte Liste (für die Anzeige).
function statsList(room) {
  const arr = Object.keys(room.stats).map((id) => {
    const e = room.stats[id];
    return { name: e.name, color: e.color, p1: e.places[1] || 0, p2: e.places[2] || 0, p3: e.places[3] || 0, games: e.games };
  });
  arr.sort((a, b) => (b.p1 - a.p1) || (b.p2 - a.p2) || (b.p3 - a.p3) || (b.games - a.games));
  return arr;
}

// Endplatzierungen einer Runde in die Session-Statistik übernehmen.
function recordStats(room) {
  const g = room.game;
  if (!g || !g.standings || room.statsRecorded) return;
  g.standings.forEach((entry) => {
    const seat = room.seats[entry.player];
    if (!seat) return;
    let e = room.stats[seat.id];
    if (!e) e = room.stats[seat.id] = { name: seat.name, color: seat.color, places: {}, games: 0 };
    e.name = seat.name; e.color = seat.color;
    e.places[entry.place] = (e.places[entry.place] || 0) + 1;
    e.games += 1;
  });
  room.statsRecorded = true;
}

function broadcast(room) {
  room.lastActivity = Date.now();
  room.seats.forEach((s, i) => { if (s.ws) send(s.ws, { t: "state", room: redactFor(room, i) }); });
}

function sendEvent(room, evt) {
  room.seats.forEach((s) => { if (s.ws) send(s.ws, Object.assign({ t: "event" }, evt)); });
}

function pushChat(room, entry) {
  room.chat.push(entry);
  if (room.chat.length > 200) room.chat.shift();
}

function systemChat(room, text) {
  pushChat(room, { sys: true, text, ts: Date.now() });
}

// --------------------------------------------------------------- Spielablauf
function startGame(room) {
  if (room.seats.length < MIN_PLAYERS) return;
  clearTimers(room);
  room.statsRecorded = false;
  room.game = E.newGame({
    players: room.seats.map((s) => ({ name: s.name, color: s.color, isBot: s.isBot })),
    variant: room.variant,
  });
  room.status = "playing";
  systemChat(room, "Neue Partie gestartet.");
  if (finishIfOver(room)) return; // sehr selten sofort vorbei (4 Asse beim Austeilen)
  broadcast(room);
  scheduleAuto(room);
}

function finishIfOver(room) {
  const g = room.game;
  if (g && g.status === "over") {
    room.status = "over";
    clearTimers(room);
    recordStats(room);
    sendEvent(room, { kind: "gameover" });
    broadcast(room);
    return true;
  }
  return false;
}

function doPlay(room, seatIndex, cardIds, rank) {
  const g = room.game;
  const chk = E.legalPlay(g, seatIndex, cardIds, rank);
  if (!chk.ok) return chk;
  const r = E.applyPlay(g, seatIndex, cardIds, rank);
  room.game = r.state;
  sendEvent(room, { kind: "play", player: seatIndex, count: cardIds.length, rank: (r.events[0] && r.events[0].rank) });
  broadcast(room);
  if (finishIfOver(room)) return { ok: true };
  scheduleAuto(room);
  return { ok: true };
}

function doChallenge(room, seatIndex) {
  const g = room.game;
  const chk = E.legalChallenge(g, seatIndex);
  if (!chk.ok) return chk;
  clearTimers(room);
  const claimer = g.lastPlay.player;
  const r = E.applyChallenge(g, seatIndex);
  room.game = r.state;
  sendEvent(room, { kind: "challenge", by: seatIndex, claimer });
  broadcast(room);

  room.timers.reveal = setTimeout(() => {
    room.timers.reveal = null;
    const rv = room.game.reveal;
    const honest = rv.honest, loser = rv.loser, claimer2 = rv.claimer;
    const res = E.resolveReveal(room.game);
    room.game = res.state;
    sendEvent(room, { kind: "reveal_done", honest, loser, claimer: claimer2 });
    broadcast(room);
    if (finishIfOver(room)) return;
    if (res.hadPickup) {
      room.timers.pickup = setTimeout(() => {
        room.timers.pickup = null;
        room.game = E.endPickup(room.game);
        broadcast(room);
        scheduleAuto(room);
      }, PICKUP_MS);
    } else {
      scheduleAuto(room);
    }
  }, REVEAL_MS);

  return { ok: true };
}

// Plant automatische Aktionen: Snap-Anzweifeln durch Bots/getrennte Spieler,
// danach den Zug des aktuellen Bots / getrennten Spielers.
function scheduleAuto(room) {
  if (room.timers.auto) { clearTimeout(room.timers.auto); room.timers.auto = null; }
  const g = room.game;
  if (!g || room.status !== "playing" || g.phase !== "play") return;

  // 1) Snap-Anzweifeln: ein zugfremder Bot/getrennter Spieler, der die Ansage
  //    beweisbar widerlegen kann.
  if (g.lastPlay) {
    const eligible = [];
    room.seats.forEach((s, i) => {
      if (i === g.lastPlay.player) return;
      if ((s.isBot || !s.connected) && E.canProveImpossible(g, i)) eligible.push(i);
    });
    if (eligible.length && Math.random() < 0.9) {
      const by = eligible[Math.floor(Math.random() * eligible.length)];
      room.timers.auto = setTimeout(() => { room.timers.auto = null; doChallenge(room, by); }, 800);
      return;
    }
  }

  // 2) Aktueller Spieler ist Bot oder getrennt -> automatisch ziehen.
  const cur = room.seats[g.turn];
  if (cur && (cur.isBot || !cur.connected)) {
    const delay = cur.isBot ? BOT_MS : DISC_MS;
    room.timers.auto = setTimeout(() => {
      room.timers.auto = null;
      const gg = room.game;
      if (!gg || room.status !== "playing" || gg.phase !== "play" || gg.turn !== g.turn) return;
      const seat = room.seats[gg.turn];
      if (!seat || (!seat.isBot && seat.connected)) return; // Mensch ist zurück
      const dec = E.botDecide(gg, room.botLevel);
      if (dec.action === "challenge") doChallenge(room, gg.turn);
      else doPlay(room, gg.turn, dec.cardIds, dec.rank);
    }, delay);
  }
}

// ----------------------------------------------------------------- Host etc.
function reassignHostIfNeeded(room) {
  const host = room.seats.find((s) => s.id === room.hostId);
  if (host && host.connected && !host.isBot) return;
  const cand = room.seats.find((s) => s.connected && !s.isBot);
  if (cand) room.hostId = cand.id;
}

function removeSeatAt(room, idx) {
  room.seats.splice(idx, 1);
  room.seats.forEach((s, i) => { s.color = E.PALETTE[i % E.PALETTE.length]; });
}

function scheduleCleanup(room) {
  if (room.timers.cleanup) clearTimeout(room.timers.cleanup);
  room.timers.cleanup = setTimeout(() => {
    const anyHuman = room.seats.some((s) => s.connected && !s.isBot);
    if (!anyHuman) destroyRoom(room);
  }, EMPTY_ROOM_TTL);
}

// ----------------------------------------------------------------- Handler
function handleMessage(ws, msg) {
  const meta = ws.meta;

  switch (msg.t) {
    case "create": {
      const room = createRoom(msg.variant);
      const seat = {
        id: makeId(), token: makeToken(),
        name: sanitizeName(msg.name, "Spieler"),
        color: nextColor(room), isBot: false, connected: true, ws,
      };
      room.seats.push(seat);
      room.hostId = seat.id;
      ws.meta = { code: room.code, seatId: seat.id };
      send(ws, { t: "joined", code: room.code, you: { id: seat.id, token: seat.token, index: 0 } });
      systemChat(room, seat.name + " hat den Raum erstellt.");
      broadcast(room);
      break;
    }

    case "join": {
      const code = String(msg.code || "").toUpperCase().trim();
      const room = rooms.get(code);
      if (!room) return send(ws, { t: "error", code: "no_room", msg: "Raum nicht gefunden." });
      if (room.status !== "lobby") return send(ws, { t: "error", code: "in_progress", msg: "Partie läuft bereits." });
      if (room.seats.length >= 6) return send(ws, { t: "error", code: "full", msg: "Raum ist voll (max. 6)." });
      const seat = {
        id: makeId(), token: makeToken(),
        name: sanitizeName(msg.name, "Spieler " + (room.seats.length + 1)),
        color: nextColor(room), isBot: false, connected: true, ws,
      };
      room.seats.push(seat);
      ws.meta = { code: room.code, seatId: seat.id };
      const idx = room.seats.length - 1;
      send(ws, { t: "joined", code: room.code, you: { id: seat.id, token: seat.token, index: idx } });
      systemChat(room, seat.name + " ist beigetreten.");
      broadcast(room);
      break;
    }

    case "rejoin": {
      const code = String(msg.code || "").toUpperCase().trim();
      const room = rooms.get(code);
      if (!room) return send(ws, { t: "error", code: "no_room", msg: "Raum existiert nicht mehr." });
      const idx = room.seats.findIndex((s) => s.token === msg.token);
      if (idx < 0) return send(ws, { t: "error", code: "no_seat", msg: "Sitzplatz nicht gefunden." });
      const seat = room.seats[idx];
      if (seat.ws && seat.ws !== ws) { try { seat.ws.close(); } catch (_e) {} }
      seat.ws = ws; seat.connected = true;
      ws.meta = { code: room.code, seatId: seat.id };
      if (room.timers.cleanup) { clearTimeout(room.timers.cleanup); room.timers.cleanup = null; }
      reassignHostIfNeeded(room);
      send(ws, { t: "joined", code: room.code, you: { id: seat.id, token: seat.token, index: idx } });
      systemChat(room, seat.name + " ist wieder da.");
      broadcast(room);
      break;
    }

    case "setVariant": {
      const room = getRoom(meta); if (!room) return;
      if (!isHost(room, meta) || room.status !== "lobby") return;
      room.variant = msg.variant === "asc" ? "asc" : "same";
      broadcast(room);
      break;
    }

    case "setBotLevel": {
      const room = getRoom(meta); if (!room) return;
      if (!isHost(room, meta) || room.status !== "lobby") return;
      room.botLevel = (["leicht", "mittel", "schwer"].indexOf(msg.level) >= 0) ? msg.level : "mittel";
      broadcast(room);
      break;
    }

    case "addBot": {
      const room = getRoom(meta); if (!room) return;
      if (!isHost(room, meta) || room.status !== "lobby") return;
      if (room.seats.length >= 6) return send(ws, { t: "error", msg: "Raum ist voll." });
      const seat = { id: makeId(), token: null, name: botName(room), color: nextColor(room), isBot: true, connected: true, ws: null };
      room.seats.push(seat);
      systemChat(room, "Bot " + seat.name + " hinzugefügt.");
      broadcast(room);
      break;
    }

    case "removeSeat": {
      const room = getRoom(meta); if (!room) return;
      if (!isHost(room, meta) || room.status !== "lobby") return;
      const idx = msg.index | 0;
      if (idx < 0 || idx >= room.seats.length) return;
      const seat = room.seats[idx];
      if (seat.id === room.hostId) return; // Host bleibt
      if (seat.ws) send(seat.ws, { t: "kicked", msg: "Du wurdest aus dem Raum entfernt." });
      removeSeatAt(room, idx);
      systemChat(room, seat.name + (seat.isBot ? " (Bot) entfernt." : " entfernt."));
      broadcast(room);
      break;
    }

    case "start": {
      const room = getRoom(meta); if (!room) return;
      if (!isHost(room, meta) || room.status !== "lobby") return;
      if (room.seats.length < MIN_PLAYERS) return send(ws, { t: "error", msg: "Mindestens " + MIN_PLAYERS + " Spieler nötig." });
      startGame(room);
      break;
    }

    case "play": {
      const room = getRoom(meta); if (!room || room.status !== "playing") return;
      const idx = seatIndex(room, meta);
      if (idx < 0) return;
      const res = doPlay(room, idx, Array.isArray(msg.cardIds) ? msg.cardIds : [], msg.rank | 0);
      if (res && !res.ok) send(ws, { t: "error", msg: res.error });
      break;
    }

    case "challenge": {
      const room = getRoom(meta); if (!room || room.status !== "playing") return;
      const idx = seatIndex(room, meta);
      if (idx < 0) return;
      const res = doChallenge(room, idx);
      if (res && !res.ok) send(ws, { t: "error", msg: res.error });
      break;
    }

    case "chat": {
      const room = getRoom(meta); if (!room) return;
      const idx = seatIndex(room, meta);
      if (idx < 0) return;
      const text = String(msg.text || "").replace(/[\u0000-\u001F]/g, "").trim().slice(0, 200);
      if (!text) return;
      pushChat(room, { name: room.seats[idx].name, index: idx, color: room.seats[idx].color, text, ts: Date.now() });
      broadcast(room);
      break;
    }

    case "rematch": {
      const room = getRoom(meta); if (!room) return;
      if (room.status !== "over") return;
      startGame(room);
      break;
    }

    case "backToLobby": {
      const room = getRoom(meta); if (!room) return;
      if (!isHost(room, meta)) return;
      clearTimers(room);
      room.status = "lobby"; room.game = null;
      broadcast(room);
      break;
    }

    case "leave": {
      const room = getRoom(meta); if (!room) return;
      detach(ws, true);
      break;
    }
  }
}

function getRoom(meta) { return meta && meta.code ? rooms.get(meta.code) : null; }
function seatIndex(room, meta) { return room.seats.findIndex((s) => s.id === (meta && meta.seatId)); }
function isHost(room, meta) { return room.hostId === (meta && meta.seatId); }

// Verbindung trennen. permanent=true -> Sitz wird (in der Lobby) entfernt.
function detach(ws, permanent) {
  const meta = ws.meta;
  if (!meta || !meta.code) return;
  const room = rooms.get(meta.code);
  if (!room) return;
  const idx = room.seats.findIndex((s) => s.id === meta.seatId);
  if (idx < 0) return;
  const seat = room.seats[idx];
  seat.connected = false; seat.ws = null;

  const removeNow = permanent || room.status === "lobby";
  if (removeNow) {
    removeSeatAt(room, idx);
    if (seat.id === room.hostId) reassignHostIfNeeded(room);
    systemChat(room, seat.name + " hat den Raum verlassen.");
  } else {
    if (seat.id === room.hostId) reassignHostIfNeeded(room);
    systemChat(room, seat.name + " ist offline.");
  }

  const anyHuman = room.seats.some((s) => s.connected && !s.isBot);
  if (!anyHuman) { scheduleCleanup(room); return; }

  broadcast(room);
  if (room.status === "playing") scheduleAuto(room); // ggf. getrennten Spieler automatisch spielen
}

// ----------------------------------------------------------------- WS-Setup
wss.on("connection", (ws) => {
  ws.meta = null;
  ws.isAlive = true;
  ws.on("pong", () => { ws.isAlive = true; });
  send(ws, { t: "welcome" });

  ws.on("message", (data) => {
    let msg;
    try { msg = JSON.parse(data.toString()); } catch (_e) { return; }
    if (!msg || typeof msg.t !== "string") return;
    try { handleMessage(ws, msg); }
    catch (err) { console.error("handler error:", err); send(ws, { t: "error", msg: "Serverfehler." }); }
  });

  ws.on("close", () => detach(ws, false));
  ws.on("error", () => {});
});

// Tote Verbindungen erkennen (Heartbeat alle 30s).
const heartbeat = setInterval(() => {
  wss.clients.forEach((ws) => {
    if (ws.isAlive === false) return ws.terminate();
    ws.isAlive = false;
    try { ws.ping(); } catch (_e) {}
  });
}, 30000);
wss.on("close", () => clearInterval(heartbeat));

server.listen(PORT, () => {
  console.log("Lügen-Server läuft auf Port " + PORT);
});
