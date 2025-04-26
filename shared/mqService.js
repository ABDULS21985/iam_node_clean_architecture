// shared/mqService.js
const amqp = require('amqplib'); // You will need to install: npm install amqplib

/**
 * Service for managing connection and channels to the Message Queue (RabbitMQ).
 */
class MqService {
    constructor() {
        this.connection = null;
        this.channel = null;
        this.isConnected = false;
        this.isChannelReady = false;
        this.connectionUrl = process.env.MESSAGE_QUEUE_URL || 'amqp://guest:guest@localhost:5672/'; // Get URL from .env
    }

    /**
     * Initializes the MQ service by establishing a connection and creating a channel.
     * Sets up error listeners for the connection and channel.
     *
     * @returns {Promise<void>} Resolves when connection and channel are ready.
     * @throws {Error} If connection or channel creation fails.
     */
    async init() {
        if (this.isConnected && this.channel) {
            console.log('[MqService] MQ service already initialized.');
            return;
        }

        console.log(`[MqService] Attempting to connect to Message Queue at ${this.connectionUrl}...`);
        try {
            // Establish the connection
            this.connection = await amqp.connect(this.connectionUrl);
            this.isConnected = true;
            console.log('[MqService] Successfully connected to Message Queue.');

            // Add connection error listeners
            this.connection.on('error', (err) => {
                console.error('[MqService] MQ connection error:', err);
                this.isConnected = false; // Mark as disconnected
                this.isChannelReady = false; // Channel is also not ready
                this.connection = null; // Clear connection reference
                this.channel = null; // Clear channel reference
                // TODO: Implement reconnection logic here or rely on service restart
            });
            this.connection.on('close', (err) => {
                console.log('[MqService] MQ connection closed.', err);
                this.isConnected = false; // Mark as disconnected
                this.isChannelReady = false; // Channel is also not ready
                this.connection = null; // Clear connection reference
                this.channel = null; // Clear channel reference
                // TODO: Implement reconnection logic
            });
             this.connection.on('blocked', (reason) => { console.warn('[MqService] MQ connection blocked:', reason); });
             this.connection.on('unblocked', () => { console.log('[MqService] MQ connection unblocked.'); });


            // Create a channel
            this.channel = await this.connection.createChannel();
            this.isChannelReady = true;
            console.log('[MqService] Successfully created MQ channel.');

            // Add channel error listeners
            this.channel.on('error', (err) => {
                console.error('[MqService] MQ channel error:', err);
                this.isChannelReady = false; // Mark channel as not ready
                // TODO: Implement channel recovery logic or rely on service restart/reconnect
            });
            this.channel.on('close', () => {
                console.log('[MqService] MQ channel closed.');
                this.isChannelReady = false; // Mark channel as not ready
                // TODO: Implement channel recovery logic
            });


        } catch (error) {
            console.error('[MqService] Failed to initialize MQ service:', error.message);
            this.isConnected = false;
            this.isChannelReady = false;
            this.connection = null;
            this.channel = null;
            // Re-throw error so calling service can handle initialization failure
            throw new Error(`Failed to initialize MQ service: ${error.message}`);
        }
    }

    /**
     * Waits for the MQ connection and channel to be ready.
     * This function might not be strictly needed after a successful init,
     * but can be used if the channel might be created/recovered asynchronously after init.
     *
     * @returns {Promise<void>} Resolves when connection and channel are ready.
     * @throws {Error} If connection or channel fails to become ready within a timeout (not implemented).
     */
    async waitForChannel() {
        // In this simple implementation, init already waits for channel creation.
        // This function could be used for more complex reconnect/recovery scenarios
        // or to add a timeout check for channel readiness.
        if (this.isConnected && this.channel && this.isChannelReady) {
            return; // Already ready
        } else if (!this.isConnected) {
            // If not connected, attempt initialization again or throw
            console.log('[MqService] waitForChannel: Not connected, attempting init.');
            await this.init(); // Attempt initialization if not connected
        }
        // If init succeeds, the channel should be ready. If init fails, it throws.
        // If init was called elsewhere and resulted in pending state, this would need more logic.
        // For now, rely on init guaranteeing ready state on successful return.
    }

    /**
     * Publishes a message to an exchange with a routing key.
     *
     * @param {string} exchange - The exchange name.
     * @param {string} routingKey - The routing key.
     * @param {object} payload - The message payload (will be JSON stringified).
     * @param {object} [options={}] - Publish options (e.g., persistent: true).
     * @returns {Promise<boolean>} True if the message was sent.
     */
    async publish(exchange, routingKey, payload, options = { persistent: true }) {
        if (!this.isChannelReady) {
            console.error(`[MqService] Cannot publish: Channel is not ready. Exchange: ${exchange}, Key: ${routingKey}`);
            // Decide behavior: Throw error, return false, buffer message?
            // Throwing is appropriate if publishing is critical.
            throw new Error('MQ Channel is not ready for publishing.');
        }
        try {
            const messageBuffer = Buffer.from(JSON.stringify(payload));
            // channel.publish returns a boolean indicating if the message was sent to the buffer.
            // For persistent messages, it always returns true unless the buffer is full.
            const published = this.channel.publish(
                exchange,
                routingKey,
                messageBuffer,
                options
            );
            if (!published) {
                 console.warn(`[MqService] Message not immediately published to channel buffer. Exchange: ${exchange}, Key: ${routingKey}. Buffer likely full.`);
                 // TODO: Handle buffer full scenario if necessary (e.g., wait for 'drain' event)
            }
            return published; // Returns boolean
        } catch (error) {
            console.error(`[MqService] Error publishing message to exchange ${exchange} with key ${routingKey}:`, error);
            // Error during publish means channel might be closed or other issue.
            this.isChannelReady = false; // Assume channel is not ready
            throw new Error(`Failed to publish message: ${error.message}`); // Re-throw error
        }
    }

    /**
     * Sets up a consumer for a queue.
     *
     * @param {string} queue - The queue name.
     * @param {Function} onMessage - Async function to handle incoming messages.
     * @param {object} [options={}] - Consume options (e.g., noAck: false).
     * @returns {Promise<{consumerTag: string}>} Promise resolving with the consumer tag.
     */
    async subscribe(queue, onMessage, options = { noAck: false }) {
         if (!this.isChannelReady) {
            console.error(`[MqService] Cannot subscribe: Channel is not ready. Queue: ${queue}`);
            throw new Error('MQ Channel is not ready for subscribing.');
        }
         try {
             // channel.consume returns a promise resolving with the consumer tag
             const consumer = await this.channel.consume(queue, onMessage, options);
             console.log(`[MqService] Successfully subscribed to queue: ${queue}. Consumer Tag: ${consumer.consumerTag}`);
             return consumer; // Return consumer object which includes the consumerTag
         } catch (error) {
            console.error(`[MqService] Error subscribing to queue ${queue}:`, error);
            this.isChannelReady = false; // Assume channel not ready
            throw new Error(`Failed to subscribe to queue "${queue}": ${error.message}`); // Re-throw
         }
    }

    // TODO: Add methods for asserting queues, exchanges, bindings if not done during init
    // In the server.js worker setup, we assert queues/exchanges/bindings *before* consuming.
    // This is a good place for those assertions if MqService manages them.

    /**
     * Asserts a queue exists.
     * @param {string} queue - Queue name.
     * @param {object} [options={}] - Queue options.
     * @returns {Promise<object>}
     */
    async assertQueue(queue, options = { durable: true }) {
         if (!this.isChannelReady) throw new Error('MQ Channel is not ready for asserting queue.');
         return this.channel.assertQueue(queue, options);
    }

     /**
     * Asserts an exchange exists.
     * @param {string} exchange - Exchange name.
     * @param {string} type - Exchange type.
     * @param {object} [options={}] - Exchange options.
     * @returns {Promise<object>}
     */
    async assertExchange(exchange, type, options = { durable: true }) {
         if (!this.isChannelReady) throw new Error('MQ Channel is not ready for asserting exchange.');
         return this.channel.assertExchange(exchange, type, options);
    }

    /**
     * Binds a queue to an exchange.
     * @param {string} queue - Queue name.
     * @param {string} exchange - Exchange name.
     * @param {string} routingKey - Routing key.
     * @param {object} [args={}] - Binding arguments.
     * @returns {Promise<void>}
     */
    async bindQueue(queue, exchange, routingKey, args = {}) {
         if (!this.isChannelReady) throw new Error('MQ Channel is not ready for binding queue.');
         return this.channel.bindQueue(queue, exchange, routingKey, args);
    }


    // TODO: Add method for cancelling consumer (used in graceful shutdown)
    async cancelConsumer(consumerTag) {
         if (!this.isChannelReady) throw new Error('MQ Channel is not ready for cancelling consumer.');
         if (!consumerTag) {
             console.warn('[MqService] Attempted to cancel consumer with null/undefined tag.');
             return; // Nothing to cancel
         }
         try {
             await this.channel.cancel(consumerTag);
              console.log(`[MqService] Consumer "${consumerTag}" cancelled.`);
         } catch (error) {
              console.error(`[MqService] Error cancelling consumer "${consumerTag}":`, error);
              throw new Error(`Failed to cancel consumer "${consumerTag}": ${error.message}`);
         }
    }


    // TODO: Add method for closing connection (used in graceful shutdown)
    async closeConnection() {
         if (this.connection && this.isConnected) {
              console.log('[MqService] Closing MQ connection...');
              try {
                   // Closing the connection should also close the channel(s) created on it.
                   await this.connection.close();
                   this.isConnected = false;
                   this.isChannelReady = false;
                   this.connection = null;
                   this.channel = null;
                   console.log('[MqService] MQ connection closed.');
              } catch (error) {
                   console.error('[MqService] Error closing MQ connection:', error);
                   throw new Error(`Failed to close MQ connection: ${error.message}`);
              }
         } else {
             console.log('[MqService] MQ connection is not open or not connected.');
         }
    }

}

// Export a singleton instance
module.exports = new MqService();