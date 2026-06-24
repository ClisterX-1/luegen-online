/*
 * Lügen — reine Spiel-Engine (DOM-frei, ohne React).
 * Läuft identisch in Node (autoritativer Server) und im Browser (Offline-Modi).
 *
 * Regeln (Stand: Mehrspieler-Rangfolge):
 *  - Mind. 3 Spieler.
 *  - Wer seine letzte Karte legt, ist NICHT sofort Sieger: Der Zug ist erst
 *    "sicher", wenn die nächste Person darauflegt ODER ein Anzweifeln zeigt,
 *    dass ehrlich gespielt wurde. Wird die letzte Karte als Bluff entlarvt,
 *    nimmt die Person den Stapel und spielt weiter (pendingFinish).
 *  - Fertige Spieler bekommen Plätze in Reihenfolge (1., 2., 3., …).
 *  - Die Runde endet, sobald nur noch 2 Spieler Karten haben; diese letzten
 *    beiden werden nach verbleibenden Karten platziert (weniger = besser).
 *  - Wer alle vier Asse hält, scheidet sofort aus (ans Ende der Rangliste).
 *
 * Die Engine kennt keine Timer/kein Netzwerk: Sie nimmt einen Zustand entgegen
 * und gibt einen NEUEN Zustand + Ereignisse zurück. Den zeitlichen Ablauf
 * (Aufdecken -> Aufnehmen) steuert der Aufrufer (Server bzw. Client).
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.LuegenEngine = factory();
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  // ----------------------------------------------------------------- Konstanten
  var RANKS = ["2","3","4","5","6","7","8","9","10","J","Q","K","A"];
  var RANKLONG = {"2":"Zweien","3":"Dreien","4":"Vieren","5":"Fünfen","6":"Sechsen","7":"Siebenen","8":"Achten","9":"Neunen","10":"Zehnen","J":"Buben","Q":"Damen","K":"Königen","A":"Assen"};
  var SUITS = [
    { s:"H", sym:"♥", red:true },
    { s:"D", sym:"♦", red:true },
    { s:"C", sym:"♣", red:false },
    { s:"S", sym:"♠", red:false },
  ];
  var BOTNAMES = ["Lina","Max","Anna","Jonas","Mia","Paul","Emma","Tom","Nora","Finn","Lea","Ben"];
  var PALETTE = ["#cf7457","#3f93a8","#5a8c6e","#d9a441","#c98a86","#6f7fa6"];
  var MIN_PLAYERS = 3;

  // ------------------------------------------------------------------- Helfer
  function clone(o) {
    if (typeof structuredClone === "function") return structuredClone(o);
    return JSON.parse(JSON.stringify(o));
  }
  function rankIdx(r) { return RANKS.indexOf(r); }
  function suitOf(card) { for (var i=0;i<SUITS.length;i++) if (SUITS[i].s===card.suit) return SUITS[i]; return SUITS[0]; }
  function suitSym(card) { return suitOf(card).sym; }
  function cardInk(card) { return { color: suitOf(card).red ? "#c15a4c" : "#1f4f5e" }; }
  function rankLongIdx(i) { return RANKLONG[RANKS[i]]; }
  function claimLabel(count, ri) { return count + " × " + RANKLONG[RANKS[ri]]; }

  function buildDeck() {
    var d = [];
    for (var si=0; si<SUITS.length; si++)
      for (var ri=0; ri<RANKS.length; ri++)
        d.push({ rank: RANKS[ri], suit: SUITS[si].s, id: RANKS[ri] + SUITS[si].s });
    for (var i=d.length-1; i>0; i--) {
      var j = Math.floor(Math.random()*(i+1));
      var t=d[i]; d[i]=d[j]; d[j]=t;
    }
    return d;
  }
  function sortHand(hand) { hand.sort(function (a,b){ return rankIdx(a.rank)-rankIdx(b.rank); }); return hand; }

  // Vollständiger Vierersatz (außer Assen) ist totes Gewicht -> aus dem Spiel.
  function cleanFours(hand) {
    var drop = {};
    for (var i=0;i<RANKS.length;i++) {
      var r = RANKS[i];
      if (r === "A") continue;
      if (hand.filter(function (x){ return x.rank===r; }).length === 4) drop[r] = true;
    }
    return hand.filter(function (x){ return !drop[x.rank]; });
  }
  function hasAllAces(hand) { return hand.filter(function (c){ return c.rank==="A"; }).length === 4; }
  function bestRankIdx(hand) {
    var best=-1, bi=0;
    for (var i=0;i<RANKS.length;i++) {
      if (RANKS[i]==="A") continue;
      var c = hand.filter(function (x){ return x.rank===RANKS[i]; }).length;
      if (c > best) { best=c; bi=i; }
    }
    return bi;
  }
  function countRank(hand, ri) { var r=RANKS[ri]; return hand.filter(function (c){ return c.rank===r; }).length; }

  // Wendet cleanFours auf alle Spieler an (nach Austeilen / nach Aufnehmen).
  function cleanAllHands(players) {
    players.forEach(function (p){ p.hand = cleanFours(p.hand); });
  }

  // ----------------------------------------------------- Rangfolge-Hilfen
  function notOutCount(s) { var n=0; s.players.forEach(function (p){ if(!p.out) n++; }); return n; }
  function nextActive(s, from) {
    var n = s.players.length;
    for (var k=1;k<=n;k++) {
      var i=(from+k)%n;
      if (!s.players[i].out && s.players[i].hand.length>0) return i;
    }
    return -1;
  }
  function confirmFinish(s, p) {
    if (s.players[p].out) return;
    s.players[p].out = true;
    s.finishOrder.push(p);
    s.players[p].place = s.finishOrder.length; // vorläufig
  }
  function eliminateAces(s, p) {
    if (s.players[p].out) return;
    s.players[p].out = true;
    s.eliminated.push(p);
  }
  // Nach Aufnehmen/Austeilen: prüft je nicht-ausgeschiedenem Spieler Asse/leere Hand.
  function terminalScan(s) {
    for (var i=0;i<s.players.length;i++) {
      var p = s.players[i];
      if (p.out) continue;
      if (hasAllAces(p.hand)) eliminateAces(s, i);
      else if (p.hand.length === 0) confirmFinish(s, i);
    }
  }
  // Endet die Runde? (nur noch <=2 nicht-ausgeschiedene Spieler) -> Endabrechnung.
  function checkEnd(s) {
    if (notOutCount(s) <= 2) { finalizeStandings(s); return true; }
    return false;
  }
  function finalizeStandings(s) {
    var order = [];
    s.finishOrder.forEach(function (p){ order.push({ player:p, reason:"finished" }); });
    var remaining = [];
    s.players.forEach(function (p,i){ if(!p.out) remaining.push(i); });
    remaining.sort(function (a,b){
      var d = s.players[a].hand.length - s.players[b].hand.length; // weniger Karten = besser
      return d !== 0 ? d : a-b;
    });
    remaining.forEach(function (p){ order.push({ player:p, reason:"remaining" }); });
    s.eliminated.forEach(function (p){ order.push({ player:p, reason:"aces" }); });
    order.forEach(function (o,i){ o.place=i+1; s.players[o.player].out=true; s.players[o.player].place=i+1; });
    s.standings = order;
    s.status = "over";
    s.phase = "play";
    s.pile = []; s.lastPlay = null; s.reveal = null; s.pickup = null; s.pendingFinish = null;
    s.winner = order.length ? order[0].player : null;
  }

  // ----------------------------------------------------------- Spiel anlegen
  function newGame(opts) {
    var n = opts.players.length;
    var variant = opts.variant === "asc" ? "asc" : "same";
    var deck = buildDeck();
    var players = opts.players.map(function (p, i) {
      return { name:p.name, color:p.color||PALETTE[i%PALETTE.length], isBot:!!p.isBot, hand:[], out:false, place:null };
    });
    deck.forEach(function (c, i){ players[i % n].hand.push(c); });
    players.forEach(function (p){ sortHand(p.hand); });
    cleanAllHands(players);

    var state = {
      variant: variant, players: players, pile: [], lastPlay: null,
      currentRank: 0, roundRank: null, turn: 0, phase: "play",
      reveal: null, pickup: null,
      finishOrder: [], eliminated: [], pendingFinish: null, standings: null,
      winner: null, status: "playing", round: 1,
    };
    terminalScan(state);                 // sehr selten: jemand hält schon 4 Asse
    if (!checkEnd(state)) {
      if (state.players[0].out || state.players[0].hand.length === 0) state.turn = nextActive(state, 0);
    }
    return state;
  }

  // ------------------------------------------------------------- Validierung
  function legalPlay(state, playerIdx, cardIds) {
    if (state.status !== "playing") return { ok:false, error:"Spiel ist vorbei." };
    if (state.phase !== "play") return { ok:false, error:"Gerade nicht am Zug." };
    if (playerIdx !== state.turn) return { ok:false, error:"Du bist nicht am Zug." };
    var pl = state.players[playerIdx];
    if (!pl || pl.out) return { ok:false, error:"Du bist nicht mehr im Spiel." };
    if (!Array.isArray(cardIds) || cardIds.length === 0) return { ok:false, error:"Wähle mindestens eine Karte." };
    if (cardIds.length > 4) return { ok:false, error:"Höchstens vier Karten." };
    var hand = pl.hand, ids = {};
    for (var i=0;i<cardIds.length;i++) {
      var id = cardIds[i];
      if (ids[id]) return { ok:false, error:"Doppelte Karte." };
      ids[id] = true;
      if (!hand.some(function (c){ return c.id===id; })) return { ok:false, error:"Karte nicht in der Hand." };
    }
    return { ok:true };
  }
  function resolveClaimRank(state, chosenRank) {
    if (state.variant === "asc") return state.currentRank;
    if (state.roundRank != null) return state.roundRank;
    var r = chosenRank | 0; if (r<0) r=0; if (r>11) r=11; return r;
  }
  function legalChallenge(state, byIdx) {
    if (state.status !== "playing") return { ok:false, error:"Spiel ist vorbei." };
    if (state.phase !== "play") return { ok:false, error:"Gerade kein offener Spielzug." };
    if (!state.lastPlay) return { ok:false, error:"Noch nichts angesagt." };
    if (state.players[byIdx] && state.players[byIdx].out) return { ok:false, error:"Du bist nicht mehr im Spiel." };
    if (byIdx === state.lastPlay.player) return { ok:false, error:"Eigene Ansage kann man nicht anzweifeln." };
    return { ok:true };
  }

  // ------------------------------------------------------------- Spielzug
  function applyPlay(state, playerIdx, cardIds, chosenRank) {
    var s = clone(state);
    var claimRank = resolveClaimRank(s, chosenRank);
    var idset = {}; cardIds.forEach(function (id){ idset[id]=true; });
    var player = s.players[playerIdx];
    var played = player.hand.filter(function (c){ return idset[c.id]; });
    player.hand = player.hand.filter(function (c){ return !idset[c.id]; });
    s.pile = s.pile.concat(played);
    s.lastPlay = { player: playerIdx, cards: played, rank: claimRank, count: played.length };
    var events = [{ kind:"play", player: playerIdx, count: played.length, rank: claimRank }];

    // Eine vorherige "letzte Karte" eines ANDEREN Spielers wird durch dieses
    // Darauflegen begraben -> jetzt sicher fertig.
    if (s.pendingFinish != null && s.pendingFinish !== playerIdx) {
      var fp = s.pendingFinish;
      confirmFinish(s, fp);
      events.push({ kind:"finished", player: fp, place: s.players[fp].place });
      s.pendingFinish = null;
    }

    // Ausgang für den aktuellen Spieler
    if (hasAllAces(player.hand)) {
      eliminateAces(s, playerIdx);
      events.push({ kind:"aces", player: playerIdx });
    } else if (player.hand.length === 0) {
      s.pendingFinish = playerIdx;               // vorläufig fertig — muss noch bestätigt werden
      events.push({ kind:"pending", player: playerIdx });
    }

    if (s.variant === "asc") s.currentRank = (claimRank + 1) % 12;
    else s.roundRank = claimRank;

    if (checkEnd(s)) { events.push({ kind:"over" }); return { state:s, events:events }; }

    s.turn = nextActive(s, playerIdx);
    s.phase = "play";
    return { state:s, events:events };
  }

  // Zweifelt die letzte Ansage an -> Aufdeck-Phase. Aufnehmen folgt in resolveReveal().
  function applyChallenge(state, byIdx) {
    var s = clone(state);
    var lp = s.lastPlay;
    var req = RANKS[lp.rank];
    var honest = lp.cards.every(function (c){ return c.rank === req; });
    var loser = honest ? byIdx : lp.player;
    var winner = honest ? lp.player : byIdx;
    s.phase = "reveal";
    s.reveal = {
      cards: lp.cards, honest: honest, loser: loser, winner: winner, rank: lp.rank,
      by: byIdx, claimer: lp.player, claimerPending: (s.pendingFinish === lp.player),
    };
    return { state:s, events:[{ kind:"challenge", by: byIdx, claimer: lp.player }, { kind:"reveal", honest: honest, loser: loser }] };
  }

  // Nach der Aufdeck-Animation: Verlierer nimmt den Stapel, Regeln anwenden.
  function resolveReveal(state) {
    var s = clone(state);
    var rv = s.reveal;
    var loser = rv.loser, winner = rv.winner, honest = rv.honest, claimer = rv.claimer;
    var pileCards = s.pile.slice();
    s.players[loser].hand = s.players[loser].hand.concat(pileCards);
    sortHand(s.players[loser].hand);

    if (rv.claimerPending) {
      if (honest) confirmFinish(s, claimer); // letzte Karte war ehrlich -> sicher fertig
      s.pendingFinish = null;                // bei Bluff hat claimer (=loser) den Stapel -> wieder im Spiel
    }

    cleanAllHands(s.players);
    terminalScan(s);                          // Asse / durch cleanFours geleerte Hände

    s.pile = []; s.lastPlay = null; s.currentRank = 0; s.roundRank = null; s.reveal = null;
    s.round = (s.round || 1) + 1;

    if (checkEnd(s)) return { state:s, hadPickup:false };

    var lead = winner;
    if (s.players[lead].out || s.players[lead].hand.length === 0) lead = nextActive(s, winner);
    if (lead < 0) lead = nextActive(s, loser);
    s.turn = lead;

    if (pileCards.length > 0 && !s.players[loser].out) {
      s.phase = "pickup";
      s.pickup = { cards: pileCards.slice().sort(function (a,b){ return rankIdx(a.rank)-rankIdx(b.rank); }), player: loser };
      return { state:s, hadPickup:true, pickupPlayer: loser };
    }
    s.phase = "play"; s.pickup = null;
    return { state:s, hadPickup:false };
  }

  function endPickup(state) {
    var s = clone(state);
    s.phase = "play"; s.pickup = null;
    return s;
  }

  // --------------------------------------------------------------- Bot-Logik
  function botDecide(state) {
    var me = state.turn;
    var hand = state.players[me].hand;
    var lp = state.lastPlay;
    if (lp && lp.player !== me) {
      var have = countRank(hand, lp.rank);
      var impossible = have + lp.count > 4;
      var pCh = impossible ? 0.97 : Math.min(0.55, 0.07*lp.count + (lp.count>=3 ? 0.18 : 0.02));
      if (hand.length <= 2) pCh += 0.1;
      // letzte Karte des Vorgängers? Etwas eher anzweifeln (sonst ist sie sicher).
      if (state.pendingFinish === lp.player) pCh = Math.max(pCh, impossible ? 0.97 : 0.5);
      if (Math.random() < pCh) return { action:"challenge" };
    }
    var reqIdx = state.variant === "asc" ? state.currentRank
      : (state.roundRank != null ? state.roundRank : bestRankIdx(hand));
    var req = RANKS[reqIdx];
    var honest = hand.filter(function (c){ return c.rank===req; });
    var toPlay;
    if (honest.length > 0) { var k=1+Math.floor(Math.random()*honest.length); toPlay=honest.slice(0,k); }
    else {
      var sorted = hand.slice().sort(function (a,b){ return rankIdx(a.rank)-rankIdx(b.rank); });
      var k2 = Math.random() < 0.6 ? 1 : 2; toPlay = sorted.slice(0, Math.min(k2, hand.length));
    }
    return { action:"play", cardIds: toPlay.map(function (c){ return c.id; }), rank: reqIdx };
  }
  function canProveImpossible(state, idx) {
    var lp = state.lastPlay;
    if (!lp || lp.player === idx || state.players[idx].out) return false;
    return countRank(state.players[idx].hand, lp.rank) + lp.count > 4;
  }

  return {
    RANKS:RANKS, RANKLONG:RANKLONG, SUITS:SUITS, BOTNAMES:BOTNAMES, PALETTE:PALETTE, MIN_PLAYERS:MIN_PLAYERS,
    clone:clone, rankIdx:rankIdx, suitSym:suitSym, cardInk:cardInk, rankLongIdx:rankLongIdx, claimLabel:claimLabel,
    buildDeck:buildDeck, cleanFours:cleanFours, hasAllAces:hasAllAces, bestRankIdx:bestRankIdx, countRank:countRank,
    newGame:newGame,
    legalPlay:legalPlay, resolveClaimRank:resolveClaimRank, applyPlay:applyPlay,
    legalChallenge:legalChallenge, applyChallenge:applyChallenge,
    resolveReveal:resolveReveal, endPickup:endPickup,
    botDecide:botDecide, canProveImpossible:canProveImpossible,
    notOutCount:notOutCount, nextActive:nextActive,
  };
});
