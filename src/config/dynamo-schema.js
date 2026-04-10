import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";

// Initialize the raw client
const client = new DynamoDBClient({ region: process.env.AWS_REGION || "ap-south-1" });

// Wrap it in the DocumentClient (makes working with JSON objects much easier)
const dynamo = DynamoDBDocumentClient.from(client);

// Export the table name and the live client
const tableName = process.env.DYNAMODB_TABLE;
if (!tableName) {
	throw new Error("DYNAMODB_TABLE env var is required");
}

export const TABLE = tableName;
export default dynamo;

// ─────────────────────────────────────────────────────────────────────────────
// DynamoDB Single-Table Schema — Enterprise URL Shortener
// Staff Systems Engineer Design Notes (v2 — with Clerk Auth & Analytics Tiering)
//
// ACCESS PATTERNS:
//  [R1] Redirect:       GET  shortCode        → originalUrl   (P99 < 1ms, ~99% of traffic)
//  [R2] Dedup write:    GET  originalUrl       → shortCode     (pre-write duplicate check)
//  [R3] Analytics:      GET  shortCode + range → click events
//  [R4] User listing:   GET  userId + range    → [shortCode]   (dashboard via GSI2)
//  [R5] Admin audit:    SCAN createdAt range   → [records]     (rare, offline)
//  [R6] Link update:    PUT  shortCode         → update originalUrl/isActive
//
// ─── ENTITY: URL (PK = "URL#<shortCode>", SK = "META") ─────────────────────
// {
//   PK:            "URL#ab3Xk7Z"           // Partition key
//   SK:            "META"                  // Sort key — fixed sentinel
//   id:            "ab3Xk7Z"              // Short code
//   originalUrl:   "https://..."          // The redirect target
//   tier:          "PREMIUM" | "ANONYMOUS" // Cost-tiering bucket
//   userId:        "user_2xBc..."         // Clerk userId (PREMIUM only)
//   clickCount:    0                       // Atomic counter (PREMIUM only)
//   isActive:      true                   // Soft-disable (PREMIUM only)
//   createdAt:     1713225600000           // Unix ms
//   expiresAt:     1715817600             // Unix SECONDS (ANONYMOUS: 30d TTL, PREMIUM: absent)
//   safetyStatus:  "PENDING"|"SAFE"|"UNSAFE"
//   safetyCheckedAt: 1713225700000
//   threatTypes:   ["MALWARE"]            // From Google Safe Browsing
// }
//
// ANONYMOUS records are as tiny as possible:
//   - NO userId, clickCount, isActive fields
//   - expiresAt set to 30 days → DynamoDB TTL auto-deletes
//
// PREMIUM records are richer:
//   - userId + clickCount + isActive fields present
//   - NO expiresAt → lives forever
//   - Indexed by GSI2-UserLinks for dashboard queries
//
// ─── ENTITY: CLICK (PK = "URL#<shortCode>", SK = "CLICK#<ts>#<nonce>") ──────
// Written only for PREMIUM-tier links. Anonymous redirects skip SQS entirely.
// {
//   PK:          "URL#ab3Xk7Z"
//   SK:          "CLICK#1713225600123#7f3a"
//   ipHash:      "a1b2c3d4e5f6g7h8"       // HMAC-SHA256 truncated (GDPR)
//   userAgent:   "Mozilla/5.0 ..."
//   referer:     "https://twitter.com"
//   createdAt:   1713225600123
//   expiresAt:   1744761600                // Purge clicks with parent URL
// }
//
// ─── GSI2-UserLinks ─────────────────────────────────────────────────────────
// Hash Key: userId (S)
// Range Key: createdAt (N)
// Projection: INCLUDE [id, originalUrl, clickCount, isActive, tier]
// Purpose: Dashboard → "show me all my links, newest first"
// Query: userId = :uid, ScanIndexForward: false
// ─────────────────────────────────────────────────────────────────────────────