import crypto from "crypto";

const IP_HASH_SALT = process.env.IP_HASH_SALT || "";

if (!IP_HASH_SALT) {
  console.warn("[privacy] IP_HASH_SALT is not set; using unsalted IP hashing.");
}

export function hashIp(ip) {
  const rawIp = typeof ip === "string" && ip.trim() ? ip.trim() : "unknown";
  return crypto.createHash("sha256").update(rawIp + IP_HASH_SALT).digest("hex").slice(0, 16);
}
