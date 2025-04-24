// shared/mqService.js
const amqp = require('amqplib');
// We can use dotenv directly here, assuming MQ connection is in .env
// For a more robust setup, MQ config could also be loaded via ConfigService
require('dotenv').config({ path: '../../.env' }); // Adjust path based on where you call this from

let connection = null;
let channel = null;

const mqUrl = process.env.MESSAGE_QUEUE_URL || 'amqp://guest:guest@localhost:5672'; // Default URL

/**
 * Establishes the connection to the message queue.
 * Handles connection closing and errors by attempting to reconnect.
 */
const connect = async () => {
    try {
        connection = await amqp.connect(mqUrl);
        console.log('[MQService] Connected to Message Queue.');

        // Handle connection closed
        connection.on('close', (err) => {
            if (err) {
                console.error('[MQService] Connection closed with error:', err);
                console.log('[MQService] Attempting to reconnect in 5 seconds...');
                setTimeout(connect, 5000); // Attempt reconnect
            }
        });

        // Handle connection errors
        connection.on('error', (err) => {
            console.error('[MQService] Connection error:', err);
            // Connection close event should follow, which triggers reconnect
        });

        // Create a channel
        channel = await connection.createChannel();
        console.log('[MQService] Channel created.');

        // Declare necessary exchanges/queues here if they are static
        // Example: await channel.assertExchange('identity.changes', 'topic', { durable: true });
        // Example: await channel.assertQueue('joiner.events.queue', { durable: true });
        // Example: await channel.bindQueue('joiner.events.queue', 'identity.changes', 'joiner.#');

    } catch (error) {
        console.error('[MQService] Failed to connect to Message Queue:', error.message);
        console.log('[MQService] Retrying connection in 5 seconds...');
        setTimeout(connect, 5000); // Retry connection
    }
};

/**
 * Publishes a message to a specific exchange with a routing key.
 * @param {string} exchange - The name of the exchange.
 * @param {string} routingKey - The routing key for the message.
 * @param {object} message - The message payload (will be JSON stringified).
 */
const publish = async (exchange, routingKey, message) => {
    if (!channel) {
        console.error('[MQService] Cannot publish, channel not available.');
        // Depending on requirements, buffer message or throw error
        throw new Error('MQ Channel not available');
    }
    try {
        const buffer = Buffer.from(JSON.stringify(message));
        // Ensure the exchange exists before publishing (or assert it in connect)
         await channel.assertExchange(exchange, 'topic', { durable: true }); // Assert exchange on publish

        const success = channel.publish(exchange, routingKey, buffer, { persistent: true });

        if (success) {
            console.log(`[MQService] Published message to ${exchange} with key ${routingKey}`);
        } else {
            console.warn(`[MQService] Failed to publish message immediately to ${exchange} with key ${routingKey}. Buffer full?`);
            // Handle buffer full scenario (e.g., wait for drain event)
        }

    } catch (error) {
        console.error(`[MQService] Error publishing message to ${exchange} with key ${routingKey}:`, error);
        throw new Error(`Failed to publish message: ${error.message}`);
    }
};

/**
 * Subscribes to a specific queue and processes incoming messages.
 * @param {string} queue - The name of the queue to subscribe to.
 * @param {function} handler - The async function to call for each received message.
 */
const subscribe = async (queue, handler) => {
     if (!channel) {
        console.error('[MQService] Cannot subscribe, channel not available.');
         throw new Error('MQ Channel not available');
    }
    try {
        // Ensure the queue exists and is bound (or assert them in connect)
        await channel.assertQueue(queue, { durable: true });
        // You would typically bind the queue to an exchange here or in `connect`
        // Example: await channel.bindQueue(queue, 'identity.changes', 'joiner.#');

        console.log(`[MQService] Subscribing to queue: ${queue}`);

        await channel.consume(queue, async (msg) => {
            if (msg !== null) {
                try {
                    const messageContent = JSON.parse(msg.content.toString());
                    console.log(`[MQService] Received message from ${queue}:`, messageContent);

                    await handler(messageContent); // Process the message

                    channel.ack(msg); // Acknowledge message
                } catch (handlerError) {
                    console.error(`[MQService] Error processing message from ${queue}:`, handlerError);
                    // Depending on retry strategy, you might nack here
                    // channel.nack(msg, false, true); // Requeue message
                    channel.nack(msg, false, false); // Discard message or move to dead-letter queue
                }
            }
        }, {
            noAck: false // We will manually acknowledge messages
        });

    } catch (error) {
        console.error(`[MQService] Error subscribing to queue ${queue}:`, error);
        throw new Error(`Failed to subscribe to queue "${queue}": ${error.message}`);
    }
};

/**
 * Initializes the MQ service by connecting.
 */
const init = async () => {
    // Start the connection process
    await connect();

    // Wait for channel to be ready before returning init success?
    // Or rely on subsequent publish/subscribe calls waiting for channel?
    // The current connect() uses setTimeout for retries, which is non-blocking.
    // A better init might wait for the *first* successful connection.
    // For now, let's just kick off the connection process.
    // Consumer services should likely wait until channel is ready before subscribing.
};

// Add helper to wait for channel if needed by consumers
const waitForChannel = () => {
    return new Promise((resolve, reject) => {
        if (channel) {
            return resolve(channel);
        }
        // Simple poll or event listener approach
        const interval = setInterval(() => {
            if (channel) {
                clearInterval(interval);
                resolve(channel);
            }
        }, 100); // Check every 100ms for channel
         // Add a timeout to reject if connection takes too long?
    });
};


module.exports = {
  init,
  publish,
  subscribe,
  waitForChannel // Export helper
};