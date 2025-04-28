# Use a lightweight Node.js base image
# Using Alpine variant for smaller image size
FROM node:23-alpine

# Set the working directory inside the container
WORKDIR /app/services/identity-collection-service

# Copy package.json and package-lock.json from the project root and the service directory
# We copy these first to leverage Docker's build cache
# Assuming build context is the project root (../) as defined in docker-compose.yml
COPY package*.json /app/

# Copy the service's package.json
COPY services/identity-collection-service/package*.json ./

# Install dependencies
# This will install root dependencies and service dependencies
# RUN npm install --production # Use --production to install only production dependencies
RUN npm install

# Copy the rest of the application code
# Copy the shared module
COPY shared /app/shared
# Copy the Identity Collection Service code
COPY services/identity-collection-service/src ./src
# Copy scripts if needed by the service at runtime (e.g., init scripts)
# COPY scripts /app/scripts

# Expose the port the service runs on (defined in your .env and service config)
# Ensure this matches the port variable used in src/server.js (IDCS_PORT)
ARG SERVICE_PORT=4001
EXPOSE ${SERVICE_PORT}

# Define environment variables within the container (can be overridden by docker-compose.yml)
ENV NODE_ENV=development
# ENV LOG_LEVEL=info # Can be set via docker-compose env_file or environment

# Command to run the application
# This assumes your main server file is src/server.js
CMD ["node", "src/server.js"]