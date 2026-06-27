# Deploy

Ein Produkt, ein Betriebsweg: Worker, Backup, Postgres.

## Setup

```bash
npm install
cp .env.production.example .env.production
docker compose -f docker-compose.app-only.yml up -d --build
```

## Pflicht

- Mailzugang verbunden.
- Lager-CSV vorhanden.
- Starke Secrets gesetzt.
- MAIL_SEND_MODE bewusst gesetzt.

## Betrieb

```bash
docker compose -f docker-compose.app-only.yml ps
docker compose -f docker-compose.app-only.yml logs -f worker
docker compose -f docker-compose.app-only.yml logs -f backup
```
