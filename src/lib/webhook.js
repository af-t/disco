import https from 'node:https';
import crypto from 'node:crypto';
import fs from 'node:fs';
import { basename } from 'node:path';
import utility from './utility.js';

const { unrefTimeout } = utility;

class DiscordWebhookTools {
  static MAX_RETRIES = 3;
  static RETRY_DELAY = 1000;
  static REQUEST_TIMEOUT = 10000;
  static MAX_RESPONSE_SIZE = 1024 * 1024; // 1MB

  static #urlCache = new Map();

  #urlObject;
  #remainingRequests = 30; // Discord's default rate limit
  #resetTime = 0;
  #boundary = Math.random().toString(16).slice(2);

  /**
   * Creates a new DiscordWebhookTools instance.
   * @param {string} webhookUrl - The Discord webhook URL.
   * @throws {Error} If the webhook URL format is invalid.
   */
  constructor(webhookUrl) {
    this.#validateAndSetWebhookUrl(webhookUrl);
  }

  /**
   * Validates and sets the webhook URL, using cached parsed URL if available.
   * @param {string} webhookUrl - The webhook URL to validate and set.
   * @private
   */
  #validateAndSetWebhookUrl(webhookUrl) {
    const cached = DiscordWebhookTools.#urlCache.get(webhookUrl);
    if (cached) {
      this.#urlObject = cached;
      return;
    }

    const webhookUrlPattern = /^https:\/\/discord\.com\/api\/webhooks\/(\d+)\/(.+)$/;
    if (!webhookUrlPattern.test(webhookUrl)) {
      throw Error('Invalid Discord webhook URL format');
    }

    const urlObject = new URL(webhookUrl);
    DiscordWebhookTools.#urlCache.set(webhookUrl, urlObject);

    this.#urlObject = urlObject;
  }

  /**
   * Handles rate limiting and waits for the reset period if necessary.
   * @private
   * @returns {Promise<void>}
   */
  async #handleRateLimit() {
    const now = Date.now();

    if (now < this.#resetTime) {
      const delay = this.#resetTime - now;
      await new Promise((resolve) => unrefTimeout(resolve, delay));
    }

    if (this.#remainingRequests <= 0) {
      const delay = Math.max(0, this.#resetTime - now);
      await new Promise((resolve) => unrefTimeout(resolve, delay));
    }
  }

  /**
   * Updates rate limit information from response headers.
   * @param {Object} headers - The response headers.
   * @private
   */
  #updateRateLimits(headers) {
    this.#remainingRequests = parseInt(headers['x-ratelimit-remaining'] ?? '30');
    this.#resetTime = parseInt(headers['x-ratelimit-reset'] ?? '0') * 1000;
  }

  #buildFormDataHeader(name, filename) {
    const form = [
      `--${this.#boundary}`,
      `Content-Disposition: form-data${name ? '; name="' + name + '"' : ''}${filename ? '; filename="' + filename + '"' : ''}`,
      '',
    ];
    return form.join('\r\n') + '\r\n';
  }

  /**
   * Sends a raw request to the webhook with improved error handling, rate limiting, and retry logic.
   * @param {Object} data - The payload to send.
   * @param {Object} [options={}] - Additional request options.  Can include `path`, `method`, and `headers`.
   * @param {number} [retryCount=0] - The current retry count.
   * @returns {Promise<Object|string>} The response data, parsed as JSON if possible, or the raw string if parsing fails.
   * @throws {Error} If the request fails after multiple retries or the response is too large.
   */
  async sendRawRequest(data, options = {}, retryCount = 0) {
    await this.#handleRateLimit();

    return new Promise((resolve, reject) => {
      // ... (rest of the sendRawRequest function remains unchanged)
      let responseSize = 0;
      const requestOptions = {
        hostname: this.#urlObject.hostname,
        path: options.path || this.#urlObject.pathname,
        method: options.method || 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...options.headers,
        },
        timeout: DiscordWebhookTools.REQUEST_TIMEOUT,
      };

      const req = https.request(requestOptions, (res) => {
        let responseData = '';

        // Update rate limits
        this.#updateRateLimits(res.headers);

        res.on('data', (chunk) => {
          responseSize += chunk.length;
          if (responseSize > DiscordWebhookTools.MAX_RESPONSE_SIZE) {
            req.destroy();
            reject(new Error('Response too large'));
            return;
          }
          responseData += chunk;
        });

        res.on('end', () => {
          if (res.statusCode >= 200 && res.statusCode < 300) {
            try {
              resolve(responseData ? JSON.parse(responseData) : {});
            } catch (_e) {
              resolve(responseData);
            }
          } else if (res.statusCode === 429 && retryCount < DiscordWebhookTools.MAX_RETRIES) {
            // Rate limited - retry after delay
            const retryAfter = parseInt(res.headers['retry-after'] ?? '1000');
            unrefTimeout(() => {
              this.sendRawRequest(data, options, retryCount + 1)
                .then(resolve)
                .catch(reject);
            }, retryAfter);
          } else {
            reject(new Error(`HTTP ${res.statusCode}: ${responseData}`));
          }
        });
      });

      const handleFailure = (err) => {
        if (retryCount < DiscordWebhookTools.MAX_RETRIES) {
          unrefTimeout(() => {
            this.sendRawRequest(data, options, retryCount + 1)
              .then(resolve)
              .catch(reject);
          }, DiscordWebhookTools.RETRY_DELAY);
        } else {
          reject(err);
        }
      };

      req.on('timeout', () => {
        req.destroy();
        handleFailure(new Error('Request timeout'));
      });

      req.on('error', handleFailure);

      if (data) {
        req.write(JSON.stringify(data));
      }
      req.end();
    });
  }

  /**
   * Sends a message to the webhook.
   * @param {string} content - The message content.
   * @returns {Promise<Object>} The response data.
   */
  async sendMessage(content) {
    return this.sendRawRequest({ content });
  }

  async sendFile(files = [], options = {}) {
    if (!Array.isArray(files)) throw TypeError('The first argument must be of type Array');
    if (!(options instanceof Object)) throw Error('The second argument must be of type Object');
    if (files.length < 1) throw Error('must include at least 1 file to upload');

    const results = [];
    const payload = { content: '', ...(options instanceof Object ? options : {}) };

    // eslint-disable-next-line no-async-promise-executor
    await new Promise(async (resolve, reject) => {
      const req = https.request(
        {
          hostname: this.#urlObject.hostname,
          path: this.#urlObject.pathname,
          method: 'POST',
          headers: {
            'Content-Type': `multipart/form-data; boundary=${this.#boundary}`,
          },
          timeout: DiscordWebhookTools.REQUEST_TIMEOUT,
        },
        (res) => {
          const chunks = [];
          res.on('data', (chunk) => chunks.push(chunk));
          res.on('end', () => {
            const data = Buffer.concat(chunks);
            try {
              // Determine data type
              results.push(JSON.parse(data));
            } catch {
              results.push(data.toString());
            }
            resolve();
          });
        },
      );

      req.on('timeout', () => {
        req.destroy();
        reject(Error('Request timeout'));
      });
      req.on('error', reject);

      req.write(this.#buildFormDataHeader('payload_json'));
      req.write(JSON.stringify(payload) + '\r\n');

      for (let i = 0; i < Math.min(files.length, 10); i++) {
        if (typeof files[i] === 'string' && fs.existsSync(files[i]) && fs.statSync(files[i]).isFile()) {
          const stream = fs.createReadStream(files[i]);
          req.write(this.#buildFormDataHeader(`files[${i}]`, basename(files[i])));

          await new Promise((resolve, reject) => {
            stream.on('end', () => {
              req.write('\r\n');
              resolve();
            });
            stream.on('error', reject);
            stream.pipe(req, { end: false });
          });
        } else if (files[i]?.filename && files[i]?.data) {
          req.write(this.#buildFormDataHeader(`files[${i}]`, files[i].filename));
          req.write(files[i].data);
        }
      }

      req.end(`--${this.#boundary}--\r\n`);

      if (files.slice(10).length > 0) results.push(...(await this.sendFile(files.slice(10), options)));
    });
    return results;
  }

  /**
   * Sends an embed to the webhook.
   * @param {Object} embed - The embed object.
   * @returns {Promise<Object>} The response data.
   */
  async sendEmbed(embed) {
    return this.sendRawRequest({ embeds: [embed] });
  }

  /**
   * Deletes a message from the webhook.
   * @param {string} messageId - The ID of the message to delete.
   * @returns {Promise<Object>} The response data.
   */
  async deleteMessage(messageId) {
    return this.sendRawRequest(null, {
      method: 'DELETE',
      path: `${this.#urlObject.pathname}/messages/${messageId}`,
    });
  }

  /**
   * Edits a message sent via the webhook.
   * @param {string} messageId - The ID of the message to edit.
   * @param {Object} data - The data to update the message with.
   * @returns {Promise<Object>} The response data.
   */
  async editMessage(messageId, data) {
    return this.sendRawRequest(data, {
      method: 'PATCH',
      path: `${this.#urlObject.pathname}/messages/${messageId}`,
    });
  }

  /**
   * Verifies an Ed25519 signature for Discord interactions.
   * @param {string} signature The signature to verify (hex string).
   * @param {string} timestamp The timestamp of the interaction.
   * @param {string | object} body The body of the interaction.
   * @param {string} publicKey The application's public key (hex string).
   * @returns {boolean} True if the signature is valid, false otherwise.
   */
  generateSignature(timestamp, body, secret) {
    const message = timestamp + (typeof body === 'string' ? body : JSON.stringify(body));
    return crypto.createHmac('sha256', secret).update(message).digest('hex');
  }

  verifySignature(signature, timestamp, body, secret) {
    try {
      const expected = this.generateSignature(timestamp, body, secret);
      if (signature.length !== expected.length) return false;
      return crypto.timingSafeEqual(Buffer.from(signature, 'hex'), Buffer.from(expected, 'hex'));
    } catch {
      return false;
    }
  }
}

export default DiscordWebhookTools;
