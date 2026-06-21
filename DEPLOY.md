# Deploy: angebote.daltec.at

## 1. DNS prüfen

```bash
dig +short angebote.daltec.at
```

Erwartet:

```text
178.105.121.24
```

## 2. Server vorbereiten

Auf dem Hetzner-Server:

```bash
sudo apt update
sudo apt install -y git docker.io docker-compose-plugin
sudo systemctl enable --now docker
```

Firewall:

```bash
sudo ufw allow OpenSSH
sudo ufw allow 80/tcp
sudo ufw allow 443/tcp
sudo ufw enable
```

## 3. App ablegen

Beispielpfad:

```bash
sudo mkdir -p /opt/eduard-angebote
sudo chown -R $USER:$USER /opt/eduard-angebote
cd /opt/eduard-angebote
```

Projektdateien in diesen Ordner kopieren.

## 4. Production Env setzen

```bash
cp .env.production.example .env.production
nano .env.production
```

Pflicht:

```text
APP_BASE_URL=https://angebote.daltec.at
ADMIN_PASSWORD_HASH=pbkdf2...
ADMIN_SESSION_SECRET=ein-langer-zufaelliger-secret
EDUARD_INGEST_SECRET=ein-langer-zufaelliger-secret
POSTGRES_PASSWORD=ein-langes-postgres-passwort
POSTGRES_BACKUP_DIR=/app/backups
```

Hash erzeugen:

```bash
node -e "import('./src/auth.js').then(m=>console.log(m.createPasswordHash('NEUES_LANGES_PASSWORT')))"
```

## 5. Gmail OAuth

Google Redirect URL:

```text
https://angebote.daltec.at/api/oauth/google/callback
```

Google OAuth Client JSON nach:

```text
/opt/eduard-angebote/secrets/google-oauth-client.json
```

## 6. Outlook OAuth optional

Microsoft Redirect URL:

```text
https://angebote.daltec.at/api/oauth/microsoft/callback
```

Danach in `.env.production`:

```text
MICROSOFT_CLIENT_ID=...
MICROSOFT_CLIENT_SECRET=...
MICROSOFT_TENANT=common
```

## 7A. Starten, wenn der Server frei ist

Nur nutzen, wenn auf Port 80/443 noch kein n8n oder anderer Reverse Proxy läuft:

```bash
mkdir -p data secrets
docker compose up -d --build
docker compose ps
```

Logs:

```bash
docker compose logs -f web
docker compose logs -f worker
docker compose logs -f caddy
```

## 7B. Starten, wenn n8n schon auf dem Server läuft

Das ist wahrscheinlich dein Fall. Dann darf kein zweiter Caddy/Nginx Port 80/443 belegen.

```bash
mkdir -p data secrets
docker compose -f docker-compose.app-only.yml up -d --build
docker compose -f docker-compose.app-only.yml ps
```

Danach im bestehenden Reverse Proxy routen:

```text
angebote.daltec.at -> http://127.0.0.1:3030
```

Snippets:

```text
reverse-proxy-snippets.md
```

## 8. Öffnen

```text
https://angebote.daltec.at
```

Dann einloggen und Gmail oder Outlook verbinden.

## 9. SaaS-Readiness pruefen

```bash
docker compose -f docker-compose.n8n-network.yml exec web npm run backup:postgres
```

Danach in der Admin-UI `SaaS Readiness` pruefen. Rot bedeutet: nicht extern verkaufen. `DALTEC Proof` bedeutet: interner Betrieb/Proof laeuft, aber SaaS ist noch nicht bewiesen.
