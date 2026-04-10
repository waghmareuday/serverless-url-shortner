import { verifyToken } from "@clerk/backend";

// ── Config (resolved once at cold-start) ────────────────────────────────────
const CLERK_SECRET_KEY = process.env.CLERK_SECRET_KEY;
const CLERK_JWT_KEY    = process.env.CLERK_JWT_KEY; // PEM public key — optional

if (!CLERK_SECRET_KEY) {
  console.warn(
    "[auth] CLERK_SECRET_KEY not set. " +
    "Authenticated endpoints will treat all requests as anonymous."
  );
}

/**
 * Verify the Clerk JWT from the Authorization header.
 *
 * Returns:
 *   - { userId: string, tier: 'PREMIUM' }  on valid JWT
 *   - { userId: null,   tier: 'ANONYMOUS' } when no token or invalid token
 *
 * This function NEVER throws — it fails open to ANONYMOUS so the shorten
 * endpoint keeps working for unauthenticated visitors.
 *
 * Performance notes:
 *   - When CLERK_JWT_KEY (PEM) is set → networkless verification (0ms overhead)
 *   - When only CLERK_SECRET_KEY is set → SDK fetches JWKS on cold start (~200ms)
 */
export async function verifyAuth(event) {
  const ANONYMOUS = { userId: null, tier: "ANONYMOUS" };

  // No Clerk configured — everything is anonymous
  if (!CLERK_SECRET_KEY) return ANONYMOUS;

  // Extract Bearer token
  const authHeader =
    event.headers?.Authorization ||
    event.headers?.authorization ||
    "";
  const token = authHeader.startsWith("Bearer ")
    ? authHeader.slice(7).trim()
    : null;

  if (!token) return ANONYMOUS;

  try {
    const verifyOpts = {};

    // Prefer PEM (networkless) if available; fall back to secretKey (JWKS fetch)
    if (CLERK_JWT_KEY) {
      verifyOpts.jwtKey = CLERK_JWT_KEY;
    } else {
      verifyOpts.secretKey = CLERK_SECRET_KEY;
    }

    const payload = await verifyToken(token, verifyOpts);

    const userId = payload?.sub;
    if (!userId) {
      console.warn("[auth] JWT verified but missing sub claim");
      return ANONYMOUS;
    }

    return { userId, tier: "PREMIUM" };
  } catch (err) {
    // Invalid/expired token → treat as anonymous (don't block the request)
    console.warn("[auth] JWT verification failed:", err?.message || err);
    return ANONYMOUS;
  }
}
