# Eduard Angebote

Ground Truth:

```text
Eduard-Mail rein -> Parser -> Preislogik -> Lager-Match -> Haendler-Mail
```

## Kernflow

1. Ungelesene Eduard-Mail lesen.
2. Kunde, Positionen, Preise und Artikelnummern extrahieren.
3. Preise mit Haendlerregeln, MwSt. und Rundung berechnen.
4. Lager-CSV matchen.
5. HTML-Angebot an den Haendler senden.
6. Run im Flight Recorder speichern.

Keine UI als Produktkern. Keine zweite Angebotswahrheit.

## Production

```bash
cp .env.production.example .env.production
docker compose -f docker-compose.app-only.yml up -d --build
```

## Mailversand

```text
MAIL_SEND_MODE=disabled
MAIL_SEND_MODE=enabled
```

## Daten

```text
data/lager.csv
data/lager-preis-muster.csv
```

## Lokal pruefen

```powershell
npm install
npm test
```
