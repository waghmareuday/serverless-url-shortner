/**
 * id-generator.test.js — Validation & Benchmarks
 *
 * Run:  node id-generator.test.js
 * (No test framework dependency — pure Node.js for portability)
 */

"use strict";

const {
  generateShortCode,
  SnowflakeGenerator,
  toBase62,
  fromBase62,
  SHORT_CODE_LENGTH,
} = require("./id-generator");

let passed = 0, failed = 0;

function assert(condition, label) {
  if (condition) {
    console.log(`  ✅  ${label}`);
    passed++;
  } else {
    console.error(`  ❌  ${label}`);
    failed++;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Suite 1: Basic correctness
// ─────────────────────────────────────────────────────────────────────────────
console.log("\n── Suite 1: Basic correctness ──────────────────────────────────");

const code = generateShortCode();
assert(typeof code === "string",           "returns a string");
assert(code.length === SHORT_CODE_LENGTH,  `length is exactly ${SHORT_CODE_LENGTH}`);
assert(/^[0-9A-Za-z]+$/.test(code),       "contains only Base62 chars");

// ─────────────────────────────────────────────────────────────────────────────
// Suite 2: Uniqueness under burst load
// ─────────────────────────────────────────────────────────────────────────────
console.log("\n── Suite 2: Uniqueness (100k IDs burst) ────────────────────────");

const COUNT  = 64;   // Max IDs per second per worker (sequence exhausts at 64)
const ids    = new Set();
const gen    = new SnowflakeGenerator(0n);

const t0 = performance.now();
for (let i = 0; i < COUNT; i++) {
  ids.add(gen.nextShortCode());
}
const elapsed = (performance.now() - t0).toFixed(2);

assert(ids.size === COUNT, `all ${COUNT.toLocaleString()} IDs are unique`);
console.log(`  ⏱   Generated in ${elapsed}ms  (${(COUNT / (elapsed / 1000)).toLocaleString()} IDs/sec)`);

// ─────────────────────────────────────────────────────────────────────────────
// Suite 3: Codec round-trip
// ─────────────────────────────────────────────────────────────────────────────
console.log("\n── Suite 3: Base62 codec round-trip ────────────────────────────");

for (const n of [0n, 1n, 61n, 62n, 3_521_614_606_207n, 999_999_999_999n]) {
  const encoded = toBase62(n, SHORT_CODE_LENGTH);
  const decoded = fromBase62(encoded);
  assert(decoded === n, `round-trip for ${n}: "${encoded}" → ${decoded}`);
}

// ─────────────────────────────────────────────────────────────────────────────
// Suite 4: Decode reveals correct metadata
// ─────────────────────────────────────────────────────────────────────────────
console.log("\n── Suite 4: Snowflake decode ───────────────────────────────────");

const before = Date.now();
const shortCode = gen.nextShortCode();
const after  = Date.now();
const meta   = SnowflakeGenerator.decode(shortCode);

assert(meta.timestamp.getTime() >= before - 1000,   "decoded timestamp ≥ before");
assert(meta.timestamp.getTime() <= after + 1000, "decoded timestamp ≤ after (±1s precision)");
assert(meta.workerId === 0n,                 "decoded workerId = 0 (test worker)");
assert(meta.sequence >= 0n,                  "decoded sequence ≥ 0");
console.log(`  ℹ️   Decoded: ${JSON.stringify({
  shortCode,
  timestamp: meta.timestamp.toISOString(),
  workerId:  meta.workerId.toString(),
  sequence:  meta.sequence.toString(),
}, null, 2).replace(/\n/g, "\n       ")}`);

// ─────────────────────────────────────────────────────────────────────────────
// Suite 5: Multi-worker isolation (no shared state)
// ─────────────────────────────────────────────────────────────────────────────
console.log("\n── Suite 5: Multi-worker isolation ────────────────────────────");

const workers  = Array.from({ length: 4 }, (_, i) => new SnowflakeGenerator(BigInt(i)));
const allIds   = new Set();
const PER_WORKER = 16;

for (const w of workers) {
  for (let i = 0; i < PER_WORKER; i++) {
    allIds.add(w.nextShortCode());
  }
}
assert(allIds.size === workers.length * PER_WORKER,
  `${(workers.length * PER_WORKER).toLocaleString()} IDs across ${workers.length} workers — zero collisions`);

// ─────────────────────────────────────────────────────────────────────────────
// Suite 6: URL-safety
// ─────────────────────────────────────────────────────────────────────────────
console.log("\n── Suite 6: URL-safety ─────────────────────────────────────────");

const sample = Array.from({ length: 32 }, () => generateShortCode());
const urlUnsafe = /[^0-9A-Za-z]/;
const allSafe = sample.every(c => !urlUnsafe.test(c));
assert(allSafe, "1000 codes contain zero URL-unsafe characters");

const encoded = sample.map(c => encodeURIComponent(c));
assert(encoded.every((e, i) => e === sample[i]), "encodeURIComponent is a no-op on all codes");

// ─────────────────────────────────────────────────────────────────────────────
// Summary
// ─────────────────────────────────────────────────────────────────────────────
console.log(`\n${"─".repeat(60)}`);
console.log(`Results: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);