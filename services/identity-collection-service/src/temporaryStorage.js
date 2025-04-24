// services/identity-collection-service/src/temporaryStorage.js
const Redis = require('ioredis');

// Read Redis URL and password from environment variables (or load via ConfigService later if needed)
// These should be defined in your project's root .env file
const redisUrl = process.env.REDIS_URL || 'redis://localhost:6379'; // Default URL for local development
const redisPassword = process.env.REDIS_PASSWORD; // Optional: Password if your Redis requires auth

let redisClient = null;

/**
 * Initializes the Redis client connection for temporary storage.
 * This should be called once on service startup via server.js.
 * It sets up event listeners and initiates the connection.
 */
const init = () => {
    if (redisClient) {
        console.log('[TemporaryStorage] Redis client already initialized.');
        return; // Prevent double initialization
    }
    try {
        console.log('[TemporaryStorage] Initializing Redis client...');
        const options = {
            enableOfflineQueue: true, // Queue commands while reconnecting
            // Add more advanced options here as needed (reconnect strategies, command timeouts, etc.)
             lazyConnect: true, // Connect only when the first command is sent (or use .connect())
        };
        if (redisPassword) {
             options.password = redisPassword;
        }

        // Create the Redis client instance
        redisClient = new Redis(redisUrl, options);

        // --- Connection Event Listeners ---
        redisClient.on('connect', () => console.log('[TemporaryStorage] Redis client connected.'));
        redisClient.on('ready', () => console.log('[TemporaryStorage] Redis client ready.'));
        redisClient.on('error', (err) => console.error('[TemporaryStorage] Redis client error:', err.message));
        redisClient.on('close', () => console.log('[TemporaryStorage] Redis client connection closed.'));
        redisClient.on('reconnecting', (delay, attempt) => console.log(`[TemporaryStorage] Redis client reconnecting (attempt ${attempt}, delay ${delay}ms).`));
        redisClient.on('end', () => console.log('[TemporaryStorage] Redis client connection ended.'));
        // --- End Event Listeners ---

         // Initiate the connection if not lazyConnect, or if lazyConnect is true, the first command will connect
         // For a startup init, explicitly calling connect is good practice
         redisClient.connect().catch(err => {
             console.error('[TemporaryStorage] Initial Redis connection attempt failed:', err);
             // The 'error' event listener will also catch this.
             // Depending on policy, you might want to throw here to block startup if Redis is essential.
             // For now, we rely on the client queueing commands and eventually connecting.
         });


         console.log('[TemporaryStorage] Redis client initialization started.');
         // The init function itself is synchronous, connection happens asynchronously.
         // Subsequent save/load calls will wait for 'ready' if enableOfflineQueue is true.
    } catch (error) {
        console.error('[TemporaryStorage] Failed to initialize Redis client:', error);
        // This catch is for errors *during* client instantiation, not connection errors.
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
    try {
        const jsonData = JSON.stringify(data);
        // Use SET command. Could add EX (expire) later if snapshots should be temporary
        await redisClient.set(key, jsonData);
        console.log(`[TemporaryStorage] Snapshot saved for key: ${key}`);
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
    try {
        const jsonData = await redisClient.get(key);
        if (jsonData === null) {
            console.log(`[TemporaryStorage] No snapshot found for key: ${key}`);
            return null; // Key does not exist
        }
        const data = JSON.parse(jsonData);
        console.log(`[TemporaryStorage] Snapshot loaded for key: ${key}`);
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
             console.log('[TemporaryStorage] Redis client connection closed.');
         } catch (error) {
              console.error('[TemporaryStorage] Error closing Redis client connection:', error);
              // The 'end' event should also fire, but catching errors here is good.
              throw new Error('Failed to close temporary storage (Redis) connection: ' + error.message);
         }
     } else {
          console.log('[TemporaryStorage] Redis client not active or already closing/ended.');
     }
};


module.exports = {
  init,
  saveSnapshot,
  loadSnapshot,
  close // Export close for graceful shutdown
};