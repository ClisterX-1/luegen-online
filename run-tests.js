/*
 * Testlauf: `npm test`
 *   1) Engine-Regeln (Deck, Varianten, Anzweifeln, Sieg/Niederlage)
 *   2) Server-End-to-End: echte WebSocket-Spieler spielen eine Partie,
 *      inkl. Prüfung der Redaktion (keine fremden Karten sichtbar) + Wiederverbindung.
 * Nutzt nur mitgelieferte Abhängigkeiten (engine.js, ws, server.js).
 */
"use strict";
const path = require("path");
const { spawn } = require("child_process");
const WS = require("ws");
const E = require(path.join(__dirname, "..", "public", "engine.js"));

let pass = 0, fail = 0;
function ok(c, m) { if (c) pass++; else { fail++; console.log("  ✗ FAIL: " + m); } }
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// --------------------------------------------------------------- 1) Engine
function engineTests() {
  console.log("Engine-Tests…");
  const d = E.buildDeck();
  ok(d.length === 52, "Deck hat 52 Karten");
  ok(new Set(d.map((c) => c.id)).size === 52, "Karten-IDs eindeutig");

  let four = [{ rank: "7", suit: "H", id: "7H" }, { rank: "7", suit: "D", id: "7D" }, { rank: "7", suit: "C", id: "7C" }, { rank: "7", suit: "S", id: "7S" }, { rank: "K", suit: "H", id: "KH" }];
  ok(E.cleanFours(four).length === 1, "Viererpaar (außer Ass) wird abgelegt");
  let aces = [{ rank: "A", suit: "H", id: "AH" }, { rank: "A", suit: "D", id: "AD" }, { rank: "A", suit: "C", id: "AC" }, { rank: "A", suit: "S", id: "AS" }];
  ok(E.cleanFours(aces).length === 4 && E.hasAllAces(aces), "Vier Asse bleiben & werden erkannt");

  // Ehrlich gespielt + angezweifelt -> Anzweifler nimmt den Stapel
  let s = E.newGame({ players: [{ name: "A" }, { name: "B" }, { name: "C" }], variant: "same" });
  s.players[0].hand = [{ rank: "5", suit: "H", id: "5H" }, { rank: "9", suit: "D", id: "9D" }];
  s.players[1].hand = [{ rank: "2", suit: "C", id: "2C" }, { rank: "3", suit: "C", id: "3C" }];
  s.players[2].hand = [{ rank: "4", suit: "C", id: "4C" }, { rank: "6", suit: "C", id: "6C" }];
  s.turn = 0; s.roundRank = null; s.phase = "play"; s.pile = []; s.lastPlay = null;
  s = E.applyPlay(s, 0, ["5H"], 3).state;
  ok(s.roundRank === 3 && s.turn === 1, "Spielzug gesetzt, Zug weiter");
  s = E.applyChallenge(s, 1).state;
  ok(s.reveal.honest === true && s.reveal.loser === 1, "ehrlich -> Anzweifler verliert");
  s = E.resolveReveal(s).state;
  ok(s.players[1].hand.length === 3 && s.turn === 0, "Anzweifler nimmt Stapel, Gewinner führt");

  // Bluff + angezweifelt -> Bluffer nimmt den Stapel
  let s2 = E.newGame({ players: [{ name: "A" }, { name: "B" }], variant: "same" });
  s2.players[0].hand = [{ rank: "7", suit: "H", id: "7H" }, { rank: "9", suit: "D", id: "9D" }];
  s2.players[1].hand = [{ rank: "2", suit: "C", id: "2C" }];
  s2.turn = 0; s2.roundRank = null; s2.phase = "play"; s2.pile = []; s2.lastPlay = null;
  s2 = E.applyPlay(s2, 0, ["7H"], 3).state;       // sagt "5", legt 7 -> Bluff
  s2 = E.applyChallenge(s2, 1).state;
  ok(s2.reveal.honest === false && s2.reveal.loser === 0, "Bluff erkannt -> Bluffer verliert");

  // Sieg durch leere Hand
  let s3 = E.newGame({ players: [{ name: "A" }, { name: "B" }], variant: "asc" });
  s3.players[0].hand = [{ rank: "2", suit: "H", id: "2H" }];
  s3.turn = 0; s3.currentRank = 0; s3.phase = "play"; s3.pile = []; s3.lastPlay = null;
  s3 = E.applyPlay(s3, 0, ["2H"], 0).state;
  ok(s3.status === "over" && s3.winner === 0, "leere Hand = Sieg");

  // Niederlage durch vier Asse
  let s4 = E.newGame({ players: [{ name: "A" }, { name: "B" }], variant: "same" });
  s4.players[0].hand = [{ rank: "A", suit: "H", id: "AH" }, { rank: "A", suit: "D", id: "AD" }, { rank: "A", suit: "C", id: "AC" }, { rank: "A", suit: "S", id: "AS" }, { rank: "2", suit: "H", id: "2H" }];
  s4.turn = 0; s4.roundRank = 2; s4.phase = "play"; s4.pile = []; s4.lastPlay = null;
  s4 = E.applyPlay(s4, 0, ["2H"], 2).state;
  ok(s4.status === "over" && s4.lossReason === "aces" && s4.loser === 0, "vier Asse = Niederlage");

  // Aufsteigend wickelt um
  let s5 = E.newGame({ players: [{ name: "A" }, { name: "B" }], variant: "asc" });
  s5.players[0].hand = [{ rank: "K", suit: "H", id: "KH" }, { rank: "2", suit: "S", id: "2S" }];
  s5.turn = 0; s5.currentRank = 11; s5.phase = "play"; s5.pile = []; s5.lastPlay = null;
  s5 = E.applyPlay(s5, 0, ["KH"], 11).state;
  ok(s5.currentRank === 0, "Aufsteigend: K -> 2 (Umlauf)");

  ok(E.legalPlay(s, 2, ["5H"], 0).ok === false, "illegaler Zug wird abgelehnt");
}

// --------------------------------------------------------------- 2) Server-E2E
function makeClient(url, name) {
  const c = { name, ws: null, code: null, you: null, state: null, events: [], sec: [] };
  c.ready = new Promise((res) => {
    c.ws = new WS(url);
    c.ws.on("open", res);
    c.ws.on("message", (d) => {
      const m = JSON.parse(d.toString());
      if (m.t === "joined") { c.code = m.code; c.you = m.you; }
      if (m.t === "event") c.events.push(m);
      if (m.t === "state") {
        c.state = m.room;
        const r = m.room;
        if (r.players) r.players.forEach((p) => { if (p.index !== r.you.index && p.hand) c.sec.push("Fremde Hand sichtbar"); });
        if (r.pile) c.sec.push("Roher Stapel sichtbar");
        if (r.lastPlay && r.lastPlay.cards) c.sec.push("Verdeckte Karten sichtbar");
        c.act();
      }
    });
  });
  c.send = (o) => c.ws.send(JSON.stringify(o));
  c.act = () => {
    const r = c.state; if (!r || r.status !== "playing" || !r.yourTurn) return;
    if (r.canChallenge && Math.random() < 0.05) { c.send({ t: "challenge" }); return; }
    const hand = r.hand;
    let reqIdx = r.variant === "asc" ? r.currentRank : (r.roundRank != null ? r.roundRank : E.bestRankIdx(hand));
    const req = E.RANKS[reqIdx];
    const honest = hand.filter((x) => x.rank === req);
    const card = honest.length ? honest[0] : hand.slice().sort((a, b) => E.rankIdx(a.rank) - E.rankIdx(b.rank))[0];
    if (card) setTimeout(() => { if (c.state && c.state.yourTurn) c.send({ t: "play", cardIds: [card.id], rank: reqIdx }); }, 50);
  };
  return c;
}

async function serverTests() {
  console.log("Server-End-to-End-Tests…");
  const PORT = 3941;
  // Schnelle Timer, damit eine ganze Partie in wenigen Sekunden durchläuft (Standard wäre 1,6–2 s).
  const fastTimers = { LUEGEN_BOT_MS: "120", LUEGEN_REVEAL_MS: "200", LUEGEN_PICKUP_MS: "160", LUEGEN_DISC_MS: "400" };
  const srv = spawn("node", ["server.js"], { cwd: path.join(__dirname, ".."), env: Object.assign({}, process.env, { PORT: String(PORT) }, fastTimers) });
  let srvErr = "";
  srv.stderr.on("data", (d) => { srvErr += d.toString(); });
  await wait(800);
  const url = "ws://127.0.0.1:" + PORT;

  const A = makeClient(url, "Alice"), B = makeClient(url, "Bob"), C = makeClient(url, "Cara");
  await Promise.all([A.ready, B.ready, C.ready]);

  A.send({ t: "create", name: "Alice", variant: "same" });
  await wait(120);
  ok(A.code && A.code.length === 4, "Raum-Code erstellt");
  B.send({ t: "join", code: A.code, name: "Bob" });
  C.send({ t: "join", code: A.code, name: "Cara" });
  await wait(160);
  ok(A.state.players.length === 3, "3 Spieler in der Lobby");
  A.send({ t: "addBot" });
  await wait(120);
  ok(A.state.players.length === 4 && A.state.players[3].isBot, "Bot hinzugefügt");

  A.send({ t: "start" });
  await wait(160);
  ok(A.state.status === "playing", "Partie gestartet");
  ok(Array.isArray(A.state.hand) && A.state.hand.length > 0, "eigene Hand vorhanden");

  let waited = 0;
  while (A.state.status === "playing" && waited < 40000) { await wait(200); waited += 200; }
  ok(A.state.status === "over", "Partie zu Ende gespielt (in " + (waited / 1000) + "s)");
  ok(A.events.some((e) => e.kind === "gameover"), "Spielende-Ereignis gesendet");

  B.send({ t: "chat", text: "gg" });
  await wait(120);
  ok(A.state.chat.some((m) => m.text === "gg" && m.name === "Bob"), "Chat zugestellt");

  A.send({ t: "rematch" });
  await wait(220);
  ok(A.state.status === "playing", "Revanche gestartet");

  // Wiederverbindung
  const token = C.you.token, code = C.code;
  C.ws.close();
  await wait(380);
  ok(A.state.players[2].connected === false, "getrennter Spieler als offline markiert");
  const C2 = makeClient(url, "Cara2");
  await C2.ready;
  C2.send({ t: "rejoin", code, token });
  await wait(280);
  ok(C2.you && C2.you.index === 2, "Wiederverbindung auf denselben Sitz");
  ok(Array.isArray(C2.state.hand), "Hand nach Wiederverbindung sichtbar");

  const leaks = [].concat(A.sec, B.sec, C.sec, C2.sec);
  ok(leaks.length === 0, "keine Informationslecks (Redaktion) — " + leaks.length + " gefunden");

  srv.kill();
  if (srvErr.trim()) console.log("  [Server-stderr]\n" + srvErr.trim());
}

(async () => {
  engineTests();
  await serverTests();
  console.log("\nErgebnis: " + pass + " bestanden, " + fail + " fehlgeschlagen");
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
