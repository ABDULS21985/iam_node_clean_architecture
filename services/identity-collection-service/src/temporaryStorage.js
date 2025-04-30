// services/identity-collection-service/src/temporaryStorage.js
const Redis = require('ioredis');

// Read Redis URL and password from environment variables (or load via ConfigService later if needed)
// These should be defined in your project's root .env file or system environment

let redisClient = null;

/**
 * Initializes the Redis client connection for temporary storage.
 * This should be called once on service startup via server.js.
 * It sets up event listeners and initiates the connection.
 */
const init = () => {
    if (redisClient) {
        console.log('[TemporaryStorage] Redis client already initialized.');
        return;
    }
    try {
        console.log('[TemporaryStorage] Initializing Redis client...');

        const redisHost = process.env.REDIS_HOST || 'localhost';
        const redisPort = process.env.REDIS_PORT || 6379;
        const redisPassword = process.env.REDIS_PASSWORD || null;

        let redisUrl;

        if (redisPassword) {
            console.log('[TemporaryStorage] REDIS_PASSWORD found. Building Redis URL with authentication.');
            redisUrl = `redis://:${redisPassword}@${redisHost}:${redisPort}/0`;
        } else {
            console.warn('[TemporaryStorage] REDIS_PASSWORD not found. Connecting without authentication.');
            redisUrl = `redis://${redisHost}:${redisPort}/0`;
        }

        console.log(`[TemporaryStorage] Final Redis URL: ${redisUrl.replace(/:([^@]+)@/, ':<password>@')}`);

        const options = {
            enableOfflineQueue: true,
            lazyConnect: true,
            retryStrategy(times) {
                const delay = Math.min(times * 50, 2000);
                console.log(`[TemporaryStorage] Retrying Redis connection (attempt ${times}, delay ${delay}ms)`);
                return delay;
            },
            maxRetriesPerRequest: 3
        };

        redisClient = new Redis(redisUrl, options);

        redisClient.on('connect', () => console.log('[TemporaryStorage] Redis client connecting...'));
        redisClient.on('ready', () => console.log('[TemporaryStorage] Redis client ready.'));
        redisClient.on('error', (err) => console.error('[TemporaryStorage] Redis client error:', err.message));
        redisClient.on('close', () => console.log('[TemporaryStorage] Redis client connection closed.'));
        redisClient.on('reconnecting', (delay) => console.log(`[TemporaryStorage] Redis client reconnecting (delay ${delay}ms)...`));
        redisClient.on('end', () => console.log('[TemporaryStorage] Redis client connection ended (will not reconnect).'));

        console.log('[TemporaryStorage] Initiating Redis connection...');
        redisClient.connect().catch(err => {
            console.error('[TemporaryStorage] Initial Redis connection attempt failed:', err.message);
        });

        console.log('[TemporaryStorage] Redis client initialization process started.');
    } catch (error) {
        console.error('[TemporaryStorage] Failed to initialize Redis client (Instantiation Error):', error);
        throw new Error('Failed to initialize temporary storage (Redis client instantiation failed): ' + error.message);
    }
};


/**
 * Saves a data snapshot to Redis. Data is stringified to JSON.
 * @param {string} key - The key to store the snapshot under.
 * @param {object} data - The data object to store.
 * @returns {Promise<void>} Resolves when the data is successfully saved.
 * @throws {Error} If the Redis client is not available or the operation fails.
 */
const saveSnapshot = async (key, data) => {
    // Check if client is initialized and not in a terminal state
    if (!redisClient || redisClient.status === 'end' || redisClient.status === 'closing') {
        console.error('[TemporaryStorage] Redis client not available or closing. Cannot save snapshot.');
        throw new Error('Temporary storage (Redis) client is not available.');
    }
    // Optional: Check if client is 'ready' before proceeding, or rely on offline queue
    // if (redisClient.status !== 'ready') {
    //     console.warn(`[TemporaryStorage] Redis not ready (status: ${redisClient.status}). Queuing save for key: ${key}`);
    //     // Command will be queued if enableOfflineQueue is true
    // }
    try {
        const jsonData = JSON.stringify(data);
        // Use SET command. Could add EX (expire) later if snapshots should be temporary
        await redisClient.set(key, jsonData);
        // console.debug(`[TemporaryStorage] Snapshot saved for key: ${key}`); // Use debug level?
    } catch (error) {
        console.error(`[TemporaryStorage] Error saving snapshot for key ${key}:`, error);
        throw new Error(`Failed to save snapshot to temporary storage: ${error.message}`);
    }
};

/**
 * Loads a data snapshot from Redis. Data is parsed from JSON.
 * @param {string} key - The key of the snapshot to load.
 * @returns {Promise<object|null>} The data object, or null if the key does not exist.
 * @throws {Error} If the Redis client is not available or the operation fails.
 */
const loadSnapshot = async (key) => {
    // Check if client is initialized and not in a terminal state
    if (!redisClient || redisClient.status === 'end' || redisClient.status === 'closing') {
        console.error('[TemporaryStorage] Redis client not available or closing. Cannot load snapshot.');
        throw new Error('Temporary storage (Redis) client is not available.');
    }
    // Optional: Check readiness
    // if (redisClient.status !== 'ready') { ... }
    try {
        const jsonData = await redisClient.get(key);
        if (jsonData === null) {
            // console.debug(`[TemporaryStorage] No snapshot found for key: ${key}`); // Use debug level?
            return null; // Key does not exist
        }
        const data = JSON.parse(jsonData);
        // console.debug(`[TemporaryStorage] Snapshot loaded for key: ${key}`); // Use debug level?
        return data;
    } catch (error) {
        console.error(`[TemporaryStorage] Error loading snapshot for key ${key}:`, error);
        throw new Error(`Failed to load snapshot from temporary storage: ${error.message}`);
    }
};

/**
 * Closes the Redis client connection gracefully.
 * This should be called during service shutdown via server.js.
 * @returns {Promise<void>}
 */
const close = async () => {
     if (redisClient && redisClient.status !== 'end' && redisClient.status !== 'closing') {
         console.log('[TemporaryStorage] Closing Redis client connection...');
         try {
             await redisClient.quit(); // QUIT command, waits for pending replies, then closes connection
             // Alternatively, use .disconnect() for immediate closing without waiting for replies
              // console.log('[TemporaryStorage] Redis client connection closed via quit.'); // 'close' event listener will log this
         } catch (error) {
              console.error('[TemporaryStorage] Error closing Redis client connection:', error);
              // The 'end' event might also fire, but catching errors here is good.
              throw new Error('Failed to close temporary storage (Redis) connection: ' + error.message);
         }
     } else {
          console.log('[TemporaryStorage] Redis client not active or already closing/ended.');
     }
};

// Added getter for redisClient status for health checks if needed directly
const getStatus = () => {
    return redisClient ? redisClient.status : 'uninitialized';
}


module.exports = {
  init,
  saveSnapshot,
  loadSnapshot,
  close, // Export close for graceful shutdown
  getStatus, // Export status getter
  redisClient // Exporting the client instance itself (use with caution)
};