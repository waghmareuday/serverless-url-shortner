import { useMemo, useEffect, useCallback, useRef } from "react";
import { useAuth } from "@clerk/react";
import { useQuery, useQueryClient } from "@tanstack/react-query";

const LINKS_QUERY_KEY = "user-links";

/**
 * Custom hook that manages the authenticated user's link history.
 *
 * Key fixes:
 *  - refreshLinks forces a real API call every time (no stale closures)
 *  - toggleLink / updateLink auto-refresh from server after success
 *  - All API methods return { ok, error?, data? } for clean UI handling
 */
export function useUserLinks(requestBaseUrl, normalizedBaseUrl) {
  const { getToken, isSignedIn, isLoaded, userId } = useAuth();
  const queryClient = useQueryClient();

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

  const queryKey = useMemo(
    () => [LINKS_QUERY_KEY, userId || "anon", requestBaseUrl, normalizedBaseUrl],
    [userId, requestBaseUrl, normalizedBaseUrl]
  );

  // ── Fetch all links ────────────────────────────────────────────────────────
  const fetchLinks = useCallback(async () => {
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

    return mergedLinks.map((link) => ({
      ...link,
      shortUrl: link.shortUrl || `${normalizedBaseUrl}/${link.id}`,
    }));
  }, [buildHeaders, requestBaseUrl, normalizedBaseUrl]);

  const {
    data: links = [],
    isLoading,
    isFetching,
    dataUpdatedAt,
    error: linksError,
    refetch,
  } = useQuery({
    queryKey,
    queryFn: fetchLinks,
    enabled: isLoaded && isSignedIn,
    refetchInterval: false,
    refetchOnWindowFocus: true,
    staleTime: 0,
    retry: 1,
  });

  useEffect(() => {
    if (isLoaded && !isSignedIn) {
      queryClient.removeQueries({ queryKey: [LINKS_QUERY_KEY] });
    }
  }, [isLoaded, isSignedIn, queryClient]);

  const urlMap = useMemo(() => {
    const map = new Map();
    for (const link of links) {
      if (link.originalUrl) map.set(link.originalUrl, link);
    }
    return map;
  }, [links]);

  const refreshLinks = useCallback(async () => {
    const result = await refetch();
    if (result.error) {
      return { ok: false, error: result.error?.message || "Failed to refresh links." };
    }
    return { ok: true, data: result.data || [] };
  }, [refetch]);

  // ── Toggle isActive ────────────────────────────────────────────────────────
  const toggleLink = useCallback(async (id, currentIsActive) => {
    const previousLinks = queryClient.getQueryData(queryKey) || [];
    queryClient.setQueryData(queryKey, (prev = []) =>
      prev.map((link) =>
        link.id === id ? { ...link, isActive: !currentIsActive } : link
      )
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
        throw new Error(payload?.error || `Toggle failed (${res.status}).`);
      }

      await refetch();
      return { ok: true };
    } catch (err) {
      queryClient.setQueryData(queryKey, previousLinks);
      return { ok: false, error: err?.message };
    }
  }, [buildHeaders, requestBaseUrl, queryClient, queryKey, refetch]);

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

      queryClient.setQueryData(queryKey, (prev = []) =>
        prev.map((link) =>
          link.id === id
            ? {
                ...link,
                originalUrl: payload.originalUrl || link.originalUrl,
                isActive: payload.isActive ?? link.isActive,
                expiresAt: payload.expiresAt ?? link.expiresAt,
              }
            : link
        )
      );

      await refetch();
      return { ok: true, data: payload };
    } catch (err) {
      return { ok: false, error: err?.message };
    }
  }, [buildHeaders, requestBaseUrl, queryClient, queryKey, refetch]);

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
  const findByOriginalUrl = useCallback((url) => urlMap.get(url) || null, [urlMap]);

  const addLink = useCallback((link) => {
    queryClient.setQueryData(queryKey, (prev = []) => [link, ...prev]);
  }, [queryClient, queryKey]);

  return {
    links,
    isLoading,
    isFetching,
    lastUpdatedAt: dataUpdatedAt || null,
    error: linksError?.message || null,
    findByOriginalUrl,
    addLink,
    refreshLinks,
    toggleLink,
    updateLink,
    fetchLinkStats,
  };
}
