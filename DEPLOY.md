# Deploy

Ein Produkt, ein Betriebsweg.

## Setup

```bash
npm install
cp .env.production.example .env.production
```

Production laeuft ueber:

```bash
docker compose -f docker-compose.app-only.yml up -d --build
```

Die App bindet lokal auf Port 3030. Der bestehende Reverse Proxy zeigt auf diese lokale App.

## Pflicht vor Live-Betrieb

- Starke Admin-Zugangsdaten setzen.
- Mailzugang verbinden.
- Lager-CSV hochladen.
- Test-Runs pruefen.
- Versand standardmaessig deaktiviert lassen.

## Versand aktivieren

Erst nach erfolgreichem Owner-Review-Proof wird Outbound-Mail in der Umgebung aktiviert.

## Betrieb

```bash
docker compose -f docker-compose.app-only.yml ps
docker compose -f docker-compose.app-only.yml logs -f web
docker compose -f docker-compose.app-only.yml logs -f worker
```
