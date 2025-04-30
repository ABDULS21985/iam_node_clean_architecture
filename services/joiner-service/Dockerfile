# ──────────────────────────────────────────────────────────────────────────────
# Joiner Service Image – Alpine + Node 23  (Released Apr 2025)
# ──────────────────────────────────────────────────────────────────────────────
FROM node:23-alpine

###############################################################################
# 1️⃣ Set the service workdir first
###############################################################################
WORKDIR /app/services/joiner-service

###############################################################################
# 2️⃣ Copy ONLY the dependency manifests and install prod deps
###############################################################################
# Copy the service-specific package.json **and** committed package-lock.json
COPY services/joiner-service/package*.json ./

# Deterministic, production-only install (lock-file required for npm ci)
RUN npm ci --omit=dev    # npm 7+ syntax replaces --production

###############################################################################
# 3️⃣ Copy the remainder of the source tree
###############################################################################
# Copy service source
COPY services/joiner-service/ ./
# Copy shared workspace code into a predictable path
COPY shared/ /app/shared/

###############################################################################
# 4️⃣ Runtime configuration
###############################################################################
EXPOSE 4002
CMD ["node", "src/server.js"]

# NOTE: env vars from .env are injected by docker-compose via `env_file:`
