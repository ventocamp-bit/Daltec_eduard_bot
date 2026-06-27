# Eduard Angebote

Ein Werkzeug fuer eine Aufgabe: Eduard-Anfragen in pruefbare Angebotsentwuerfe verwandeln.

## Produktversprechen

1. Mail-Eingang lesen.
2. Eduard-Anfrage erkennen.
3. Kunde und Positionen extrahieren.
4. Preis mit Haendlerregeln berechnen.
5. Lager-CSV matchen.
6. Entwurf intern zur Pruefung bereitstellen.
7. Erst nach menschlicher Pruefung senden.

Kein Auto-Send als Standard. Kein Demo-SaaS-Theater im Hauptflow.

## Lokal starten

```powershell
npm install
Copy-Item .env.example .env
npm run admin
```

Admin:

```text
http://localhost:3030
```

## Production

Ein Production-Pfad:

```bash
cp .env.production.example .env.production
docker compose -f docker-compose.app-only.yml up -d --build
```

Reverse Proxy:

```text
angebote.daltec.at -> http://127.0.0.1:3030
```

## Daten

Die App nutzt eine CSV fuer Lager, Preise und Upsell.

```text
data/lager.csv
```

Pflichtspalten stehen in:

```text
data/lager-preis-muster.csv
```

## Mailversand

Outbound-Mail ist standardmaessig deaktiviert:

```text
MAIL_SEND_MODE=disabled
```

Echter Versand wird erst aktiviert, wenn Setup, Testdaten und Owner-Review stabil sind:

```text
MAIL_SEND_MODE=enabled
```

## Tests

```powershell
npm test
```
