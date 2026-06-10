# Deploy — Pultrum Mail Processor (Hostinger VPS)

Containerized deployment with **Docker Compose** (API + PostgreSQL + Redis) behind
**Nginx** with a free **Let's Encrypt** TLS certificate.

---

## 0. Prerequisites

- A Hostinger **VPS** (Ubuntu 22.04/24.04).
- A **domain/subdomain** for the API (e.g. `api.seudominio.com`) with a DNS
  **A record** pointing to the VPS IP.
- A GitHub repository (private recommended — the code is proprietary).

---

## 1. Push to GitHub (from your machine)

The repo is already prepared: `.gitignore` excludes `.env` and certificates, so no
secrets are committed.

```bash
cd pultrum-mail-processor
git init
git add .
git commit -m "Initial commit: Pultrum mail processor"
git branch -M main
git remote add origin git@github.com:<org>/pultrum-mail-processor.git
git push -u origin main
```

> Double-check before pushing: `git status` must **not** list `.env`.
> Only `.env.example` should be tracked.

---

## 2. Prepare the VPS

SSH in and install Docker:

```bash
ssh root@<VPS_IP>

apt update && apt upgrade -y
curl -fsSL https://get.docker.com | sh        # Docker Engine + Compose plugin

# Firewall (if using ufw)
ufw allow OpenSSH
ufw allow 80
ufw allow 443
ufw enable
```

---

## 3. Get the code on the VPS

```bash
git clone git@github.com:<org>/pultrum-mail-processor.git
cd pultrum-mail-processor
```

(For private repos, add a deploy key or use a GitHub PAT.)

---

## 4. Create the production `.env`

```bash
cp .env.example .env
nano .env
```

Set at minimum:

| Variable | Production value |
| --- | --- |
| `NODE_ENV` | `production` |
| `POSTGRES_PASSWORD` | a strong password |
| `CORS_ORIGINS` | your frontend URL, e.g. `https://app.seudominio.com` |
| `MS_CLIENT_ID` / `MS_CLIENT_SECRET` / `MS_TENANT_ID` | Microsoft Graph app |
| `MS_REDIRECT_URI` | `https://api.seudominio.com/auth/callback` |
| `FRONTEND_SETTINGS_URL` | your frontend settings URL |
| `OPENROUTER_API_KEY` | your OpenRouter key |
| `ADMIN_EMAIL` / `ADMIN_PASSWORD` / `ADMIN_NAME` | real admin credentials |

> You can leave `DATABASE_URL`/`REDIS_HOST` as-is — `docker-compose.prod.yml`
> overrides them to the internal `postgres` / `redis` services.

**Also update the domain in Nginx:** edit `nginx/conf.d/pultrum.conf` and replace
every `api.seudominio.com` with your real domain.

---

## 5. Issue the TLS certificate (one-time)

DNS must already point to the VPS. Obtain the cert with a standalone certbot run
(binds port 80 directly, so do this **before** starting Nginx):

```bash
docker run --rm -p 80:80 \
  -v "$PWD/nginx/certbot/conf:/etc/letsencrypt" \
  -v "$PWD/nginx/certbot/www:/var/www/certbot" \
  certbot/certbot certonly --standalone \
  -d api.seudominio.com \
  --email voce@empresa.com --agree-tos --no-eff-email
```

This writes the certificate into `nginx/certbot/conf/live/api.seudominio.com/`,
which Nginx mounts read-only.

---

## 6. Build and start everything

```bash
docker compose -f docker-compose.prod.yml up -d --build
```

What happens:
- `postgres` and `redis` start (with persistent volumes).
- `api` builds, waits for Postgres to be healthy, runs `prisma migrate deploy`
  automatically, then starts on port 3000 (internal).
- `nginx` serves HTTPS on 443 and proxies to the API.

Seed the admin user + mailboxes (one-time):

```bash
docker compose -f docker-compose.prod.yml exec api npm run prisma:seed
```

Check it's up:

```bash
docker compose -f docker-compose.prod.yml ps
docker compose -f docker-compose.prod.yml logs -f api
curl https://api.seudominio.com/health
```

---

## 7. Updates (redeploy)

```bash
git pull
docker compose -f docker-compose.prod.yml up -d --build
```

Migrations are applied automatically on container boot.

---

## 8. Certificate renewal

Let's Encrypt certs last 90 days. Renew with:

```bash
docker run --rm \
  -v "$PWD/nginx/certbot/conf:/etc/letsencrypt" \
  -v "$PWD/nginx/certbot/www:/var/www/certbot" \
  certbot/certbot renew --webroot -w /var/www/certbot

docker compose -f docker-compose.prod.yml exec nginx nginx -s reload
```

Automate it with cron (`crontab -e`), e.g. weekly:

```
0 3 * * 1 cd /root/pultrum-mail-processor && docker run --rm -v "$PWD/nginx/certbot/conf:/etc/letsencrypt" -v "$PWD/nginx/certbot/www:/var/www/certbot" certbot/certbot renew --webroot -w /var/www/certbot && docker compose -f docker-compose.prod.yml exec nginx nginx -s reload
```

---

## 9. Backups (recommended)

Dump the database periodically:

```bash
docker compose -f docker-compose.prod.yml exec postgres \
  pg_dump -U pultrum pultrum_mail_processor > backup_$(date +%F).sql
```

---

## Notes

- **Azure redirect URI:** the value in `MS_REDIRECT_URI` must be registered in the
  Microsoft Entra app registration, otherwise OAuth fails.
- **Switching to the company tenant:** when moving from personal accounts to the
  Pultrum tenant, update `MS_TENANT_ID` (and reconnect the mailboxes via OAuth).
- **Logs:** `docker compose -f docker-compose.prod.yml logs -f api`.
