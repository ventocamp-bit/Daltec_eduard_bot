# Eduard Angebote

Angebots-Automation für Eduard-Anfragen.

## Was die App macht

1. Liest ungelesene Eduard-Anfragen aus Gmail oder Outlook.
2. Extrahiert Kunde, Positionen und Preise aus der Mail.
3. Berechnet Angebotspreise mit Rabatt, Rundung, MwSt. und Kategorie-Regeln.
4. Matcht die Anfrage gegen die lokale Lager-/Preis-CSV.
5. Erstellt einen HTML-Angebotsvorschlag und sendet ihn intern an den Owner.
6. Speichert jeden Run als Flight Recorder mit Status, Events und Snapshots.

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

Lokaler Standard-Login:

```text
admin@daltec.local
admin
```

## Production

Production-Ziel:

```text
https://angebote.daltec.at
```

Siehe:

```text
DEPLOY.md
```

OAuth Redirect URLs:

```text
https://angebote.daltec.at/api/oauth/google/callback
https://angebote.daltec.at/api/oauth/microsoft/callback
```

## Daten

Die App nutzt eine CSV für Lager, Preise und Upsell:

```text
data/lager.csv
```

Muster:

```text
data/lager-preis-muster.csv
```

Wichtige Spalten:

```text
Lager
Art.-Nr.
Art.-Bez.
Ser.-Nr. (int)
Lagermenge
Lagerwert
Laenge
Breite
hzGGew
```

## Tests

```powershell
npm test
```

## SaaS Readiness

Die App unterscheidet hart zwischen DALTEC-Proof und verkaufbarem SaaS. Die Admin-UI zeigt unter `SaaS Readiness`, was noch blockiert.

Pflicht für externen SaaS-Betrieb:

```text
Postgres aktiv
starke Secrets
ADMIN_PASSWORD_HASH statt Plain-Passwort
aktuelles Postgres Backup
Mailzugang verbunden
keine automatische Kundenmail
Google OAuth verifiziert oder Pilot über zentrale Weiterleitung
100 echte Proof-Runs
20 Owner-Feedbacks
Safe Draft Acceptance >= 80 %
```

Backup manuell ausloesen:

```powershell
npm run backup:postgres
```

## Replay Proof

Exportierte Eduard-Mails als JSON, JSONL oder Ordner mit JSON/JSONL-Dateien replayen:

```powershell
npm run replay -- --file .\data\replay-mails --tenant daltec-local
```

Der Replay verschickt keine Owner-Mail. Er erzeugt Runs im Flight Recorder und reportet Status, Duplikate, Review-Gründe, Snapshots und gefährliche Fälle. Für den DALTEC-Proof zuerst 20 echte alte Mails replayen, danach die häufigsten Fehlerursachen fixen.

Gmail-Fixtures read-only exportieren, ohne Labels oder Read-Status zu aendern:

```powershell
npm run export:gmail -- --limit 20 --out .\data\replay-exports\daltec-20.json
npm run replay -- --file .\data\replay-exports\daltec-20.json --tenant daltec-local
```

Für einen sauberen SaaS-Proof ohne Live-Metriken zu verschmutzen, einen isolierten Proof-Tenant mit echter DALTEC-Konfiguration und Lagerdaten seed'en:

```powershell
npm run replay -- --file .\data\replay-exports\daltec-20.json --tenant daltec-proof-20 --source-tenant daltec-local --provider replay_test
```

Der Proof-Tenant kopiert nur `tenant.json`, `settings.json` und `lager.csv`. Keine Gmail-Tokens, keine alten Runs und keine Owner-Mails werden kopiert oder verschickt.
