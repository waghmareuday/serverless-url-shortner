import redis from './redis.js';

const EXPECTED_ITEMS      = 1_000_000;
const FALSE_POSITIVE_RATE = 0.01;

/**
 * Monthly key rotation:
 *  - bloom:url_shortener:YYYY-MM  (current month)
 *  - bloom:url_shortener:YYYY-MM  (previous month)
 *
 * We check both on reads so no URL added last month is missed at the
 * month boundary. Each key gets a 62-day TTL so Redis cleans up
 * automatically — zero ops work required.
 *
 * Why monthly instead of item-count-based rotation?
 *  - Simpler (no distributed counter needed)
 *  - At 5M req/day and, say, 1% of that being new URLs (~50k/day),
 *    we create ~1.5M URLs/month — comfortably within EXPECTED_ITEMS.
 *    Adjust EXPECTED_ITEMS if your write rate is higher.
 */
const BLOOM_KEY_TTL_SECONDS = 62 * 24 * 3600; // 62 days

function bloomKey(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  return `bloom:url_shortener:${y}-${m}`;
}

function getKeys() {
  const now  = new Date();
  const prev = new Date(now.getFullYear(), now.getMonth() - 1, 1);
  return { current: bloomKey(now), prev: bloomKey(prev) };
}

function computeOptimalParams(n, p) {
  const m = Math.ceil((-n * Math.log(p)) / Math.pow(Math.log(2), 2));
  const k = Math.ceil((m / n) * Math.log(2));
  return { bitSize: m, numHashes: k };
}

const { bitSize, numHashes } = computeOptimalParams(EXPECTED_ITEMS, FALSE_POSITIVE_RATE);

function getBitPositions(key) {
  // FNV-1a hash — force unsigned 32-bit via >>> 0 after each Math.imul to
  // stay consistent with the unsigned FNV spec and avoid Math.abs(-2^31)
  // overflowing to 2^31 (outside safe 32-bit int range).
  let h1 = 2166136261;
  for (let i = 0; i < key.length; i++) {
    h1 ^= key.charCodeAt(i);
    h1  = (Math.imul(h1, 16777619)) >>> 0;
  }
  // djb2 hash
  let h2 = 5381;
  for (let i = 0; i < key.length; i++) {
    h2 = (Math.imul(h2, 33) ^ key.charCodeAt(i)) >>> 0;
  }
  // h1 and h2 are already unsigned 32-bit, no Math.abs needed.
  h2 = h2 || 1; // ensure h2 is non-zero for double hashing

  const positions = [];
  for (let i = 0; i < numHashes; i++) {
    positions.push((h1 + i * h2) % bitSize);
  }
  return positions;
}

/**
 * Add a short-code to the current month's bloom filter.
 * Also sets the key's TTL on the first write of a new month.
 */
export async function addToBloomFilter(shortCode) {
  const { current } = getKeys();
  const positions   = getBitPositions(shortCode);
  const pipeline    = redis.pipeline();

  for (const pos of positions) {
    pipeline.setbit(current, pos, 1);
  }
  // Refresh TTL every write — cheap and ensures the key never disappears early.
  pipeline.expire(current, BLOOM_KEY_TTL_SECONDS);

  await pipeline.exec();
}

/**
 * Returns true if the short-code *might* exist (false positives possible).
 * Returns false only when the code is definitely not in the filter.
 *
 * Checks both the current and previous month's filter so URLs created just
 * before a month boundary are found reliably.
 */
export async function mightExist(shortCode) {
  const { current, prev } = getKeys();
  const positions         = getBitPositions(shortCode);
  const pipeline          = redis.pipeline();

  // Check current month
  for (const pos of positions) pipeline.getbit(current, pos);
  // Check previous month
  for (const pos of positions) pipeline.getbit(prev, pos);

  const results = await pipeline.exec();

  function normalize(bit) {
    if (Array.isArray(bit)) {
      const [err, val] = bit;
      if (err) throw err;
      return val;
    }
    return bit;
  }

  const currentBits = results.slice(0, numHashes).map(normalize);
  const prevBits    = results.slice(numHashes).map(normalize);

  const inCurrent = currentBits.every((b) => Number(b) === 1);
  const inPrev    = prevBits.every((b)    => Number(b) === 1);

  return inCurrent || inPrev;
}
