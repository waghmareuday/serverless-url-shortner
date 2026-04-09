import redis from './redis.js';

const EXPECTED_ITEMS      = 1_000_000; 
const FALSE_POSITIVE_RATE = 0.01;      

const BLOOM_KEY = 'bloom:url_shortener';

function computeOptimalParams(n, p) {
  const m = Math.ceil((-n * Math.log(p)) / Math.pow(Math.log(2), 2));
  const k = Math.ceil((m / n) * Math.log(2));
  return { bitSize: m, numHashes: k };
}

const { bitSize, numHashes } = computeOptimalParams(EXPECTED_ITEMS, FALSE_POSITIVE_RATE);

function getBitPositions(key) {
  let h1 = 2166136261;
  for (let i = 0; i < key.length; i++) {
    h1 ^= key.charCodeAt(i);
    h1 = Math.imul(h1, 16777619);
  }
  let h2 = 5381;
  for (let i = 0; i < key.length; i++) {
    h2 = Math.imul(h2, 33) ^ key.charCodeAt(i);
  }
  h1 = Math.abs(h1);
  h2 = Math.abs(h2) || 1; 

  const positions = [];
  for (let i = 0; i < numHashes; i++) {
    positions.push((h1 + i * h2) % bitSize);
  }
  return positions;
}

export async function addToBloomFilter(shortCode) {
  const positions = getBitPositions(shortCode);
  const pipeline  = redis.pipeline();
  for (const pos of positions) {
    pipeline.setbit(BLOOM_KEY, pos, 1);
  }
  await pipeline.exec();
}

export async function mightExist(shortCode) {
  const positions = getBitPositions(shortCode);
  const pipeline  = redis.pipeline();
  for (const pos of positions) {
    pipeline.getbit(BLOOM_KEY, pos);
  }
  const results = await pipeline.exec();
  // Upstash returns [val, val, ...] while ioredis commonly returns [[err, val], ...].
  const normalizedBits = results.map((bit) => {
    if (Array.isArray(bit)) {
      const [err, val] = bit;
      if (err) {
        throw err;
      }
      return val;
    }
    return bit;
  });

  return normalizedBits.every((bit) => Number(bit) === 1);
}