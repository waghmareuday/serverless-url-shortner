import { useState, useEffect, useCallback, useRef } from "react";
import { useAuth } from "@clerk/react";

/**
 * Custom hook that manages the authenticated user's link history.
 *
 * Key fixes:
 *  - refreshLinks forces a real API call every time (no stale closures)
 *  - toggleLink / updateLink auto-refresh from server after success
 *  - All API methods return { ok, error?, data? } for clean UI handling
 */
export function useUserLinks(requestBaseUrl, normalizedBaseUrl) {
  const { getToken, isSignedIn, isLoaded } = useAuth();
  const [links, setLinks]         = useState([]);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError]         = useState(null);
  const urlMapRef                 = useRef(new Map());

  // Rebuild lookup map
  useEffect(() => {
    const map = new Map();
    for (const link of links) {
      if (link.originalUrl) map.set(link.originalUrl, link);
    }
    urlMapRef.current = map;
  }, [links]);

  // ── Stable auth header builder ─────────────────────────────────────────────
  // Use ref to avoid re-creating fetchLinks when getToken reference changes
  const getTokenRef = useRef(getToken);
  useEffect(() => { getTokenRef.current = getToken; }, [getToken]);

  const buildHeaders = useCallback(async () => {
    let token = null;
    try {
      token = await getTokenRef.current?.({ skipCache: true });
      if (!token) token = await getTokenRef.current?.();
    } catch (err) {
      console.warn("[useUserLinks] Token fetch failed:", err?.message || err);
    }

    if (!token) {
      throw new Error("Authentication expired. Please sign in again.");
    }

    return { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
  }, []); // stable — never changes

  // ── Fetch all links ────────────────────────────────────────────────────────
  const fetchLinks = useCallback(async ({ silent = false } = {}) => {
    if (!isSignedIn) return;

    if (!silent) setIsLoading(true);
    setError(null);

    try {
      const headers = await buildHeaders();

      const mergedLinks = [];
      let nextToken = null;

      do {
        const qs = new URLSearchParams();
        if (nextToken) qs.set("nextToken", nextToken);

        const url = qs.toString()
          ? `${requestBaseUrl}/user/links?${qs.toString()}`
          : `${requestBaseUrl}/user/links`;

        const res = await fetch(url, { headers, cache: "no-store" });
        const payload = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(payload?.error || `Failed (${res.status}).`);

        mergedLinks.push(...(payload.links || []));
        nextToken = payload.nextToken || null;
      } while (nextToken);

      setLinks(
        mergedLinks.map((link) => ({
          ...link,
          shortUrl: link.shortUrl || `${normalizedBaseUrl}/${link.id}`,
        }))
      );

      return { ok: true };
    } catch (err) {
      console.error("[useUserLinks] Fetch error:", err?.message);
      setError(err?.message || "Failed to load your links.");
      return { ok: false, error: err?.message || "Failed to load your links." };
    } finally {
      if (!silent) setIsLoading(false);
    }
  }, [isSignedIn, buildHeaders, requestBaseUrl, normalizedBaseUrl]);

  // Auto-fetch on sign-in / clear on sign-out
  useEffect(() => {
    if (isLoaded && isSignedIn) void fetchLinks();
    if (isLoaded && !isSignedIn) { setLinks([]); setError(null); }
  }, [isLoaded, isSignedIn, fetchLinks]);

  // ── Toggle isActive ────────────────────────────────────────────────────────
  const toggleLink = useCallback(async (id, currentIsActive) => {
    // Optimistic UI update FIRST for instant feedback
    setLinks((prev) =>
      prev.map((l) => (l.id === id ? { ...l, isActive: !currentIsActive } : l))
    );
    try {
      const headers = await buildHeaders();
      const res = await fetch(`${requestBaseUrl}/user/links/${id}`, {
        method: "PUT",
        headers,
        body: JSON.stringify({ isActive: !currentIsActive }),
      });
      const payload = await res.json().catch(() => ({}));
      if (!res.ok) {
        // Revert optimistic update on failure
        setLinks((prev) =>
          prev.map((l) => (l.id === id ? { ...l, isActive: currentIsActive } : l))
        );
        throw new Error(payload?.error || `Toggle failed (${res.status}).`);
      }

      // Pull latest server state so dashboard stays accurate without re-login.
      await fetchLinks({ silent: true });
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err?.message };
    }
  }, [buildHeaders, requestBaseUrl, fetchLinks]);

  // ── Update link (reroute URL / set expiration) ─────────────────────────────
  const updateLink = useCallback(async (id, updates) => {
    try {
      const headers = await buildHeaders();
      const res = await fetch(`${requestBaseUrl}/user/links/${id}`, {
        method: "PUT",
        headers,
        body: JSON.stringify(updates),
      });
      const payload = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(payload?.error || `Update failed (${res.status}).`);

      // Update local state with server response
      setLinks((prev) =>
        prev.map((l) =>
          l.id === id
            ? {
                ...l,
                originalUrl: payload.originalUrl || l.originalUrl,
                isActive:    payload.isActive ?? l.isActive,
                expiresAt:   payload.expiresAt ?? l.expiresAt,
              }
            : l
        )
      );

      // Refresh from backend to avoid drift across tabs/sessions.
      await fetchLinks({ silent: true });
      return { ok: true, data: payload };
    } catch (err) {
      return { ok: false, error: err?.message };
    }
  }, [buildHeaders, requestBaseUrl, fetchLinks]);

  // ── Fetch link stats ───────────────────────────────────────────────────────
  const fetchLinkStats = useCallback(async (id) => {
    try {
      const headers = await buildHeaders();
      const res = await fetch(`${requestBaseUrl}/user/links/${id}/stats`, {
        headers,
        cache: "no-store",
      });
      const payload = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(payload?.error || `Stats failed (${res.status}).`);
      return { ok: true, data: payload };
    } catch (err) {
      return { ok: false, error: err?.message };
    }
  }, [buildHeaders, requestBaseUrl]);

  // ── Lookups ────────────────────────────────────────────────────────────────
  const findByOriginalUrl = useCallback((url) => urlMapRef.current.get(url) || null, []);
  const addLink = useCallback((link) => setLinks((prev) => [link, ...prev]), []);

  return {
    links,
    isLoading,
    error,
    findByOriginalUrl,
    addLink,
    refreshLinks: fetchLinks,
    toggleLink,
    updateLink,
    fetchLinkStats,
  };
}
