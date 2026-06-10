# syntax=docker/dockerfile:1

# ---- Builder: install all deps, generate Prisma client, compile ----
FROM node:20-slim AS builder
WORKDIR /app

# openssl is required by Prisma
RUN apt-get update \
  && apt-get install -y --no-install-recommends openssl \
  && rm -rf /var/lib/apt/lists/*

COPY package*.json ./
RUN npm ci

COPY prisma ./prisma
RUN npx prisma generate

COPY . .
RUN npm run build

# ---- Runner: production image ----
FROM node:20-slim AS runner
WORKDIR /app
ENV NODE_ENV=production

RUN apt-get update \
  && apt-get install -y --no-install-recommends openssl \
  && rm -rf /var/lib/apt/lists/*

# Reuse the builder's node_modules: it already contains the generated Prisma
# client, the Prisma CLI (for `migrate deploy`) and ts-node (for the seed).
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/prisma ./prisma
COPY package*.json ./

EXPOSE 3000

# Apply pending migrations on boot, then start the API.
CMD ["sh", "-c", "npx prisma migrate deploy && node dist/main"]
