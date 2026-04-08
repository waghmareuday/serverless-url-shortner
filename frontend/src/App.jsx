import { useMemo, useState } from "react";

const API_BASE_URL =
  import.meta.env.VITE_API_BASE_URL || "https://1qlfu0ouhd.execute-api.ap-south-1.amazonaws.com";

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

  const normalizedBaseUrl = useMemo(() => API_BASE_URL.replace(/\/+$/, ""), []);
  const requestBaseUrl = useMemo(
    () => (import.meta.env.DEV ? "/api" : normalizedBaseUrl),
    [normalizedBaseUrl]
  );

  async function handleSubmit(event) {
    event.preventDefault();

    const input = longUrl.trim();
    setCopied(false);
    setError("");

    if (!input) {
      setError("Please enter a URL to shorten.");
      return;
    }

    try {
      const parsed = new URL(input);
      if (!["http:", "https:"].includes(parsed.protocol)) {
        setError("Please use a valid http:// or https:// URL.");
        return;
      }
    } catch {
      setError("Please enter a valid URL, for example: https://example.com/page");
      return;
    }

    setIsLoading(true);
    setShortLink("");

    try {
      const response = await fetch(`${requestBaseUrl}/shorten`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ url: input }),
      });

      const payload = await response.json().catch(() => ({}));

      if (!response.ok) {
        const message = payload?.error || payload?.message || `Request failed (${response.status}).`;
        throw new Error(message);
      }

      const shortId = payload?.shortId || payload?.id || payload?.shortCode || payload?.code;
      const resolvedLink = shortId ? `${normalizedBaseUrl}/${shortId}` : payload?.shortUrl;

      if (!resolvedLink) {
        throw new Error("The API response did not include a short URL.");
      }

      setShortLink(resolvedLink);
    } catch (requestError) {
      const message =
        requestError?.message === "Failed to fetch"
          ? "Browser blocked the request (likely CORS or network issue)."
          : requestError?.message;
      setError(message || "Failed to shorten URL. Please try again.");
    } finally {
      setIsLoading(false);
    }
  }

  async function handleCopy() {
    if (!shortLink) {
      return;
    }

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
        @import url("https://fonts.googleapis.com/css2?family=Manrope:wght@400;500;600;700&display=swap");

        :root {
          color-scheme: dark;
          --bg: #09090b;
          --panel: #111114;
          --panel-soft: #18181c;
          --text: #f4f4f5;
          --muted: #a1a1aa;
          --border: #27272a;
          --focus: rgba(161, 161, 170, 0.34);
          --btn-bg: #f4f4f5;
          --btn-text: #111114;
          --danger: #fca5a5;
          --badge-bg: #16161a;
          --badge-text: #a1a1aa;
        }

        .shell {
          min-height: 100vh;
          display: grid;
          place-items: center;
          padding: 24px;
          background:
            radial-gradient(900px 500px at 10% -10%, rgba(63, 63, 70, 0.23), transparent 55%),
            radial-gradient(700px 450px at 100% 0%, rgba(39, 39, 42, 0.3), transparent 50%),
            var(--bg);
          color: var(--text);
          font-family: "Manrope", "Segoe UI", sans-serif;
        }

        .card {
          width: 100%;
          max-width: 760px;
          border-radius: 16px;
          border: 1px solid var(--border);
          background: linear-gradient(180deg, rgba(24, 24, 28, 0.94), rgba(15, 15, 18, 0.94));
          padding: 28px;
          box-shadow: 0 24px 70px rgba(0, 0, 0, 0.45);
        }

        .eyebrow {
          margin: 0 0 10px;
          font-size: 12px;
          letter-spacing: 0.08em;
          text-transform: uppercase;
          color: var(--muted);
          font-weight: 600;
        }

        .title {
          margin: 0;
          font-size: clamp(1.32rem, 2.5vw, 2rem);
          line-height: 1.2;
          font-weight: 700;
        }

        .subtitle {
          margin: 10px 0 0;
          color: var(--muted);
          font-size: 0.96rem;
          line-height: 1.52;
        }

        .form {
          margin-top: 22px;
          display: grid;
          gap: 12px;
        }

        .row {
          display: grid;
          grid-template-columns: 1fr auto;
          gap: 10px;
        }

        .url-input {
          height: 50px;
          border-radius: 12px;
          border: 1px solid var(--border);
          background: #0f0f13;
          color: var(--text);
          padding: 0 14px;
          font-size: 0.95rem;
          outline: none;
          transition: border-color 140ms ease, box-shadow 140ms ease;
        }

        .url-input::placeholder {
          color: #71717a;
        }

        .url-input:focus {
          border-color: #52525b;
          box-shadow: 0 0 0 4px var(--focus);
        }

        .shorten-btn {
          min-width: 132px;
          height: 50px;
          border-radius: 12px;
          border: 1px solid #3f3f46;
          background: var(--btn-bg);
          color: var(--btn-text);
          font-size: 0.93rem;
          font-weight: 700;
          display: inline-flex;
          align-items: center;
          justify-content: center;
          gap: 8px;
          cursor: pointer;
          transition: transform 120ms ease, opacity 120ms ease;
        }

        .shorten-btn:hover:enabled {
          transform: translateY(-1px);
        }

        .shorten-btn:disabled {
          opacity: 0.82;
          cursor: not-allowed;
        }

        .spinner {
          width: 16px;
          height: 16px;
          border-radius: 50%;
          border: 2px solid rgba(17, 17, 20, 0.22);
          border-top-color: rgba(17, 17, 20, 0.92);
          animation: spin 680ms linear infinite;
        }

        @keyframes spin {
          to { transform: rotate(360deg); }
        }

        .error {
          margin: 0;
          color: var(--danger);
          font-size: 0.9rem;
        }

        .result {
          margin-top: 18px;
          border: 1px solid #2b2b32;
          border-radius: 13px;
          background: linear-gradient(180deg, #121216, #101015);
          padding: 14px;
          animation: reveal 220ms ease;
        }

        @keyframes reveal {
          from { opacity: 0; transform: translateY(6px); }
          to { opacity: 1; transform: translateY(0); }
        }

        .result-label {
          margin: 0 0 10px;
          font-size: 0.82rem;
          color: var(--muted);
          letter-spacing: 0.03em;
          text-transform: uppercase;
        }

        .result-row {
          display: flex;
          align-items: center;
          gap: 10px;
          flex-wrap: wrap;
        }

        .result-link {
          color: #e4e4e7;
          text-decoration: none;
          font-weight: 600;
          word-break: break-all;
        }

        .result-link:hover {
          text-decoration: underline;
        }

        .copy-btn {
          height: 34px;
          min-width: 34px;
          border-radius: 8px;
          border: 1px solid #3f3f46;
          background: var(--panel-soft);
          color: #d4d4d8;
          padding: 0 10px;
          display: inline-flex;
          align-items: center;
          justify-content: center;
          gap: 6px;
          cursor: pointer;
          transition: border-color 120ms ease;
        }

        .copy-btn:hover {
          border-color: #52525b;
        }

        .copy-icon {
          width: 16px;
          height: 16px;
        }

        .copy-label {
          font-size: 0.8rem;
          color: var(--muted);
        }

        .badge {
          margin-top: 11px;
          display: inline-block;
          border-radius: 999px;
          border: 1px solid var(--border);
          background: var(--badge-bg);
          color: var(--badge-text);
          padding: 7px 11px;
          font-size: 0.74rem;
          letter-spacing: 0.02em;
        }

        @media (max-width: 640px) {
          .card {
            padding: 20px;
          }

          .row {
            grid-template-columns: 1fr;
          }

          .shorten-btn {
            width: 100%;
          }
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
                type="url"
                value={longUrl}
                onChange={(event) => setLongUrl(event.target.value)}
                placeholder="https://paste-your-long-link-here.com"
                aria-label="Long URL"
                required
              />

              <button className="shorten-btn" type="submit" disabled={isLoading} aria-busy={isLoading}>
                {isLoading ? (
                  <>
                    <span className="spinner" />
                    Shortening...
                  </>
                ) : (
                  "Shorten"
                )}
              </button>
            </div>

            {error ? <p className="error">{error}</p> : null}
          </form>

          {shortLink ? (
            <section className="result" aria-live="polite">
              <p className="result-label">Generated short link</p>
              <div className="result-row">
                <a className="result-link" href={shortLink} target="_blank" rel="noreferrer noopener">
                  {shortLink}
                </a>
                <button className="copy-btn" type="button" onClick={handleCopy} aria-label="Copy short link">
                  <CopyIcon className="copy-icon" />
                  <span className="copy-label">{copied ? "Copied" : "Copy"}</span>
                </button>
              </div>
              <div className="badge"> Blazing Fast Redirect [ L2 Redis Cache Active ] </div>
            </section>
          ) : null}
        </main>
      </div>
    </>
  );
}
