import { useMemo, useState } from "react";
import { parse as parseDomain } from "tldts";

// BUG FIX: removed the hardcoded production API Gateway URL fallback.
// VITE_API_BASE_URL must be set at build time — an explicit error at startup
// is far better than silently hitting the production endpoint from staging/preview.
const _rawBase = import.meta.env.VITE_API_BASE_URL;
if (!_rawBase) {
  throw new Error(
    "VITE_API_BASE_URL is not set. " +
    "Copy frontend/.env.example to frontend/.env.local and fill in the value."
  );
}

function CopyIcon({ className = "" }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" aria-hidden="true" focusable="false">
      <path
        d="M9 9.75A2.25 2.25 0 0 1 11.25 7.5h7.5A2.25 2.25 0 0 1 21 9.75v7.5a2.25 2.25 0 0 1-2.25 2.25h-7.5A2.25 2.25 0 0 1 9 17.25v-7.5Z"
        stroke="currentColor"
        strokeWidth="1.5"
      />
      <path
        d="M15 7.5V6.75A2.25 2.25 0 0 0 12.75 4.5h-7.5A2.25 2.25 0 0 0 3 6.75v7.5a2.25 2.25 0 0 0 2.25 2.25H6"
        stroke="currentColor"
        strokeWidth="1.5"
      />
    </svg>
  );
}

export default function App() {
  const [longUrl, setLongUrl] = useState("");
  const [shortLink, setShortLink] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState("");
  const [cacheStatus, setCacheStatus] = useState("");
  const [isCacheProbeLoading, setIsCacheProbeLoading] = useState(false);
  const [cacheProbeNote, setCacheProbeNote] = useState("");

  const normalizedBaseUrl = useMemo(() => _rawBase.replace(/\/+$/, ""), []);
  const requestBaseUrl = useMemo(
    () => (import.meta.env.DEV ? "/api" : normalizedBaseUrl),
    [normalizedBaseUrl]
  );

  const hasScheme = (value) => /^[a-zA-Z][a-zA-Z\d+\-.]*:\/\//.test(value);

  const hasMalformedWwwPrefix = (hostname) => {
    const firstLabel = hostname.split(".")[0]?.toLowerCase() || "";
    return firstLabel.startsWith("www") && firstLabel !== "www";
  };

  const isValidPublicUrl = (raw) => {
    try {
      const parsed = new URL(raw);
      if (!["http:", "https:"].includes(parsed.protocol)) return false;

      const hostname = parsed.hostname.toLowerCase();
      if (!hostname || hostname === "localhost" || hostname.endsWith(".")) return false;
      if (hasMalformedWwwPrefix(hostname)) return false;

      const domainInfo = parseDomain(hostname, { allowPrivateDomains: true });
      if (domainInfo.isIp || !domainInfo.domain || !domainInfo.publicSuffix) return false;

      return domainInfo.isIcann || domainInfo.isPrivate;
    } catch {
      return false;
    }
  };

  const formatCacheBadge = (status) => {
    if (status === "L1_HIT") return "Redirect Cache [ L1 Memory Hit ]";
    if (status === "HIT")    return "Redirect Cache [ L2 Redis Hit ]";
    if (status === "MISS")   return "Redirect Cache [ MISS → DynamoDB ]";
    return status ? `Redirect Cache [ ${status} ]` : "";
  };

  async function probeCacheStatus(shortId) {
    setIsCacheProbeLoading(true);
    setCacheProbeNote("");

    try {
      const res     = await fetch(`${requestBaseUrl}/cache-status/${encodeURIComponent(shortId)}`);
      const payload = await res.json().catch(() => ({}));

      if (!res.ok) {
        throw new Error(payload?.error || `Cache probe failed (${res.status}).`);
      }

      const normalized = String(payload?.cacheStatus || "").trim().toUpperCase();
      setCacheStatus(normalized);
      if (!normalized) setCacheProbeNote("Cache status unavailable right now.");
    } catch (probeErr) {
      console.warn("[ui] Could not probe redirect cache status:", probeErr?.message);
      setCacheStatus("");
      setCacheProbeNote("Cache status unavailable right now.");
    } finally {
      setIsCacheProbeLoading(false);
    }
  }

  async function handleSubmit(event) {
    event.preventDefault();

    const input = longUrl.trim();
    setCopied(false);
    setError("");
    setCacheStatus("");
    setIsCacheProbeLoading(false);
    setCacheProbeNote("");

    if (!input) {
      setError("Please enter a URL to shorten.");
      return;
    }

    const candidateUrl = hasScheme(input) ? input : `https://${input}`;

    if (!isValidPublicUrl(candidateUrl)) {
      setError("Please enter a valid public URL, for example: https://example.com/page");
      return;
    }

    setIsLoading(true);
    setShortLink("");

    try {
      const res = await fetch(`${requestBaseUrl}/shorten`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url: candidateUrl }),
      });

      const payload = await res.json().catch(() => ({}));

      if (!res.ok) {
        const message = payload?.error || payload?.message || `Request failed (${res.status}).`;
        throw new Error(message);
      }

      const shortId      = payload?.shortId || payload?.id || payload?.shortCode || payload?.code;
      // Prefer the server's canonical shortUrl (it knows the real redirect domain).
      // Only fall back to manual construction if the API omits shortUrl.
      const resolvedLink = payload?.shortUrl || (shortId ? `${normalizedBaseUrl}/${shortId}` : null);

      if (!resolvedLink) {
        throw new Error("The API response did not include a short URL.");
      }

      setShortLink(resolvedLink);
      if (shortId) void probeCacheStatus(shortId);

    } catch (requestErr) {
      const message =
        requestErr?.message === "Failed to fetch"
          ? "Browser blocked the request (likely CORS or network issue)."
          : requestErr?.message;
      setError(message || "Failed to shorten URL. Please try again.");
    } finally {
      setIsLoading(false);
    }
  }

  async function handleCopy() {
    if (!shortLink) return;
    try {
      await navigator.clipboard.writeText(shortLink);
      setCopied(true);
      setTimeout(() => setCopied(false), 1400);
    } catch {
      setError("Could not copy to clipboard. Please copy manually.");
    }
  }

  return (
    <>
      <style>{`
        /* Google Fonts loaded via <link> in index.html for better performance */
        :root {
          color-scheme: dark;
          --bg: #09090b; --panel: #111114; --panel-soft: #18181c;
          --text: #f4f4f5; --muted: #a1a1aa; --border: #27272a;
          --focus: rgba(161,161,170,0.34); --btn-bg: #f4f4f5; --btn-text: #111114;
          --danger: #fca5a5; --badge-bg: #16161a; --badge-text: #a1a1aa;
        }
        .shell { min-height:100vh; display:grid; place-items:center; padding:24px;
          background: radial-gradient(900px 500px at 10% -10%,rgba(63,63,70,.23),transparent 55%),
                      radial-gradient(700px 450px at 100% 0%,rgba(39,39,42,.3),transparent 50%), var(--bg);
          color:var(--text); font-family:"Manrope","Segoe UI",sans-serif; }
        .card { width:100%; max-width:760px; border-radius:16px; border:1px solid var(--border);
          background:linear-gradient(180deg,rgba(24,24,28,.94),rgba(15,15,18,.94));
          padding:28px; box-shadow:0 24px 70px rgba(0,0,0,.45); }
        .eyebrow { margin:0 0 10px; font-size:12px; letter-spacing:.08em; text-transform:uppercase;
          color:var(--muted); font-weight:600; }
        .title { margin:0; font-size:clamp(1.32rem,2.5vw,2rem); line-height:1.2; font-weight:700; }
        .subtitle { margin:10px 0 0; color:var(--muted); font-size:.96rem; line-height:1.52; }
        .form { margin-top:22px; display:grid; gap:12px; }
        .row { display:grid; grid-template-columns:1fr auto; gap:10px; }
        .url-input { height:50px; border-radius:12px; border:1px solid var(--border);
          background:#0f0f13; color:var(--text); padding:0 14px; font-size:.95rem;
          outline:none; transition:border-color 140ms,box-shadow 140ms; }
        .url-input::placeholder { color:#71717a; }
        .url-input:focus { border-color:#52525b; box-shadow:0 0 0 4px var(--focus); }
        .shorten-btn { min-width:132px; height:50px; border-radius:12px;
          border:1px solid #3f3f46; background:var(--btn-bg); color:var(--btn-text);
          font-size:.93rem; font-weight:700; display:inline-flex; align-items:center;
          justify-content:center; gap:8px; cursor:pointer; transition:transform 120ms,opacity 120ms; }
        .shorten-btn:hover:enabled { transform:translateY(-1px); }
        .shorten-btn:disabled { opacity:.82; cursor:not-allowed; }
        .spinner { width:16px; height:16px; border-radius:50%; border:2px solid rgba(17,17,20,.22);
          border-top-color:rgba(17,17,20,.92); animation:spin 680ms linear infinite; }
        @keyframes spin { to { transform:rotate(360deg); } }
        .error { margin:0; color:var(--danger); font-size:.9rem; }
        .result { margin-top:18px; border:1px solid #2b2b32; border-radius:13px;
          background:linear-gradient(180deg,#121216,#101015); padding:14px; animation:reveal 220ms ease; }
        @keyframes reveal { from{opacity:0;transform:translateY(6px)} to{opacity:1;transform:translateY(0)} }
        .result-label { margin:0 0 10px; font-size:.82rem; color:var(--muted);
          letter-spacing:.03em; text-transform:uppercase; }
        .result-row { display:flex; align-items:center; gap:10px; flex-wrap:wrap; }
        .result-link { color:#e4e4e7; text-decoration:none; font-weight:600; word-break:break-all; }
        .result-link:hover { text-decoration:underline; }
        .copy-btn { height:34px; min-width:34px; border-radius:8px; border:1px solid #3f3f46;
          background:var(--panel-soft); color:#d4d4d8; padding:0 10px; display:inline-flex;
          align-items:center; justify-content:center; gap:6px; cursor:pointer; transition:border-color 120ms; }
        .copy-btn:hover { border-color:#52525b; }
        .copy-icon { width:16px; height:16px; }
        .copy-label { font-size:.8rem; color:var(--muted); }
        .badge { margin-top:11px; display:inline-block; border-radius:999px;
          border:1px solid var(--border); background:var(--badge-bg); color:var(--badge-text);
          padding:7px 11px; font-size:.74rem; letter-spacing:.02em; }
        @media (max-width:640px) {
          .card { padding:20px; }
          .row { grid-template-columns:1fr; }
          .shorten-btn { width:100%; }
        }
      `}</style>

      <div className="shell">
        <main className="card">
          <p className="eyebrow">High-Performance Serverless URL Shortener</p>
          <h1 className="title">Shorten links at distributed cache speed.</h1>
          <p className="subtitle">
            Purpose-built to highlight backend performance with Lambda, DynamoDB single-table design,
            and multi-tier Redis caching.
          </p>

          <form className="form" onSubmit={handleSubmit}>
            <div className="row">
              <input
                className="url-input"
                type="text"
                value={longUrl}
                onChange={(e) => setLongUrl(e.target.value)}
                placeholder="https://paste-your-long-link-here.com"
                aria-label="Long URL"
                required
              />
              <button className="shorten-btn" type="submit" disabled={isLoading} aria-busy={isLoading}>
                {isLoading ? (
                  <><span className="spinner" />Shortening...</>
                ) : "Shorten"}
              </button>
            </div>
            {error ? <p className="error">{error}</p> : null}
          </form>

          {shortLink ? (
            <section className="result" aria-live="polite">
              <p className="result-label">Generated short link</p>
              <div className="result-row">
                <a className="result-link" href={shortLink} target="_blank" rel="noopener noreferrer">
                  {shortLink}
                </a>
                <button className="copy-btn" type="button" onClick={handleCopy} aria-label="Copy short link">
                  <CopyIcon className="copy-icon" />
                  <span className="copy-label">{copied ? "Copied" : "Copy"}</span>
                </button>
              </div>
              {isCacheProbeLoading && <div className="badge">Checking redirect cache...</div>}
              {!isCacheProbeLoading && cacheStatus && <div className="badge">{formatCacheBadge(cacheStatus)}</div>}
              {!isCacheProbeLoading && !cacheStatus && cacheProbeNote && <div className="badge">{cacheProbeNote}</div>}
            </section>
          ) : null}
        </main>
      </div>
    </>
  );
}
