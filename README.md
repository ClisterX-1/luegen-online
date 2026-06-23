# Lügen — Online-Multiplayer

Das Bluff-Kartenspiel **Lügen** als fertiges Online-Spiel: Räume per Code, Echtzeit über mehrere Geräte, dazu Chat, Revanche und Soundeffekte. Die Offline-Modi **Gegen Bots** und **Pass & Play** sind weiterhin enthalten.

Gebaut aus dem ursprünglichen Claude-Design-Entwurf. Das Spielgefühl, die Optik und die Regeln wurden originalgetreu übernommen — neu sind der Online-Modus und ein schummelsicherer Server.

---

## Was drin ist

```
luegen-online/
├─ server.js            # Server: liefert das Spiel aus + Echtzeit (WebSocket)
├─ package.json         # Abhängigkeiten + Start-Befehl
├─ public/
│  ├─ index.html        # Einstiegsseite
│  ├─ app.js            # Das Spiel im Browser (Design, Online + Offline, Chat, Sound)
│  ├─ engine.js         # Spielregeln (laufen identisch im Server und im Browser)
│  └─ styles.css        # Stile & Animationen
├─ render.yaml          # Ein-Klick-Konfiguration für Render.com
├─ Dockerfile           # Für Container-Hoster (Fly.io u. a.) — optional
└─ README.md            # Diese Anleitung
```

**Warum ein Server?** Lügen lebt vom verdeckten Bluffen. Damit niemand die Karten der anderen oder den verdeckten Stapel auslesen kann, läuft die komplette Spiellogik auf dem Server. Jedes Gerät bekommt **nur die eigenen Karten** geschickt — Schummeln per „Quelltext anschauen" ist damit ausgeschlossen.

---

## Schnell lokal testen (auf deinem Computer)

Voraussetzung: **Node.js 18+** ([nodejs.org](https://nodejs.org) → „LTS" installieren).

```bash
cd luegen-online
npm install
npm start
```

Dann im Browser **http://localhost:3000** öffnen. Für eine echte Testrunde einfach ein zweites Browserfenster (oder den Handy-Browser im selben WLAN) öffnen.

**Mit Freunden im selben WLAN spielen:** Starte wie oben und finde deine lokale IP heraus
(macOS: `ipconfig getifaddr en0`, Windows: `ipconfig`). Deine Freunde öffnen dann
`http://DEINE-IP:3000` (z. B. `http://192.168.1.42:3000`). Dein Computer muss dabei laufen.

> Für „Freunde überall im Internet" geht es weiter unten — dafür stellst du das Spiel einmal kostenlos online.

---

## Kostenlos online stellen — empfohlen: Render.com

Render hat einen kostenlosen Tarif und unterstützt WebSockets. So geht's:

### 1. Code zu GitHub hochladen
1. Erstelle ein kostenloses Konto auf [github.com](https://github.com).
2. Neues Repository anlegen (z. B. `luegen-online`), **Public**.
3. Lade den **gesamten Ordner `luegen-online`** hoch
   (auf der GitHub-Seite: „Add file" → „Upload files" → den Ordnerinhalt hineinziehen → „Commit").
   Den Ordner `node_modules` brauchst du **nicht** mit hochzuladen.

### 2. Bei Render bereitstellen
1. Konto auf [render.com](https://render.com) erstellen und mit GitHub verbinden.
2. **New +** → **Web Service** → dein Repository auswählen.
3. Render erkennt Node automatisch. Falls gefragt:
   - **Build Command:** `npm install`
   - **Start Command:** `npm start`
   - **Instance Type:** `Free`
4. **Create Web Service** klicken und kurz warten, bis „Live" erscheint.
5. Du bekommst eine Adresse wie `https://luegen-online.onrender.com` — das ist dein Spiel.

> Tipp: Mit der Datei `render.yaml` im Projekt kannst du stattdessen **New + → Blueprint** wählen — dann werden Build, Start und Health-Check automatisch gesetzt.

> **Hinweis Gratis-Tarif:** Nach ~15 Minuten ohne Besucher legt sich der Server „schlafen".
> Der erste Aufruf danach dauert ~30 Sekunden, dann läuft alles flüssig. Für ein gelegentliches
> Spiel mit Freunden ist das völlig in Ordnung.

### 3. Spielen
Öffne deine Render-Adresse, klicke **Online spielen → Raum erstellen**, und teile den
**4-stelligen Code** oder den **Einladungslink** (Button „Link kopieren") mit deinen Freunden.
Alle öffnen die Adresse, geben den Code ein — fertig.

---

## Alternative: Railway.app

1. Konto auf [railway.app](https://railway.app) (mit GitHub) erstellen.
2. **New Project** → **Deploy from GitHub repo** → dein Repository.
3. Railway baut und startet automatisch (`npm install` / `npm start`).
4. Unter **Settings → Networking → Generate Domain** bekommst du eine öffentliche Adresse.

## Alternative: Container-Hoster (Fly.io u. a.)

Das beigelegte `Dockerfile` funktioniert mit jedem Container-Hoster. Beispiel Fly.io:
`fly launch` (erkennt das Dockerfile) → `fly deploy`. Der Port wird über `PORT` gesetzt.

---

## Spielregeln (wie im Original-Entwurf)

- Alle Karten werden ausgeteilt. Reihum legt man **verdeckt** eine oder mehrere Karten und **sagt eine Zahl an**.
- **Variante „Gleiche Zahl":** Die erste Person der Runde wählt die Zahl, alle anderen legen auf dieselbe Zahl.
- **Variante „Aufsteigend":** Die angesagte Zahl steigt jede Runde (2, 3, 4 … K, dann wieder 2).
- Man darf **ehrlich** legen oder **bluffen**. Wer dran ist (und jede andere Person online), kann **„Lüge!"** rufen:
  - War es ein Bluff, nimmt die bluffende Person den ganzen Stapel.
  - War es die Wahrheit, nimmt die anzweifelnde Person den Stapel.
- Ein vollständiger **Viererpaar** (außer Assen) wird automatisch abgelegt.
- Wer **alle vier Asse** auf der Hand hat, **verliert** sofort.
- Wer **zuerst alle Karten** los ist, **gewinnt**.

Online kann der Host **Bots** dazunehmen, falls ihr nur zu zweit seid (2–6 Spieler).

---

## Technisches in Kürze

- **Server:** Node.js, Express (statische Dateien) + `ws` (WebSocket). Ein Prozess, ein Port (`process.env.PORT`).
- **Schummelsicher:** autoritativer Server, pro Spieler redigierter Spielzustand (fremde Karten & Stapel bleiben verborgen).
- **Robust:** automatische Wiederverbindung nach kurzem Verbindungsabbruch (Sitzplatz bleibt erhalten); getrennte Spieler werden vorübergehend vom Bot übernommen, damit die Partie weiterläuft.
- **Keine Datenbank nötig:** Räume leben im Arbeitsspeicher und werden aufgeräumt, wenn alle gegangen sind.

Viel Spaß beim Bluffen!
