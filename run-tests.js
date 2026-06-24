/*
 * Testlauf: `npm test`
 *   1) Engine-Regeln inkl. Rangfolge (letzte Karte bestätigen/zurücknehmen,
 *      Mehrspieler-Plätze, Ende bei 2 übrig, Asse).
 *   2) Server-End-to-End: 4 echte WebSocket-Spieler bis zum Rundenende,
 *      Mindestens 3, Statistik, verdecktes Aufnehmen (Redaktion).
 * Nutzt nur mitgelieferte Abhängigkeiten (engine.js, ws, server.js).
 */
"use strict";
const path = require("path");
const { spawn } = require("child_process");
const WS = require("ws");
const E = require(path.join(__dirname, "engine.js"));

let pass = 0, fail = 0;
function ok(c, m) { if (c) pass++; else { fail++; console.log("  ✗ FAIL: " + m); } }
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
function card(id) { return { rank: id.replace(/[HDCS]$/, ""), suit: id.slice(-1), id }; }
function mk(hands, o) {
  o = o || {};
  return {
    variant: o.variant || "same",
    players: hands.map((h, i) => ({ name: "P" + i, color: "#000", isBot: false, hand: h.map(card), out: false, place: null })),
    pile: (o.pile || []).map(card), lastPlay: o.lastPlay || null, currentRank: o.currentRank || 0,
    roundRank: (o.roundRank != null ? o.roundRank : null), turn: o.turn || 0, phase: "play", reveal: null, pickup: null,
    finishOrder: [], eliminated: [], pendingFinish: (o.pendingFinish != null ? o.pendingFinish : null),
    standings: null, winner: null, status: "playing", round: 1,
  };
}

// --------------------------------------------------------------- 1) Engine
function engineTests() {
  console.log("Engine-Tests (Rangfolge)…");
  const d = E.buildDeck();
  ok(d.length === 52 && new Set(d.map((c) => c.id)).size === 52, "Deck vollständig & eindeutig");

  // letzte Karte -> pendingFinish, kein Sofort-Sieg
  let s = mk([["5H"], ["2C", "3C"], ["4C", "6C"]], { roundRank: null });
  s = E.applyPlay(s, 0, ["5H"], 3).state;
  ok(s.pendingFinish === 0 && s.players[0].out === false && s.status === "playing", "letzte Karte: vorläufig fertig, kein Sofort-Sieg");
  // Darauflegen bestätigt + Ende bei 2 übrig (3 Spieler)
  s = E.applyPlay(s, 1, ["2C"], 3).state;
  ok(s.players[0].out === true && s.status === "over", "Darauflegen bestätigt; 3 Spieler -> Ende bei 2 übrig");
  ok(s.standings[0].player === 0 && s.standings[0].place === 1, "1. Platz korrekt");
  ok(s.standings[1].player === 1 && s.standings[2].player === 2, "letzte 2 nach Restkarten platziert");

  // Anzweifeln ehrlich auf letzte Karte -> sicher fertig (4 Spieler, läuft weiter)
  let s3 = mk([["5H"], ["2C", "3C"], ["4C", "6C"], ["7D", "8D"]], { roundRank: null });
  s3 = E.applyPlay(s3, 0, ["5H"], 3).state;
  let c3 = E.applyChallenge(s3, 2).state;
  ok(c3.reveal.honest && c3.reveal.claimerPending, "Anzweifeln: ehrlich + claimerPending");
  let r3 = E.resolveReveal(c3).state;
  ok(r3.players[0].out && r3.players[0].place === 1 && r3.status === "playing", "ehrlich angezweifelt -> sicher 1., Spiel läuft");
  ok(r3.players[2].hand.some((c) => c.id === "5H"), "Anzweifler nimmt den Stapel");

  // Anzweifeln Bluff auf letzte Karte -> nimmt Stapel, bleibt im Spiel
  let s4 = mk([["7H"], ["2C", "3C"], ["4C", "6C"], ["8D", "9D"]], { roundRank: null });
  s4 = E.applyPlay(s4, 0, ["7H"], 3).state;       // sagt '5', legt 7 -> Bluff
  let r4 = E.resolveReveal(E.applyChallenge(s4, 1).state).state;
  ok(!r4.players[0].out && r4.players[0].hand.some((c) => c.id === "7H") && r4.pendingFinish === null, "Bluff auf letzte Karte: nimmt Stapel, weiter");

  // 4 Spieler: zwei Finisher, volle Rangfolge, Ende bei 2 übrig
  let s5 = mk([["5H"], ["2C", "3C", "7S"], ["4C"], ["6D", "8D", "9D"]], { roundRank: null });
  s5 = E.applyPlay(s5, 0, ["5H"], 3).state;
  s5 = E.applyPlay(s5, 1, ["2C"], 3).state;       // bestätigt A=1.
  s5 = E.applyPlay(s5, 2, ["4C"], 3).state;       // C letzte Karte -> pending
  s5 = E.applyPlay(s5, 3, ["6D"], 3).state;       // bestätigt C=2.; Ende
  ok(s5.status === "over" && s5.standings[0].player === 0 && s5.standings[1].player === 2, "4 Spieler: A=1., C=2.");
  ok(s5.standings.length === 4 && s5.standings[3].place === 4, "alle vier platziert");

  // Asse: sofortige Elimination ans Ende
  let s6 = mk([["AH", "AD", "AC", "AS", "2H"], ["3C", "4C"], ["5C", "6C"]], { roundRank: 2 });
  s6 = E.applyPlay(s6, 0, ["2H"], 2).state;
  ok(s6.players[0].out && s6.status === "over" && s6.standings[s6.standings.length - 1].player === 0, "4 Asse -> letzter Platz");

  // Mindestspielerzahl
  ok(E.MIN_PLAYERS === 3, "Mindestspielerzahl = 3");
  // ausgeschiedene dürfen nicht handeln
  let s7 = mk([["5H", "9H"], ["2C", "3C"], ["4C", "6C"]]); s7.players[0].out = true;
  ok(E.legalPlay(s7, 0, ["5H"]).ok === false, "ausgeschieden: kein Zug");
}

// --------------------------------------------------------------- 2) Server-E2E
function makeClient(url) {
  const c = { ws: null, you: null, state: null, events: [], leak: [], standings: null };
  c.ready = new Promise((res) => {
    c.ws = new WS(url);
    c.ws.on("open", res);
    c.ws.on("message", (d) => {
      const m = JSON.parse(d.toString());
      if (m.t === "joined") c.you = m.you;
      if (m.t === "event") c.events.push(m);
      if (m.t === "state") {
        c.state = m.room; const r = m.room;
        if (r.players) r.players.forEach((p) => { if (p.index !== r.you.index && p.hand) c.leak.push("hand"); });
        if (r.pile) c.leak.push("pile");
        if (r.lastPlay && r.lastPlay.cards) c.leak.push("lastPlayCards");
        if (r.pickup && r.pickup.player !== r.you.index && r.pickup.cards != null) c.leak.push("pickupCards");
        if (r.status === "over" && r.standings) c.standings = r.standings;
        c.act();
      }
    });
  });
  c.send = (o) => c.ws.send(JSON.stringify(o));
  c.act = () => {
    const r = c.state; if (!r || r.status !== "playing" || !r.yourTurn) return;
    if (r.canChallenge && Math.random() < 0.06) { c.send({ t: "challenge" }); return; }
    const hand = r.hand;
    let ri = r.variant === "asc" ? r.currentRank : (r.roundRank != null ? r.roundRank : E.bestRankIdx(hand));
    const req = E.RANKS[ri]; const h = hand.filter((x) => x.rank === req);
    const cd = h.length ? h[0] : hand.slice().sort((a, b) => E.rankIdx(a.rank) - E.rankIdx(b.rank))[0];
    if (cd) setTimeout(() => { if (c.state && c.state.yourTurn) c.send({ t: "play", cardIds: [cd.id], rank: ri }); }, 20);
  };
  return c;
}

async function serverTests() {
  console.log("Server-End-to-End-Tests…");
  const PORT = 3941;
  const fast = { LUEGEN_BOT_MS: "90", LUEGEN_BOT_JITTER: "0", LUEGEN_REVEAL_MS: "150", LUEGEN_PICKUP_MS: "120", LUEGEN_DISC_MS: "400" };
  const srv = spawn("node", ["server.js"], { cwd: __dirname, env: Object.assign({}, process.env, { PORT: String(PORT) }, fast) });
  let srvErr = ""; srv.stderr.on("data", (d) => { srvErr += d.toString(); });
  await wait(800);
  const url = "ws://127.0.0.1:" + PORT;

  const A = makeClient(url), B = makeClient(url), C = makeClient(url), D = makeClient(url);
  await Promise.all([A.ready, B.ready, C.ready, D.ready]);

  A.send({ t: "create", name: "Alice", variant: "same" }); await wait(120);
  B.send({ t: "join", code: A.state.code, name: "Bob" }); await wait(120);
  ok(A.state.players.length === 2 && A.state.canStart === false, "mit 2 Spielern: canStart=false (Mindestens 3)");
  A.send({ t: "start" }); await wait(100);
  ok(A.state.status === "lobby", "Start mit 2 abgelehnt");
  C.send({ t: "join", code: A.state.code, name: "Cara" });
  D.send({ t: "join", code: A.state.code, name: "Dora" }); await wait(160);
  ok(A.state.players.length === 4 && A.state.canStart, "4 Spieler, canStart=true");
  A.send({ t: "start" }); await wait(140);
  ok(A.state.status === "playing", "Partie gestartet");

  let w = 0; while (A.state.status === "playing" && w < 30000) { await wait(150); w += 150; }
  ok(A.state.status === "over", "Runde zu Ende (" + (w / 1000) + "s)");
  ok(A.standings && A.standings.length === 4 && A.standings.map((s) => s.place).sort().join() === "1,2,3,4", "standings: Plätze 1..4");

  const stats = A.state.stats;
  ok(Array.isArray(stats) && stats.length === 4 && stats.reduce((s, x) => s + x.p1, 0) === 1, "Statistik: genau ein 1. Platz");

  const leaks = [].concat(A.leak, B.leak, C.leak, D.leak);
  ok(leaks.length === 0, "keine Lecks inkl. verdecktem Aufnehmen — " + [...new Set(leaks)].join(","));

  A.send({ t: "rematch" }); await wait(140);
  let w2 = 0; while (A.state.status === "playing" && w2 < 30000) { await wait(150); w2 += 150; }
  ok(A.state.stats.every((x) => x.games === 2), "Revanche kumuliert Statistik (2 Spiele)");

  srv.kill();
  if (srvErr.trim()) console.log("  [Server-stderr]\n" + srvErr.trim().slice(0, 400));
}

(async () => {
  engineTests();
  await serverTests();
  console.log("\nErgebnis: " + pass + " bestanden, " + fail + " fehlgeschlagen");
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
