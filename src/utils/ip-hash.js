import crypto from "crypto";

const IP_HASH_SALT = process.env.IP_HASH_SALT;

// BUG FIX: Throw at startup — unsalted SHA-256 of an IP is trivially reversible
// via rainbow table, making any GDPR/privacy claim about hashed IPs false.
if (!IP_HASH_SALT) {
  throw new Error(
    "[privacy] IP_HASH_SALT env var is required. " +
    "Generate a secret value (e.g. 32 random hex bytes) and set it before deploying."
  );
}

/**
 * Returns a 16-character hex HMAC of the IP address.
 * Using HMAC-SHA256 (keyed hash) rather than plain SHA-256 provides
 * proper pseudonymisation — the salt is the key, not just a prefix.
 */
export function hashIp(ip) {
  const rawIp = typeof ip === "string" && ip.trim() ? ip.trim() : "unknown";
  return crypto
    .createHmac("sha256", IP_HASH_SALT)
    .update(rawIp)
    .digest("hex")
    .slice(0, 16);
}
