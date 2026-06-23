/*
 * Lügen — reine Spiel-Engine (DOM-frei, ohne React).
 * Läuft identisch in Node (autoritativer Server) und im Browser (Offline-Modi).
 *
 * Die Engine kennt KEINE Timer und KEIN Netzwerk. Sie nimmt einen Zustand
 * entgegen und gibt einen NEUEN Zustand + Ereignisse zurück. Den zeitlichen
 * Ablauf (Aufdecken -> Aufnehmen) steuert der Aufrufer (Server bzw. Client).
 *
 * Portiert aus dem ursprünglichen Claude-Design-Entwurf (Lügen-published.html).
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

  function sortHand(hand) {
    hand.sort(function (a,b) { return rankIdx(a.rank) - rankIdx(b.rank); });
    return hand;
  }

  // Ein vollständiger Vierersatz (außer Assen) ist totes Gewicht -> aus dem Spiel.
  function cleanFours(hand) {
    var drop = {};
    for (var i=0;i<RANKS.length;i++) {
      var r = RANKS[i];
      if (r === "A") continue;
      var c = hand.filter(function (x){ return x.rank===r; }).length;
      if (c === 4) drop[r] = true;
    }
    return hand.filter(function (x){ return !drop[x.rank]; });
  }
  function hasAllAces(hand) { return hand.filter(function (c){ return c.rank==="A"; }).length === 4; }

  // Wendet Hand-Regeln auf ALLE Spieler an (nach Austeilen / nach Aufnehmen).
  function applyHandRules(players) {
    var np = players.map(function (p){ var q = clone(p); q.hand = cleanFours(q.hand.slice()); return q; });
    var aceLoser = null, emptyWinner = null;
    for (var i=0;i<np.length;i++) if (aceLoser===null && hasAllAces(np[i].hand)) aceLoser = i;
    for (var k=0;k<np.length;k++) if (emptyWinner===null && np[k].hand.length===0) emptyWinner = k;
    return { players: np, aceLoser: aceLoser, emptyWinner: emptyWinner };
  }

  function bestRankIdx(hand) {
    var best=-1, bi=0;
    for (var i=0;i<RANKS.length;i++) {
      if (RANKS[i]==="A") continue;
      var c = hand.filter(function (x){ return x.rank===RANKS[i]; }).length;
      if (c > best) { best=c; bi=i; }
    }
    return bi;
  }
  function countRank(hand, ri) {
    var r = RANKS[ri];
    return hand.filter(function (c){ return c.rank===r; }).length;
  }

  // ----------------------------------------------------------- Spiel anlegen
  // opts: { players:[{name,color,isBot}], variant:'same'|'asc' }
  function newGame(opts) {
    var n = opts.players.length;
    var variant = opts.variant === "asc" ? "asc" : "same";
    var deck = buildDeck();
    var players = opts.players.map(function (p, i) {
      return { name: p.name, color: p.color || PALETTE[i % PALETTE.length], isBot: !!p.isBot, hand: [] };
    });
    deck.forEach(function (c, i){ players[i % n].hand.push(c); });
    players.forEach(function (p){ sortHand(p.hand); });

    var r = applyHandRules(players);
    var state = {
      variant: variant,
      players: r.players,
      pile: [],
      lastPlay: null,
      currentRank: 0,   // für 'asc'
      roundRank: null,  // für 'same'
      turn: 0,
      phase: "play",    // 'play' | 'reveal' | 'pickup'
      reveal: null,
      pickup: null,
      winner: null,
      loser: null,
      lossReason: null,
      status: "playing",
      round: 1,
    };
    if (r.aceLoser !== null) { state.status="over"; state.loser=r.aceLoser; state.lossReason="aces"; }
    return state;
  }

  // ------------------------------------------------------------- Validierung
  function legalPlay(state, playerIdx, cardIds, chosenRank) {
    if (state.status !== "playing") return { ok:false, error:"Spiel ist vorbei." };
    if (state.phase !== "play") return { ok:false, error:"Gerade nicht am Zug." };
    if (playerIdx !== state.turn) return { ok:false, error:"Du bist nicht am Zug." };
    if (!Array.isArray(cardIds) || cardIds.length === 0) return { ok:false, error:"Wähle mindestens eine Karte." };
    var hand = state.players[playerIdx].hand;
    var ids = {};
    for (var i=0;i<cardIds.length;i++) {
      var id = cardIds[i];
      if (ids[id]) return { ok:false, error:"Doppelte Karte." };
      ids[id] = true;
      if (!hand.some(function (c){ return c.id===id; })) return { ok:false, error:"Karte nicht in der Hand." };
    }
    if (cardIds.length > 4) return { ok:false, error:"Höchstens vier Karten." };
    return { ok:true };
  }

  function resolveClaimRank(state, chosenRank) {
    if (state.variant === "asc") return state.currentRank;
    if (state.roundRank != null) return state.roundRank;
    // Freie Wahl der ersten Ansage einer Runde (Asse ausgeschlossen -> 0..11).
    var r = chosenRank | 0;
    if (r < 0) r = 0;
    if (r > 11) r = 11;
    return r;
  }

  // Spielt Karten verdeckt + sagt eine Zahl an. Gibt {state, events} zurück.
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

    if (hasAllAces(player.hand)) {
      s.status="over"; s.loser=playerIdx; s.lossReason="aces";
      events.push({ kind:"lose", player: playerIdx, reason:"aces" });
      return { state:s, events:events };
    }
    if (player.hand.length === 0) {
      s.status="over"; s.winner=playerIdx;
      events.push({ kind:"win", player: playerIdx });
      return { state:s, events:events };
    }
    var n = s.players.length;
    if (s.variant === "asc") s.currentRank = (claimRank + 1) % 12;
    else s.roundRank = claimRank;
    s.turn = (playerIdx + 1) % n;
    s.phase = "play";
    return { state:s, events:events };
  }

  function legalChallenge(state, byIdx) {
    if (state.status !== "playing") return { ok:false, error:"Spiel ist vorbei." };
    if (state.phase !== "play") return { ok:false, error:"Gerade kein offener Spielzug." };
    if (!state.lastPlay) return { ok:false, error:"Noch nichts angesagt." };
    if (byIdx === state.lastPlay.player) return { ok:false, error:"Eigene Ansage kann man nicht anzweifeln." };
    return { ok:true };
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
    s.reveal = { cards: lp.cards, honest: honest, loser: loser, winner: winner, rank: lp.rank, by: byIdx, claimer: lp.player };
    var events = [{ kind:"challenge", by: byIdx, claimer: lp.player }, { kind:"reveal", honest: honest, loser: loser }];
    return { state:s, events:events };
  }

  // Nach der Aufdeck-Animation: Verlierer nimmt den Stapel, Regeln anwenden.
  // Gibt {state, hadPickup, pickupPlayer} zurück. Bei hadPickup ruft der Aufrufer
  // nach kurzer Pause endPickup() auf.
  function resolveReveal(state) {
    var s = clone(state);
    var rv = s.reveal;
    var loser = rv.loser, winner = rv.winner;
    var players = s.players.map(function (p){ var q=clone(p); return q; });
    var pileCards = s.pile.slice();
    players[loser].hand = players[loser].hand.concat(pileCards);
    sortHand(players[loser].hand);
    var r = applyHandRules(players);
    s.players = r.players;
    s.pile = [];
    s.lastPlay = null;
    s.currentRank = 0;
    s.roundRank = null;
    s.reveal = null;
    s.round = (s.round || 1) + 1;

    if (r.aceLoser !== null) {
      s.status="over"; s.loser=r.aceLoser; s.lossReason="aces"; s.phase="play";
      return { state:s, hadPickup:false };
    }
    if (r.emptyWinner !== null) {
      s.status="over"; s.winner=r.emptyWinner; s.phase="play";
      return { state:s, hadPickup:false };
    }
    s.turn = winner;
    if (pileCards.length > 0) {
      s.phase = "pickup";
      s.pickup = { cards: pileCards.slice().sort(function (a,b){ return rankIdx(a.rank)-rankIdx(b.rank); }), player: loser };
      return { state:s, hadPickup:true, pickupPlayer: loser };
    }
    s.phase = "play";
    s.pickup = null;
    return { state:s, hadPickup:false };
  }

  function endPickup(state) {
    var s = clone(state);
    s.phase = "play";
    s.pickup = null;
    return s;
  }

  // --------------------------------------------------------------- Bot-Logik
  // Entscheidung des Bots, der gerade am Zug ist.
  // -> { action:'challenge' } ODER { action:'play', cardIds, rank }
  function botDecide(state) {
    var me = state.turn;
    var hand = state.players[me].hand;
    var lp = state.lastPlay;
    if (lp && lp.player !== me) {
      var have = countRank(hand, lp.rank);
      var impossible = have + lp.count > 4;
      var pCh = impossible ? 0.97 : Math.min(0.55, 0.07*lp.count + (lp.count>=3 ? 0.18 : 0.02));
      if (hand.length <= 2) pCh += 0.1;
      if (Math.random() < pCh) return { action:"challenge" };
    }
    var reqIdx = state.variant === "asc"
      ? state.currentRank
      : (state.roundRank != null ? state.roundRank : bestRankIdx(hand));
    var req = RANKS[reqIdx];
    var honest = hand.filter(function (c){ return c.rank===req; });
    var toPlay;
    if (honest.length > 0) {
      var k = 1 + Math.floor(Math.random()*honest.length);
      toPlay = honest.slice(0, k);
    } else {
      var sorted = hand.slice().sort(function (a,b){ return rankIdx(a.rank)-rankIdx(b.rank); });
      var k2 = Math.random() < 0.6 ? 1 : 2;
      toPlay = sorted.slice(0, Math.min(k2, hand.length));
    }
    return { action:"play", cardIds: toPlay.map(function (c){ return c.id; }), rank: reqIdx };
  }

  // Darf ein (zugfremder) Spieler die letzte Ansage als unmöglich entlarven?
  function canProveImpossible(state, idx) {
    var lp = state.lastPlay;
    if (!lp || lp.player === idx) return false;
    return countRank(state.players[idx].hand, lp.rank) + lp.count > 4;
  }

  // --------------------------------------------------------------- Anzeige-Helfer
  function publicCounts(state) {
    return state.players.map(function (p){ return p.hand.length; });
  }

  return {
    RANKS: RANKS, RANKLONG: RANKLONG, SUITS: SUITS, BOTNAMES: BOTNAMES, PALETTE: PALETTE,
    clone: clone,
    rankIdx: rankIdx, suitSym: suitSym, cardInk: cardInk, rankLongIdx: rankLongIdx, claimLabel: claimLabel,
    buildDeck: buildDeck, cleanFours: cleanFours, hasAllAces: hasAllAces, applyHandRules: applyHandRules,
    bestRankIdx: bestRankIdx, countRank: countRank,
    newGame: newGame,
    legalPlay: legalPlay, resolveClaimRank: resolveClaimRank, applyPlay: applyPlay,
    legalChallenge: legalChallenge, applyChallenge: applyChallenge,
    resolveReveal: resolveReveal, endPickup: endPickup,
    botDecide: botDecide, canProveImpossible: canProveImpossible,
    publicCounts: publicCounts,
  };
});
