# ──────────────────────────────────────────────────────────────────────────────
# Leaver Service Image – Alpine + Node 23  (Released Apr 2025)
# ──────────────────────────────────────────────────────────────────────────────
FROM node:23-alpine

###############################################################################
# 1️⃣ Establish the service working directory
###############################################################################
WORKDIR /app/services/leaver-service

###############################################################################
# 2️⃣ Ingest dependency manifests and install production dependencies
###############################################################################
# Copy service-specific package.json and committed package-lock.json
COPY services/leaver-service/package*.json ./

# Deterministic, production-only install
RUN npm ci --omit=dev

###############################################################################
# 3️⃣ Ingest application source and shared modules
###############################################################################
# Copy the leaver-service source code
COPY services/leaver-service/ ./

# Copy shared workspace library into a predictable path
COPY shared/ /app/shared/

###############################################################################
# 4️⃣ Runtime configuration
###############################################################################
# Expose the port configured via LEAVER_PORT (defaults to 4004)
EXPOSE 4004

# Launch the Node.js server
CMD ["node", "src/server.js"]
