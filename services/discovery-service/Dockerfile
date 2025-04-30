# ──────────────────────────────────────────────────────────────────────────────
# Discovery Service Image – Alpine + Node 23 (Updated Apr 2025)
# ──────────────────────────────────────────────────────────────────────────────
FROM node:23-alpine

###############################################################################
# 1️⃣ Establish the service working directory
###############################################################################
WORKDIR /app/services/discovery-service

###############################################################################
# 2️⃣ Ingest dependency manifests and install production dependencies
###############################################################################
# Copy service-specific package.json and package-lock.json
COPY services/discovery-service/package*.json ./

# Install dependencies (including dotenv)
RUN npm ci --omit=dev

###############################################################################
# 3️⃣ Ingest application source and shared modules
###############################################################################
# Copy the discovery-service source code
COPY services/discovery-service/ ./

# Copy shared workspace library from the repo root into a predictable path
COPY shared/ /app/shared/

###############################################################################
# 4️⃣ Runtime configuration
###############################################################################
# Expose the port configured via DISCOVERY_PORT (defaults to 4006)
EXPOSE 4006

# Launch the Node.js discovery entrypoint
CMD ["node", "src/server.js"]
