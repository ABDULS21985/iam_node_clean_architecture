// shared/mqService.js
const amqp = require('amqplib');
const EventEmitter = require('events');
const { v4: uuidv4 } = require('uuid');
// Removed fs and path imports as debugging print is removed

// Configuration for MQ connection and reconnection
const MQ_CONNECTION_URL = process.env.MESSAGE_QUEUE_URL || 'amqp://guest:guest@localhost:5672/';
const MQ_RECONNECT_DELAY_MS = parseInt(process.env.MQ_RECONNECT_DELAY_MS, 10) || 5000; // Configurable reconnect delay, default 5s
const MQ_WAIT_FOR_CHANNEL_TIMEOUT_MS = parseInt(process.env.MQ_WAIT_FOR_CHANNEL_TIMEOUT_MS, 10) || 30000; // Configurable wait timeout, default 30s
const MQ_SHUTDOWN_CONSUMER_CANCEL_TIMEOUT_MS = parseInt(process.env.MQ_SHUTDOWN_CONSUMER_CANCEL_TIMEOUT_MS, 10) || 5000; // Timeout for cancelling consumers during shutdown

/**
 * Service for managing a robust connection and channels to the Message Queue (RabbitMQ).
 * Implements connection/channel resilience, publisher confirms, and graceful shutdown.
 * Requires a logger instance to be passed during initialization.
 */
class MqService extends EventEmitter {
    constructor() {
        super(); // Call parent constructor
        this.connection = null;
        this.channel = null;
        // Internal state variables (prefixed with underscore)
        this._isConnected = false; // <-- Corrected: Use underscore
        this._isChannelReady = false; // <-- Corrected: Use underscore
        this._isAttemptingReconnect = false; // <-- Corrected: Use underscore
        this._isShuttingDownMq = false; // <-- Corrected: Use underscore
        this.connectAttempts = 0; // Counter for reconnection attempts
        this.logger = null; // <-- Property to hold the logger instance

        // Publisher confirms tracking
        // Store { resolve, reject, sequence, messageId, timestamp, exchange, routingKey }
        this.publisherConfirms = new Map(); // Map to store pending confirms: { deliveryTag: { ... } }
        this.nextPublishSequence = 1; // Sequence number for published messages (used as deliveryTag)

        // Consumer tracking for graceful shutdown
        // Store { consumerTag: { consumer, channel } } - channel might be useful if you have multiple publisher channels later
        this.activeConsumers = new Map(); // Map to track active consumers by consumerTag

        console.log('[MqService] MQ service instance created.'); // Using standard console for this very early log
    }

    /**
     * Initializes the MQ service by establishing a connection and creating a channel.
     * Sets up robust error handling and reconnection logic.
     * A logger instance must be provided.
     *
     * @param {object} logger - The logger instance for this service.
     * @returns {Promise<void>} Resolves when connection and channel are ready.
     * @throws {Error} If the initial connection or channel creation fails critically (e.g., invalid URL, auth failure).
     */
    async init(logger) { // <-- Accept logger as parameter
        if (!logger) {
            console.error('[MqService] CRITICAL: Logger not provided to MqService.init().'); // Use standard console if logger is null
            throw new Error("Logger not provided to MqService.init()");
        }
        this.logger = logger; // <-- Store the logger instance

        // If we are shutting down, do not attempt to initialize or reconnect
        if (this._isShuttingDownMq) { // <-- Corrected: Use underscore
            this.logger.debug('[MqService] init: Skipping initialization as service is shutting down.');
            return;
        }

        // Add checks to prevent redundant init calls
        if (this._isAttemptingReconnect) { // <-- Corrected: Use underscore
            this.logger.debug('[MqService] init: Already attempting to reconnect. Waiting for it to complete.');
            // Wait for the current reconnection attempt to finish
            // We can leverage the waitForChannel method here as it waits for readiness
            try {
                // Wait longer if init is called while reconnecting, but respect shutdown
                await this.waitForChannel(MQ_WAIT_FOR_CHANNEL_TIMEOUT_MS * 2);
                this.logger.debug('[MqService] init: Existing reconnection attempt completed successfully.');
                return; // Exit if already successfully connected/channel ready
            } catch (err) {
                this.logger.warn('[MqService] init: Existing reconnection attempt failed while new init was called.', err);
                // Fall through to start a new attempt below if the error wasn't due to shutdown
                 if (this._isShuttingDownMq) return; // <-- Corrected: Check again after await
            }
        }

        // Use public getters here to check current state derived from internal variables
        if (this.isConnected && this.isChannelReady && this.channel && !this._isShuttingDownMq) { // <-- Corrected: Use underscore
             this.logger.debug('[MqService] init: MQ service already initialized and connected.');
             return; // Already fully ready
        }


        this._isAttemptingReconnect = true; // <-- Corrected: Set internal variable
        this.connectAttempts++;
        this.logger.info(`[MqService] init: Attempting to connect to MQ (attempt ${this.connectAttempts})...`);
        // Log URL safely
        this.logger.info(`[MqService] init: Connection URL: ${MQ_CONNECTION_URL.replace(/:([^@\/]+)@/, ':<password>@')}`);

        try {
            // Attempt to establish the connection
            this.connection = await amqp.connect(MQ_CONNECTION_URL);
            this._isConnected = true; // <-- Corrected: Set internal variable
            this._isAttemptingReconnect = false; // <-- Corrected: Set internal variable - Connection successful
            this.connectAttempts = 0; // Reset attempts on successful connection

            this.logger.info('[MqService] init: Successfully connected to MQ.');
            this.emit('connected'); // Emit event

            // Set up connection error listeners *after* successful connection
            // These handlers will check the isShuttingDownMq flag (using internal variable)
            this.connection.on('error', (err) => {
                this.logger.error('[MqService] Connection Error:', err);
                this.handleConnectionError(err); // Handle connection-level errors
            });
            this.connection.on('close', (err) => {
                this.logger.warn('[MqService] Connection Closed:', err);
                this.handleConnectionError(err); // Handle connection-level closure
            });
            this.connection.on('blocked', (reason) => { this.logger.warn('[MqService] Connection Blocked:', reason); });
            this.connection.on('unblocked', () => { this.logger.info('[MqService] Connection Unblocked.'); });

            // Create a channel *after* the connection is established
            await this.createChannel(); // This calls the method on 'this'

            // Check if channel creation succeeded and marked as ready
            if (this._isChannelReady && !this._isShuttingDownMq) { // <-- Corrected: Use underscore
                 this.logger.info('[MqService] init: Service initialization complete.');
            } else if (this._isShuttingDownMq) { // <-- Corrected: Use underscore
                 this.logger.debug('[MqService] init: Channel created successfully, but service is now shutting down.');
                 // If shutdown signal received while connecting/creating channel, start shutdown process
                 // This scenario is less likely if gracefulShutdown handles all signals, but good safeguard.
                 // The check in gracefulShutdown promises should handle this better.
                 // No need to throw here, just let the service proceed to shutdown.
            }
            else {
                // This case should ideally not happen if createChannel throws on failure,
                // but added as a safeguard.
                this.logger.error('[MqService] init: Connection successful, but channel did NOT become ready.');
                throw new Error('MQ Connection established, but channel creation/setup failed.');
            }


        } catch (error) {
            const log = this.logger || console; // Use logger if available, fallback to console
            log.error('[MqService] init: Initial connection or channel creation failed:', error);

            this._isConnected = false; // <-- Corrected: Set internal variable
            this._isChannelReady = false; // <-- Corrected: Set internal variable
            this.connection = null; // Nullify on critical init failure
            this.channel = null;   // Nullify on critical init failure
            this._isAttemptingReconnect = false; // <-- Corrected: Set internal variable - Attempt failed

            // Only attempt reconnection if the error is potentially transient AND we are NOT shutting down
            // Critical errors (like authentication failure) might require manual intervention
            if (error.message.includes('ACCESS_REFUSED') || error.message.includes('unauthorized')) {
                log.error('[MqService] init: Critical Authentication Error. Reconnection will NOT be attempted automatically.', error);
                throw new Error(`Critical MQ Authentication Error: ${error.message}`); // Throw if auth fails
            } else if (!this._isShuttingDownMq) { // <-- Corrected: Check internal variable before attempting reconnect
                log.warn('[MqService] init: Transient connection error. Attempting to reconnect...', error);
                // Attempt reconnection after a delay using the init function itself
                setTimeout(() => {
                     // Check shutdown flag AGAIN before calling init in the timeout callback
                     if (!this._isShuttingDownMq) { // <-- Corrected: Check internal variable
                          this.logger.debug('[MqService] Reconnection setTimeout triggered. Attempting init...');
                          this.init(this.logger).catch(reconnectErr => this.logger.error('[MqService] init: Reconnection attempt failed in setTimeout:', reconnectErr)); // Pass this.logger
                     } else {
                         this.logger.debug('[MqService] Reconnection setTimeout callback fired, but shutdown is in progress.');
                         // Ensure connection/channel are nullified if not already
                         this.connection = null;
                         this.channel = null;
                     }
                }, MQ_RECONNECT_DELAY_MS);
            } else {
                 log.debug('[MqService] init: Connection error occurred, but skipping reconnection as service is shutting down.');
            }
        }
    }

    /**
     * Handles MQ connection errors or closures. Attempts reconnection if not shutting down.
     */
    handleConnectionError(err) {
        if (!this.logger) { console.error('[MqService] CRITICAL: Logger not available in handleConnectionError.'); return; } // Safeguard

        // If we are intentionally shutting down, ignore connection errors/closures that happen as a result.
        if (this._isShuttingDownMq) { // <-- Corrected: Check internal variable
            this.logger.debug('[MqService] handleConnectionError: Ignoring error as shutdown is in progress.', { error: err?.message });
            // Ensure state is updated even if we're shutting down
            this._isConnected = false; // <-- Corrected: Set internal variable
            this._isChannelReady = false; // <-- Corrected: Set internal variable
            this.connection = null; // Explicitly nullify on connection error/close
            this.channel = null;   // Explicitly nullify as channel is also invalid
            this._isAttemptingReconnect = false; // <-- Corrected: Set internal variable - Reconnection attempt is now stopped/failed
            return;
        }

        // Use public getters here
        if (this.isConnected || this.isChannelReady) { // Only run handler logic if we were previously connected/ready
             this.logger.warn(`[MqService] Handling connection error/closure. Error: ${err?.message}`, err);
             this._isConnected = false; // <-- Corrected: Set internal variable
             this._isChannelReady = false; // <-- Corrected: Set internal variable
             // Nullify immediately on error/close so state is consistent
             this.connection = null;
             this.channel = null;
             this.emit('disconnected'); // Emit event
             this.logger.warn('[MqService] State updated to disconnected/channel not ready.');

             // Reject any pending publisher confirms that haven't received ACK/NACK
             this.publisherConfirms.forEach(pending => {
                 const confirmError = new Error(`Publisher confirm failed due to connection/channel loss. Message sequence ${pending.sequence}.`);
                 this.logger.error(`[MqService] Publisher Confirm: Received NACK for message ${pending.sequence} due to connection error.`, confirmError);
                 pending.reject(confirmError);
             });
             this.publisherConfirms.clear(); // Clear pending confirms map
             this.logger.debug('[MqService] Rejected and cleared pending publisher confirms.');

             if (!this._isAttemptingReconnect) { // <-- Corrected: Check internal variable - Only start reconnection if not already trying
                 this.logger.warn('[MqService] Attempting to initiate reconnection sequence...');
                 this._isAttemptingReconnect = true; // <-- Corrected: Set internal variable - Set the flag *before* the timeout
                 // Use setTimeout to attempt reconnection after a delay
                 setTimeout(() => {
                      // Check shutdown flag AGAIN before calling init in the timeout callback
                      if (!this._isShuttingDownMq) { // <-- Corrected: Check internal variable
                           this.logger.debug('[MqService] Reconnection setTimeout triggered. Attempting init...');
                           this.init(this.logger).catch(reconnectErr => { // Pass this.logger
                               this.logger.error('[MqService] init: Reconnection sequence error:', reconnectErr);
                                this._isAttemptingReconnect = false; // <-- Corrected: Set internal variable - Ensure flag is reset on final failure
                           });
                      } else {
                           this.logger.debug('[MqService] Reconnection setTimeout callback fired, but shutdown is in progress.');
                      }
                 }, MQ_RECONNECT_DELAY_MS);
             } else {
                 this.logger.debug('[MqService] Reconnection sequence is already in progress.');
             }
        } else {
            this.logger.debug('[MqService] Connection error/closure handler called, but state already indicates disconnected.');
        }
    }

    /**
     * Handles MQ channel errors or closures. Attempts channel recovery if connection is still open and not shutting down.
     * If the connection is also closed, the connection error handler will trigger reconnection.
     */
    handleChannelError(err) {
         if (!this.logger) { console.error('[MqService] CRITICAL: Logger not available in handleChannelError.'); return; } // Safeguard

        // If we are intentionally shutting down, ignore channel errors/closures that happen as a result.
        if (this._isShuttingDownMq) { // <-- Corrected: Check internal variable
             this.logger.debug('[MqService] handleChannelError: Ignoring error as shutdown is in progress.', { error: err?.message });
             // Ensure state is updated even if we're shutting down
             this._isChannelReady = false; // <-- Corrected: Set internal variable
             this.channel = null; // Explicitly nullify on channel error/close
             return;
        }

        // Use public getter here
         if (this.isChannelReady) { // Only run handler logic if we were previously ready
              this.logger.warn(`[MqService] Handling channel error/closure. Error: ${err?.message}`, err);
             this._isChannelReady = false; // <-- Corrected: Set internal variable
              this.channel = null; // Nullify immediately on error/close
              this.emit('channelClosed'); // Emit event
             this.logger.warn('[MqService] State updated to channel not ready.');

              // Reject any pending publisher confirms on this channel
              this.publisherConfirms.forEach(pending => {
                  const confirmError = new Error(`Publisher confirm failed due to channel loss. Message sequence ${pending.sequence}.`);
                  this.logger.error(`[MqService] Publisher Confirm: Received NACK for message ${pending.sequence} due to channel error.`, confirmError);
                  pending.reject(confirmError);
              });
              this.publisherConfirms.clear(); // Clear pending confirms map
              this.logger.debug('[MqService] Rejected and cleared pending publisher confirms due to channel error.');


             // If the connection is still open and not shutting down, try to recreate the channel
             // Check connection state robustly and shutdown flag
              if (this.isConnected && this.connection && !this._isShuttingDownMq) { // <-- Corrected: Use internal variable for shutdown check, public getter for connection state
                   this.logger.warn('[MqService] Connection is still open and not shutting down. Attempting to recreate channel...');
                   this.createChannel().catch(recreateErr => {
                       this.logger.error('[MqService] Channel recreation attempt failed:', recreateErr);
                       // If channel recreation fails, it might be a connection issue.
                       // The connection error handler should pick this up if it's happening.
                       // Avoid manually triggering handleConnectionError from here unless strictly necessary.
                   });
              } else {
                   this.logger.debug('[MqService] Connection is also closed, unstable, or service is shutting down. Channel recreation skipped.');
              }
         } else {
             this.logger.debug('[MqService] Channel error/closure handler called, but state already indicates channel not ready.');
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
         if (!this.logger) { console.error('[MqService] CRITICAL: Logger not available in createChannel.'); throw new Error("Logger not available."); } // Safeguard

         this.logger.debug('[MqService] createChannel: Creating new channel...');
          if (this._isChannelReady || this._isShuttingDownMq) { // <-- Corrected: Check internal variables
              if (this._isShuttingDownMq) { // <-- Corrected: Check internal variable
                   this.logger.debug('[MqService] createChannel: Skipping channel creation as service is shutting down.');
              } else {
                  this.logger.debug('[MqService] createChannel: Channel is already ready.');
              }
              return;
          }
          if (!this.connection) {
              this.logger.error('[MqService] createChannel: Cannot create channel, connection is not available.');
              throw new Error('MQ Connection not available to create channel.');
          }

         try {
             // Creates a confirm channel using the connection
             // This channel is automatically in publisher confirm mode
              this.channel = await this.connection.createConfirmChannel(); // <--- Changed from createChannel()
             this.logger.debug('[MqService] createChannel: Successfully created channel.');

             // Set up channel error listeners
             // These handlers will check the isShuttingDownMq flag (using internal variable)
             this.channel.on('error', (err) => {
                 this.logger.error('[MqService] Channel Error:', err);
                 this.handleChannelError(err); // Handle channel-level errors
             });
             this.channel.on('close', (err) => {
                 this.logger.warn('[MqService] Channel Closed:', err);
                 this.handleChannelError(err); // Handle channel-level closure
             });

             this.logger.debug('[MqService] createChannel: Publisher confirms implicitly enabled by using createConfirmChannel().');

             // Set up listener for publisher confirmations (ack/nack)
             this.channel.on('ack', (msg) => {
                 const pending = this.publisherConfirms.get(msg.deliveryTag);
                 if (pending) {
                      // this.logger.debug(`[MqService] Publisher Confirm: Received ACK for message ${msg.deliveryTag}`, { sequence: msg.deliveryTag, messageId: pending.messageId }); // Optional debug
                     pending.resolve(msg);
                     this.publisherConfirms.delete(msg.deliveryTag);
                 } else {
                      this.logger.warn(`[MqService] Publisher Confirm: Received ACK for unknown message ID ${msg.deliveryTag}.`, { deliveryTag: msg.deliveryTag });
                 }
             });

             this.channel.on('nack', (msg) => {
                 const pending = this.publisherConfirms.get(msg.deliveryTag);
                 if (pending) {
                      this.logger.error(`[MqService] Publisher Confirm: Received NACK for message ${msg.deliveryTag}. Reason:`, { sequence: msg.deliveryTag, messageId: pending.messageId, details: msg }); // Log details
                     pending.reject(new Error(`Message ${msg.deliveryTag} was NACKed by the broker: ${msg.description || 'No description'}`));
                     this.publisherConfirms.delete(msg.deliveryTag);
                 } else {
                      this.logger.warn(`[MqService] Publisher Confirm: Received NACK for unknown message ID ${msg.deliveryTag}.`, { deliveryTag: msg.deliveryTag });
                 }
             });

             // --- Channel Topology Setup (assert exchanges, queues, binds) ---
             // Add calls here if your service is responsible for declaring its topology on startup.
             // These should also await. E.g.:
             // await this.assertExchange('my-events', 'topic');
             // await this.assertQueue('my-queue');
             // await this.bindQueue('my-queue', 'my-events', 'my.routing.key');
             // The topology methods already call waitForChannel, so they handle readiness before attempting assertions/binds.
             // However, calling them *after* createChannel here ensures the channel exists immediately.
             // If topology setup fails, the channel will be marked not ready and init will be triggered.

             this._isChannelReady = true; // <-- Corrected: Set internal variable - Mark channel as ready after channel creation succeeds AND topology is set up (if applicable)
             this.emit('channelReady'); // Emit event
             this.logger.info('[MqService] createChannel: Channel ready for operations.');

         } catch (error) {
              this.logger.error('[MqService] createChannel: Failed to create or configure channel:', error);
              this._isChannelReady = false; // <-- Corrected: Set internal variable
              this.channel = null; // Clear channel reference
              // Wrap the error to indicate it came from channel creation
              throw new Error(`Failed to create MQ channel: ${error.message}`);
         }
    }


    /**
     * Waits for the MQ connection and channel to be ready for operations.
     * @param {number} [timeout=MQ_WAIT_FOR_CHANNEL_TIMEOUT_MS] - Timeout in milliseconds.
     * @returns {Promise<void>} Resolves when connection and channel are ready, or rejects on timeout/critical error/shutdown.
     * @fires MqService#channelReady
     * @fires MqService#disconnected
     * @fires MqService#shutdown - Rejected if shutdown initiated while waiting.
     */
    async waitForChannel(timeout = MQ_WAIT_FOR_CHANNEL_TIMEOUT_MS) {
         if (!this.logger) { console.error('[MqService] CRITICAL: Logger not available in waitForChannel.'); throw new Error("Logger not available."); } // Safeguard

         // If already shutting down, waiting is pointless, reject immediately.
         if (this._isShuttingDownMq) { // <-- Corrected: Check internal variable
              this.logger.debug('[MqService] waitForChannel: Skipping wait as service is shutting down.');
             throw new Error('MQ service is shutting down.');
         }

         this.logger.debug('[MqService] waitForChannel: Waiting for channel to be ready...');
          // Use the public getter for the check
          if (this.isReady) {
              this.logger.debug('[MqService] waitForChannel: Channel is already ready.');
              return; // Already ready
          }

        // Return a promise that resolves when the 'channelReady' event is emitted,
        // or rejects if a 'disconnected' or critical error occurs within the timeout,
        // or if shutdown is initiated while waiting.
        return new Promise((resolve, reject) => {
            let timer;
            let shutdownListener;

            const cleanUp = () => {
                clearTimeout(timer);
                this.removeListener('channelReady', readyListener);
                this.removeListener('disconnected', disconnectedListener);
                 if (shutdownListener) {
                      this.removeListener('shutdown', shutdownListener);
                 }
            };

            const readyListener = () => {
                cleanUp();
                this.logger.debug('[MqService] waitForChannel: Channel ready event received. Promise resolved.');
                resolve(); // Resolve the promise
            };

            // If connection is lost while waiting
            const disconnectedListener = (err) => {
                 cleanUp();
                 const disconnectErr = new Error(`MQ connection lost while waiting for channel readiness${err ? ': ' + err.message : ''}.`);
                 this.logger.error('[MqService] waitForChannel: Disconnected event received. Promise rejected.', disconnectErr);
                 reject(disconnectErr); // Reject the promise
             };

            // If shutdown is initiated while waiting
             shutdownListener = () => {
                  cleanUp();
                  const shutdownErr = new Error('MQ service initiated shutdown while waiting for channel readiness.');
                 this.logger.warn('[MqService] waitForChannel: Shutdown event received. Promise rejected.', shutdownErr);
                  reject(shutdownErr); // Reject the promise
             };


            this.once('channelReady', readyListener); // Listen for the channel ready event ONCE
            this.once('disconnected', disconnectedListener); // Listen for disconnection event ONCE
             this.once('shutdown', shutdownListener); // <-- NEW: Listen for shutdown event

            // Set a timeout for the wait itself
            timer = setTimeout(() => {
                cleanUp(); // Clean up listeners if timeout occurs
                const timeoutError = new Error(`MQ channel did not become ready within ${timeout}ms timeout.`);
                this.logger.error('[MqService] waitForChannel: Timeout occurred. Promise rejected.', timeoutError);
                reject(timeoutError); // Reject on timeout
            }, timeout);

             // If MQ is not connected or channel not ready, but not currently attempting reconnect,
             // and NOT shutting down, trigger the init process.
             // Use public getters here for state checks
             if (!this.isReady && !this.isAttemptingReconnect && !this.isShuttingDown) { // <-- Corrected: Use public getters
                  this.logger.debug('[MqService] waitForChannel: Not ready and not attempting reconnect/shutdown. Triggering init...');
                  this.init(this.logger).catch(err => { // Pass this.logger
                       this.logger.error('[MqService] waitForChannel: Error during init triggered by waitForChannel:', err);
                       // If init itself fails critically, it should ideally throw or trigger disconnected/shutdown.
                       // Reject this waiting promise if it doesn't seem to recover.
                       cleanUp();
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
     * @throws {Error} If waiting for channel times out, publishing fails critically, or service is shutting down.
     */
    async publish(exchange, routingKey, payload, options = { persistent: true }) {
         if (!this.logger) { console.error('[MqService] CRITICAL: Logger not available in publish.'); throw new Error("Logger not available."); } // Safeguard

        // Do not allow publishing if shutting down
         if (this._isShuttingDownMq) { // <-- Corrected: Check internal variable
              this.logger.warn('[MqService] publish: Skipping publish as service is shutting down.');
             throw new Error('MQ service is shutting down.');
         }

         // --- Wait for the channel to be ready before attempting to publish ---
         this.logger.debug(`[MqService] publish: Waiting for channel readiness before publishing to ${exchange} with key ${routingKey}...`);
         try {
              await this.waitForChannel(); // Wait until isReady is true or timeout/error
             this.logger.debug('[MqService] publish: Channel is ready. Proceeding with publish.');
         } catch (waitError) {
              this.logger.error('[MqService] publish: Failed while waiting for channel readiness:', waitError);
             // Re-throw the error received from waitForChannel
             throw new Error(`MQ channel not ready to publish after waiting: ${waitError.message}`);
         }
         // --- END WAIT ---

        // Now that we've waited for the channel to be ready, proceed with publish logic
         // Use public getter here
         if (!this.isChannelReady || !this.channel || typeof this.channel.publish !== 'function') {
              const state = `isChannelReady: ${this.isChannelReady}, channelExists: ${!!this.channel}, publishMethod: ${typeof this.channel?.publish}`;
              this.logger.error(`[MqService] publish: Cannot publish: Channel is not in a publishable state after wait. State: ${state}`);
              throw new Error(`MQ Channel is not ready for publishing. State: ${state}`);
         }

         try {
             const messageBuffer = Buffer.from(JSON.stringify(payload));
             // Use sequence for deliveryTag lookup by the broker
             const sequence = this.nextPublishSequence++; // Increment sequence *before* publishing
             const messageId = options.messageId || uuidv4(); // Use provided messageId or generate

             // Store the resolve/reject functions for this message's confirmation promise
             let pendingConfirmation = {};
             const confirmationPromise = new Promise((resolve, reject) => {
                 // Store info needed to match confirms back to this promise
                  pendingConfirmation = { resolve, reject, messageId, sequence, timestamp: new Date(), exchange, routingKey };
             });

             // Store promise by sequence number (deliveryTag)
             // Use 'set' which handles adding/updating.
             this.publisherConfirms.set(sequence, pendingConfirmation);

             // Publish the message. This returns boolean indicating if buffer is full.
              const published = this.channel.publish(
                  exchange,
                  routingKey,
                  messageBuffer,
                  { ...options, correlationId: messageId, messageId: messageId } // Pass messageId/correlationId in options
              );

             if (!published) {
                 this.logger.warn(`[MqService] publish: Channel buffer is full for message sequence ${sequence}. This message may be delayed or fail confirmation if channel closes before drain.`, { sequence, exchange, routingKey, messageId });
                 // With confirms enabled, the broker confirmation will still eventually come (or timeout/fail).
                 // The 'drain' event can be listened to on the channel if flow control is needed before sending more.
             } else {
                  this.logger.debug(`[MqService] publish: Message sequence ${sequence} sent to channel. Waiting for confirmation...`, { sequence, exchange, routingKey, messageId });
             }


             // Return the promise that will be resolved/rejected by the 'ack'/'nack' listeners
             // The caller can optionally await this promise to confirm delivery to the broker.
             return confirmationPromise;


         } catch (error) {
              this.logger.error(`[MqService] publish: Error during channel.publish call for exchange ${exchange} with key ${routingKey}:`, { exchange, routingKey, error: error.message, stack: error.stack });
             // If an error occurs *during* the channel.publish call itself (after waiting),
             // it likely means the channel became unusable concurrently.
             // Mark channel as not ready and let the channel error handler attempt recovery.
             // The error handler will reject relevant pending confirms.
              this._isChannelReady = false; // <-- Corrected: Set internal variable - Mark state immediately
              this.channel = null;   // Nullify channel immediately
             throw new Error(`Failed to send message to MQ channel: ${error.message}`); // Re-throw error
         }
    }

    /**
     * Sets up a consumer for a queue.
     * Requires the channel to be ready. Will wait for the channel to be ready if it's not.
     * Tracks active consumers for graceful shutdown.
     *
     * @param {string} queue - The queue name.
     * @param {Function} onMessage - Async function to handle incoming messages. Should handle ack/nack.
     * @param {object} [options={}] - Consume options (e.g., noAck: false).
     * @returns {Promise<{consumerTag: string}>} Promise resolving with the consumer tag when consumption starts.
     * @throws {Error} If waiting for channel times out or consumption fails to start critically, or service is shutting down.
     */
    async subscribe(queue, onMessage, options = { noAck: false }) {
         if (!this.logger) { console.error('[MqService] CRITICAL: Logger not available in subscribe.'); throw new Error("Logger not available."); } // Safeguard

        // Do not allow subscribing if shutting down
         if (this._isShuttingDownMq) { // <-- Corrected: Check internal variable
              this.logger.warn('[MqService] subscribe: Skipping subscribe as service is shutting down.');
             throw new Error('MQ service is shutting down.');
         }

         // --- Wait for the channel to be ready before attempting to consume ---
         this.logger.debug(`[MqService] subscribe: Waiting for channel readiness before subscribing to queue ${queue}...`);
         try {
              await this.waitForChannel(); // Wait until isReady is true or timeout/error
             this.logger.debug('[MqService] subscribe: Channel is ready. Proceeding with subscribe.');
         } catch (waitError) {
              this.logger.error('[MqService] subscribe: Failed while waiting for channel readiness:', waitError);
             // Re-throw the error received from waitForChannel
             throw new Error(`MQ channel not ready to subscribe after waiting: ${waitError.message}`);
         }
         // --- END WAIT ---

         // Now that we've waited, the channel should be ready
         // Use public getter here
         if (!this.isChannelReady || !this.channel || typeof this.channel.consume !== 'function') {
              const state = `isChannelReady: ${this.isChannelReady}, channelExists: ${!!this.channel}, consumeMethod: ${typeof this.channel?.consume}`;
              this.logger.error(`[MqService] subscribe: CRITICAL: Channel reported ready after wait, but subscribe check failed. State: ${state}`);
              throw new Error(`MQ channel state error after readiness wait. Cannot subscribe. State: ${state}`);
         }

         this.logger.info(`[MqService] subscribe: Attempting to subscribe to queue: ${queue}.`, { queue });
         try {
              const consumer = await this.channel.consume(queue, onMessage, options);
              this.logger.info(`[MqService] subscribe: Consumer started successfully with tag: ${consumer.consumerTag}.`, { queue, consumerTag: consumer.consumerTag });
             // Track the active consumer
              this.activeConsumers.set(consumer.consumerTag, consumer); // Store the consumer object
              this.logger.debug(`[MqService] subscribe: Added consumer ${consumer.consumerTag} to tracking list. Active: ${this.activeConsumers.size}`);

             return consumer; // Return consumer object which includes the consumerTag
         } catch (error) {
              this.logger.error(`[MqService] subscribe: Error during channel.consume call for queue "${queue}":`, { queue, error: error.message, stack: error.stack });
             // If an error occurs *during* the channel.consume call itself,
             // mark channel as not ready and let the channel error handler attempt recovery.
              this._isChannelReady = false; // <-- Corrected: Set internal variable - Mark state immediately
              this.channel = null;   // Nullify channel immediately
             throw new Error(`Failed to start consuming from queue "${queue}": ${error.message}`);
         }
    }

    // --- Topology Management Methods ---
    // These should also ideally wait for the channel to be ready before asserting/binding.
    // Updated to use this.logger, public getters for state checks, and check internal shutdown flag

    /**
     * Asserts a queue exists.
     * Will wait for the channel to be ready if it's not.
     * @param {string} queue - Queue name.
     * @param {object} [options={ durable: true }] - Queue options.
     * @returns {Promise<object>} Promise resolving with queue details.
     * @throws {Error} If waiting for channel times out or assertion fails critically, or service is shutting down.
     */
    async assertQueue(queue, options = { durable: true }) {
         if (!this.logger) { console.error('[MqService] CRITICAL: Logger not available in assertQueue.'); throw new Error("Logger not available."); } // Safeguard

         if (this._isShuttingDownMq) { // <-- Corrected: Check internal variable
             this.logger.warn('[MqService] assertQueue: Skipping assertion as service is shutting down.');
             throw new Error('MQ service is shutting down.');
         }

         // --- Wait for the channel to be ready before asserting ---
         this.logger.debug(`[MqService] assertQueue: Waiting for channel readiness before asserting queue ${queue}...`);
         try {
              await this.waitForChannel(); // Wait until isReady is true or timeout/error
             this.logger.debug('[MqService] assertQueue: Channel is ready. Proceeding with assertion.');
         } catch (waitError) {
              this.logger.error('[MqService] assertQueue: Failed while waiting for channel readiness:', waitError);
             // Re-throw the error received from waitForChannel
             throw new Error(`MQ channel not ready to assert queue after waiting: ${waitError.message}`);
         }
         // --- END WAIT ---

         // Now that we've waited, the channel should be ready
         // Use public getter here
         if (!this.isChannelReady || !this.channel || typeof this.channel.assertQueue !== 'function') {
              const state = `isChannelReady: ${this.isChannelReady}, channelExists: ${!!this.channel}, assertQueueMethod: ${typeof this.channel?.assertQueue}`;
              this.logger.error(`[MqService] assertQueue: CRITICAL: Channel reported ready after wait, but assertQueue check failed. State: ${state}`);
              throw new Error(`MQ channel state error after readiness wait. Cannot assert queue. State: ${state}`);
         }

         this.logger.info(`[MqService] assertQueue: Asserting queue "${queue}"...`, { queue });
         try {
             const result = await this.channel.assertQueue(queue, options);
             this.logger.info(`[MqService] assertQueue: Queue "${queue}" asserted successfully.`, { queue, result });
             return result;
         } catch (error) {
              this.logger.error(`[MqService] assertQueue: Error asserting queue "${queue}":`, { queue, error: error.message, stack: error.stack });
              this._isChannelReady = false; // <-- Corrected: Set internal variable - Assume channel is not ready
             throw new Error(`Failed to assert queue "${queue}": ${error.message}`);
         }
    }

    /**
     * Asserts an exchange exists.
     * Will wait for the channel to be ready if it's not.
     * @param {string} exchange - Exchange name.
     * @param {string} type - Exchange type (e.g., 'topic', 'direct', 'fanout').
     * @param {object} [options={ durable: true }] - Exchange options.
     * @returns {Promise<object>} Promise resolving with exchange details.
     * @throws {Error} If waiting for channel times out or assertion fails critically, or service is shutting down.
     */
    async assertExchange(exchange, type, options = { durable: true }) {
         if (!this.logger) { console.error('[MqService] CRITICAL: Logger not available in assertExchange.'); throw new Error("Logger not available."); } // Safeguard

         if (this._isShuttingDownMq) { // <-- Corrected: Check internal variable
              this.logger.warn('[MqService] assertExchange: Skipping assertion as service is shutting down.');
             throw new Error('MQ service is shutting down.');
         }

         // --- Wait for the channel to be ready before asserting ---
         this.logger.debug(`[MqService] assertExchange: Waiting for channel readiness before asserting exchange ${exchange}...`);
         try {
              await this.waitForChannel(); // Wait until isReady is true or timeout/error
             this.logger.debug('[MqService] assertExchange: Channel is ready. Proceeding with assertion.');
         } catch (waitError) {
              this.logger.error('[MqService] assertExchange: Failed while waiting for channel readiness:', waitError);
             // Re-throw the error received from waitForChannel
             throw new Error(`MQ channel not ready to assert exchange after waiting: ${waitError.message}`);
         }
         // --- END WAIT ---

         // Now that we've waited, the channel should be ready
         // Use public getter here
         if (!this.isChannelReady || !this.channel || typeof this.channel.assertExchange !== 'function') {
              const state = `isChannelReady: ${this.isChannelReady}, channelExists: ${!!this.channel}, assertExchangeMethod: ${typeof this.channel?.assertExchange}`;
              this.logger.error(`[MqService] assertExchange: CRITICAL: Channel reported ready after wait, but assertExchange check failed. State: ${state}`);
              throw new Error(`MQ channel state error after readiness wait. Cannot assert exchange. State: ${state}`);
         }

         this.logger.info(`[MqService] assertExchange: Asserting exchange "${exchange}" (${type})...`, { exchange, type });
         try {
              const result = await this.channel.assertExchange(exchange, type, options);
              this.logger.info(`[MqService] assertExchange: Exchange "${exchange}" asserted successfully.`, { exchange, result });
             return result;
         } catch (error) {
              this.logger.error(`[MqService] assertExchange: Error asserting exchange "${exchange}":`, { exchange, error: error.message, stack: error.stack });
              this._isChannelReady = false; // <-- Corrected: Set internal variable - Assume channel is not ready
             throw new Error(`Failed to assert exchange "${exchange}": ${error.message}`);
         }
    }

    /**
     * Binds a queue to an exchange using a routing key.
     * Will wait for the channel to be ready if it's not.
     * @param {string} queue - Queue name.
     * @param {string} exchange - Exchange name.
     * @param {string} routingKey - Routing key.
     * @param {object} [args={}] - Binding arguments.
     * @returns {Promise<void>}
     * @throws {Error} If waiting for channel times out or binding fails critically, or service is shutting down.
     */
    async bindQueue(queue, exchange, routingKey, args = {}) {
         if (!this.logger) { console.error('[MqService] CRITICAL: Logger not available in bindQueue.'); throw new Error("Logger not available."); } // Safeguard

         if (this._isShuttingDownMq) { // <-- Corrected: Check internal variable
              this.logger.warn('[MqService] bindQueue: Skipping binding as service is shutting down.');
             throw new Error('MQ service is shutting down.');
         }

         // --- Wait for the channel to be ready before binding ---
         this.logger.debug(`[MqService] bindQueue: Waiting for channel readiness before binding queue ${queue}...`);
         try {
              await this.waitForChannel(); // Wait until isReady is true or timeout/error
             this.logger.debug('[MqService] bindQueue: Channel is ready. Proceeding with binding.');
         } catch (waitError) {
              this.logger.error('[MqService] bindQueue: Failed while waiting for channel readiness:', waitError);
             // Re-throw the error received from waitForChannel
             throw new Error(`MQ channel not ready to bind queue after waiting: ${waitError.message}`);
         }
         // --- END WAIT ---

         // Now that we've waited, the channel should be ready
         // Use public getter here
         if (!this.isChannelReady || !this.channel || typeof this.channel.bindQueue !== 'function') {
              const state = `isChannelReady: ${this.isChannelReady}, channelExists: ${!!this.channel}, bindQueueMethod: ${typeof this.channel?.bindQueue}`;
              this.logger.error(`[MqService] bindQueue: CRITICAL: Channel reported ready after wait, but bindQueue check failed. State: ${state}`);
              throw new Error(`MQ channel state error after readiness wait. Cannot bind queue. State: ${state}`);
         }

         this.logger.info(`[MqService] bindQueue: Binding queue "${queue}" to exchange "${exchange}" with key "${routingKey}"...`, { queue, exchange, routingKey });
         try {
              const result = await this.channel.bindQueue(queue, exchange, routingKey, args);
              this.logger.info(`[MqService] bindQueue: Queue "${queue}" bound successfully.`, { queue, exchange, routingKey });
             return result;
         } catch (error) {
              this.logger.error(`[MqService] bindQueue: Error binding queue "${queue}" to exchange "${exchange}" with key "${routingKey}":`, { queue, exchange, routingKey, error: error.message, stack: error.stack });
              this._isChannelReady = false; // <-- Corrected: Set internal variable - Assume channel is not ready
             throw new Error(`Failed to bind queue "${queue}": ${error.message}`);
         }
    }


    // --- Graceful Closure Methods ---
    // Updated to use this.logger and respect isShuttingDownMq

    /**
     * Cancels a consumer subscription using its consumer tag.
     * Will wait for the channel to be ready if it's not, within a shorter timeout.
     * @param {string} consumerTag - The consumer tag returned by subscribe().
     * @returns {Promise<void>} Resolves when the consumer is cancelled. Logs errors but does not throw during shutdown.
     */
    async cancelConsumer(consumerTag) {
         if (!this.logger) { console.error('[MqService] CRITICAL: Logger not available in cancelConsumer.'); return; } // Safeguard

         if (!consumerTag) {
              this.logger.warn('[MqService] cancelConsumer: Attempted to cancel consumer with null/undefined tag. Skipping.', { consumerTag });
             return; // Nothing to cancel
         }

         // Only attempt to cancel if the consumer is actively tracked, implies it was successfully subscribed.
         if (!this.activeConsumers.has(consumerTag)) {
              this.logger.debug('[MqService] cancelConsumer: Consumer tag not found in active list. Already cancelled or not started?', { consumerTag });
              return;
         }


         // Add a short wait for channel readiness, as cancellation usually happens during shutdown.
         // If the channel is not ready quickly, it's likely gone and cancellation isn't possible anyway.
          try {
              // Use a shorter waitForChannel specifically for cancellation, but respect shutdown flag
              // waitForChannel will throw if _isShuttingDownMq is true
              await this.waitForChannel(MQ_SHUTDOWN_CONSUMER_CANCEL_TIMEOUT_MS);
              this.logger.debug(`[MqService] cancelConsumer: Channel ready for cancellation.`);
          } catch (waitError) {
               this.logger.warn(`[MqService] cancelConsumer: Channel not ready for cancellation within ${MQ_SHUTDOWN_CONSUMER_CANCEL_TIMEOUT_MS}ms timeout. Skipping cancellation attempt.`, { consumerTag, waitError: waitError.message });
               this.activeConsumers.delete(consumerTag); // Assume consumer is gone if channel not ready quickly
              return; // Cannot cancel if channel isn't ready after waiting (or if shutting down)
          }

         // Check if channel object actually exists and has the cancel method after waiting
         // Use public getter here
         if (!this.isChannelReady || !this.channel || typeof this.channel.cancel !== 'function') {
              this.logger.error('[MqService] cancelConsumer: Channel object or cancel method not available after readiness wait. Skipping cancellation.', { consumerTag });
               this.activeConsumers.delete(consumerTag); // Assume consumer is gone
              return;
         }

         this.logger.info(`[MqService] cancelConsumer: Cancelling consumer "${consumerTag}"...`, { consumerTag });
         try {
              await this.channel.cancel(consumerTag);
              this.logger.info(`[MqService] cancelConsumer: Consumer "${consumerTag}" cancelled successfully.`, { consumerTag });
         } catch (error) {
              // Log the error but do NOT throw during shutdown
              this.logger.error(`[MqService] cancelConsumer: Error cancelling consumer "${consumerTag}":`, { consumerTag, error: error.message, stack: error.stack });
         } finally {
             // Always remove from tracking map after attempting cancellation
             this.activeConsumers.delete(consumerTag);
             this.logger.debug(`[MqService] cancelConsumer: Removed consumer ${consumerTag} from tracking. Active: ${this.activeConsumers.size}`);
         }
    }

    /**
     * Cancels all active consumer subscriptions. Used during shutdown.
     * @returns {Promise<void>}
     */
    async cancelAllConsumers() {
         if (!this.logger) { console.error('[MqService] CRITICAL: Logger not available in cancelAllConsumers.'); return; } // Safeguard

         if (this.activeConsumers.size === 0) {
              this.logger.debug('[MqService] cancelAllConsumers: No active consumers to cancel.');
             return;
         }

         this.logger.info(`[MqService] cancelAllConsumers: Cancelling ${this.activeConsumers.size} active consumers...`);
         const cancelPromises = [];
         // Iterate over active consumer tags and call cancelConsumer for each
         for (const consumerTag of this.activeConsumers.keys()) {
              cancelPromises.push(this.cancelConsumer(consumerTag)); // cancelConsumer handles removal from map
         }

         // Wait for all cancellation attempts to settle
         await Promise.allSettled(cancelPromises);

         this.logger.info('[MqService] cancelAllConsumers: All consumer cancellation attempts finished.');
         // The map should now be empty due to cancelConsumer's finally block, but clear just in case.
         this.activeConsumers.clear();
    }


    /**
     * Closes the current channel gracefully.
     * @returns {Promise<void>}
     */
    async closeChannel() {
        if (!this.logger) { console.error('[MqService] CRITICAL: Logger not available in closeChannel.'); } // Safeguard

        // Only attempt to close if a channel object exists
        if (this.channel) {
             this.logger.info('[MqService] closeChannel: Closing MQ channel...');
             try {
                  // Use amqplib's internal state checks if needed, but relying on .close() promise is standard.
                  await this.channel.close();
                 this.logger.info('[MqService] closeChannel: MQ channel closed successfully.');
             } catch (error) {
                 // Log the error but do NOT throw during shutdown sequence
                 this.logger.error('[MqService] closeChannel: Error closing channel:', error);
             } finally {
                 this._isChannelReady = false; // <-- Corrected: Set internal variable - Always update state
                 this.channel = null; // Always clear reference
                 // Clear pending confirms associated with this channel if not already done by error handler
                 if (this.publisherConfirms.size > 0) {
                      this.logger.debug('[MqService] closeChannel: Clearing remaining pending confirms...');
                      this.publisherConfirms.forEach(pending => {
                           const confirmError = new Error(`Publisher confirm failed because channel was closed during shutdown. Message sequence ${pending.sequence}.`);
                            // Use warn/info level here, not error, as it's expected during shutdown
                           this.logger.warn(`[MqService] Publisher Confirm: Confirm skipped for message ${pending.sequence} due to channel close during shutdown.`, confirmError);
                           // Decide whether to reject or resolve undefined during shutdown. Rejecting is safer.
                           pending.reject(confirmError);
                      });
                      this.publisherConfirms.clear();
                 }
             }
        } else {
            this.logger?.debug('[MqService] closeChannel: MQ channel is not active or already closed.'); // Use this.logger, optional chaining for logger
        }
    }

    /**
     * Closes the current connection gracefully.
     * Should typically be called after closing channels.
     * @returns {Promise<void>}
     */
    async closeConnection() {
         if (!this.logger) { console.error('[MqService] CRITICAL: Logger not available in closeConnection.'); } // Safeguard

        // Only attempt to close if a connection object exists
         if (this.connection) {
              this.logger.info('[MqService] closeConnection: Closing MQ connection...');
             try {
                  // Use amqplib's internal state checks if needed, but relying on .close() promise is standard.
                  await this.connection.close();
                 this.logger.info('[MqService] closeConnection: MQ connection closed successfully.');
             } catch (error) {
                 // Log the error but do NOT throw during shutdown sequence
                 this.logger.error('[MqService] closeConnection: Error closing connection:', error);
             } finally {
                 this._isConnected = false; // <-- Corrected: Set internal variable - Always update state
                 this.connection = null; // Always clear reference
                 this._isAttemptingReconnect = false; // <-- Corrected: Set internal variable - Ensure this is false after explicit close
             }
         } else {
             this.logger?.debug('[MqService] closeConnection: MQ connection is not open or not connected.'); // Use this.logger, optional chaining for logger
         }
    }

    /**
     * Initiates the graceful shutdown of the MQ service.
     * Cancels consumers, closes the channel, and closes the connection,
     * preventing any further reconnection attempts.
     * @returns {Promise<void>} Resolves when the shutdown process is complete.
     */
    async shutdown() {
         if (!this.logger) { console.error('[MqService] CRITICAL: Logger not available in shutdown.'); } // Safeguard

         if (this._isShuttingDownMq) { // <-- Corrected: Check internal variable
              this.logger?.warn('[MqService] shutdown: Shutdown already in progress.');
             return;
         }

         this._isShuttingDownMq = true; // <-- Corrected: Set internal variable immediately
         this.logger?.info('[MqService] Initiating graceful shutdown...'); // Use optional chaining in case logger wasn't initialized

         // Emit a shutdown event so waitForChannel and other components can react
         this.emit('shutdown');

         try {
             // 1. Cancel all active consumers first to stop processing messages
             await this.cancelAllConsumers();

             // 2. Close the channel. This will also implicitly NACK any unacknowledged messages (if noAck is false).
             // Closing the channel is important before closing the connection.
             await this.closeChannel();

             // 3. Close the connection. This will stop all network activity.
             await this.closeConnection();

             this.logger?.info('[MqService] Graceful shutdown complete.');

         } catch (error) {
             // This catch block primarily logs unexpected errors during the shutdown sequence itself.
             // Errors during closeChannel or closeConnection are caught and logged within those methods.
             this.logger?.error('[MqService] Error during graceful shutdown sequence:', error);
         } finally {
              // Ensure flags are reset or finalized state is correct
              this._isConnected = false; // <-- Corrected: Set internal variable
              this._isChannelReady = false; // <-- Corrected: Set internal variable
              this.connection = null;
              this.channel = null;
              this._isAttemptingReconnect = false; // <-- Corrected: Set internal variable
              // _isShuttingDownMq remains true
         }
    }


    // Getter for overall readiness state
    get isReady() {
        // Check internal state variables and channel object existence.
        // During shutdown (_isShuttingDownMq is true), we should NOT report as ready.
        return this._isConnected && this._isChannelReady && this.channel !== null && !this._isShuttingDownMq; // <-- Corrected: Use internal variable
    }

     // Public Getters for internal state (useful for health checks, debugging)
     // These return the value of the corresponding internal underscored variables.
     get isConnected() {
          return this._isConnected; // <-- Corrected: Return internal variable
     }
      get isChannelReady() {
          return this._isChannelReady; // <-- Corrected: Return internal variable
      }
      get isAttemptingReconnect() {
          return this._isAttemptingReconnect; // <-- Corrected: Return internal variable
      }
       get isShuttingDown() {
           return this._isShuttingDownMq; // <-- Corrected: Return internal variable
       }

}

// Export a singleton instance
// Note: The MqService singleton is created here, but relies on init(logger) being called later by the service server.js
module.exports = new MqService();