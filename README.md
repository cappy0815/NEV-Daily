# NEV Daily

Handy-Webseite zum Trainingsplan des Neusser EV.

- **Jetzt auf dem Eis:** wer gerade die Eisfläche belegt, wer im Off-Ice-Raum ist und wer als Nächstes aufs Eis geht.
- **Heute:** Tagesplan der Halle, chronologisch, mit Blättern auf andere Tage. Optional alle Termine inkl. Auswärtsspiele und externer Eiszeiten.
- **Mannschaft:** Team wählen (wird im Browser gemerkt) und alle Termine der Woche Mo–So sehen, mit Blättern auf andere Wochen.

## Datenquelle

Google Sheet „NEV Trainingsplan“, ein Tabellenblatt pro Monat mit dem Namen `<Monat> <Jahr>` (z. B. `November 2026`).
Die Seite liest das Blatt direkt über den öffentlichen gviz-CSV-Endpunkt von Google. Voraussetzung: Das Sheet ist für „Jeder mit dem Link“ lesbar.

Wird ein Monatsblatt noch nicht gefunden, zeigt die Seite „Plan … noch nicht online“.

Erkannte Zellformate:

| Zelle | Bedeutung |
|---|---|
| `17.35 - 18.30 K2` oder `15.00 - 16.15` + Zeile `K3/K4/K5` | Eiszeit in Neuss, Kabine(n) |
| `18.45 - 19.30 Off-Ice A` | Off-Ice, Raum A (B, AB) |
| `18.15 - 19.15` + Zeile `Eissporthalle Moers` | Eiszeit extern |
| `LS 15.00 - …` / `TW 11.30 - …` | Laufschule / Torwart-Training |
| `H 20.00` + Gegner | Heimspiel |
| `A 18.00` + Gegner | Auswärtsspiel |
| `H 20.30 @ Moers` / `A 12.45` + `@ Ratingen` | Spielort extern |

Spiele haben im Plan nur eine Anfangszeit. Für die Anzeige „Halle belegt“ wird eine Dauer von 150 Minuten angenommen (`GAME_DURATION_MIN` in `app.js`).

## Dateien

- `index.html`, `style.css`, `app.js` – die Seite, ohne Build-Schritt und ohne externe Bibliotheken
- `manifest.webmanifest`, `assets/` – Logo und Icons, damit die Seite als App auf den Startbildschirm gelegt werden kann

## Veröffentlichen (GitHub Pages)

Settings → Pages → Source „Deploy from a branch“ → Branch `main`, Ordner `/ (root)`.
Erreichbar unter https://cappy0815.github.io/NEV-Daily/ – andere Schreibweisen (z. B. `/nev-daily`) leitet die `404.html` im Repo `cappy0815.github.io` weiter.

## Belegungsplan Stadt

Steht laut Trainingsplan kein NEV-Team auf dem Eis, zeigt die Seite die Belegung aus dem Blatt „Belegungsplan Stadt“ (NSK, öffentlicher Lauf, Schule/Kindergarten). Das Blatt ist ein Wochenplan im Viertelstunden-Raster; verbundene Zellen sind die Belegungsblöcke, Ziffern in Klammern verweisen auf die Fußnoten darunter. Es wird über `htmlview` geladen, weil nur dort die verbundenen Zellen enthalten sind. NEV-Blöcke aus diesem Plan zählen nur, wenn im Trainingsplan zur selben Zeit nichts steht.

Logo und Farben: Neusser EV (neusserev.de).

## Neue Version veröffentlichen

GitHub Pages liefert alle Dateien mit `Cache-Control: max-age=600` aus; Handys nehmen `app.js` und `style.css` dann bis zu 10 Minuten aus dem Cache, auch beim Neuladen.
Deshalb bei jeder Änderung in `index.html` die Versionsnummer erhöhen (drei Stellen: `style.css?v=…`, `app.js?v=…` und die Anzeige „Version …“ im Footer).
