import { useMemo, useState, useCallback, useEffect, useRef } from "react";
import { parse as parseDomain } from "tldts";
import { SignInButton, UserButton, useAuth } from "@clerk/react";
import { useUserLinks } from "./hooks/useUserLinks.js";

// ── Config ───────────────────────────────────────────────────────────────────
const _rawBase = (import.meta.env.VITE_API_BASE_URL || "").trim();
const _isDev   = import.meta.env.DEV;

// ── SVG Icons (inline, no deps) ─────────────────────────────────────────────
const Icon = ({ d, size = 16, ...p }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none"
    stroke="currentColor" strokeWidth="1.8" strokeLinecap="round"
    strokeLinejoin="round" aria-hidden="true" {...p}>
    <path d={d}/>
  </svg>
);
const CopyIcon   = (p) => <Icon d="M9 9.75A2.25 2.25 0 0 1 11.25 7.5h7.5A2.25 2.25 0 0 1 21 9.75v7.5a2.25 2.25 0 0 1-2.25 2.25h-7.5A2.25 2.25 0 0 1 9 17.25v-7.5ZM15 7.5V6.75A2.25 2.25 0 0 0 12.75 4.5h-7.5A2.25 2.25 0 0 0 3 6.75v7.5a2.25 2.25 0 0 0 2.25 2.25H6" {...p}/>;
const BarIcon    = (p) => <Icon d="M3 3v18h18M7 16v-3m4 3v-6m4 6v-4m4 4V7" {...p}/>;
const LinkIcn    = (p) => <Icon d="M10 13a5 5 0 0 0 7.54.54l3-3A5 5 0 0 0 13.46 3.46l-1.72 1.72M14 11a5 5 0 0 0-7.54-.54l-3 3A5 5 0 0 0 10.54 20.54l1.72-1.72" {...p}/>;
const GlobeIcon  = (p) => <Icon d="M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20zM2 12h20M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10A15.3 15.3 0 0 1 12 2z" {...p}/>;
const EditIcon   = (p) => <Icon d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7M18.5 2.5a2.121 2.121 0 1 1 3 3L12 15l-4 1 1-4 9.5-9.5z" {...p}/>;
const ChevIcon   = (p) => <Icon d="m6 9 6 6 6-6" {...p}/>;
const CheckIcon  = (p) => <Icon d="M20 6L9 17l-5-5" {...p}/>;

export default function App() {
  const [longUrl, setLongUrl]           = useState("");
  const [shortLink, setShortLink]       = useState("");
  const [isLoading, setIsLoading]       = useState(false);
  const [copied, setCopied]             = useState(false);
  const [error, setError]               = useState("");
  const [cacheStatus, setCacheStatus]   = useState("");
  const [cacheProbe, setCacheProbe]     = useState({ loading: false, note: "" });
  const [duplicateLink, setDuplicateLink] = useState(null);

  // Dashboard state
  const [expandedId, setExpandedId]     = useState(null);
  const [statsData, setStatsData]       = useState({});
  const [statsLoading, setStatsLoading] = useState(null);
  const [editingId, setEditingId]       = useState(null);
  const [editUrl, setEditUrl]           = useState("");
  const [actionError, setActionError]   = useState(null);
  const [actionSuccess, setActionSuccess] = useState(null);
  const [togglingId, setTogglingId]     = useState(null);

  // Use refs for values needed in callbacks to avoid stale closures
  const editUrlRef    = useRef(editUrl);
  editUrlRef.current  = editUrl;
  const expandedIdRef = useRef(expandedId);
  expandedIdRef.current = expandedId;

  const { getToken, isSignedIn, isLoaded } = useAuth();

  const normalizedBaseUrl = useMemo(() => _rawBase.replace(/\/+$/, ""), []);
  const requestBaseUrl    = useMemo(() => (_isDev ? "/api" : normalizedBaseUrl), [normalizedBaseUrl]);

  const {
    links: userLinks, isLoading: isLinksLoading, error: linksError, addLink, findByOriginalUrl,
    refreshLinks, toggleLink, updateLink, fetchLinkStats,
  } = useUserLinks(requestBaseUrl, normalizedBaseUrl);

  // ── Helpers ──────────────────────────────────────────────────────────────
  const hasScheme       = (v) => /^[a-zA-Z][a-zA-Z\d+\-.]*:\/\//.test(v);
  const isValidPublicUrl = (raw) => {
    try {
      const p = new URL(raw);
      if (!["http:", "https:"].includes(p.protocol)) return false;
      const h = p.hostname.toLowerCase();
      if (!h || h === "localhost" || h.endsWith(".")) return false;
      const d = parseDomain(h, { allowPrivateDomains: true });
      if (d.isIp || !d.domain || !d.publicSuffix) return false;
      return d.isIcann || d.isPrivate;
    } catch { return false; }
  };
  const cacheBadge = (s) => {
    const m = { L0_HIT: "L0 Browser", USER_DEDUP: "User Dedup", L1_HIT: "L1 Memory", HIT: "L2 Redis", MISS: "DynamoDB" };
    return m[s] ? `Cache [ ${m[s]} ]` : s ? `Cache [ ${s} ]` : "";
  };

  // Flash success/error with auto-clear
  const flashSuccess = (msg) => {
    setActionSuccess(msg);
    setActionError(null);
    setTimeout(() => setActionSuccess(null), 2500);
  };
  const flashError = (msg) => {
    setActionError(msg);
    setActionSuccess(null);
    setTimeout(() => setActionError(null), 5000);
  };

  // ── Clipboard ──────────────────────────────────────────────────────────
  const copyText = async (t) => {
    try { await navigator.clipboard.writeText(t); setCopied(true); setTimeout(() => setCopied(false), 1400); }
    catch { setError("Copy failed. Please copy manually."); }
  };

  // ── Cache probe ────────────────────────────────────────────────────────
  const probeCacheStatus = async (sid) => {
    setCacheProbe({ loading: true, note: "" });
    try {
      const r = await fetch(`${requestBaseUrl}/cache-status/${encodeURIComponent(sid)}`);
      const p = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(p?.error);
      setCacheStatus(String(p?.cacheStatus || "").trim().toUpperCase());
    } catch { setCacheStatus(""); setCacheProbe(s => ({ ...s, note: "Unavailable" })); }
    finally { setCacheProbe(s => ({ ...s, loading: false })); }
  };

  // ── Shorten submit ─────────────────────────────────────────────────────
  const handleSubmit = async (e) => {
    e.preventDefault();
    const input = longUrl.trim();
    setCopied(false); setError(""); setCacheStatus(""); setCacheProbe({ loading: false, note: "" }); setDuplicateLink(null);
    if (!input) { setError("Please enter a URL."); return; }
    const candidate = hasScheme(input) ? input : `https://${input}`;
    if (!isValidPublicUrl(candidate)) { setError("Enter a valid public URL (e.g., https://example.com)"); return; }
    const normalized = new URL(candidate).toString();
    setShortLink("");

    if (isSignedIn) {
      const existing = findByOriginalUrl(normalized);
      if (existing) { setDuplicateLink(existing); setShortLink(existing.shortUrl); setCacheStatus("USER_DEDUP"); return; }
    }
    if (!isSignedIn) {
      try { const c = localStorage.getItem(normalized); if (c) { setShortLink(c); setCacheStatus("L0_HIT"); return; } } catch {}
    }

    setIsLoading(true);
    try {
      const headers = { "Content-Type": "application/json" };
      if (isSignedIn) { try { const t = await getToken(); if (t) headers.Authorization = `Bearer ${t}`; } catch {} }
      const res = await fetch(`${requestBaseUrl}/shorten`, { method: "POST", headers, body: JSON.stringify({ url: normalized }) });
      const p   = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(p?.error || p?.message || `Request failed (${res.status}).`);
      const sid  = p?.shortId || p?.id || p?.shortCode || p?.code;
      const link = p?.shortUrl || (sid ? `${normalizedBaseUrl}/${sid}` : null);
      if (!link) throw new Error("No short URL in response.");
      setShortLink(link);
      if (isSignedIn && sid) {
        addLink({ id: sid, originalUrl: normalized, shortUrl: link, clickCount: 0, isActive: true, createdAt: p.createdAt || Date.now(), tier: "PREMIUM" });
      } else {
        try { localStorage.setItem(normalized, link); } catch {}
      }
      if (sid) void probeCacheStatus(sid);
    } catch (err) {
      setError(err?.message === "Failed to fetch" ? "CORS or network issue." : (err?.message || "Failed."));
    } finally { setIsLoading(false); }
  };

  // ── Dashboard actions (using refs to avoid stale closures) ─────────────
  const handleToggle = useCallback(async (link) => {
    setTogglingId(link.id);
    const { ok, error: err } = await toggleLink(link.id, link.isActive);
    setTogglingId(null);
    if (ok) flashSuccess(`Link ${link.isActive ? "paused" : "activated"}!`);
    else flashError(`Toggle failed: ${err}`);
  }, [toggleLink]);

  const handleReroute = useCallback(async (id) => {
    const url = editUrlRef.current.trim();
    if (!url) { flashError("Enter a destination URL."); return; }
    const finalUrl = hasScheme(url) ? url : `https://${url}`;
    if (!isValidPublicUrl(finalUrl)) { flashError("Invalid URL for rerouting."); return; }
    const { ok, error: err } = await updateLink(id, { originalUrl: finalUrl });
    if (ok) { setEditingId(null); setEditUrl(""); flashSuccess("Link rerouted!"); }
    else flashError(`Reroute failed: ${err}`);
  }, [updateLink, hasScheme]);

  const reloadStats = useCallback(async (id, { silent = false } = {}) => {
    if (!id) return { ok: false };

    if (!silent) setStatsLoading(id);
    try {
      const { ok, data } = await fetchLinkStats(id);
      if (ok) {
        setStatsData((s) => ({ ...s, [id]: data }));
      }
      return { ok };
    } finally {
      if (!silent) setStatsLoading(null);
    }
  }, [fetchLinkStats]);

  const handleExpandStats = useCallback(async (id) => {
    if (expandedIdRef.current === id) { setExpandedId(null); return; }
    setExpandedId(id);
    await reloadStats(id);
  }, [reloadStats]);

  const handleRefreshLinks = useCallback(async () => {
    await refreshLinks();

    const openId = expandedIdRef.current;
    if (openId) {
      await reloadStats(openId);
    }
  }, [refreshLinks, reloadStats]);

  useEffect(() => {
    if (!isSignedIn || !expandedId) return;

    const id = expandedId;
    const timer = setInterval(() => {
      void reloadStats(id, { silent: true });
    }, 10000);

    return () => clearInterval(timer);
  }, [isSignedIn, expandedId, reloadStats]);

  // ── Geo flag emoji ─────────────────────────────────────────────────────
  const flag = (cc) => {
    if (!cc || cc === "XX" || cc.length !== 2) return "🌍";
    return String.fromCodePoint(...[...cc.toUpperCase()].map(c => 0x1F1E6 + c.charCodeAt(0) - 65));
  };

  // ── Render ─────────────────────────────────────────────────────────────
  return (
    <>
      <style>{CSS}</style>
      <div className="shell">
        {/* Auth header */}
        <div className="auth-bar">
          {isLoaded && !isSignedIn && (<>
            <span className="chip chip--anon">Anonymous</span>
            <SignInButton mode="modal"><button className="btn-signin" id="sign-in-btn">Sign In</button></SignInButton>
          </>)}
          {isLoaded && isSignedIn && (<>
            <span className="chip chip--prem">★ Premium</span>
            <UserButton appearance={{ elements: { avatarBox: { width: 32, height: 32 } } }}/>
          </>)}
        </div>

        {/* Shortener card */}
        <main className="card" id="shortener-card">
          <p className="eyebrow">High-Performance Serverless URL Shortener</p>
          <h1 className="heading">Shorten links at distributed cache speed.</h1>
          <p className="sub">Lambda · DynamoDB Single-Table · Multi-Tier Redis Cache</p>
          <form className="form" onSubmit={handleSubmit} id="shorten-form">
            <div className="input-row">
              <input className="url-input" value={longUrl} onChange={e => setLongUrl(e.target.value)}
                placeholder="https://paste-your-long-link-here.com" id="url-input" required/>
              <button className="btn-primary" type="submit" disabled={isLoading} id="shorten-btn">
                {isLoading ? <><span className="spin"/>Shortening…</> : "Shorten"}
              </button>
            </div>
            {error && <p className="err" id="error-msg">{error}</p>}
          </form>

          {shortLink && (
            <section className="result" id="result-section">
              {duplicateLink && <p className="dedup">You've already shortened this link!</p>}
              <p className="result-lbl">Generated short link</p>
              <div className="result-row">
                <a className="result-link" href={shortLink} target="_blank" rel="noopener noreferrer" id="result-link">{shortLink}</a>
                <button className="btn-sm" onClick={() => copyText(shortLink)} id="copy-btn">
                  <CopyIcon size={14}/>{copied ? "Copied" : "Copy"}
                </button>
              </div>
              {cacheProbe.loading && <span className="badge">Checking cache…</span>}
              {!cacheProbe.loading && cacheStatus && <span className="badge">{cacheBadge(cacheStatus)}</span>}
            </section>
          )}
        </main>

        {/* ── Dashboard ───────────────────────────────────────────────── */}
        {isLoaded && isSignedIn && (
          <section className="dash" id="dashboard-section">
            <div className="dash-head">
              <h2 className="dash-title"><LinkIcn size={18}/>My Links{userLinks.length > 0 && <span className="dash-n">({userLinks.length})</span>}</h2>
              <button className="btn-sm" onClick={handleRefreshLinks} disabled={isLinksLoading} id="refresh-links-btn">
                {isLinksLoading ? <><span className="spin spin--light"/>Loading…</> : "↻ Refresh"}
              </button>
            </div>

            {/* Action feedback */}
            {actionError && <div className="toast toast--err">{actionError}</div>}
            {actionSuccess && <div className="toast toast--ok"><CheckIcon size={14}/>{actionSuccess}</div>}
            {linksError && <div className="toast toast--err">{linksError}</div>}

            {userLinks.length === 0 && !isLinksLoading ? (
              <p className="empty">No links yet — shorten your first URL above!</p>
            ) : (
              <div className="link-list">
                {userLinks.map((lk) => {
                  const stats   = statsData[lk.id];
                  const isOpen  = expandedId === lk.id;
                  const isEdit  = editingId === lk.id;
                  const isToggling = togglingId === lk.id;
                  return (
                    <div className={`lk-card${isOpen ? " lk-card--open" : ""}`} key={lk.id}>
                      {/* ── Top row ─────────────────────────────────── */}
                      <div className="lk-top">
                        <a className="lk-short" href={lk.shortUrl} target="_blank" rel="noopener noreferrer">{lk.shortUrl}</a>
                        <div className="lk-actions">
                          <span className="lk-clicks"><BarIcon size={13}/>{lk.clickCount ?? 0}</span>
                          {/* Toggle switch */}
                          <button
                            className={`toggle${lk.isActive !== false ? " toggle--on" : ""}${isToggling ? " toggle--busy" : ""}`}
                            onClick={() => handleToggle(lk)}
                            disabled={isToggling}
                            title={lk.isActive !== false ? "Pause link" : "Activate link"}>
                            <span className="toggle-dot"/>
                          </button>
                        </div>
                      </div>

                      {/* ── Original URL ────────────────────────────── */}
                      {isEdit ? (
                        <div className="lk-edit-row">
                          <input className="lk-edit-input" value={editUrl} onChange={e => setEditUrl(e.target.value)}
                            placeholder="New destination URL" autoFocus
                            onKeyDown={e => { if (e.key === "Enter") { e.preventDefault(); handleReroute(lk.id); } }}/>
                          <button className="btn-sm btn-sm--accent" onClick={() => handleReroute(lk.id)}>Save</button>
                          <button className="btn-sm" onClick={() => { setEditingId(null); setEditUrl(""); }}>Cancel</button>
                        </div>
                      ) : (
                        <div className="lk-orig" title={lk.originalUrl}>
                          <span className="lk-orig-text">{lk.originalUrl}</span>
                          <button className="btn-icon" onClick={() => { setEditingId(lk.id); setEditUrl(lk.originalUrl); }}
                            title="Reroute to different URL"><EditIcon size={12}/></button>
                        </div>
                      )}

                      {/* ── Meta row ────────────────────────────────── */}
                      <div className="lk-meta">
                        <span className={`tag ${lk.isActive !== false ? "tag--ok" : "tag--off"}`}>
                          {lk.isActive !== false ? "Active" : "Paused"}
                        </span>
                        <span className="tag tag--prem">Premium</span>
                        {lk.expiresAt && (
                          <span className="tag tag--exp">Expires {new Date(lk.expiresAt * 1000).toLocaleDateString()}</span>
                        )}
                        <span className="lk-date">
                          {new Date(lk.createdAt).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" })}
                        </span>
                        <button className={`btn-expand${isOpen ? " btn-expand--open" : ""}`}
                          onClick={() => handleExpandStats(lk.id)}>
                          <ChevIcon size={14}/>{isOpen ? "Hide Stats" : "View Stats"}
                        </button>
                      </div>

                      {/* ── Expanded stats ──────────────────────────── */}
                      {isOpen && (
                        <div className="stats-panel">
                          {statsLoading === lk.id ? (
                            <p className="stats-loading"><span className="spin spin--light"/>Loading analytics…</p>
                          ) : stats?.analytics ? (
                            <>
                              <div className="stats-grid">
                                {/* Geo */}
                                <div className="stats-box">
                                  <h4 className="stats-h"><GlobeIcon size={14}/>Locations</h4>
                                  {stats.analytics.geo.length > 0 ? stats.analytics.geo.map(g => (
                                    <div className="stats-item" key={g.code}>
                                      <span>{flag(g.code)} {g.country}</span>
                                      <span className="stats-val">{g.count}</span>
                                    </div>
                                  )) : <p className="stats-empty">No data yet</p>}
                                </div>
                                {/* Referers */}
                                <div className="stats-box">
                                  <h4 className="stats-h"><LinkIcn size={14}/>Referers</h4>
                                  {stats.analytics.referers.length > 0 ? stats.analytics.referers.map(r => (
                                    <div className="stats-item" key={r.domain}>
                                      <span>{r.domain}</span>
                                      <span className="stats-val">{r.count}</span>
                                    </div>
                                  )) : <p className="stats-empty">No data yet</p>}
                                </div>
                                {/* Browsers */}
                                <div className="stats-box">
                                  <h4 className="stats-h"><Icon d="M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20z" size={14}/>Browsers</h4>
                                  {stats.analytics.browsers.length > 0 ? stats.analytics.browsers.map(b => (
                                    <div className="stats-item" key={b.name}>
                                      <span>{b.name}</span>
                                      <span className="stats-val">{b.count}</span>
                                    </div>
                                  )) : <p className="stats-empty">No data yet</p>}
                                </div>
                                {/* Devices */}
                                <div className="stats-box">
                                  <h4 className="stats-h"><Icon d="M20 7v10H4V7h16zM2 7a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V7zm7 12h6" size={14}/>Devices</h4>
                                  {stats.analytics.devices.length > 0 ? stats.analytics.devices.map(d => (
                                    <div className="stats-item" key={d.name}>
                                      <span>{d.name}</span>
                                      <span className="stats-val">{d.count}</span>
                                    </div>
                                  )) : <p className="stats-empty">No data yet</p>}
                                </div>
                              </div>

                              {/* Recent clicks */}
                              {stats.analytics.recentClicks?.length > 0 && (
                                <div className="recent">
                                  <h4 className="stats-h">Recent Clicks</h4>
                                  <div className="recent-list">
                                    {stats.analytics.recentClicks.map((c, i) => (
                                      <div className="recent-item" key={i}>
                                        <span className="recent-flag">{flag(c.countryCode)}</span>
                                        <span className="recent-info">{c.browser} · {c.os} · {c.device}</span>
                                        <span className="recent-ref">{c.refererDomain}</span>
                                        <span className="recent-time">{new Date(c.timestamp).toLocaleString()}</span>
                                      </div>
                                    ))}
                                  </div>
                                </div>
                              )}
                            </>
                          ) : (
                            <p className="stats-empty">No analytics available yet. Clicks will appear after someone visits your link.</p>
                          )}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </section>
        )}
      </div>
    </>
  );
}

// ── Styles ───────────────────────────────────────────────────────────────────
const CSS = `
:root{color-scheme:dark;--bg:#09090b;--panel:#111114;--soft:#18181c;--text:#f4f4f5;
--muted:#a1a1aa;--border:#27272a;--accent:#818cf8;--accent2:rgba(129,140,248,.12);
--ok:#4ade80;--ok2:rgba(74,222,128,.12);--off:#f87171;--off2:rgba(248,113,113,.1);
--btn:#f4f4f5;--btn-t:#111114;--danger:#fca5a5}

.shell{min-height:100vh;display:flex;flex-direction:column;align-items:center;padding:40px 24px 60px;
  background:radial-gradient(900px 500px at 10% -10%,rgba(99,102,241,.08),transparent 55%),
  radial-gradient(700px 450px at 100% 0%,rgba(129,140,248,.06),transparent 50%),var(--bg);
  color:var(--text);font-family:"Manrope","Segoe UI",system-ui,sans-serif}

/* auth */
.auth-bar{width:100%;max-width:760px;display:flex;justify-content:flex-end;align-items:center;gap:12px;margin-bottom:24px}
.chip{padding:5px 12px;border-radius:999px;font-size:.72rem;font-weight:700;letter-spacing:.04em;text-transform:uppercase;display:inline-flex;align-items:center;gap:5px}
.chip--anon{background:rgba(161,161,170,.08);color:var(--muted);border:1px solid rgba(161,161,170,.15)}
.chip--prem{background:var(--accent2);color:var(--accent);border:1px solid rgba(129,140,248,.2)}
.btn-signin{height:36px;padding:0 18px;border-radius:10px;border:none;background:linear-gradient(135deg,#6366f1,#818cf8);
  color:#fff;font-size:.84rem;font-weight:700;cursor:pointer;transition:transform .12s,box-shadow .12s}
.btn-signin:hover{transform:translateY(-1px);box-shadow:0 4px 16px rgba(99,102,241,.25)}

/* card */
.card{width:100%;max-width:760px;border-radius:16px;border:1px solid var(--border);
  background:linear-gradient(180deg,rgba(24,24,28,.94),rgba(15,15,18,.94));padding:28px;box-shadow:0 24px 70px rgba(0,0,0,.45)}
.eyebrow{margin:0 0 8px;font-size:11px;letter-spacing:.08em;text-transform:uppercase;color:var(--muted);font-weight:600}
.heading{margin:0;font-size:clamp(1.3rem,2.5vw,2rem);line-height:1.2;font-weight:700}
.sub{margin:8px 0 0;color:var(--muted);font-size:.92rem;line-height:1.5}
.form{margin-top:20px;display:grid;gap:12px}
.input-row{display:grid;grid-template-columns:1fr auto;gap:10px}
.url-input{height:50px;border-radius:12px;border:1px solid var(--border);background:#0f0f13;color:var(--text);
  padding:0 14px;font-size:.95rem;outline:none;transition:border-color .14s,box-shadow .14s}
.url-input::placeholder{color:#71717a}
.url-input:focus{border-color:#52525b;box-shadow:0 0 0 4px rgba(161,161,170,.2)}
.btn-primary{min-width:128px;height:50px;border-radius:12px;border:1px solid #3f3f46;background:var(--btn);color:var(--btn-t);
  font-size:.93rem;font-weight:700;display:inline-flex;align-items:center;justify-content:center;gap:8px;cursor:pointer;transition:transform .12s}
.btn-primary:hover:enabled{transform:translateY(-1px)}.btn-primary:disabled{opacity:.8;cursor:not-allowed}
.spin{width:14px;height:14px;border-radius:50%;border:2px solid rgba(17,17,20,.15);
  border-top-color:rgba(17,17,20,.8);animation:spin .65s linear infinite;display:inline-block}
.spin--light{border-color:rgba(244,244,245,.15);border-top-color:rgba(244,244,245,.7)}
@keyframes spin{to{transform:rotate(360deg)}}
.err{margin:0;color:var(--danger);font-size:.88rem}

/* result */
.result{margin-top:16px;border:1px solid #2b2b30;border-radius:13px;background:linear-gradient(180deg,#121216,#101015);
  padding:14px;animation:reveal .22s ease}
@keyframes reveal{from{opacity:0;transform:translateY(6px)}to{opacity:1;transform:translateY(0)}}
.result-lbl{margin:0 0 8px;font-size:.78rem;color:var(--muted);letter-spacing:.03em;text-transform:uppercase}
.result-row{display:flex;align-items:center;gap:10px;flex-wrap:wrap}
.result-link{color:#e4e4e7;text-decoration:none;font-weight:600;word-break:break-all}
.result-link:hover{text-decoration:underline}
.btn-sm{height:30px;padding:0 12px;border-radius:8px;border:1px solid var(--border);background:var(--soft);
  color:var(--muted);font-size:.76rem;font-weight:600;cursor:pointer;display:inline-flex;align-items:center;gap:5px;
  transition:border-color .12s,color .12s}
.btn-sm:hover{border-color:#52525b;color:var(--text)}.btn-sm:disabled{opacity:.5;cursor:not-allowed}
.btn-sm--accent{border-color:rgba(129,140,248,.3);color:var(--accent);background:var(--accent2)}
.btn-sm--accent:hover{border-color:var(--accent)}
.btn-icon{background:none;border:none;color:var(--muted);cursor:pointer;padding:2px;border-radius:4px;display:inline-flex;
  transition:color .12s}.btn-icon:hover{color:var(--text)}
.badge{margin-top:10px;display:inline-block;border-radius:999px;border:1px solid var(--border);
  background:#16161a;color:var(--muted);padding:6px 10px;font-size:.72rem;letter-spacing:.02em}
.dedup{margin:0 0 10px;padding:10px 14px;border-radius:10px;background:var(--accent2);
  border:1px solid rgba(129,140,248,.2);color:var(--accent);font-size:.84rem;font-weight:500}

/* toast notifications */
.toast{margin-bottom:12px;padding:10px 14px;border-radius:10px;font-size:.84rem;font-weight:500;animation:reveal .2s ease;
  display:flex;align-items:center;gap:6px}
.toast--err{background:var(--off2);border:1px solid rgba(248,113,113,.2);color:var(--off)}
.toast--ok{background:var(--ok2);border:1px solid rgba(74,222,128,.2);color:var(--ok)}

/* dashboard */
.dash{width:100%;max-width:760px;margin-top:24px;animation:reveal .3s ease}
.dash-head{display:flex;align-items:center;justify-content:space-between;margin-bottom:16px}
.dash-title{margin:0;font-size:1.1rem;font-weight:700;display:inline-flex;align-items:center;gap:8px}
.dash-title svg{color:var(--accent)}.dash-n{font-size:.76rem;color:var(--muted);font-weight:500}
.empty{text-align:center;padding:32px 16px;color:var(--muted);font-size:.9rem}
.link-list{display:flex;flex-direction:column;gap:8px}

/* link card */
.lk-card{border:1px solid var(--border);border-radius:12px;
  background:linear-gradient(180deg,rgba(24,24,28,.92),rgba(18,18,22,.92));padding:14px 16px;transition:border-color .18s}
.lk-card:hover{border-color:#3f3f46}.lk-card--open{border-color:rgba(129,140,248,.25)}
.lk-top{display:flex;align-items:center;justify-content:space-between;gap:10px}
.lk-short{color:var(--text);font-weight:700;font-size:.9rem;text-decoration:none;word-break:break-all}
.lk-short:hover{text-decoration:underline}
.lk-actions{display:flex;align-items:center;gap:10px;flex-shrink:0}
.lk-clicks{display:inline-flex;align-items:center;gap:4px;font-size:.76rem;color:var(--muted)}

/* toggle */
.toggle{width:36px;height:20px;border-radius:10px;border:none;background:#3f3f46;cursor:pointer;
  position:relative;transition:background .2s;padding:0;flex-shrink:0}
.toggle--on{background:var(--ok)}
.toggle--busy{opacity:.5;cursor:wait}
.toggle-dot{position:absolute;top:2px;left:2px;width:16px;height:16px;border-radius:50%;
  background:#fff;transition:transform .2s;pointer-events:none}
.toggle--on .toggle-dot{transform:translateX(16px)}

/* original url + edit */
.lk-orig{margin-top:4px;display:flex;align-items:center;gap:6px}
.lk-orig-text{font-size:.82rem;color:#71717a;word-break:break-all;white-space:nowrap;overflow:hidden;
  text-overflow:ellipsis;max-width:calc(100% - 24px)}
.lk-edit-row{margin-top:6px;display:flex;gap:6px;align-items:center}
.lk-edit-input{flex:1;height:32px;border-radius:8px;border:1px solid var(--border);background:#0f0f13;
  color:var(--text);padding:0 10px;font-size:.84rem;outline:none}
.lk-edit-input:focus{border-color:#52525b}

/* meta */
.lk-meta{margin-top:8px;display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.tag{font-size:.68rem;padding:3px 8px;border-radius:6px;font-weight:700;letter-spacing:.03em;text-transform:uppercase}
.tag--ok{background:var(--ok2);color:var(--ok);border:1px solid rgba(74,222,128,.15)}
.tag--off{background:var(--off2);color:var(--off);border:1px solid rgba(248,113,113,.15)}
.tag--prem{background:var(--accent2);color:var(--accent);border:1px solid rgba(129,140,248,.15)}
.tag--exp{background:rgba(251,191,36,.1);color:#fbbf24;border:1px solid rgba(251,191,36,.15)}
.lk-date{font-size:.72rem;color:#52525b}
.btn-expand{margin-left:auto;background:none;border:none;color:var(--muted);font-size:.74rem;cursor:pointer;
  display:inline-flex;align-items:center;gap:4px;font-weight:600;transition:color .12s}
.btn-expand:hover{color:var(--text)}
.btn-expand--open svg{transform:rotate(180deg)}

/* stats panel */
.stats-panel{margin-top:14px;padding-top:14px;border-top:1px solid var(--border);animation:reveal .25s ease}
.stats-loading{display:flex;align-items:center;gap:8px;color:var(--muted);font-size:.84rem}
.stats-grid{display:grid;grid-template-columns:1fr 1fr;gap:10px}
.stats-box{padding:12px;border:1px solid var(--border);border-radius:10px;background:rgba(15,15,19,.6)}
.stats-h{margin:0 0 8px;font-size:.78rem;font-weight:700;color:var(--muted);display:flex;align-items:center;gap:6px;
  text-transform:uppercase;letter-spacing:.04em}
.stats-item{display:flex;justify-content:space-between;align-items:center;padding:3px 0;font-size:.8rem}
.stats-val{color:var(--accent);font-weight:700;font-size:.78rem;min-width:28px;text-align:right}
.stats-empty{color:#52525b;font-size:.78rem;font-style:italic;margin:0}

/* recent clicks */
.recent{margin-top:12px}
.recent-list{display:flex;flex-direction:column;gap:4px;max-height:240px;overflow-y:auto}
.recent-item{display:grid;grid-template-columns:28px 1fr auto auto;gap:8px;align-items:center;
  padding:6px 8px;border-radius:8px;background:rgba(15,15,19,.4);font-size:.78rem}
.recent-flag{font-size:1rem;text-align:center}
.recent-info{color:var(--text);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.recent-ref{color:var(--muted);font-size:.72rem}
.recent-time{color:#52525b;font-size:.7rem;white-space:nowrap}

@media(max-width:640px){
  .shell{padding:20px 16px 40px}.card{padding:20px}.input-row{grid-template-columns:1fr}
  .btn-primary{width:100%}.auth-bar{margin-bottom:16px}.stats-grid{grid-template-columns:1fr}
  .recent-item{grid-template-columns:28px 1fr;gap:4px}.recent-ref,.recent-time{display:none}
}
`;
