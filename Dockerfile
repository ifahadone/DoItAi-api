# syntax=docker/dockerfile:1
# Multi-stage build for the DoIT API (ApiSpec §16 — stateless container).

# --- deps: install ALL deps (incl. dev) for the build ----------------------
FROM node:22-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json* ./
# `npm ci` when a lockfile exists; fall back to `npm install` otherwise.
RUN if [ -f package-lock.json ]; then npm ci; else npm install; fi

# --- build: compile TypeScript -> dist -------------------------------------
FROM node:22-alpine AS build
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN npm run build

# --- prod-deps: production-only node_modules -------------------------------
FROM node:22-alpine AS prod-deps
WORKDIR /app
COPY package.json package-lock.json* ./
RUN if [ -f package-lock.json ]; then npm ci --omit=dev; else npm install --omit=dev; fi

# --- runtime: minimal image ------------------------------------------------
FROM node:22-alpine AS runtime
ENV NODE_ENV=production
WORKDIR /app
# Run as the built-in non-root `node` user.
USER node
COPY --chown=node:node package.json ./
COPY --chown=node:node loader.mjs ./loader.mjs
COPY --chown=node:node --from=prod-deps /app/node_modules ./node_modules
COPY --chown=node:node --from=build /app/dist ./dist
# Migrations ship in the image so a release step can run `db:migrate`.
COPY --chown=node:node --from=build /app/drizzle ./drizzle
COPY --chown=node:node --from=build /app/drizzle.config.ts ./drizzle.config.ts

EXPOSE 3000
# The platform health check should hit GET /ready.
# `--import ./loader.mjs` resolves the @/* path alias at runtime (see loader.mjs).
CMD ["node", "--import", "./loader.mjs", "dist/index.js"]
