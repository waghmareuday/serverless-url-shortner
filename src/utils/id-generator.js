/**
 * id-generator.js — Collision-Free Short Code Engine
 *
 * ALGORITHM: Twitter Snowflake (modified) → Base62 → 7-char short code
 */

"use strict";

// ── MODERN ES MODULE IMPORTS ───────────────────────────────────────────────
import os from "os";
import crypto from "crypto";

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

/** Custom epoch: 2024-01-01T00:00:00.000Z in seconds */
const EPOCH = 1704067200n;

const TIMESTAMP_BITS   = 30n;  // seconds
const WORKER_ID_BITS   = 5n;
const SEQUENCE_BITS    = 6n;

const MAX_WORKER_ID    = -1n ^ (-1n << WORKER_ID_BITS);  // 31
const MAX_SEQUENCE     = -1n ^ (-1n << SEQUENCE_BITS);   // 63

const WORKER_SHIFT     = SEQUENCE_BITS;                  // 6
const TIMESTAMP_SHIFT  = WORKER_ID_BITS + SEQUENCE_BITS; // 11

const BASE62_CHARS = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
const BASE         = 62n;
const SHORT_CODE_LENGTH = 7;

// ─────────────────────────────────────────────────────────────────────────────
// Worker ID Resolution
// ─────────────────────────────────────────────────────────────────────────────

function resolveWorkerId() {
  const envId = process.env.WORKER_ID;
  if (envId !== undefined) {
    const id = BigInt(envId);
    if (id < 0n || id > MAX_WORKER_ID) {
      throw new RangeError(`WORKER_ID must be 0–${MAX_WORKER_ID}, got ${id}`);
    }
    return id;
  }

  const seed = `${os.hostname()}:${process.env.AWS_LAMBDA_FUNCTION_NAME ?? "local"}`;
  let hash = 0;
  for (let i = 0; i < seed.length; i++) {
    hash = (Math.imul(31, hash) + seed.charCodeAt(i)) | 0;
  }
  return BigInt(Math.abs(hash)) & MAX_WORKER_ID;
}

// ─────────────────────────────────────────────────────────────────────────────
// SnowflakeGenerator Class
// ─────────────────────────────────────────────────────────────────────────────

class SnowflakeGenerator {
  #workerId;
  #sequence    = 0n;
  #lastTimestamp = -1n;

  constructor(workerId = resolveWorkerId()) {
    if (workerId < 0n || workerId > MAX_WORKER_ID) {
      throw new RangeError(`workerId must be 0–${MAX_WORKER_ID}`);
    }
    this.#workerId = workerId;
  }

  nextId() {
    let timestamp = this.#currentTime();

    if (timestamp < this.#lastTimestamp) {
      throw new ClockBackwardsError(
        `Clock moved backwards by ${this.#lastTimestamp - timestamp}ms. ` +
        `Last: ${this.#lastTimestamp}, Now: ${timestamp}`
      );
    }

    if (timestamp === this.#lastTimestamp) {
      this.#sequence = (this.#sequence + 1n) & MAX_SEQUENCE;

      if (this.#sequence === 0n) {
        console.warn("[id-generator] Sequence exhausted for current second; waiting for next second.");
        timestamp = this.#waitNextSecond(this.#lastTimestamp);
      }
    } else {
      this.#sequence = 0n;
    }

    this.#lastTimestamp = timestamp;

    return (
      ((timestamp - EPOCH) << TIMESTAMP_SHIFT) |
      (this.#workerId      << WORKER_SHIFT)    |
      this.#sequence
    );
  }

  nextShortCode() {
    return toBase62(this.nextId(), SHORT_CODE_LENGTH);
  }

  static decode(shortCode) {
    const id          = fromBase62(shortCode);
    const timestampSecs = (id >> TIMESTAMP_SHIFT) + EPOCH;
    const workerId    = (id >> WORKER_SHIFT) & MAX_WORKER_ID;
    const sequence    = id & MAX_SEQUENCE;

    return {
      rawId:     id,
      timestamp: new Date(Number(timestampSecs) * 1000),
      workerId,
      sequence,
    };
  }

  #currentTime() {
    return BigInt(Math.floor(Date.now() / 1000));
  }

  #waitNextSecond(lastTimestamp) {
    let ts = this.#currentTime();
    while (ts <= lastTimestamp) {
      ts = this.#currentTime();
    }
    return ts;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Base62 Codec
// ─────────────────────────────────────────────────────────────────────────────

function toBase62(num, length) {
  if (num < 0n) throw new RangeError("num must be non-negative");

  let result = "";
  let n = num;

  while (n > 0n) {
    result = BASE62_CHARS[Number(n % BASE)] + result;
    n = n / BASE;
  }
  return result.padStart(length, "0");
}

function fromBase62(str) {
  let result = 0n;
  for (const char of str) {
    const idx = BASE62_CHARS.indexOf(char);
    if (idx === -1) throw new SyntaxError(`Invalid Base62 char: '${char}'`);
    result = result * BASE + BigInt(idx);
  }
  return result;
}

// ─────────────────────────────────────────────────────────────────────────────
// NanoID Fallback
// ─────────────────────────────────────────────────────────────────────────────

function nanoIdFallback(length = SHORT_CODE_LENGTH) {
  const bytes = crypto.randomBytes(length * 2); 
  let result  = "";
  for (let i = 0; i < bytes.length && result.length < length; i++) {
    const idx = bytes[i] % 62;
    result += BASE62_CHARS[idx];
  }
  return result;
}

// ─────────────────────────────────────────────────────────────────────────────
// Custom Errors
// ─────────────────────────────────────────────────────────────────────────────

class ClockBackwardsError extends Error {
  constructor(message) {
    super(message);
    this.name = "ClockBackwardsError";
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Singleton & ES Module Exports
// ─────────────────────────────────────────────────────────────────────────────

const generator = new SnowflakeGenerator();

export { SnowflakeGenerator, toBase62, fromBase62, ClockBackwardsError, SHORT_CODE_LENGTH };

// Export the main function as generateId to match Phase 2's shorten.js
export function generateId() {
  try {
    return generator.nextShortCode();
  } catch (err) {
    if (err instanceof ClockBackwardsError) {
      console.warn("[id-generator] Clock backwards, using NanoID fallback", err.message);
      return nanoIdFallback();
    }
    throw err;
  }
}