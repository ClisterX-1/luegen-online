/*
 * Lügen — Client. Behält das Design des Original-Entwurfs bei und ergänzt:
 *   - Online-Multiplayer (Räume per Code, Echtzeit über WebSocket, Wiederverbindung)
 *   - Chat, Revanche, Soundeffekte
 *   - Offline-Modi "Gegen Bots" und "Pass & Play" (gleiche Engine lokal)
 */
(function () {
  "use strict";
  var E = window.LuegenEngine;
  var RANKS = E.RANKS, RANKLONG = E.RANKLONG;

  var REVEAL_MS = 1900, PICKUP_MS = 2000, BOT_MS = 1600;

  var THEMES = {
    "Ägäis":     { a:"#3f8fa6", b:"#246b82", edge:"#184f63", sky:"#bfe3e8", sun:"rgba(247,228,184,.32)" },
    "Santorini": { a:"#d98a6a", b:"#9c5a6e", edge:"#523a55", sky:"#f6d6c0", sun:"rgba(255,226,184,.34)" },
    "Strand":    { a:"#5bb0b0", b:"#2f8a90", edge:"#1f6b72", sky:"#d6f1ee", sun:"rgba(250,236,200,.36)" },
  };
  function bgCss(name) {
    var t = THEMES[name] || THEMES["Ägäis"];
    return "background:" + [
      "radial-gradient(135% 115% at 50% 34%, transparent 50%, rgba(0,0,0,.32) 100%)",
      "radial-gradient(circle at 80% 13%, rgba(255,250,232,.95) 0 1.5%, rgba(255,242,208,.55) 2.3% 4.3%, transparent 8.5%)",
      "radial-gradient(120% 52% at 80% 9%, " + t.sun + ", transparent 55%)",
      "repeating-linear-gradient(179deg, rgba(255,255,255,.045) 0 2px, transparent 2px 13px)",
      "linear-gradient(180deg, transparent 56%, rgba(233,208,166,.42) 76%, rgba(212,182,136,.7) 92%)",
      "linear-gradient(180deg, " + t.sky + " 0%, " + t.a + " 32%, " + t.b + " 64%, " + t.edge + " 100%)"
    ].join(",") + ";";
  }

  // ----------------------------------------------------------- DOM-Helfer
  function el(tag, attrs) {
    var node = document.createElement(tag);
    attrs = attrs || {};
    for (var k in attrs) {
      var v = attrs[k];
      if (v == null) continue;
      if (k === "style") node.setAttribute("style", v);
      else if (k === "class") node.className = v;
      else if (k === "html") node.innerHTML = v;
      else if (k === "text") node.textContent = v;
      else if (k === "value") node.value = v;
      else if (k === "disabled" || k === "checked") node[k] = !!v;
      else if (k.slice(0, 2) === "on" && typeof v === "function") node.addEventListener(k.slice(2), v);
      else node.setAttribute(k, v);
    }
    for (var i = 2; i < arguments.length; i++) append(node, arguments[i]);
    return node;
  }
  function append(node, c) {
    if (c == null || c === false) return;
    if (Array.isArray(c)) { c.forEach(function (x) { append(node, x); }); return; }
    if (typeof c === "string" || typeof c === "number") node.appendChild(document.createTextNode(String(c)));
    else node.appendChild(c);
  }
  function clear(n) { while (n.firstChild) n.removeChild(n.firstChild); }
  function $(id) { return document.getElementById(id); }

  // ----------------------------------------------------------- Sound
  var Sound = (function () {
    var ctx = null, enabled = (localStorage.getItem("luegen.sound") !== "0");
    function ac() { if (!ctx) { try { ctx = new (window.AudioContext || window.webkitAudioContext)(); } catch (e) { ctx = null; } } return ctx; }
    function unlock() { var c = ac(); if (c && c.state === "suspended") c.resume(); }
    function tone(freq, dur, type, gain, when) {
      var c = ac(); if (!c || !enabled) return;
      var t = c.currentTime + (when || 0);
      var o = c.createOscillator(), g = c.createGain();
      o.type = type || "sine"; o.frequency.value = freq;
      o.connect(g); g.connect(c.destination);
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(gain || 0.14, t + 0.012);
      g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
      o.start(t); o.stop(t + dur + 0.02);
    }
    return {
      unlock: unlock,
      setEnabled: function (v) { enabled = v; localStorage.setItem("luegen.sound", v ? "1" : "0"); },
      isEnabled: function () { return enabled; },
      play: function () { tone(430, 0.08, "triangle", 0.11); tone(300, 0.10, "sine", 0.07, 0.02); },
      turn: function () { tone(660, 0.12, "sine", 0.12); tone(880, 0.14, "sine", 0.09, 0.09); },
      challenge: function () { tone(210, 0.18, "sawtooth", 0.12); tone(150, 0.22, "sawtooth", 0.10, 0.05); },
      reveal: function (honest) { if (honest) { tone(523, 0.12, "sine", 0.12); tone(784, 0.18, "sine", 0.12, 0.10); } else { tone(330, 0.16, "square", 0.09); tone(210, 0.24, "square", 0.09, 0.10); } },
      win: function () { [523, 659, 784, 1047].forEach(function (f, i) { tone(f, 0.20, "triangle", 0.13, i * 0.10); }); },
      lose: function () { [392, 330, 262].forEach(function (f, i) { tone(f, 0.24, "sine", 0.12, i * 0.12); }); },
      ping: function () { tone(880, 0.07, "sine", 0.06); },
      join: function () { tone(587, 0.10, "sine", 0.09); tone(740, 0.10, "sine", 0.07, 0.06); },
    };
  })();

  // ----------------------------------------------------------- App-Zustand
  var app = {
    screen: "home",          // home | online-setup | offline-setup | online-room | offline-play
    mode: null,              // online | bots | pass
    theme: localStorage.getItem("luegen.theme") || "Ägäis",
    net: null, code: null, token: null, room: null,
    leaving: false, reconnecting: false,
    ui: { selected: {}, pickRank: null },
    off: null,
    offCfg: { variant: "same", numPlayers: 4, names: ["", "", "", "", "", ""] },
    onlineForm: { name: localStorage.getItem("luegen.name") || "", code: "", variant: "same" },
    banner: { text: "", on: false, timer: null },
  };

  // ----------------------------------------------------------- Toast
  function toast(msg) {
    var box = $("lg-toast");
    if (!box) { box = el("div", { id: "lg-toast" }); document.body.appendChild(box); }
    var t = el("div", { class: "t", text: msg });
    box.appendChild(t);
    setTimeout(function () { t.style.transition = "opacity .3s"; t.style.opacity = "0"; setTimeout(function () { if (t.parentNode) t.parentNode.removeChild(t); }, 300); }, 2800);
  }

  // ----------------------------------------------------------- Banner
  function setBanner(text) {
    app.banner.text = text; app.banner.on = true;
    if (app.banner.timer) clearTimeout(app.banner.timer);
    render();
    app.banner.timer = setTimeout(function () { app.banner.on = false; render(); }, 2600);
  }

  // ----------------------------------------------------------- Netzwerk
  function wsURL() { return (location.protocol === "https:" ? "wss://" : "ws://") + location.host; }
  function netConnect() {
    return new Promise(function (resolve, reject) {
      var ws;
      try { ws = new WebSocket(wsURL()); } catch (e) { reject(e); return; }
      var settled = false;
      ws.onopen = function () { settled = true; resolve(ws); };
      ws.onmessage = function (ev) { var m; try { m = JSON.parse(ev.data); } catch (e) { return; } handleServer(m); };
      ws.onerror = function () { if (!settled) { settled = true; reject(new Error("ws")); } };
      ws.onclose = function () { onNetClosed(); };
      app.net = ws;
    });
  }
  function netSend(o) { if (app.net && app.net.readyState === 1) app.net.send(JSON.stringify(o)); }

  function onNetClosed() {
    if (app.leaving || app.mode !== "online") return;
    if (!app.code || !app.token) return;
    if (app.reconnecting) return;
    app.reconnecting = true;
    toast("Verbindung verloren – neu verbinden…");
    var attempt = 0;
    (function retry() {
      attempt++;
      netConnect().then(function () {
        app.reconnecting = false;
        netSend({ t: "rejoin", code: app.code, token: app.token });
      }).catch(function () {
        if (attempt < 8) setTimeout(retry, Math.min(800 * attempt, 4000));
        else { app.reconnecting = false; toast("Verbindung fehlgeschlagen."); }
      });
    })();
  }

  function persistSession() {
    if (app.code && app.token) localStorage.setItem("luegen.session", JSON.stringify({ code: app.code, token: app.token }));
  }
  function clearSession() { localStorage.removeItem("luegen.session"); }

  function handleServer(m) {
    switch (m.t) {
      case "welcome": break;
      case "joined": {
        app.code = m.code; app.token = m.you.token; app.mode = "online"; app.screen = "online-room";
        persistSession();
        break;
      }
      case "state": {
        var prevMine = app.room ? app.room.yourTurn : false;
        app.room = m.room;
        if (m.room.yourTurn && !prevMine) Sound.turn();
        if (!m.room.yourTurn) { app.ui.selected = {}; app.ui.pickRank = null; }
        render(); Chat.ensure();
        break;
      }
      case "event": handleEvent(m); break;
      case "error": {
        toast(m.msg || "Fehler.");
        // Fehler beim Erstellen/Beitreten/Wiederaufnehmen (noch kein Raum): sanft zurück.
        if (app.mode === "online" && !app.room) {
          clearSession(); app.mode = null; app.code = null; app.token = null; app.screen = "online-setup"; render();
        }
        break;
      }
      case "kicked": toast(m.msg || "Entfernt."); leaveToHome(); break;
    }
  }

  function pname(i) { return (app.room && app.room.players[i]) ? app.room.players[i].name : "?"; }
  function youIdx() { return app.room ? app.room.you.index : -1; }

  function handleEvent(m) {
    switch (m.kind) {
      case "play": Sound.play(); break;
      case "challenge": {
        Sound.challenge();
        setBanner(m.by === youIdx() ? "Du zweifelst an!" : pname(m.by) + " zweifelt an!");
        break;
      }
      case "reveal_done": {
        Sound.reveal(m.honest);
        var take = m.loser === youIdx() ? "Du nimmst den Stapel." : pname(m.loser) + " nimmt den Stapel.";
        var text = m.honest ? ("Die Wahrheit! " + take)
          : ((m.claimer === youIdx() ? "Du hast geblufft! " : pname(m.claimer) + " hat geblufft! ") + take);
        setBanner(text);
        break;
      }
      case "gameover": Sound[(m.winner != null && m.winner === youIdx()) ? "win" : "lose"](); break;
    }
  }

  // ----------------------------------------------------------- View-Modell
  function buildVM() {
    if (app.mode === "online") {
      var r = app.room;
      return {
        online: true, status: r.status, variant: r.variant, phase: r.phase,
        currentRank: r.currentRank, roundRank: r.roundRank, pileCount: r.pileCount,
        players: r.players, youIndex: r.you.index, hand: r.hand || [],
        lastPlay: r.lastPlay, reveal: r.reveal, pickup: r.pickup,
        winner: r.winner, loser: r.loser, lossReason: r.lossReason,
        yourTurn: r.yourTurn, canChallenge: r.canChallenge,
        passHidden: false, youResultIndex: r.you.index, round: r.round,
      };
    }
    var g = app.off.game;
    var players = g.players.map(function (p, i) { return { index: i, name: p.name, color: p.color, isBot: p.isBot, connected: true, count: p.hand.length, isHost: false }; });
    var you = app.mode === "bots" ? 0 : g.turn;
    var revealed = app.off.revealed;
    var playPhase = g.phase === "play" && g.status === "playing";
    var canCh = playPhase && !!g.lastPlay && g.lastPlay.player !== you && (app.mode === "bots" ? true : revealed);
    return {
      online: false, status: g.status, variant: g.variant, phase: g.phase,
      currentRank: g.currentRank, roundRank: g.roundRank, pileCount: g.pile.length,
      players: players, youIndex: you, hand: g.players[you] ? g.players[you].hand : [],
      lastPlay: g.lastPlay ? { player: g.lastPlay.player, count: g.lastPlay.count, rank: g.lastPlay.rank } : null,
      reveal: g.reveal, pickup: g.pickup, winner: g.winner, loser: g.loser, lossReason: g.lossReason,
      yourTurn: playPhase && (app.mode === "bots" ? g.turn === 0 : (g.turn === you && revealed)),
      canChallenge: canCh,
      passHidden: app.mode === "pass" && !revealed && playPhase,
      youResultIndex: app.mode === "bots" ? 0 : -1, round: g.round,
      challengerIdx: you,
    };
  }

  // ----------------------------------------------------------- Render-Root
  function mount(content) {
    var root = $("app"); clear(root);
    root.appendChild(el("div", { style: "position:absolute;inset:0;z-index:0;" + bgCss(app.theme) }));
    var layer = el("div", { style: "position:relative;z-index:1;height:100%;" });
    append(layer, content);
    root.appendChild(layer);
  }

  function render() {
    if (app.screen === "home") return mount(renderHome());
    if (app.screen === "online-setup") return mount(renderOnlineSetup());
    if (app.screen === "offline-setup") return mount(renderOfflineSetup());
    if (app.screen === "online-room") {
      if (!app.room) return mount(connecting());
      if (app.room.status === "lobby") return mount(renderLobby());
      var vm = buildVM();
      return mount(vm.status === "over" ? renderGameOver(vm) : renderTable(vm));
    }
    if (app.screen === "offline-play") {
      var vm2 = buildVM();
      return mount(vm2.status === "over" ? renderGameOver(vm2) : renderTable(vm2));
    }
    mount(renderHome());
  }

  function connecting() {
    return el("div", { style: "position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:16px;" },
      el("div", { class: "lg-spinner" }),
      el("div", { style: "color:rgba(251,243,226,.8);font-weight:700;", text: "Verbinde…" })
    );
  }

  // ----------------------------------------------------------- Karten
  function handCard(card, idx, selected, clickable, onClick) {
    var ink = E.cardInk(card).color;
    var base = "position:relative;color:" + ink + ";flex:none;width:clamp(44px,11.5vw,66px);height:clamp(62px,16vw,92px);border-radius:8px;"
      + "background:linear-gradient(160deg,#fffdf6,#f4ead2);box-shadow:0 4px 12px rgba(0,0,0,.3);border:1px solid rgba(0,0,0,.12);"
      + "cursor:" + (clickable ? "pointer" : "default") + ";transition:transform .15s,box-shadow .15s;margin-left:" + (idx === 0 ? "0" : "-16px") + ";";
    if (selected) base += "transform:translateY(-22px);box-shadow:0 14px 26px rgba(0,0,0,.4);border:2px solid #d9a441;z-index:5;";
    var sym = E.suitSym(card);
    return el("div", { style: base, onclick: clickable ? onClick : null },
      el("span", { style: "font-family:'Playfair Display',serif;font-weight:800;font-size:15px;line-height:1;position:absolute;top:5px;left:6px;", text: card.rank }),
      el("span", { style: "position:absolute;top:20px;left:7px;font-size:11px;line-height:1;", text: sym }),
      el("span", { style: "position:absolute;top:50%;left:50%;transform:translate(-50%,-50%);font-size:30px;line-height:1;", text: sym }),
      el("span", { style: "font-family:'Playfair Display',serif;font-weight:800;font-size:15px;line-height:1;position:absolute;bottom:5px;right:6px;transform:rotate(180deg);", text: card.rank })
    );
  }
  function revealCard(card, matchRank) {
    var ink = E.cardInk(card).color;
    var ok = card.rank === RANKS[matchRank];
    var st = "position:relative;width:64px;height:90px;border-radius:8px;background:linear-gradient(160deg,#fffdf6,#f4ead2);display:flex;flex-direction:column;justify-content:space-between;padding:6px;color:" + ink + ";"
      + "box-shadow:0 8px 20px rgba(0,0,0,.4),0 0 0 2px " + (ok ? "#5a8c6e" : "#c15a4c") + ";";
    return el("div", { style: st, class: "lg-pop" },
      el("span", { style: "font-family:'Playfair Display',serif;font-weight:800;font-size:17px;line-height:1;", text: card.rank }),
      el("span", { style: "text-align:center;font-size:26px;line-height:1;", text: E.suitSym(card) }),
      el("span", { style: "font-family:'Playfair Display',serif;font-weight:800;font-size:17px;line-height:1;text-align:right;", text: card.rank })
    );
  }
  function smallCard(card) {
    var ink = E.cardInk(card).color;
    return el("div", { style: "position:relative;flex:none;width:44px;height:60px;border-radius:6px;background:linear-gradient(160deg,#fffdf6,#f4ead2);box-shadow:0 4px 10px rgba(0,0,0,.35);color:" + ink + ";", class: "lg-pop" },
      el("span", { style: "font-family:'Playfair Display',serif;font-weight:800;font-size:13px;line-height:1;position:absolute;top:3px;left:5px;", text: card.rank }),
      el("span", { style: "position:absolute;top:50%;left:50%;transform:translate(-50%,-50%);font-size:22px;line-height:1;", text: E.suitSym(card) })
    );
  }
  function pileStack(count) {
    var back = "position:absolute;inset:0;border-radius:10px;background:repeating-linear-gradient(45deg,#2e7d8f 0 9px,#246575 9px 18px);box-shadow:0 6px 16px rgba(0,0,0,.4),inset 0 0 0 3px rgba(217,164,65,.55),inset 0 0 0 5px #246575;";
    return el("div", { style: "position:relative;width:80px;height:112px;" },
      el("div", { style: back + "transform:rotate(-7deg) translate(-6px,2px);" }),
      el("div", { style: back + "transform:rotate(5deg) translate(5px,-1px);" }),
      el("div", { style: back + "transform:rotate(-1deg);" }),
      el("div", { style: "position:absolute;bottom:-12px;left:50%;transform:translateX(-50%);background:#15464f;color:#fbf3e2;border:1px solid rgba(217,164,65,.5);border-radius:20px;padding:4px 12px;font-size:12px;font-weight:800;white-space:nowrap;", text: "Stapel · " + count })
    );
  }

  // ----------------------------------------------------------- Startbildschirm
  function topRightControls() {
    return el("div", { style: "position:absolute;top:14px;right:14px;z-index:5;display:flex;gap:8px;" },
      themeBtn(), soundBtn());
  }
  function soundBtn() {
    return el("button", {
      style: "cursor:pointer;border:1px solid rgba(251,243,226,.25);background:rgba(0,0,0,.2);color:#fbf3e2;border-radius:10px;width:40px;height:40px;font-size:18px;",
      title: "Ton an/aus",
      onclick: function () { Sound.setEnabled(!Sound.isEnabled()); Sound.unlock(); if (Sound.isEnabled()) Sound.ping(); render(); }
    }, Sound.isEnabled() ? "🔊" : "🔇");
  }
  function themeBtn() {
    var names = Object.keys(THEMES);
    return el("button", {
      style: "cursor:pointer;border:1px solid rgba(251,243,226,.25);background:rgba(0,0,0,.2);color:#fbf3e2;border-radius:10px;height:40px;padding:0 12px;font-size:13px;font-weight:700;",
      title: "Farbwelt wechseln",
      onclick: function () { var i = names.indexOf(app.theme); app.theme = names[(i + 1) % names.length]; localStorage.setItem("luegen.theme", app.theme); render(); }
    }, "🎨 " + app.theme);
  }

  function renderHome() {
    var wrap = el("div", { style: "position:absolute;inset:0;display:flex;align-items:center;justify-content:center;padding:24px;overflow-y:auto;" });
    var card = el("div", { class: "lg-rise", style: "width:100%;max-width:440px;background:linear-gradient(180deg,#fdf6e9,#f6e8cf);border-radius:22px;padding:36px 30px 30px;box-shadow:0 30px 80px rgba(0,0,0,.4),0 0 0 1px rgba(217,164,65,.4),inset 0 0 0 4px rgba(255,255,255,.5);color:#173f4c;" });
    append(card, el("div", { style: "text-align:center;" },
      el("div", { style: "font-family:'Playfair Display',serif;font-style:italic;color:#cf7457;font-size:14px;letter-spacing:.18em;text-transform:uppercase;", text: "Das Kartenspiel" }),
      el("div", { style: "font-family:'Playfair Display',serif;font-weight:800;font-size:clamp(48px,13vw,68px);line-height:.95;color:#173f4c;", text: "Lügen" }),
      el("div", { style: "display:flex;align-items:center;gap:10px;justify-content:center;margin-top:8px;color:#6f8a86;" },
        el("span", { style: "height:1px;width:34px;background:#d9a441;" }),
        el("span", { style: "font-size:13px;letter-spacing:.06em;", text: "Bluffen · ansagen · entlarven" }),
        el("span", { style: "height:1px;width:34px;background:#d9a441;" }))
    ));
    function big(title, sub, accent, onClick) {
      return el("button", {
        onclick: function () { Sound.unlock(); onClick(); },
        style: "margin-top:14px;width:100%;text-align:left;cursor:pointer;border:none;border-radius:16px;padding:16px 18px;color:#fff;"
          + "background:" + accent + ";box-shadow:0 12px 26px rgba(0,0,0,.18),inset 0 0 0 1px rgba(255,255,255,.18);display:flex;align-items:center;gap:14px;"
      },
        el("span", { style: "font-size:24px;flex:none;width:44px;height:44px;border-radius:12px;background:rgba(255,255,255,.18);display:flex;align-items:center;justify-content:center;", text: title.icon }),
        el("div", {},
          el("div", { style: "font-weight:800;font-size:18px;", text: title.t }),
          el("div", { style: "font-size:13px;opacity:.85;margin-top:1px;", text: sub })));
    }
    append(card, el("div", { style: "margin-top:18px;" },
      big({ t: "Online spielen", icon: "🌐" }, "Mit Freunden über das Internet", "linear-gradient(180deg,#d98a63,#c2674a)", function () { app.screen = "online-setup"; render(); }),
      big({ t: "Gegen Bots", icon: "🤖" }, "Allein gegen die KI üben", "linear-gradient(180deg,#3f93a8,#2c7689)", function () { app.mode = "bots"; app.screen = "offline-setup"; render(); }),
      big({ t: "Pass & Play", icon: "📱" }, "Ein Gerät reihum weitergeben", "linear-gradient(180deg,#5a8c6e,#447256)", function () { app.mode = "pass"; app.screen = "offline-setup"; render(); })
    ));
    append(card, el("div", { style: "text-align:center;margin-top:18px;font-size:12px;color:#8aa39e;line-height:1.5;", text: "Lege verdeckt Karten und sage eine Zahl an — ehrlich oder geblufft. Wer „Lüge!“ ruft und falsch liegt, nimmt den Stapel. Wer zuerst alle Karten los ist, gewinnt." }));
    append(wrap, card);
    append(wrap, topRightControls());
    return wrap;
  }

  // ----------------------------------------------------------- Online-Setup
  function sectionLabel(t) { return el("div", { style: "font-size:12px;font-weight:700;letter-spacing:.1em;text-transform:uppercase;color:#86a09b;margin-bottom:8px;", text: t }); }
  function pill(active, title, sub, onClick) {
    var base = "padding:12px;border-radius:12px;cursor:pointer;text-align:left;transition:all .15s;border:1px solid;width:100%;";
    var st = active
      ? base + "background:linear-gradient(180deg,#1f6b78,#15505c);color:#fbf3e2;border-color:rgba(217,164,65,.55);box-shadow:0 6px 16px rgba(0,0,0,.18);"
      : base + "background:#fff;color:#5a6b60;border-color:rgba(31,79,94,.14);";
    return el("button", { style: st, onclick: onClick },
      el("div", { style: "font-weight:800;font-size:15px;", text: title }),
      el("div", { style: "font-size:12px;opacity:.7;margin-top:2px;", text: sub }));
  }
  function textInput(value, placeholder, oninput, maxlen) {
    return el("input", {
      value: value || "", placeholder: placeholder, maxlength: maxlen || 14,
      oninput: oninput,
      style: "width:100%;border:1px solid rgba(31,79,94,.18);outline:none;background:#fff;border-radius:12px;padding:12px 14px;font-size:16px;font-weight:600;color:#173f4c;",
    });
  }
  function lobbyCardWrap(children) {
    var wrap = el("div", { class: "lg-lobby", style: "position:absolute;inset:0;display:flex;align-items:center;justify-content:center;padding:24px;overflow-y:auto;" });
    var card = el("div", { class: "lg-rise", style: "width:100%;max-width:480px;background:linear-gradient(180deg,#fdf6e9,#f6e8cf);border-radius:22px;padding:30px 28px 26px;box-shadow:0 30px 80px rgba(0,0,0,.4),0 0 0 1px rgba(217,164,65,.4),inset 0 0 0 4px rgba(255,255,255,.5);color:#173f4c;" });
    append(card, children);
    append(wrap, card);
    append(wrap, topRightControls());
    return wrap;
  }
  function backLink(onClick) {
    return el("button", { onclick: onClick, style: "cursor:pointer;border:none;background:none;color:#86a09b;font-weight:700;font-size:14px;padding:0;margin-bottom:6px;" }, "‹ Zurück");
  }
  function primaryBtn(label, onClick, enabled) {
    var on = enabled !== false;
    return el("button", {
      onclick: on ? onClick : null,
      style: "width:100%;border:none;cursor:" + (on ? "pointer" : "default") + ";color:#fff;font-weight:800;font-size:18px;padding:15px;border-radius:14px;"
        + (on ? "background:linear-gradient(180deg,#d98a63,#c2674a);box-shadow:0 12px 26px rgba(194,103,74,.42),inset 0 0 0 1px rgba(255,255,255,.25);"
              : "background:#cbb9a0;box-shadow:none;opacity:.7;"),
    }, label);
  }

  function renderOnlineSetup() {
    var f = app.onlineForm;
    var body = el("div", {});
    append(body, backLink(function () { app.screen = "home"; render(); }));
    append(body, el("div", { style: "font-family:'Playfair Display',serif;font-weight:800;font-size:34px;color:#173f4c;margin-bottom:4px;", text: "Online spielen" }));
    append(body, el("div", { style: "font-size:13px;color:#7e948f;margin-bottom:18px;", text: "Erstelle einen Raum und teile den Code — oder tritt mit einem Code bei." }));

    // Name
    append(body, sectionLabel("Dein Name"));
    append(body, textInput(f.name, "Dein Name", function (e) { f.name = e.target.value; localStorage.setItem("luegen.name", f.name); }));

    // Create
    append(body, el("div", { style: "margin-top:18px;" }, sectionLabel("Variante")));
    append(body, el("div", { style: "display:grid;grid-template-columns:1fr 1fr;gap:10px;" },
      pill(f.variant === "same", "Gleiche Zahl", "Immer dieselbe Zahl", function () { f.variant = "same"; render(); }),
      pill(f.variant === "asc", "Aufsteigend", "2, 3, 4 … der Reihe nach", function () { f.variant = "asc"; render(); })));
    append(body, el("div", { style: "margin-top:14px;" }, primaryBtn("Raum erstellen", function () {
      var name = (f.name || "").trim(); if (!name) { toast("Bitte gib einen Namen ein."); return; }
      Sound.unlock(); app.leaving = false;
      mount(connecting());
      netConnect().then(function () { netSend({ t: "create", name: name, variant: f.variant }); })
        .catch(function () { toast("Verbindung fehlgeschlagen."); app.screen = "online-setup"; render(); });
    })));

    append(body, el("div", { style: "display:flex;align-items:center;gap:10px;margin:22px 0 14px;color:#b6c8c2;" },
      el("span", { style: "height:1px;flex:1;background:rgba(31,79,94,.14);" }),
      el("span", { style: "font-size:12px;font-weight:700;", text: "ODER" }),
      el("span", { style: "height:1px;flex:1;background:rgba(31,79,94,.14);" })));

    // Join
    append(body, sectionLabel("Raum-Code"));
    var codeInput = el("input", {
      value: f.code || "", placeholder: "z. B. ABCD", maxlength: 4,
      oninput: function (e) { f.code = e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, ""); e.target.value = f.code; },
      style: "width:100%;border:1px solid rgba(31,79,94,.18);outline:none;background:#fff;border-radius:12px;padding:12px 14px;font-size:24px;font-weight:800;letter-spacing:.3em;text-align:center;color:#173f4c;font-family:'Playfair Display',serif;text-transform:uppercase;",
    });
    append(body, codeInput);
    append(body, el("div", { style: "margin-top:12px;" }, el("button", {
      onclick: function () {
        var name = (f.name || "").trim(); if (!name) { toast("Bitte gib einen Namen ein."); return; }
        var code = (f.code || "").trim(); if (code.length !== 4) { toast("Bitte gib einen 4-stelligen Code ein."); return; }
        Sound.unlock(); app.leaving = false;
        mount(connecting());
        netConnect().then(function () { netSend({ t: "join", code: code, name: name }); })
          .catch(function () { toast("Verbindung fehlgeschlagen."); app.screen = "online-setup"; render(); });
      },
      style: "width:100%;border:1px solid rgba(31,79,94,.2);cursor:pointer;background:#fff;color:#1f4f5e;font-weight:800;font-size:17px;padding:14px;border-radius:14px;"
    }, "Raum beitreten")));

    return lobbyCardWrap(body);
  }

  // ----------------------------------------------------------- Online-Lobby
  function renderLobby() {
    var r = app.room;
    var meHost = r.players[r.you.index] && r.players[r.you.index].isHost;
    var body = el("div", {});
    append(body, el("div", { style: "display:flex;justify-content:space-between;align-items:center;margin-bottom:10px;" },
      el("button", { onclick: leaveToHome, style: "cursor:pointer;border:none;background:none;color:#86a09b;font-weight:700;font-size:14px;padding:0;" }, "‹ Verlassen"),
      el("div", { style: "font-family:'Playfair Display',serif;font-weight:800;font-size:22px;color:#173f4c;", text: "Lobby" })));

    // Code + share
    append(body, el("div", { style: "background:#fff;border:1px solid rgba(31,79,94,.14);border-radius:16px;padding:16px;text-align:center;" },
      el("div", { style: "font-size:12px;font-weight:700;letter-spacing:.12em;text-transform:uppercase;color:#86a09b;", text: "Raum-Code" }),
      el("div", { style: "font-family:'Playfair Display',serif;font-weight:800;font-size:44px;letter-spacing:.18em;color:#cf7457;line-height:1.1;", text: r.code }),
      el("div", { style: "display:flex;gap:8px;justify-content:center;margin-top:6px;" },
        el("button", { onclick: function () { copy(r.code, "Code kopiert!"); }, style: shareBtnStyle() }, "Code kopieren"),
        el("button", { onclick: function () { copy(location.origin + "/?room=" + r.code, "Einladungslink kopiert!"); }, style: shareBtnStyle() }, "Link kopieren"))));

    // Variant
    append(body, el("div", { style: "margin-top:18px;" }, sectionLabel("Variante" + (meHost ? "" : " (legt der Host fest)"))));
    append(body, el("div", { style: "display:grid;grid-template-columns:1fr 1fr;gap:10px;" + (meHost ? "" : "opacity:.7;pointer-events:none;") },
      pill(r.variant === "same", "Gleiche Zahl", "Immer dieselbe Zahl", function () { netSend({ t: "setVariant", variant: "same" }); }),
      pill(r.variant === "asc", "Aufsteigend", "2, 3, 4 … der Reihe nach", function () { netSend({ t: "setVariant", variant: "asc" }); })));

    // Players
    append(body, el("div", { style: "margin-top:18px;" }, sectionLabel("Spieler · " + r.players.length + "/6")));
    var list = el("div", { style: "display:flex;flex-direction:column;gap:8px;" });
    r.players.forEach(function (p) {
      var row = el("div", { style: "display:flex;align-items:center;gap:10px;background:#fff;border:1px solid rgba(31,79,94,.14);border-radius:12px;padding:8px 10px;" },
        el("span", { style: "width:34px;height:34px;border-radius:50%;flex:none;display:flex;align-items:center;justify-content:center;font-weight:800;font-size:14px;color:#fff;background:" + p.color + ";", text: (p.name[0] || "?").toUpperCase() }),
        el("div", { style: "flex:1;min-width:0;" },
          el("div", { style: "font-weight:700;color:#173f4c;font-size:15px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;", text: p.name + (p.index === r.you.index ? " (du)" : "") }),
          el("div", { style: "font-size:11px;color:#9bb0aa;", text: (p.isHost ? "Host" : "") + (p.isBot ? "Bot" : "") + (!p.connected ? " · offline" : "") })),
        (meHost && !p.isHost) ? el("button", { onclick: function () { netSend({ t: "removeSeat", index: p.index }); }, style: "cursor:pointer;border:none;background:rgba(207,90,76,.12);color:#c15a4c;font-weight:800;border-radius:8px;width:30px;height:30px;font-size:16px;" }, "×") : null
      );
      append(list, row);
    });
    append(body, list);

    // Host actions
    if (meHost) {
      append(body, el("div", { style: "display:flex;gap:10px;margin-top:16px;" },
        el("button", { onclick: function () { netSend({ t: "addBot" }); }, disabled: r.players.length >= 6, style: "flex:1;cursor:pointer;border:1px dashed rgba(31,79,94,.3);background:#fff;color:#1f4f5e;font-weight:800;font-size:15px;padding:13px;border-radius:14px;" + (r.players.length >= 6 ? "opacity:.5;" : "") }, "+ Bot")));
      append(body, el("div", { style: "margin-top:10px;" }, primaryBtn("Spiel starten" + (r.players.length < 2 ? " (≥ 2 nötig)" : ""), function () { netSend({ t: "start" }); }, r.players.length >= 2)));
    } else {
      append(body, el("div", { style: "margin-top:16px;text-align:center;color:#7e948f;font-weight:700;font-size:14px;display:flex;align-items:center;justify-content:center;gap:8px;" },
        el("span", { class: "lg-spinner", style: "width:16px;height:16px;border-width:2px;" }), "Warte auf den Host…"));
    }
    return lobbyCardWrap(body);
  }
  function shareBtnStyle() { return "cursor:pointer;border:1px solid rgba(31,79,94,.18);background:#f3ead8;color:#1f4f5e;font-weight:700;font-size:13px;padding:8px 12px;border-radius:10px;"; }

  function copy(text, okMsg) {
    if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(text).then(function () { toast(okMsg); }, function () { toast(text); });
    else toast(text);
  }

  // ----------------------------------------------------------- Tisch
  function renderTable(vm) {
    var compact = window.innerHeight < 620;
    var root = el("div", { style: "position:absolute;inset:0;display:flex;flex-direction:column;" });

    // Kopfzeile
    var anker = vm.variant === "asc" ? RANKS[vm.currentRank] : (vm.roundRank != null ? RANKS[vm.roundRank] : "—");
    append(root, el("div", { style: "flex:none;display:flex;align-items:center;justify-content:space-between;padding:12px 16px;gap:10px;" },
      el("button", { onclick: onMenu, style: "background:rgba(0,0,0,.22);border:1px solid rgba(251,243,226,.2);color:#fbf3e2;border-radius:10px;padding:8px 12px;font-size:13px;font-weight:700;cursor:pointer;" }, "‹ Menü"),
      el("div", { style: "font-family:'Playfair Display',serif;font-weight:700;font-style:italic;letter-spacing:.16em;font-size:15px;color:rgba(251,243,226,.85);", text: "L Ü G E N" }),
      el("div", { style: "display:flex;align-items:center;gap:8px;background:rgba(0,0,0,.22);border:1px solid rgba(217,164,65,.45);border-radius:10px;padding:7px 12px;" },
        el("span", { style: "font-size:11px;color:rgba(251,243,226,.6);font-weight:700;letter-spacing:.05em;", text: "ANSAGE" }),
        el("span", { style: "font-family:'Playfair Display',serif;font-weight:800;font-size:18px;color:#d9a441;line-height:1;", text: anker }))));

    // Gegner
    var oppRow = el("div", { style: "flex:none;display:flex;flex-wrap:wrap;align-items:flex-start;justify-content:center;gap:" + (compact ? "5px 12px" : "10px 14px") + ";padding:" + (compact ? "4px 12px 2px" : "4px 12px 6px") + ";" });
    vm.players.forEach(function (p) {
      if (p.index === vm.youIndex) return;
      var isCur = p.index === turnOf(vm) && vm.phase === "play";
      var status = "";
      if (isCur) status = p.isBot ? "denkt nach…" : "am Zug";
      else if (vm.lastPlay && p.index === vm.lastPlay.player) status = "hat angesagt";
      else if (!p.connected) status = "offline";
      append(oppRow, el("div", { style: "display:flex;flex-direction:column;align-items:center;gap:5px;width:96px;transition:transform .25s;transform:" + (isCur ? "scale(1.05)" : "none") + ";" },
        el("div", { style: "position:relative;width:50px;height:50px;border-radius:50%;display:flex;align-items:center;justify-content:center;font-family:'Playfair Display',serif;font-weight:800;font-size:19px;color:#fff;background:" + p.color + ";"
          + "box-shadow:" + (isCur ? "0 0 0 3px #d9a441,0 6px 16px rgba(0,0,0,.35)" : "0 6px 14px rgba(0,0,0,.3)") + ";opacity:" + (p.connected ? "1" : ".5") + ";" },
          (p.name[0] || "?").toUpperCase(),
          el("span", { style: "position:absolute;bottom:-4px;right:-6px;background:#15464f;color:#fbf3e2;border:2px solid rgba(251,243,226,.3);border-radius:9px;min-width:22px;height:20px;display:flex;align-items:center;justify-content:center;font-size:12px;font-weight:800;padding:0 4px;", text: String(p.count) })),
        el("div", { style: "font-size:13px;font-weight:700;color:#fbf3e2;max-width:96px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;", text: p.name }),
        el("div", { style: "font-size:11px;font-weight:600;height:15px;line-height:15px;text-align:center;color:" + (isCur ? "#d9a441" : "rgba(251,243,226,.5)") + ";", text: status })));
    });
    append(root, oppRow);

    // Mitte
    var center = el("div", { style: "flex:1;min-height:0;display:flex;flex-direction:column;align-items:center;justify-content:" + (compact ? "flex-start" : "center") + ";gap:" + (compact ? "8px" : "14px") + ";padding:" + (compact ? "2px 16px 0" : "6px 16px") + ";position:relative;" });
    if (vm.lastPlay && vm.phase !== "reveal") {
      append(center, el("div", { style: "text-align:center;" },
        el("div", { style: "font-size:12px;letter-spacing:.12em;text-transform:uppercase;color:rgba(251,243,226,.6);font-weight:700;", text: (vm.lastPlay.player === vm.youIndex ? "Du sagst" : nameOf(vm, vm.lastPlay.player) + " sagt") }),
        el("div", { style: "font-family:'Playfair Display',serif;font-weight:800;font-size:clamp(22px,5vw,32px);color:#d9a441;line-height:1.05;margin-top:2px;", text: E.claimLabel(vm.lastPlay.count, vm.lastPlay.rank) })));
    }
    var pileRegion = el("div", { style: "position:relative;height:" + (compact ? "112px" : "128px") + ";display:flex;align-items:center;justify-content:center;" });
    if (vm.phase === "reveal" && vm.reveal) {
      var row = el("div", { style: "display:flex;gap:8px;" });
      vm.reveal.cards.forEach(function (c) { append(row, revealCard(c, vm.reveal.rank)); });
      append(pileRegion, row);
    } else if (vm.pileCount > 0) {
      append(pileRegion, pileStack(vm.pileCount));
    } else {
      append(pileRegion, el("div", { style: "width:80px;height:112px;border:2px dashed rgba(251,243,226,.28);border-radius:10px;display:flex;align-items:center;justify-content:center;text-align:center;font-size:11px;color:rgba(251,243,226,.5);padding:8px;", text: "Neuer Stapel" }));
    }
    append(center, pileRegion);
    if (vm.canChallenge) {
      append(center, el("button", { onclick: onChallenge.bind(null, vm), style: "border:none;cursor:pointer;background:linear-gradient(180deg,#cf6a5c,#a84436);color:#fff;font-weight:800;font-size:17px;letter-spacing:.04em;padding:12px 28px;border-radius:30px;box-shadow:0 10px 24px rgba(168,68,54,.5),inset 0 0 0 1px rgba(255,255,255,.2);animation:lg-glow 1.8s ease-in-out infinite;" }, "„Lüge!“"));
    }
    append(root, center);

    // Banner
    if (app.banner.on && app.banner.text) {
      append(root, el("div", { class: "lg-pop", style: "position:absolute;top:84px;left:50%;transform:translateX(-50%);z-index:30;background:rgba(16,54,64,.96);border:1px solid rgba(217,164,65,.5);color:#fbf3e2;padding:12px 20px;border-radius:14px;font-weight:700;font-size:15px;box-shadow:0 16px 40px rgba(0,0,0,.5);text-align:center;max-width:90vw;", text: app.banner.text }));
    }

    // Unten: eigene Hand
    append(root, renderBottom(vm, compact));

    // Overlays
    if (vm.passHidden) append(root, privacyOverlay(vm));
    if (vm.phase === "pickup" && vm.pickup) append(root, pickupOverlay(vm));

    return root;
  }

  function renderBottom(vm, compact) {
    var bottom = el("div", { style: "flex:none;background:linear-gradient(180deg,rgba(0,0,0,0),rgba(0,0,0,.3));padding:8px 10px 14px;" });
    var youName = vm.online ? nameOf(vm, vm.youIndex) : (app.mode === "bots" ? "Du" : nameOf(vm, vm.youIndex));
    var youColor = vm.players[vm.youIndex] ? vm.players[vm.youIndex].color : "#cf7457";
    var prompt = "";
    if (vm.yourTurn) {
      if (vm.variant === "asc") prompt = "Du sagst an: " + RANKLONG[RANKS[vm.currentRank]];
      else if (vm.roundRank != null) prompt = "Du legst: " + RANKLONG[RANKS[vm.roundRank]];
      else prompt = "Wähle deine Zahl ↓";
    }
    append(bottom, el("div", { style: "display:flex;align-items:center;justify-content:space-between;gap:10px;padding:0 6px 8px;" },
      el("div", { style: "display:flex;align-items:center;gap:8px;min-width:0;" },
        el("span", { style: "width:30px;height:30px;border-radius:50%;flex:none;display:flex;align-items:center;justify-content:center;font-weight:800;font-size:13px;color:#fff;background:" + youColor + ";", text: (youName[0] || "?").toUpperCase() }),
        el("span", { style: "font-weight:800;font-size:15px;color:#fbf3e2;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;", text: youName }),
        el("span", { style: "font-size:12px;color:rgba(251,243,226,.55);font-weight:600;white-space:nowrap;", text: "· " + vm.hand.length + " Karten" })),
      el("div", { style: "font-size:13px;font-weight:700;text-align:right;color:#d9a441;", text: prompt })));

    // Handreihe
    var handRow = el("div", { style: "display:flex;justify-content:safe center;overflow-x:auto;overflow-y:visible;padding:" + (compact ? "14px 22px 6px" : "24px 22px 10px") + ";min-height:" + (compact ? "100px" : "118px") + ";" });
    var inner = el("div", { style: "display:flex;align-items:flex-end;" });
    vm.hand.forEach(function (c, idx) {
      var selected = !!app.ui.selected[c.id] && vm.yourTurn;
      append(inner, handCard(c, idx, selected, vm.yourTurn, function () { toggleCard(c.id, vm); }));
    });
    append(handRow, inner);
    append(bottom, handRow);

    // Rang-Auswahl
    if (vm.yourTurn && vm.variant === "same" && vm.roundRank == null) {
      var effPick = app.ui.pickRank != null ? app.ui.pickRank : E.bestRankIdx(vm.hand);
      var chips = el("div", { style: "display:flex;gap:5px;overflow-x:auto;padding:2px;" });
      RANKS.forEach(function (r, i) {
        if (r === "A") return;
        var on = i === effPick;
        var st = "flex:none;min-width:34px;height:40px;border-radius:8px;border:1px solid;cursor:pointer;font-family:'Playfair Display',serif;font-weight:800;font-size:16px;display:flex;align-items:center;justify-content:center;transition:all .12s;padding:0 6px;"
          + (on ? "background:#d9a441;color:#173f4c;border-color:#d9a441;transform:translateY(-2px);box-shadow:0 4px 10px rgba(217,164,65,.5);" : "background:rgba(255,253,246,.92);color:#173f4c;border-color:rgba(0,0,0,.12);");
        append(chips, el("button", { style: st, onclick: function () { app.ui.pickRank = i; render(); } }, r));
      });
      append(bottom, el("div", { style: "display:flex;align-items:center;justify-content:center;gap:8px;padding:0 10px 8px;" },
        el("span", { style: "font-size:12px;font-weight:700;color:rgba(251,243,226,.65);white-space:nowrap;flex:none;", text: "Deine Zahl" }), chips));
    }

    // Aktion
    var actions = el("div", { style: "display:flex;align-items:center;justify-content:center;gap:10px;padding:2px 6px 0;min-height:52px;" });
    if (vm.yourTurn) {
      var selCount = Object.keys(app.ui.selected).filter(function (id) { return app.ui.selected[id] && vm.hand.some(function (c) { return c.id === id; }); }).length;
      var word = vm.variant === "same" ? "Legen" : "Spielen";
      var pb = "border:none;font-weight:800;font-size:17px;padding:13px 30px;border-radius:30px;letter-spacing:.02em;transition:all .15s;"
        + (selCount > 0 ? "cursor:pointer;background:linear-gradient(180deg,#d98a63,#c2674a);color:#fff;box-shadow:0 10px 24px rgba(194,103,74,.45),inset 0 0 0 1px rgba(255,255,255,.22);"
                       : "cursor:default;background:rgba(255,255,255,.12);color:rgba(251,243,226,.5);box-shadow:inset 0 0 0 1px rgba(251,243,226,.18);");
      append(actions, el("button", { style: pb, onclick: selCount > 0 ? function () { playSelected(vm); } : null }, selCount > 0 ? (word + " · " + selCount) : "Karten wählen"));
    } else if (vm.status === "playing" && vm.phase === "play" && !vm.passHidden) {
      append(actions, el("div", { style: "color:rgba(251,243,226,.7);font-weight:700;font-size:15px;display:flex;align-items:center;gap:8px;" },
        el("span", { style: "width:8px;height:8px;border-radius:50%;background:#d9a441;animation:lg-glow 1s infinite;" }),
        (nameOf(vm, turnOf(vm)) + " ist am Zug…")));
    }
    append(bottom, actions);
    return bottom;
  }

  function privacyOverlay(vm) {
    var t = turnOf(vm);
    var p = vm.players[t];
    return el("div", { style: "position:absolute;inset:0;z-index:50;background:rgba(16,54,64,.93);backdrop-filter:blur(6px);display:flex;flex-direction:column;align-items:center;justify-content:center;gap:18px;text-align:center;padding:30px;" },
      el("div", { style: "font-size:13px;letter-spacing:.16em;text-transform:uppercase;color:rgba(251,243,226,.6);font-weight:700;", text: "Gerät weitergeben an" }),
      el("div", { style: "width:80px;height:80px;border-radius:50%;display:flex;align-items:center;justify-content:center;font-family:'Playfair Display',serif;font-weight:800;font-size:34px;color:#fff;background:" + p.color + ";", text: (p.name[0] || "?").toUpperCase() }),
      el("div", { style: "font-family:'Playfair Display',serif;font-weight:800;font-size:34px;color:#fbf3e2;", text: p.name }),
      el("button", { onclick: function () { Offline.reveal(); }, style: "margin-top:6px;border:none;cursor:pointer;background:linear-gradient(180deg,#d98a63,#c2674a);color:#fff;font-weight:800;font-size:17px;padding:14px 34px;border-radius:30px;box-shadow:0 10px 24px rgba(194,103,74,.5),inset 0 0 0 1px rgba(255,255,255,.25);" }, "Hand aufdecken"));
  }

  function pickupOverlay(vm) {
    var title = (vm.pickup.player === vm.youIndex && (vm.online || app.mode === "bots")) ? "Du nimmst auf" : nameOf(vm, vm.pickup.player) + " nimmt auf";
    var grid = el("div", { style: "display:flex;flex-wrap:wrap;gap:6px;justify-content:center;align-items:flex-start;max-width:560px;max-height:58vh;overflow-y:auto;" });
    vm.pickup.cards.forEach(function (c) { append(grid, smallCard(c)); });
    return el("div", { style: "position:absolute;inset:0;z-index:55;background:rgba(16,54,64,.9);backdrop-filter:blur(5px);display:flex;flex-direction:column;align-items:center;justify-content:center;gap:14px;text-align:center;padding:26px;" },
      el("div", { style: "font-size:13px;letter-spacing:.14em;text-transform:uppercase;color:rgba(251,243,226,.7);font-weight:700;", text: title + " · " + vm.pickup.cards.length + " Karten" }),
      grid);
  }

  // ----------------------------------------------------------- Game Over
  function renderGameOver(vm) {
    var isYou = function (i) { return vm.youResultIndex >= 0 && i === vm.youResultIndex; };
    var dotBase = "width:104px;height:104px;border-radius:50%;margin:18px auto;display:flex;align-items:center;justify-content:center;font-family:'Playfair Display',serif;font-weight:800;font-size:44px;color:#fff;";
    var initial = "?", dot = dotBase, name = "", sub = "";
    if (vm.lossReason === "aces" && vm.loser != null) {
      var l = vm.loser;
      initial = (nameOf(vm, l)[0] || "?").toUpperCase();
      dot = dotBase + "box-shadow:0 0 0 4px rgba(193,90,76,.9),0 18px 40px rgba(0,0,0,.45);background:" + colorOf(vm, l) + ";";
      name = isYou(l) ? "Verloren!" : nameOf(vm, l) + " verliert";
      sub = (isYou(l) ? "Du hattest" : nameOf(vm, l) + " hatte") + " alle vier Asse auf der Hand.";
    } else if (vm.winner != null) {
      var w = vm.winner;
      initial = (nameOf(vm, w)[0] || "?").toUpperCase();
      dot = dotBase + "box-shadow:0 0 0 4px rgba(217,164,65,.85),0 18px 40px rgba(0,0,0,.45);background:" + colorOf(vm, w) + ";";
      name = isYou(w) ? "Gewonnen!" : nameOf(vm, w) + " gewinnt";
      sub = isYou(w) ? "Du hast zuerst alle Karten abgelegt." : "Zuerst alle Karten abgelegt — stark gespielt!";
    }
    var wrap = el("div", { style: "position:absolute;inset:0;display:flex;align-items:center;justify-content:center;padding:24px;" });
    var inner = el("div", { class: "lg-rise", style: "text-align:center;" },
      el("div", { style: "font-size:13px;letter-spacing:.2em;text-transform:uppercase;color:rgba(251,243,226,.55);font-weight:700;", text: "Spiel vorbei" }),
      el("div", { class: "lg-pop", style: dot, text: initial }),
      el("div", { style: "font-family:'Playfair Display',serif;font-weight:800;font-size:clamp(36px,9vw,60px);color:#d9a441;line-height:1.05;", text: name }),
      el("div", { style: "font-size:18px;color:#fbf3e2;margin-top:6px;", text: sub }));
    var btns = el("div", { style: "display:flex;gap:12px;justify-content:center;margin-top:30px;flex-wrap:wrap;" });
    append(btns, el("button", { onclick: onRematch, style: "border:none;cursor:pointer;background:linear-gradient(180deg,#d98a63,#c2674a);color:#fff;font-weight:800;font-size:17px;padding:14px 30px;border-radius:14px;box-shadow:0 10px 24px rgba(194,103,74,.5),inset 0 0 0 1px rgba(255,255,255,.25);" }, "Nochmal spielen"));
    append(btns, el("button", { onclick: onMenu, style: "border:1px solid rgba(251,243,226,.3);cursor:pointer;background:rgba(0,0,0,.2);color:#fbf3e2;font-weight:800;font-size:17px;padding:14px 30px;border-radius:14px;" }, vm.online ? "Verlassen" : "Zum Menü"));
    append(inner, btns);
    append(wrap, inner);
    return wrap;
  }

  // ----------------------------------------------------------- VM-Helfer
  function turnOf(vm) { return vm.online ? app.room.turn : app.off.game.turn; }
  function nameOf(vm, i) { return vm.players[i] ? vm.players[i].name : "?"; }
  function colorOf(vm, i) { return vm.players[i] ? vm.players[i].color : "#d9a441"; }

  // ----------------------------------------------------------- Aktionen
  function toggleCard(id, vm) {
    if (!vm.yourTurn) return;
    if (app.ui.selected[id]) delete app.ui.selected[id]; else app.ui.selected[id] = true;
    render();
  }
  function playSelected(vm) {
    var ids = vm.hand.filter(function (c) { return app.ui.selected[c.id]; }).map(function (c) { return c.id; });
    if (!ids.length) return;
    var rank;
    if (vm.variant === "asc") rank = vm.currentRank;
    else rank = vm.roundRank != null ? vm.roundRank : (app.ui.pickRank != null ? app.ui.pickRank : E.bestRankIdx(vm.hand));
    app.ui.selected = {}; app.ui.pickRank = null;
    if (vm.online) netSend({ t: "play", cardIds: ids, rank: rank });
    else Offline.play(ids, rank);
  }
  function onChallenge(vm) {
    if (vm.online) netSend({ t: "challenge" });
    else Offline.challenge(vm.challengerIdx);
  }
  function onRematch() {
    if (app.mode === "online") netSend({ t: "rematch" });
    else Offline.start(app.mode, app.offCfg);
  }
  function onMenu() {
    if (app.mode === "online") leaveToHome();
    else { Offline.clearTimers(); app.off = null; app.screen = "home"; app.mode = null; render(); }
  }
  function leaveToHome() {
    app.leaving = true; clearSession();
    try { netSend({ t: "leave" }); } catch (e) {}
    try { if (app.net) app.net.close(); } catch (e) {}
    app.net = null; app.room = null; app.code = null; app.token = null; app.mode = null;
    Chat.remove(); app.screen = "home"; render();
  }

  // ----------------------------------------------------------- Offline-Steuerung
  var Offline = {
    timers: { auto: null, reveal: null, pickup: null },
    clearTimers: function () { for (var k in this.timers) { if (this.timers[k]) { clearTimeout(this.timers[k]); this.timers[k] = null; } } },
    start: function (mode, cfg) {
      this.clearTimers();
      app.mode = mode; app.screen = "offline-play";
      var players = [];
      if (mode === "bots") {
        players.push({ name: (cfg.names[0] || "").trim() || "Du", isBot: false });
        var used = [];
        for (var i = 1; i < cfg.numPlayers; i++) {
          var bn; do { bn = E.BOTNAMES[Math.floor(Math.random() * E.BOTNAMES.length)]; } while (used.indexOf(bn) >= 0);
          used.push(bn); players.push({ name: bn, isBot: true });
        }
      } else {
        for (var j = 0; j < cfg.numPlayers; j++) players.push({ name: (cfg.names[j] || "").trim() || ("Spieler " + (j + 1)), isBot: false });
      }
      app.off = { mode: mode, variant: cfg.variant, revealed: mode !== "pass" };
      app.off.game = E.newGame({ players: players, variant: cfg.variant });
      Sound.unlock(); app.banner.on = false;
      render();
      if (this.over()) return;
      this.schedule();
    },
    play: function (cardIds, rank) {
      var g = app.off.game, idx = g.turn;
      var chk = E.legalPlay(g, idx, cardIds, rank); if (!chk.ok) { toast(chk.error); return; }
      var r = E.applyPlay(g, idx, cardIds, rank); app.off.game = r.state;
      Sound.play();
      if (app.mode === "pass") app.off.revealed = false;
      render();
      if (this.over()) return;
      this.schedule();
    },
    botPlay: function (idx, cardIds, rank) {
      var r = E.applyPlay(app.off.game, idx, cardIds, rank); app.off.game = r.state;
      Sound.play(); render();
      if (this.over()) return;
      this.schedule();
    },
    challenge: function (by) {
      var g = app.off.game;
      var chk = E.legalChallenge(g, by); if (!chk.ok) { toast(chk.error); return; }
      this.clearTimers();
      var r = E.applyChallenge(g, by); app.off.game = r.state;
      var rv = app.off.game.reveal;
      Sound.challenge();
      setBanner(byLabelOffline(by) + " zweifelt an!");
      render();
      var self = this;
      this.timers.reveal = setTimeout(function () {
        self.timers.reveal = null;
        var honest = rv.honest, loser = rv.loser, claimer = rv.claimer;
        var res = E.resolveReveal(app.off.game); app.off.game = res.state;
        Sound.reveal(honest);
        var take = takeLabelOffline(loser);
        setBanner(honest ? ("Die Wahrheit! " + take) : (claimerLabelOffline(claimer) + " geblufft! " + take));
        render();
        if (self.over()) return;
        if (res.hadPickup) {
          self.timers.pickup = setTimeout(function () {
            self.timers.pickup = null;
            app.off.game = E.endPickup(app.off.game);
            if (app.mode === "pass") app.off.revealed = false;
            render(); self.schedule();
          }, PICKUP_MS);
        } else {
          if (app.mode === "pass") app.off.revealed = false;
          self.schedule();
        }
      }, REVEAL_MS);
    },
    schedule: function () {
      if (this.timers.auto) { clearTimeout(this.timers.auto); this.timers.auto = null; }
      var g = app.off.game;
      if (!g || g.status !== "playing" || g.phase !== "play") return;
      var self = this;
      if (g.lastPlay) {
        var elig = [];
        g.players.forEach(function (p, i) { if (i !== g.lastPlay.player && p.isBot && E.canProveImpossible(g, i)) elig.push(i); });
        if (elig.length && Math.random() < 0.9) {
          var by = elig[Math.floor(Math.random() * elig.length)];
          this.timers.auto = setTimeout(function () { self.timers.auto = null; self.challenge(by); }, 800);
          return;
        }
      }
      var cur = g.players[g.turn];
      if (cur && cur.isBot) {
        this.timers.auto = setTimeout(function () {
          self.timers.auto = null;
          var gg = app.off.game;
          if (!gg || gg.status !== "playing" || gg.phase !== "play" || !gg.players[gg.turn].isBot) return;
          var dec = E.botDecide(gg);
          if (dec.action === "challenge") self.challenge(gg.turn);
          else self.botPlay(gg.turn, dec.cardIds, dec.rank);
        }, BOT_MS);
      }
    },
    reveal: function () { app.off.revealed = true; render(); },
    over: function () {
      var g = app.off.game;
      if (g.status === "over") {
        this.clearTimers();
        var youWon = app.mode === "bots" ? (g.winner === 0) : (g.winner != null);
        Sound[youWon ? "win" : "lose"]();
        render();
        return true;
      }
      return false;
    },
  };
  function dispOff(i) { return app.mode === "bots" && i === 0 ? "Du" : (app.off.game.players[i] ? app.off.game.players[i].name : "?"); }
  function byLabelOffline(by) { return app.mode === "bots" && by === 0 ? "Du" : dispOff(by); }
  function takeLabelOffline(loser) { return (app.mode === "bots" && loser === 0) ? "Du nimmst den Stapel." : dispOff(loser) + " nimmt den Stapel."; }
  function claimerLabelOffline(c) { return (app.mode === "bots" && c === 0) ? "Du hast" : dispOff(c) + " hat"; }

  // ----------------------------------------------------------- Offline-Setup
  function renderOfflineSetup() {
    var cfg = app.offCfg;
    var isBots = app.mode === "bots";
    var body = el("div", {});
    append(body, backLink(function () { app.screen = "home"; app.mode = null; render(); }));
    append(body, el("div", { style: "font-family:'Playfair Display',serif;font-weight:800;font-size:32px;color:#173f4c;margin-bottom:2px;", text: isBots ? "Gegen Bots" : "Pass & Play" }));
    append(body, el("div", { style: "font-size:13px;color:#7e948f;margin-bottom:16px;", text: isBots ? "Du gegen KI-Gegner auf diesem Gerät." : "Reihum auf einem Gerät — Hand wird zwischendurch verdeckt." }));

    append(body, sectionLabel("Variante"));
    append(body, el("div", { style: "display:grid;grid-template-columns:1fr 1fr;gap:10px;" },
      pill(cfg.variant === "same", "Gleiche Zahl", "Immer dieselbe Zahl", function () { cfg.variant = "same"; render(); }),
      pill(cfg.variant === "asc", "Aufsteigend", "2, 3, 4 … der Reihe nach", function () { cfg.variant = "asc"; render(); })));

    append(body, el("div", { style: "margin-top:18px;" }, sectionLabel("Spieler")));
    append(body, el("div", { style: "display:flex;align-items:center;justify-content:space-between;background:#fff;border:1px solid rgba(31,79,94,.14);border-radius:14px;padding:8px 10px;" },
      el("button", { onclick: function () { cfg.numPlayers = Math.max(3, cfg.numPlayers - 1); render(); }, style: stepBtn() }, "–"),
      el("div", { style: "text-align:center;" },
        el("div", { style: "font-family:'Playfair Display',serif;font-weight:800;font-size:30px;line-height:1;color:#173f4c;", text: String(cfg.numPlayers) }),
        el("div", { style: "font-size:11px;color:#86a09b;", text: "3 – 6 Spieler" })),
      el("button", { onclick: function () { cfg.numPlayers = Math.min(6, cfg.numPlayers + 1); render(); }, style: stepBtn() }, "+")));

    append(body, el("div", { style: "margin-top:18px;" }, sectionLabel(isBots ? "Dein Name" : "Spielernamen")));
    var fields = el("div", { style: "display:flex;flex-direction:column;gap:8px;max-height:188px;overflow-y:auto;" });
    var cnt = isBots ? 1 : cfg.numPlayers;
    for (var i = 0; i < cnt; i++) (function (i) {
      append(fields, el("div", { style: "display:flex;align-items:center;gap:10px;background:#fff;border:1px solid rgba(31,79,94,.14);border-radius:12px;padding:6px 8px;" },
        el("span", { style: "width:30px;height:30px;border-radius:50%;flex:none;display:flex;align-items:center;justify-content:center;font-weight:800;font-size:13px;color:#fff;background:" + E.PALETTE[i % E.PALETTE.length] + ";", text: ((cfg.names[i] || "").trim()[0] || (i + 1)).toString().toUpperCase() }),
        el("input", { value: cfg.names[i] || "", maxlength: 14, placeholder: isBots ? "Dein Name" : ("Spieler " + (i + 1)),
          oninput: function (e) { cfg.names[i] = e.target.value; var dot = e.target.previousSibling; if (dot) dot.textContent = ((e.target.value || "").trim()[0] || (i + 1)).toString().toUpperCase(); },
          style: "flex:1;border:none;outline:none;background:transparent;font-size:15px;font-weight:600;color:#173f4c;min-width:0;" })));
    })(i);
    append(body, fields);

    append(body, el("div", { style: "margin-top:20px;" }, primaryBtn("Spiel starten", function () { Offline.start(app.mode, cfg); })));
    return lobbyCardWrap(body);
  }
  function stepBtn() { return "width:40px;height:40px;border-radius:10px;border:none;background:#1f4f5e;color:#fbf3e2;font-size:24px;font-weight:700;cursor:pointer;line-height:1;"; }

  // ----------------------------------------------------------- Chat-Dock
  var Chat = {
    el: null, log: null, panel: null, open: false, rendered: 0, unread: 0,
    ensure: function () {
      if (app.mode !== "online" || !app.room) { this.remove(); return; }
      if (!this.el) this.build();
      this.sync();
    },
    build: function () {
      var self = this;
      this.rendered = 0; this.unread = 0; this.open = false;
      this.log = el("div", { class: "log" });
      var input = el("input", { placeholder: "Nachricht…", maxlength: 200 });
      var form = el("form", { onsubmit: function (e) { e.preventDefault(); var t = input.value.trim(); if (t) { netSend({ t: "chat", text: t }); input.value = ""; } } },
        input, el("button", { class: "send", type: "submit" }, "Senden"));
      this.panel = el("div", { class: "panel", style: "display:none;" }, this.log, form);
      this.toggleBtn = el("button", { class: "lg-chat-toggle", onclick: function () { self.toggle(); } }, el("span", {}, "💬 Chat"), el("span", { class: "lg-chat-badge", style: "display:none;" }, "0"));
      this.el = el("div", { id: "lg-chat" }, this.toggleBtn, this.panel);
      document.body.appendChild(this.el);
    },
    toggle: function () {
      this.open = !this.open;
      this.panel.style.display = this.open ? "flex" : "none";
      this.toggleBtn.style.display = this.open ? "none" : "inline-flex";
      if (this.open) { this.unread = 0; this.updateBadge(); this.log.scrollTop = this.log.scrollHeight; }
    },
    sync: function () {
      var msgs = app.room.chat || [];
      for (var i = this.rendered; i < msgs.length; i++) {
        var m = msgs[i];
        this.append(m);
        if (!this.open && !m.sys) this.unread++;
        if (!m.sys && m.index !== youIdx()) Sound.ping();
      }
      this.rendered = msgs.length;
      this.updateBadge();
      if (this.open) this.log.scrollTop = this.log.scrollHeight;
    },
    append: function (m) {
      if (m.sys) { append(this.log, el("div", { class: "row sys", text: m.text })); return; }
      append(this.log, el("div", { class: "row" },
        el("span", { class: "who", style: "color:" + (m.color || "#d9a441") + ";", text: (m.name || "?") + ": " }),
        document.createTextNode(m.text)));
    },
    updateBadge: function () {
      if (!this.toggleBtn) return;
      var b = this.toggleBtn.querySelector(".lg-chat-badge");
      if (!b) return;
      if (this.unread > 0 && !this.open) { b.style.display = "inline-flex"; b.textContent = String(this.unread); }
      else b.style.display = "none";
    },
    remove: function () { if (this.el) { this.el.remove(); this.el = null; this.rendered = 0; this.open = false; } },
  };

  // ----------------------------------------------------------- Boot
  function init() {
    if (!$("lg-toast")) document.body.appendChild(el("div", { id: "lg-toast" }));
    // ?room=CODE vorbefüllen
    var params = new URLSearchParams(location.search);
    var roomParam = (params.get("room") || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
    if (roomParam) { app.onlineForm.code = roomParam; app.screen = "online-setup"; }
    // Vorherige Sitzung wiederaufnehmen?
    var saved = null; try { saved = JSON.parse(localStorage.getItem("luegen.session") || "null"); } catch (e) {}
    if (saved && saved.code && saved.token && !roomParam) {
      app.mode = "online"; app.code = saved.code; app.token = saved.token; app.screen = "online-room";
      mount(connecting());
      netConnect().then(function () { netSend({ t: "rejoin", code: saved.code, token: saved.token }); })
        .catch(function () { clearSession(); app.mode = null; app.screen = "home"; render(); });
      // Falls der Server den Sitz nicht kennt, kommt ein error -> wir fallen sanft zurück:
      setTimeout(function () { if (app.mode === "online" && !app.room) { clearSession(); app.mode = null; app.screen = "home"; render(); } }, 4000);
      return;
    }
    render();
  }

  window.addEventListener("resize", function () { if (app.screen === "online-room" || app.screen === "offline-play") render(); });
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();
})();
