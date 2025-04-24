# services/identity-collection-service/Dockerfile

# ---------------------------------------------------------------------------
# IGLM │ Identity-Collection-Service │ OCI Image Definition
# ---------------------------------------------------------------------------
# syntax=docker/dockerfile:1 # Explicitly use the new syntax

# --- Base Image ---
# Use a specific version of the official Node.js image
FROM node:23-slim 

# --- Global Hardening (Optional but good practice) ---
# Set Node.js environment for production (optimizations)
ENV NODE_ENV=production \
    # Disable npm funding/audit messages for cleaner build logs
    NPM_CONFIG_FUND=false \
    NPM_CONFIG_AUDIT=false

# Create a non-root user and group named 'app'
RUN groupadd -r app && useradd -r -g app app

# --- Dependency Layer – cache-friendly install ---
# Set the working directory inside the container where app code will live
# All subsequent COPY and RUN commands are relative to this directory (/app)
WORKDIR /app

# Copy package.json and package-lock.json (or yarn.lock) from context to container
# Source paths are relative to the build context (project root)
# Destination paths are relative to the current WORKDIR (/app)
# Ensure package.json and lock files exist at these source paths on your host
COPY shared/package*.json ./shared/ # Copy manifests from context root/shared/ to /app/shared/
COPY services/identity-collection-service/package*.json ./services/identity-collection-service/ # Copy manifests from context root/services/.../ to /app/services/.../

# Install dependencies for the shared module (in /app/shared)
# Use BuildKit cache mount for npm cache. Install ALL deps (removed --omit=dev).
# cd into the target directory to run npm ci there
RUN --mount=type=cache,target=/root/.npm cd ./shared && npm ci

# Install dependencies for the service module (in /app/services/identity-collection-service)
# Use BuildKit cache mount for npm cache. Install ALL deps (removed --omit=dev).
# cd into the target directory to run npm ci there
RUN --mount=type=cache,target=/root/.npm cd ./services/identity-collection-service && npm ci


# --- Application Layer – copy the rest of the code ---
# Copy all source code from context to container working directory (/app)
# Source paths are relative to the build context (project root)
# Destination paths are relative to the current WORKDIR (/app)
COPY shared/ ./shared/ # Copy shared source code from context root/shared/ to /app/shared/
COPY services/identity-collection-service/ ./services/identity-collection-service/ # Copy service source code from context root/services/.../ to /app/services/.../


# --- Build Steps (if any, e.g., TypeScript compilation) ---
# If you use TypeScript, add build commands here AFTER copying all code
# Example: RUN cd /app/shared && npm run build && cd /app/services/identity-collection-service && npm run build


# --- Runtime Configuration ---
# Switch to the non-root user for running the application
USER app

# Set the working directory for the application execution
# This is the directory where your main script (src/server.js) should be run from
# It's /app + the service's code location within /app
WORKDIR /app/services/identity-collection-service

# Expose the port the service listens on
EXPOSE 4001

# Define the command to run the application
# This array format is recommended (exec form)
CMD ["node", "src/server.js"]

# --- Healthcheck (Optional but recommended) ---
# Checks if the service is running by hitting its health endpoint
# Uses a simple http GET request. Corrected the path to /health.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "const http = require('http'); http.get('http://localhost:4001/health', (res) => { console.log(`HEALTHCHECK STATUS: ${res.statusCode}`); process.exit(res.statusCode === 200 ? 0 : 1); }).on('error', (e) => { console.error(`HEALTHCHECK ERROR: ${e.message}`); process.exit(1); });"