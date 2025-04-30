# ──────────────────────────────────────────────────────────────────────────────
# Joiner Service Image – Alpine + Node 23 (Monorepo Multi-Stage Build, Apr 2025)
# ──────────────────────────────────────────────────────────────────────────────

### ── Stage 1: Builder ─────────────────────────────────────────────────────────
FROM node:23-alpine AS builder

# 1️⃣ Set root working directory
WORKDIR /app

# 2️⃣ Copy ALL package.json files (including shared if they exist)
COPY package*.json ./
COPY services/joiner-service/package*.json ./services/joiner-service/
COPY shared/package*.json ./shared/  

# 3️⃣ Install root dependencies and service dependencies
RUN npm ci --omit=dev --workspace=services/joiner-service

# 4️⃣ Copy service source
COPY services/joiner-service/ ./services/joiner-service/

# 5️⃣ Copy shared code
COPY shared/ ./shared/


### ── Stage 2: Runtime ─────────────────────────────────────────────────────────
FROM node:23-alpine

# 6️⃣ Set service working directory
WORKDIR /app/services/joiner-service

# 7️⃣ Bring in installed deps from builder
COPY --from=builder /app/node_modules ./node_modules

# 8️⃣ Copy service source
COPY --from=builder /app/services/joiner-service/ ./

# 9️⃣ Copy shared code
COPY --from=builder /app/shared/ /app/shared/

# 🔧 Expose port from JOINER_PORT (default 4002)
EXPOSE 4002

# 🚀 Start the service
CMD ["node", "src/server.js"]