# Live-Abstimmung

Kleine Node.js-Demo fuer sync Abstimmungen mit REST + WebSocket.

## Schnellstart

```powershell
cd c:\Repos\Abstimmung
npm install
npm start
```

- HTTP-UI laeuft auf `http://localhost:30000`
- WebSocket Stream nutzt Port `30003`

## Bedienung

1. Beim ersten Aufruf erscheint ein Namensdialog. Der schwebe Button "Name aendern" oeffnet ihn spaeter erneut.
2. Der Button "Adminbereich anzeigen" klappt den Verwaltungsbereich auf; dort ist ein Spoiler mit Passwort `abc` (nur die ersten drei Abstimmungen aktiv, es gibt eine "Keine Auswahl"-Option).
3. Umschalter "Modus": Privat blendet Namen aus, Oeffentlich zeigt sie direkt am Diagramm.
4. "Starten" oeffnet Stimmenabgabe, "Stoppen" startet einen 5-Sekunden-Countdown bis zum Ende, "Zuruecksetzen" loescht Stimmen, setzt Status auf warten und stellt den Modus wieder auf Privat.
5. Alle Aenderungen erscheinen sofort in Diagrammen (Kreis oder Balken je Thema).

## Erweiterungsideen

- Echte Admin-Authentifizierung
- Dauerhafte Speicherung per Datenbank
- Historie/Berichte fuer vergangene Abstimmungen
- Mehrsprachige UI
