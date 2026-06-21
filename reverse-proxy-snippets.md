# Reverse Proxy Snippets

Use this when the server already hosts n8n and already has Caddy, Nginx, Traefik or another reverse proxy on ports 80/443.

The Eduard app should run only on localhost:

```bash
docker compose -f docker-compose.app-only.yml up -d --build
```

Then route:

```text
angebote.daltec.at -> http://127.0.0.1:3030
```

## Caddy

```caddyfile
angebote.daltec.at {
  encode gzip zstd
  reverse_proxy 127.0.0.1:3030
}
```

Reload:

```bash
sudo caddy reload --config /etc/caddy/Caddyfile
```

## Nginx

```nginx
server {
  server_name angebote.daltec.at;

  location / {
    proxy_pass http://127.0.0.1:3030;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
  }
}
```

Then add HTTPS with Certbot:

```bash
sudo certbot --nginx -d angebote.daltec.at
```

## Traefik

If n8n is already behind Traefik, add labels to the `web` service instead of exposing Caddy. Use the existing Traefik network and route host:

```text
angebote.daltec.at
```
