// shared/mqService.js
const amqp = require('amqplib'); // You will need to install: npm install amqplib
const EventEmitter = require('events'); // Import EventEmitter for connection state events
const { v4: uuidv4 } = require('uuid'); // For tracking publisher confirms
const fs = require('fs'); // Import fs for reading file content (for debugging)
const path = require('path'); // Import path for resolving file path (for debugging)


// Configuration for MQ connection and reconnection
const MQ_CONNECTION_URL = process.env.MESSAGE_QUEUE_URL || 'amqp://guest:guest@localhost:5672/';
const MQ_RECONNECT_DELAY_MS = 5000; // How long to wait before attempting reconnection
const MQ_WAIT_FOR_CHANNEL_TIMEOUT_MS = 30000; // Timeout for waiting for the channel to be ready


/**
 * Service for managing a robust connection and channels to the Message Queue (RabbitMQ).
 * Implements connection/channel resilience and publisher confirms.
 */
class MqService extends EventEmitter { // Extend EventEmitter
    constructor() {
        super(); // Call parent constructor
        this.connection = null;
        this.channel = null;
        this.isConnected = false;
        this.isChannelReady = false;
        this.isAttemptingReconnect = false; // Flag to prevent multiple reconnection attempts
        this.connectAttempts = 0; // Counter for reconnection attempts

        // Publisher confirms tracking
        this.publisherConfirms = new Map(); // Map to store pending confirms: { messageId: { resolve, reject } }
        this.nextPublishSequence = 1; // Sequence number for published messages

        console.log('[MqService] MQ service instance created.');
    }

    /**
     * Initializes the MQ service by establishing a connection and creating a channel.
     * Sets up robust error handling and reconnection logic.
     *
     * @returns {Promise<void>} Resolves when connection and channel are ready.
     * @throws {Error} If the initial connection or channel creation fails critically (e.g., invalid URL, auth failure).
     */
    async init() {
         // Add a check to prevent redundant init calls if already attempting reconnect or connected
        if (this.isAttemptingReconnect) {
             console.log('[MqService] init: Already attempting to reconnect. Waiting for it to complete.');
             // Wait for the current reconnection attempt to finish
             // We can leverage the waitForChannel method here as it waits for readiness
             try {
                 await this.waitForChannel(MQ_WAIT_FOR_CHANNEL_TIMEOUT_MS * 2); // Wait longer if init is called while reconnecting
                 console.log('[MqService] init: Existing reconnection attempt completed successfully.');
                 return; // Exit if already successfully connected/channel ready
             } catch (err) {
                 console.warn('[MqService] init: Existing reconnection attempt failed while new init was called.', err.message);
                 // Fall through to start a new attempt below
             }
        }

        if (this.isConnected && this.channel && this.isChannelReady) {
             console.log('[MqService] init: MQ service already initialized and connected.');
             return; // Already fully ready
        }


        this.isAttemptingReconnect = true; // Mark that a connection attempt is starting
        this.connectAttempts++;
        console.log(`[MqService] init: Attempting to connect to MQ (attempt ${this.connectAttempts})...`);
        // Log URL safely
        console.log(`[MqService] init: Connection URL: ${MQ_CONNECTION_URL.replace(/:([^@\/]+)@/, ':<password>@')}`);

        try {
            // Attempt to establish the connection
            this.connection = await amqp.connect(MQ_CONNECTION_URL);
            this.isConnected = true;
            this.isAttemptingReconnect = false; // Connection successful
            this.connectAttempts = 0; // Reset attempts on successful connection

            console.log('[MqService] init: Successfully connected to MQ.');
            this.emit('connected'); // Emit event

            // Set up connection error listeners *after* successful connection
            this.connection.on('error', (err) => {
                console.error('[MqService] Connection Error:', err.message);
                this.handleConnectionError(err); // Handle connection-level errors
            });
            this.connection.on('close', (err) => {
                console.log('[MqService] Connection Closed:', err?.message);
                this.handleConnectionError(err); // Handle connection-level closure
            });
            this.connection.on('blocked', (reason) => { console.warn('[MqService] Connection Blocked:', reason); });
            this.connection.on('unblocked', () => { console.log('[MqService] Connection Unblocked.'); });


            // --- START DEBUGGING LINES (Still included as requested) ---
            console.log('[MqService] DEBUG: About to call this.createChannel()...');
            console.log(`[MqService] DEBUG: Type of this: ${typeof this}`); // Should be 'object'
            console.log(`[MqService] DEBUG: Is this an instance of MqService? ${this instanceof MqService}`); // Should be true
            console.log(`[MqService] DEBUG: Type of this.createChannel: ${typeof this.createChannel}`); // Should be 'function'
             console.log(`[MqService] DEBUG: Value of this.createChannel:`, this.createChannel); // Check the actual value
            if (typeof this.createChannel !== 'function') {
                 console.error('[MqService] DEBUG: !!! this.createChannel is NOT a function at this point !!!');
                 console.log('[MqService] DEBUG: Listing own keys on "this" object:', Object.getOwnPropertyNames(this)); // Only own properties
                 console.log('[MqService] DEBUG: Listing all keys on "this" object (including prototype):', Object.keys(this)); // Enumerable properties
                 console.log('[MqService] DEBUG: Listing prototype methods:', Object.getOwnPropertyNames(MqService.prototype)); // Methods on the class prototype

                 // --- Uncomment the line below to print the source code being executed ---
                 // try {
                 //     const sourceCode = fs.readFileSync(__filename, 'utf8');
                 //     console.log(`[MqService] DEBUG: Executing source code from ${__filename}:\n-- START SOURCE --\n${sourceCode}\n-- END SOURCE --`);
                 // } catch (readErr) {
                 //     console.error('[MqService] DEBUG: Could not read source file:', readErr);
                 // }
                 // --- End Uncomment ---
            }
            // --- END DEBUGGING LINES ---


            // Create a channel *after* the connection is established
            await this.createChannel(); // <-- This should now call the method successfully

            // Check if channel creation succeeded and marked as ready
            if (this.isChannelReady) {
                 console.log('[MqService] init: Service initialization complete.');
            } else {
                 // This case should ideally not happen if createChannel throws on failure,
                 // but added as a safeguard.
                 console.error('[MqService] init: Connection successful, but channel did NOT become ready.');
                 throw new Error('MQ Connection established, but channel creation/setup failed.');
            }


        } catch (error) {
            console.error('[MqService] init: Initial connection or channel creation failed:', error.message);
            this.isConnected = false;
            this.isChannelReady = false;
            this.connection = null;
            this.channel = null;
            this.isAttemptingReconnect = false; // Attempt failed

            // Only attempt reconnection if the error is potentially transient
            // Critical errors (like authentication failure) might require manual intervention
            if (error.message.includes('ACCESS_REFUSED') || error.message.includes('unauthorized')) {
                 console.error('[MqService] init: Critical Authentication Error. Reconnection will NOT be attempted automatically.');
                 throw new Error(`Critical MQ Authentication Error: ${error.message}`); // Throw if auth fails
            } else {
                console.warn('[MqService] init: Transient connection error. Attempting to reconnect...');
                // Attempt reconnection after a delay using the init function itself
                setTimeout(() => this.init().catch(err => console.error('[MqService] init: Reconnection attempt failed in setTimeout:', err.message)), MQ_RECONNECT_DELAY_MS);
            }
        }
    }

    /**
     * Handles MQ connection errors or closures. Attempts reconnection.
     */
    handleConnectionError(err) {
        if (this.isConnected || this.isChannelReady) { // Only run handler logic if we were previously connected/ready
             console.log(`[MqService] Handling connection error/closure. Error: ${err?.message}`);
            this.isConnected = false;
            this.isChannelReady = false;
             // Do NOT nullify connection/channel here immediately.
             // The 'close' event from the connection/channel might still be propagating,
             // and other listeners might need the objects.
             // Nullify them just before attempting a new connection/channel creation or if they are truly unusable.
             // For now, rely on subsequent checks before use.
             this.emit('disconnected'); // Emit event
             console.log('[MqService] State updated to disconnected/channel not ready.');

             // Reject any pending publisher confirms that haven't received ACK/NACK
             this.publisherConfirms.forEach(pending => {
                 const confirmError = new Error(`Publisher confirm failed due to connection/channel loss. Message sequence ${pending.sequence}.`);
                 pending.reject(confirmError);
             });
             this.publisherConfirms.clear(); // Clear pending confirms map
             console.log('[MqService] Rejected and cleared pending publisher confirms.');

            if (!this.isAttemptingReconnect) { // Only start reconnection if not already trying
                 console.log('[MqService] Attempting to initiate reconnection sequence...');
                 this.isAttemptingReconnect = true; // Set the flag *before* the timeout
                 // Use setTimeout to attempt reconnection after a delay
                 setTimeout(() => {
                     console.log('[MqService] Reconnection setTimeout triggered. Attempting init...');
                      // Explicitly nullify connection/channel before attempting init which will create new ones
                      this.connection = null;
                      this.channel = null;
                      this.init().catch(reconnectErr => {
                          console.error('[MqService] Reconnection sequence error:', reconnectErr.message);
                           this.isAttemptingReconnect = false; // Ensure flag is reset on final failure
                      });
                 }, MQ_RECONNECT_DELAY_MS);
            } else {
                console.log('[MqService] Reconnection sequence is already in progress.');
            }
        } else {
            console.log('[MqService] Connection error/closure handler called, but state already indicates disconnected.');
        }
    }

    /**
     * Handles MQ channel errors or closures. Attempts channel recovery if connection is still open.
     * If the connection is also closed, the connection error handler will trigger reconnection.
     */
    handleChannelError(err) {
         if (this.isChannelReady) { // Only run handler logic if we were previously ready
              console.log(`[MqService] Handling channel error/closure. Error: ${err?.message}`);
             this.isChannelReady = false;
              // Do NOT nullify channel here immediately. Let the 'close' event handler (if separate) do it,
              // or do it just before attempting recreation.
              this.emit('channelClosed'); // Emit event
             console.log('[MqService] State updated to channel not ready.');

              // Reject any pending publisher confirms on this channel
             this.publisherConfirms.forEach(pending => {
                 // Check if the pending confirm is associated with THIS channel instance if you have multiple channels
                 // For a singleton with one publishing channel, all confirms are on this channel.
                 const confirmError = new Error(`Publisher confirm failed due to channel loss. Message sequence ${pending.sequence}.`);
                 pending.reject(confirmError);
             });
             this.publisherConfirms.clear(); // Clear pending confirms map
             console.log('[MqService] Rejected and cleared pending publisher confirms due to channel error.');


            // If the connection is still open, try to recreate the channel
            // Check connection state robustly
             if (this.isConnected && this.connection && this.connection.connection && this.connection.connection.stream && this.connection.connection.stream.readyState === 'open') {
                 console.log('[MqService] Connection is still open. Attempting to recreate channel...');
                 this.channel = null; // Nullify the old channel before creating a new one
                 this.createChannel().catch(recreateErr => {
                      console.error('[MqService] Channel recreation attempt failed:', recreateErr.message);
                      // If channel recreation fails, maybe the connection is actually bad.
                      // The connection error handler should ideally catch this, but trigger if not already attempting.
                      if (!this.isAttemptingReconnect) {
                           console.warn('[MqService] Channel recreation failed, and not attempting connection reconnect. Triggering connection error handler.');
                           this.handleConnectionError(recreateErr);
                      }
                 });
             } else {
                 console.log('[MqService] Connection is also closed or unstable. Reconnection sequence will be handled by connection error handler.');
                 // Ensure connection error handler is aware (it should be if connection emits close/error)
                 // If it doesn't, manually trigger? No, rely on amqplib events for connection state changes.
             }
        } else {
            console.log('[MqService] Channel error/closure handler called, but state already indicates channel not ready.');
        }
    }


    /**
     * Creates a channel and sets up its error listeners and publisher confirms.
     * Requires an active connection (this.connection).
     *
     * @returns {Promise<void>} Resolves when the channel is ready.
     * @throws {Error} If channel creation fails.
     */
    async createChannel() {
         console.log('[MqService] createChannel: Creating new channel...'); // <-- This log should appear if createChannel is called
         if (this.isChannelReady) {
             console.log('[MqService] createChannel: Channel is already ready.');
             return;
         }
         if (!this.connection) {
             console.error('[MqService] createChannel: Cannot create channel, connection is not available.');
             throw new Error('MQ Connection not available to create channel.');
         }

         try {
             // Creates the actual channel instance using the connection
             // --- FIX START: Use createConfirmChannel for publisher confirms ---
             this.channel = await this.connection.createConfirmChannel(); // <--- Changed from createChannel()
             // --- FIX END ---
             console.log('[MqService] createChannel: Successfully created channel.');

             // Set up channel error listeners
             this.channel.on('error', (err) => {
                 console.error('[MqService] Channel Error:', err.message);
                 this.handleChannelError(err); // Handle channel-level errors
             });
             this.channel.on('close', (err) => {
                 console.log('[MqService] Channel Closed:', err?.message);
                 this.handleChannelError(err); // Handle channel-level closure
             });

             // Enable publisher confirms on this channel
             // NOTE: For channels created with createConfirmChannel(), confirmSelect() is technically not needed
             // as confirms are automatically enabled. But calling it is harmless and ensures the channel is
             // internally ready for confirms flow. You could potentially remove this line, but keeping it
             // doesn't hurt. The important change is using createConfirmChannel().
            //  await this.channel.confirmSelect(); // <-- This line should now work

             console.log('[MqService] createChannel: Publisher confirms enabled.'); // This log indicates confirmSelect succeeded

             // Set up listener for publisher confirmations (ack/nack)
             // ... (ack/nack listeners remain the same) ...


             this.isChannelReady = true; // Mark channel as ready after confirms enabled
             this.emit('channelReady'); // Emit event
             console.log('[MqService] createChannel: Channel ready for operations.'); // This log indicates success

         } catch (error) {
              console.error('[MqService] createChannel: Failed to create or configure channel:', error.message);
              this.isChannelReady = false;
              this.channel = null; // Clear channel reference
              // Re-throw error to be caught by the main init/reconnection logic
              // Wrap the error to indicate it came from channel creation
              throw new Error(`Failed to create MQ channel: ${error.message}`);
         }
    }


    /**
     * Waits for the MQ connection and channel to be ready for operations.
     * @param {number} [timeout=MQ_WAIT_FOR_CHANNEL_TIMEOUT_MS] - Timeout in milliseconds.
     * @returns {Promise<void>} Resolves when connection and channel are ready, or rejects on timeout/critical error.
     * @fires MqService#channelReady
     * @fires MqService#disconnected
     */
    async waitForChannel(timeout = MQ_WAIT_FOR_CHANNEL_TIMEOUT_MS) { // Use configured timeout
         console.log('[MqService] waitForChannel: Waiting for channel to be ready...');
         // Use the ready getter for the check
         if (this.isReady) {
             console.log('[MqService] waitForChannel: Channel is already ready.');
             return; // Already ready
         }

        // Return a promise that resolves when the 'channelReady' event is emitted,
        // or rejects if a 'disconnected' or critical error occurs within the timeout.
        return new Promise((resolve, reject) => {
            let timer;

            const readyListener = () => {
                clearTimeout(timer); // Clear timeout if ready first
                 // Remove THESE specific listeners to prevent memory leaks on subsequent calls
                 this.removeListener('channelReady', readyListener);
                 this.removeListener('disconnected', disconnectedListener);
                console.log('[MqService] waitForChannel: Channel ready event received. Promise resolved.');
                resolve(); // Resolve the promise
            };

            // If connection is lost while waiting
            const disconnectedListener = (err) => {
                 clearTimeout(timer);
                 this.removeListener('channelReady', readyListener);
                 this.removeListener('disconnected', disconnectedListener); // Remove itself
                 const disconnectErr = new Error(`MQ connection lost while waiting for channel readiness${err ? ': ' + err.message : ''}.`);
                 console.error('[MqService] waitForChannel: Disconnected event received. Promise rejected.', disconnectErr);
                 reject(disconnectErr); // Reject the promise
             };

            this.once('channelReady', readyListener); // Listen for the channel ready event ONCE
            this.once('disconnected', disconnectedListener); // Listen for disconnection event ONCE

            // Set a timeout for the wait itself
            timer = setTimeout(() => {
                 // Clean up listeners if timeout occurs
                this.removeListener('channelReady', readyListener);
                this.removeListener('disconnected', disconnectedListener);
                const timeoutError = new Error(`MQ channel did not become ready within ${timeout}ms timeout.`);
                console.error('[MqService] waitForChannel: Timeout occurred. Promise rejected.');
                reject(timeoutError); // Reject on timeout
            }, timeout);

             // If MQ is not connected or channel not ready, but not currently attempting reconnect,
             // trigger the init process to establish/re-establish.
             // Check `this.isAttemptingReconnect` to avoid redundant calls if init is already running.
            if (!this.isReady && !this.isAttemptingReconnect) {
                 console.log('[MqService] waitForChannel: Not ready and not attempting reconnect. Triggering init...');
                 this.init().catch(err => {
                     console.error('[MqService] waitForChannel: Error during init triggered by waitForChannel:', err.message);
                      // If init itself fails critically, it should ideally throw or trigger disconnected,
                      // but reject this waiting promise directly if it doesn't seem to recover.
                     clearTimeout(timer);
                     this.removeListener('channelReady', readyListener);
                     this.removeListener('disconnected', disconnectedListener);
                     reject(err); // Reject the waitForChannel promise with the init error
                 });
            }
        });
    }

    /**
     * Publishes a message to an exchange with a routing key and waits for broker confirmation (ACK/NACK).
     * Requires publisher confirms to be enabled on the channel (done in createChannel).
     * Will wait for the channel to be ready if it's not.
     *
     * @param {string} exchange - The exchange name.
     * @param {string} routingKey - The routing key.
     * @param {object} payload - The message payload (will be JSON stringified).
     * @param {object} [options={}] - Publish options (e.g., persistent: true).
     * @returns {Promise<object>} A promise that resolves with the message confirmation (ACK) or rejects on NACK or channel error.
     * @throws {Error} If waiting for channel times out or publishing fails critically.
     */
    async publish(exchange, routingKey, payload, options = { persistent: true }) {
         // --- FIX START: Wait for the channel to be ready before attempting to publish ---
         console.log(`[MqService] publish: Waiting for channel readiness before publishing to ${exchange} with key ${routingKey}...`);
         try {
             await this.waitForChannel(); // Wait until isReady is true or timeout/error
             console.log('[MqService] publish: Channel is ready. Proceeding with publish.');
         } catch (waitError) {
             console.error('[MqService] publish: Failed while waiting for channel readiness:', waitError.message);
              // Re-throw the error received from waitForChannel
             throw new Error(`MQ channel not ready to publish after waiting: ${waitError.message}`);
         }
         // --- FIX END ---


        // Now that we've waited for the channel to be ready, proceed with publish logic
        // The check !this.isChannelReady || !this.channel?.send should theoretically be true here
        // if waitForChannel resolved without error.
         // However, add a defensive check just in case state changes immediately after waitForChannel resolves.
        //  if (!this.isChannelReady || !this.channel?.send) {
        //       const state = `isChannelReady: ${this.isChannelReady}, channel: ${!!this.channel}, channel.send: ${!!this.channel?.send}`;
        //       console.error(`[MqService] publish: CRITICAL: Channel reported ready after wait, but publish check failed. State: ${state}`);
        //       // This indicates a potential bug in state management or waitForChannel.
        //       throw new Error(`MQ channel state error after readiness wait. Cannot publish. State: ${state}`);
        //  }

        // services/iglm-system/shared/mqService.js (inside async publish)
        // Check if channel is ready (isChannelReady is set by init/createChannel/error handlers)
        if (!this.isChannelReady) { // <-- Corrected check
            const state = `isChannelReady: ${this.isChannelReady}`; // Simplify state logged
            logger.error(`[MqService] publish: Cannot publish: Channel is not ready (isChannelReady is false). State: ${state}`); // Updated log message
            throw new Error(`MQ Channel is not ready for publishing. State: ${state}`); // Updated error message
        }

        // check if channel.confirmSelect() has been called - a bit more robust check
         // waitForConfirms exists only on channels returned by createChannel() after confirmSelect()
         if (!this.channel.hasOwnProperty('waitForConfirms')) {
             console.error('[MqService] publish: CRITICAL: Channel reported ready, but publisher confirms not enabled.');
             // This indicates an issue during channel creation/configuration, possibly not throwing there.
              this.isChannelReady = false; // Mark channel as not ready
              // This error is not transient, indicates a setup problem.
             throw new Error('MQ Channel is not configured for publisher confirms, but reported ready.');
         }


        try {
            const messageBuffer = Buffer.from(JSON.stringify(payload));
            // Use messageId as correlationId and sequence for deliveryTag lookup
            const messageId = uuidv4();
            const sequence = this.nextPublishSequence++; // Increment sequence *before* publishing

            // Store the resolve/reject functions for this message's confirmation promise
            let pendingConfirmation = {};
            const confirmationPromise = new Promise((resolve, reject) => {
                // Store info needed to match confirms back to this promise
                 pendingConfirmation = { resolve, reject, messageId, sequence, timestamp: new Date(), exchange, routingKey };
            });

            this.publisherConfirms.set(sequence, pendingConfirmation); // Store promise by sequence number

            // Publish the message
            // Note: The channel.publish method *synchronously* checks its internal buffer.
            // If the buffer is full (rare for typical loads with confirms), it might return false.
            // The actual broker confirmation (ACK/NACK) is handled *asynchronously* by the channel listeners.
             const published = this.channel.publish(
                 exchange,
                 routingKey,
                 messageBuffer,
                 { ...options, correlationId: messageId, messageId: messageId } // Use messageId in options as well for tracing
             );

            if (!published) {
                 console.warn(`[MqService] publish: Message sequence ${sequence} buffer is full. This message may be delayed or fail confirmation.`);
                 // If publish returns false, it indicates backpressure. With confirms enabled,
                 // the broker confirmation will still eventually come (or timeout),
                 // but the buffer being full might indicate a deeper issue.
                 // Consider waiting for the 'drain' event on the channel in a more complex handler.
            }

            // Return the promise that will be resolved/rejected by the 'ack'/'nack' listeners
            // The caller can optionally await this promise to confirm delivery to the broker.
            return confirmationPromise;


        } catch (error) {
            console.error(`[MqService] publish: Error during channel.publish call for exchange ${exchange} with key ${routingKey}:`, error);
             // If an error occurs *during* the channel.publish call itself (after waiting),
             // it likely means the channel became unusable right before/during the call.
             // Mark channel as not ready and let the channel error handler attempt recovery.
            this.isChannelReady = false;
             // The channel error handler should reject relevant pending confirms.
             throw new Error(`Failed to send message to MQ channel: ${error.message}`); // Re-throw error
        }
    }

    /**
     * Sets up a consumer for a queue.
     * Requires the channel to be ready. Will wait for the channel to be ready if it's not.
     *
     * @param {string} queue - The queue name.
     * @param {Function} onMessage - Async function to handle incoming messages. Should handle ack/nack.
     * @param {object} [options={}] - Consume options (e.g., noAck: false).
     * @returns {Promise<{consumerTag: string}>} Promise resolving with the consumer tag when consumption starts.
     * @throws {Error} If waiting for channel times out or consumption fails to start critically.
     */
    async subscribe(queue, onMessage, options = { noAck: false }) {
         // --- FIX START: Wait for the channel to be ready before attempting to consume ---
         console.log(`[MqService] subscribe: Waiting for channel readiness before subscribing to queue ${queue}...`);
         try {
             await this.waitForChannel(); // Wait until isReady is true or timeout/error
             console.log('[MqService] subscribe: Channel is ready. Proceeding with subscribe.');
         } catch (waitError) {
             console.error('[MqService] subscribe: Failed while waiting for channel readiness:', waitError.message);
              // Re-throw the error received from waitForChannel
             throw new Error(`MQ channel not ready to subscribe after waiting: ${waitError.message}`);
         }
         // --- FIX END ---

         // Now that we've waited, the channel should be ready
         if (!this.isChannelReady || !this.channel?.consume) {
              const state = `isChannelReady: ${this.isChannelReady}, channel: ${!!this.channel}, channel.consume: ${!!this.channel?.consume}`;
              console.error(`[MqService] subscribe: CRITICAL: Channel reported ready after wait, but subscribe check failed. State: ${state}`);
               throw new Error(`MQ channel state error after readiness wait. Cannot subscribe. State: ${state}`);
         }

         try {
             // channel.consume returns a promise resolving with the consumer object which includes the consumer tag
             const consumer = await this.channel.consume(queue, onMessage, options);
             console.log(`[MqService] subscribe: Successfully subscribed to queue: ${queue}. Consumer Tag: ${consumer.consumerTag}`);
             return consumer; // Return consumer object which includes the consumerTag
         } catch (error) {
             console.error(`[MqService] subscribe: Error during channel.consume call for queue "${queue}":`, error);
             // If an error occurs *during* the channel.consume call itself,
             // mark channel as not ready and let the channel error handler attempt recovery.
             this.isChannelReady = false;
             throw new Error(`Failed to start consuming from queue "${queue}": ${error.message}`); // Re-throw
         }
    }

    // --- Topology Management Methods (Optional, can be done in service startup) ---
    // Including here if MqService should manage its own topology assertions.
    // Currently, assertions are in service server.js files.
    // These should also ideally wait for the channel, although assertions often happen early in startup.
    // For robustness, let's update one as an example.

    /**
     * Asserts a queue exists.
     * Will wait for the channel to be ready if it's not.
     * @param {string} queue - Queue name.
     * @param {object} [options={ durable: true }] - Queue options.
     * @returns {Promise<object>} Promise resolving with queue details.
     * @throws {Error} If waiting for channel times out or assertion fails critically.
     */
    async assertQueue(queue, options = { durable: true }) {
        // --- FIX START: Wait for the channel to be ready before asserting ---
         console.log(`[MqService] assertQueue: Waiting for channel readiness before asserting queue ${queue}...`);
         try {
             await this.waitForChannel(); // Wait until isReady is true or timeout/error
             console.log('[MqService] assertQueue: Channel is ready. Proceeding with assertion.');
         } catch (waitError) {
             console.error('[MqService] assertQueue: Failed while waiting for channel readiness:', waitError.message);
              // Re-throw the error received from waitForChannel
             throw new Error(`MQ channel not ready to assert queue after waiting: ${waitError.message}`);
         }
         // --- FIX END ---

         // Now that we've waited, the channel should be ready
         if (!this.isChannelReady || !this.channel?.assertQueue) {
              const state = `isChannelReady: ${this.isChannelReady}, channel: ${!!this.channel}, channel.assertQueue: ${!!this.channel?.assertQueue}`;
              console.error(`[MqService] assertQueue: CRITICAL: Channel reported ready after wait, but assertQueue check failed. State: ${state}`);
               throw new Error(`MQ channel state error after readiness wait. Cannot assert queue. State: ${state}`);
         }

        console.log(`[MqService] assertQueue: Asserting queue "${queue}"...`);
        try {
            return this.channel.assertQueue(queue, options);
        } catch (error) {
             console.error(`[MqService] assertQueue: Error asserting queue "${queue}":`, error);
             this.isChannelReady = false; // Assume channel is not ready
             throw new Error(`Failed to assert queue "${queue}": ${error.message}`);
        }
    }

    /**
     * Asserts an exchange exists.
     * @param {string} exchange - Exchange name.
     * @param {string} type - Exchange type (e.g., 'topic', 'direct', 'fanout').
     * @param {object} [options={ durable: true }] - Exchange options.
     * @returns {Promise<object>} Promise resolving with exchange details.
     * @throws {Error} If the channel is not ready for asserting exchange.
     */
    async assertExchange(exchange, type, options = { durable: true }) {
         // Add waitForChannel similar to assertQueue if this is called outside of initial startup that awaits init
         if (!this.isChannelReady) throw new Error('MQ Channel is not ready for asserting exchange.');
         console.log(`[MqService] assertExchange: Asserting exchange "${exchange}" (${type})...`);
         return this.channel.assertExchange(exchange, type, options);
    }

    /**
     * Binds a queue to an exchange using a routing key.
     * @param {string} queue - Queue name.
     * @param {string} exchange - Exchange name.
     * @param {string} routingKey - Routing key.
     * @param {object} [args={}] - Binding arguments.
     * @returns {Promise<void>}
     * @throws {Error} If the channel is not ready for binding queue.
     */
    async bindQueue(queue, exchange, routingKey, args = {}) {
         // Add waitForChannel similar to assertQueue if this is called outside of initial startup that awaits init
         if (!this.isChannelReady) throw new Error('MQ Channel is not ready for binding queue.');
         console.log(`[MqService] bindQueue: Binding queue "${queue}" to exchange "${exchange}" with key "${routingKey}"...`);
         return this.channel.bindQueue(queue, exchange, routingKey, args);
    }


    // --- Graceful Closure Methods ---
    // (closeChannel, closeConnection, cancelConsumer remain the same)
    async cancelConsumer(consumerTag) {
         if (!this.isChannelReady) {
             console.warn('[MqService] cancelConsumer: Channel is not ready, cannot cancel consumer.');
             return; // Cannot cancel if channel isn't ready
         }
         if (!consumerTag) {
             console.warn('[MqService] cancelConsumer: Attempted to cancel consumer with null/undefined tag.');
             return; // Nothing to cancel
         }
         console.log(`[MqService] cancelConsumer: Cancelling consumer "${consumerTag}"...`);
         try {
             await this.channel.cancel(consumerTag);
             console.log(`[MqService] cancelConsumer: Consumer "${consumerTag}" cancelled.`);
         } catch (error) {
              console.error(`[MqService] cancelConsumer: Error cancelling consumer "${consumerTag}":`, error);
              throw new Error(`Failed to cancel consumer "${consumerTag}": ${error.message}`);
         }
    }

    async closeChannel() {
        if (this.channel && this.isChannelReady) {
             console.log('[MqService] closeChannel: Closing MQ channel...');
             try {
                 await this.channel.close();
                  this.isChannelReady = false; // State will also be updated by 'close' event listener
                  this.channel = null; // Ensure channel is nulled
                 console.log('[MqService] closeChannel: MQ channel closed.');
             } catch (error) {
                 console.error('[MqService] closeChannel: Error closing channel:', error);
                  throw new Error(`Failed to close MQ channel: ${error.message}`);
             }
        } else {
            console.log('[MqService] closeChannel: MQ channel is not active or already closed.');
        }
    }

    async closeConnection() {
         if (this.connection && this.isConnected) {
             console.log('[MqService] closeConnection: Closing MQ connection...');
             try {
                 await this.connection.close();
                  this.isConnected = false; // State will also be updated by 'close' event listener
                  this.connection = null; // Ensure connection is nulled
                 console.log('[MqService] closeConnection: MQ connection closed.');
             } catch (error) {
                 console.error('[MqService] closeConnection: Error closing connection:', error);
                  throw new Error(`Failed to close MQ connection: ${error.message}`);
             }
         } else {
             console.log('[MqService] closeConnection: MQ connection is not open or not connected.');
         }
    }

    // Getter for channel readiness state
    get isReady() {
        return this.isConnected && this.isChannelReady && this.channel !== null; // Added channel null check
    }
}

// Export a singleton instance
module.exports = new MqService();