import React, { useMemo, useState } from "react";

const API_BASE_URL = "<YOUR_AWS_API_ENDPOINT>";

function CopyIcon() {
  return (
    <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true" focusable="false">
      <path
        d="M8 8a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2h-8a2 2 0 0 1-2-2V8z"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
      />
      <path
        d="M14 6V5a2 2 0 0 0-2-2H4a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h1"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
      />
    </svg>
  );
}

function Spinner() {
  return <span className="spinner" aria-hidden="true" />;
}

export default function App() {
  const [longUrl, setLongUrl] = useState("");
  const [shortUrl, setShortUrl] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState("");
  const [copyState, setCopyState] = useState("Copy");

  const normalizedApiBase = useMemo(() => API_BASE_URL.replace(/\/+$/, ""), []);

  async function handleShorten(event) {
    event.preventDefault();
    setError("");
    setShortUrl("");
    setCopyState("Copy");

    const candidate = longUrl.trim();

    if (!candidate) {
      setError("Please paste a URL to shorten.");
      return;
    }

    try {
      const parsed = new URL(candidate);
      if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
        setError("Please use a valid http or https URL.");
        return;
      }
    } catch {
      setError("Please enter a valid URL, for example: https://example.com/page");
      return;
    }

    setIsLoading(true);

    try {
      const response = await fetch(`${normalizedApiBase}/shorten`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ url: candidate }),
      });

      const data = await response.json().catch(() => ({}));

      if (!response.ok) {
        const message = data.error || data.message || `Request failed with status ${response.status}`;
        throw new Error(message);
      }

      const shortId = data.shortId || data.id || data.shortCode || data.code;
      const resolvedShortUrl = data.shortUrl || (shortId ? `${normalizedApiBase}/${shortId}` : "");

      if (!resolvedShortUrl) {
        throw new Error("Backend response did not include a short link id.");
      }

      setShortUrl(resolvedShortUrl);
    } catch (requestError) {
      setError(requestError.message || "Unable to shorten URL right now.");
    } finally {
      setIsLoading(false);
    }
  }

  async function handleCopy() {
    if (!shortUrl) return;

    try {
      await navigator.clipboard.writeText(shortUrl);
      setCopyState("Copied");
      window.setTimeout(() => setCopyState("Copy"), 1500);
    } catch {
      setError("Copy failed. Please copy the short link manually.");
    }
  }

  return (
    <div className="app-shell">
      <style>{`
        :root {
          color-scheme: dark;
        }

        * {
          box-sizing: border-box;
        }

        html,
        body,
        #root {
          margin: 0;
          min-height: 100%;
          background: #09090b;
          color: #e4e4e7;
          font-family: "Segoe UI", "SF Pro Text", "Helvetica Neue", Arial, sans-serif;
        }

        .app-shell {
          min-height: 100vh;
          display: grid;
          place-items: center;
          padding: 24px;
          background:
            radial-gradient(800px 480px at 0% -10%, rgba(63, 63, 70, 0.35), transparent 65%),
            radial-gradient(640px 420px at 100% 0%, rgba(39, 39, 42, 0.45), transparent 62%),
            #09090b;
        }

        .panel {
          width: min(760px, 100%);
          border: 1px solid #27272a;
          border-radius: 16px;
          padding: 28px;
          background: linear-gradient(180deg, rgba(24, 24, 27, 0.96), rgba(15, 15, 18, 0.96));
          box-shadow: 0 20px 64px rgba(0, 0, 0, 0.45);
        }

        .eyebrow {
          margin: 0 0 10px;
          color: #a1a1aa;
          text-transform: uppercase;
          letter-spacing: 0.08em;
          font-size: 0.72rem;
          font-weight: 600;
        }

        .title {
          margin: 0;
          color: #fafafa;
          font-size: clamp(1.3rem, 2.8vw, 2rem);
          line-height: 1.2;
          font-weight: 700;
        }

        .subtitle {
          margin: 10px 0 0;
          color: #a1a1aa;
          font-size: 0.95rem;
          line-height: 1.5;
        }

        .form {
          margin-top: 22px;
          display: grid;
          gap: 12px;
        }

        .controls {
          display: grid;
          grid-template-columns: 1fr auto;
          gap: 10px;
        }

        .url-input {
          width: 100%;
          height: 50px;
          border-radius: 12px;
          border: 1px solid #27272a;
          background: #0f0f13;
          color: #f4f4f5;
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
          box-shadow: 0 0 0 3px rgba(161, 161, 170, 0.25);
        }

        .shorten-btn {
          min-width: 128px;
          height: 50px;
          border-radius: 12px;
          border: 1px solid #3f3f46;
          background: #e4e4e7;
          color: #18181b;
          padding: 0 16px;
          font-weight: 700;
          font-size: 0.92rem;
          cursor: pointer;
          display: inline-flex;
          align-items: center;
          justify-content: center;
          gap: 8px;
          transition: transform 120ms ease, opacity 120ms ease;
        }

        .shorten-btn:hover:enabled {
          transform: translateY(-1px);
        }

        .shorten-btn:disabled {
          cursor: not-allowed;
          opacity: 0.8;
        }

        .spinner {
          width: 14px;
          height: 14px;
          border-radius: 50%;
          border: 2px solid rgba(9, 9, 11, 0.24);
          border-top-color: rgba(9, 9, 11, 0.92);
          animation: spin 700ms linear infinite;
        }

        .error-text {
          margin: 0;
          color: #fca5a5;
          font-size: 0.88rem;
        }

        .result {
          margin-top: 16px;
          border: 1px solid #27272a;
          border-radius: 12px;
          background: #111114;
          padding: 14px;
          animation: fadeIn 180ms ease;
        }

        .result-label {
          margin: 0 0 9px;
          color: #a1a1aa;
          font-size: 0.8rem;
          text-transform: uppercase;
          letter-spacing: 0.05em;
        }

        .result-row {
          display: flex;
          align-items: center;
          gap: 10px;
          flex-wrap: wrap;
        }

        .result-link {
          color: #f4f4f5;
          text-decoration: none;
          font-weight: 600;
          word-break: break-all;
        }

        .result-link:hover {
          text-decoration: underline;
        }

        .copy-btn {
          border: 1px solid #3f3f46;
          background: #18181b;
          color: #d4d4d8;
          border-radius: 8px;
          height: 34px;
          min-width: 34px;
          padding: 0 10px;
          display: inline-flex;
          align-items: center;
          gap: 6px;
          cursor: pointer;
          font-size: 0.8rem;
          transition: border-color 120ms ease;
        }

        .copy-btn:hover {
          border-color: #52525b;
        }

        .perf-badge {
          margin-top: 10px;
          display: inline-block;
          color: #a1a1aa;
          background: #18181b;
          border: 1px solid #27272a;
          border-radius: 999px;
          padding: 6px 10px;
          font-size: 0.74rem;
          line-height: 1;
          letter-spacing: 0.01em;
        }

        @keyframes spin {
          to {
            transform: rotate(360deg);
          }
        }

        @keyframes fadeIn {
          from {
            opacity: 0;
            transform: translateY(4px);
          }
          to {
            opacity: 1;
            transform: translateY(0);
          }
        }

        @media (max-width: 640px) {
          .panel {
            padding: 20px;
          }

          .controls {
            grid-template-columns: 1fr;
          }

          .shorten-btn {
            width: 100%;
          }
        }
      `}</style>

      <main className="panel">
        <p className="eyebrow">High-Performance Serverless URL Shortener</p>
        <h1 className="title">Compress long links into instant redirects.</h1>
        <p className="subtitle">
          Built for speed-first infrastructure with Lambda, DynamoDB single-table design, and Redis-backed
          acceleration.
        </p>

        <form className="form" onSubmit={handleShorten}>
          <div className="controls">
            <input
              className="url-input"
              type="url"
              inputMode="url"
              autoComplete="off"
              value={longUrl}
              onChange={(event) => setLongUrl(event.target.value)}
              placeholder="https://paste-your-long-link-here.com"
              aria-label="Enter long URL"
              required
            />

            <button className="shorten-btn" type="submit" disabled={isLoading}>
              {isLoading ? (
                <>
                  <Spinner />
                  Shortening
                </>
              ) : (
                "Shorten"
              )}
            </button>
          </div>

          {error ? <p className="error-text">{error}</p> : null}
        </form>

        {shortUrl ? (
          <section className="result" aria-live="polite">
            <p className="result-label">Generated short link</p>
            <div className="result-row">
              <a className="result-link" href={shortUrl} target="_blank" rel="noreferrer noopener">
                {shortUrl}
              </a>
              <button className="copy-btn" type="button" onClick={handleCopy} aria-label="Copy short link">
                <CopyIcon />
                <span>{copyState}</span>
              </button>
            </div>
            <div className="perf-badge"> Blazing Fast Redirect [ L2 Redis Cache Active ] </div>
          </section>
        ) : null}
      </main>
    </div>
  );
}
