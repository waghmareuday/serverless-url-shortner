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

// (Keep your CREATE_TABLE_PARAMS from Phase 1 down here as a reference, 
// though we won't need them in the Lambda runtime, only for setup)

// /**
//  * DynamoDB Table Schema — Enterprise URL Shortener
//  * Staff Systems Engineer Design Notes
//  *
//  * ACCESS PATTERNS (drives every design decision):
//  *  [R1] Redirect:      GET  shortCode        → originalUrl   (P99 < 1ms, ~99% of traffic)
//  *  [R2] Dedup write:   GET  originalUrl       → shortCode     (pre-write duplicate check)
//  *  [R3] Analytics:     GET  shortCode + range → click events
//  *  [R4] User listing:  GET  userId + range    → [shortCode]   (dashboard)
//  *  [R5] Admin audit:   SCAN createdAt range   → [records]     (rare, offline)
//  *
//  * WHY SINGLE-TABLE DESIGN?
//  *  - Eliminates cross-table joins (no RDS, no N+1)
//  *  - One network round-trip per hot-path read [R1]
//  *  - DynamoDB Accelerator (DAX) caches a single table cleanly
//  */

// const { DynamoDBClient } = require("@aws-sdk/client-dynamodb");

// // ─────────────────────────────────────────────────────────────────────────────
// // ENTITY: URL  (PK = "URL#<shortCode>",  SK = "META")
// // ─────────────────────────────────────────────────────────────────────────────
// // {
// //   PK:            "URL#ab3Xk7Z"           // Partition key — hash of shortCode
// //   SK:            "META"                  // Sort key — fixed sentinel
// //   shortCode:     "ab3Xk7Z"              // Projected for GSI
// //   originalUrl:   "https://..."          // The redirect target
// //   userId:        "usr_01HV..."           // Owner (ULID or Cognito sub)
// //   domain:        "go.acme.com"           // Custom domain support
// //   title:         "Q4 Campaign Link"      // Optional human label
// //   tags:          ["campaign", "email"]   // For faceted filtering
// //   clickCount:    0                       // Atomic counter (UpdateItem ADD)
// //   createdAt:     1713225600000           // Unix ms — for TTL math & GSI sort
// //   expiresAt:     1744761600             // Unix SECONDS — DynamoDB native TTL
// //   isActive:      true                   // Soft-disable without delete
// // }

// // ─────────────────────────────────────────────────────────────────────────────
// // ENTITY: CLICK  (PK = "URL#<shortCode>",  SK = "CLICK#<timestamp>#<nonce>")
// // ─────────────────────────────────────────────────────────────────────────────
// // Writes are async (SQS → Lambda fan-out), never on the hot redirect path.
// // {
// //   PK:          "URL#ab3Xk7Z"
// //   SK:          "CLICK#1713225600123#7f3a"  // ms + 4-char nonce → no collision
// //   ip:          "203.0.113.42"              // Hashed at write time (GDPR)
// //   userAgent:   "Mozilla/5.0 ..."
// //   referer:     "https://twitter.com"
// //   country:     "IN"                        // MaxMind GeoIP — enriched async
// //   createdAt:   1713225600123
// //   expiresAt:   1744761600                 // Purge clicks with parent URL
// // }

// // ─────────────────────────────────────────────────────────────────────────────
// // CreateTable Parameters
// // ─────────────────────────────────────────────────────────────────────────────
// const CREATE_TABLE_PARAMS = {
//   TableName: "url-shortener",

//   // ── Keys ──────────────────────────────────────────────────────────────────
//   // Composite key lets us co-locate URL metadata + click events in one partition.
//   // Single-partition reads for analytics = zero fan-out, zero scatter-gather.
//   KeySchema: [
//     { AttributeName: "PK", KeyType: "HASH" },   // "URL#<shortCode>"
//     { AttributeName: "SK", KeyType: "RANGE" },  // "META" | "CLICK#<ts>#<nonce>"
//   ],
//   AttributeDefinitions: [
//     { AttributeName: "PK",          AttributeType: "S" },
//     { AttributeName: "SK",          AttributeType: "S" },
//     { AttributeName: "originalUrl", AttributeType: "S" },  // GSI-1 key
//     { AttributeName: "userId",      AttributeType: "S" },  // GSI-2 key
//     { AttributeName: "createdAt",   AttributeType: "N" },  // GSI-2 sort key
//   ],

//   // ── Billing ───────────────────────────────────────────────────────────────
//   // PAY_PER_REQUEST = zero capacity planning, auto-scales to millions of RPS.
//   // Switch to PROVISIONED + auto-scaling only if steady-state traffic is known.
//   BillingMode: "PAY_PER_REQUEST",

//   // ── Global Secondary Indexes ──────────────────────────────────────────────
//   GlobalSecondaryIndexes: [
//     {
//       // [R2] Dedup: "has this URL been shortened before?"
//       // Query: KeyConditionExpression = "originalUrl = :url AND SK = :meta"
//       IndexName: "GSI1-OriginalUrl",
//       KeySchema: [
//         { AttributeName: "originalUrl", KeyType: "HASH" },
//         { AttributeName: "SK",          KeyType: "RANGE" },
//       ],
//       Projection: {
//         // Only project what we need — minimise read cost & GSI storage
//         ProjectionType: "INCLUDE",
//         NonKeyAttributes: ["shortCode", "isActive", "expiresAt"],
//       },
//     },
//     {
//       // [R4] Dashboard: "show me all links for userId, newest first"
//       // Query: KeyConditionExpression = "userId = :uid"
//       //        ScanIndexForward: false  →  newest first via createdAt DESC
//       IndexName: "GSI2-UserLinks",
//       KeySchema: [
//         { AttributeName: "userId",    KeyType: "HASH" },
//         { AttributeName: "createdAt", KeyType: "RANGE" },
//       ],
//       Projection: {
//         ProjectionType: "INCLUDE",
//         NonKeyAttributes: ["shortCode", "originalUrl", "title", "clickCount", "isActive"],
//       },
//     },
//   ],

//   // ── TTL ───────────────────────────────────────────────────────────────────
//   // DynamoDB deletes items automatically when `expiresAt` (Unix seconds) passes.
//   // Zero cost, zero Lambda, zero cron. TTL deletions are free and eventual (~48h).
//   // Store expiresAt on BOTH the URL meta item AND each CLICK item for full purge.
//   // (No need to delete clicks manually — they share the same expiresAt value.)

//   // ── Point-in-Time Recovery ────────────────────────────────────────────────
//   // Enabled post-create via UpdateContinuousBackups. 35-day rolling window.
//   // Non-negotiable for any table storing customer data in production.

//   // ── Server-Side Encryption ────────────────────────────────────────────────
//   // Default AWS-owned KMS key (free). Swap for CMK if compliance requires
//   // key rotation audit trails (PCI-DSS, SOC2, ISO 27001).
//   SSESpecification: {
//     Enabled: true,
//   },

//   Tags: [
//     { Key: "service",     Value: "url-shortener" },
//     { Key: "env",         Value: "production" },
//     { Key: "cost-center", Value: "platform" },
//   ],
// };

// // ─────────────────────────────────────────────────────────────────────────────
// // Hot-path read helper — optimised for [R1] redirect
// // Consistent read = always latest data (no stale redirect).
// // ProjectionExpression = fetch only what Lambda needs, saves RCU bandwidth.
// // ─────────────────────────────────────────────────────────────────────────────
// const buildRedirectGetParams = (shortCode) => ({
//   TableName: "url-shortener",
//   Key: {
//     PK: { S: `URL#${shortCode}` },
//     SK: { S: "META" },
//   },
//   ProjectionExpression: "originalUrl, isActive, expiresAt, clickCount",
//   ConsistentRead: true,   // Strong consistency on redirect — never serve stale 404
// });

// module.exports = { CREATE_TABLE_PARAMS, buildRedirectGetParams };