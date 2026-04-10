/**
 * Lightweight User-Agent parser — zero external dependencies.
 *
 * Extracts { browser, browserVersion, os, device } from a UA string.
 * Covers ~95% of real-world traffic patterns (Chrome, Safari, Firefox, Edge,
 * Samsung Internet, Opera, plus bots). Falls back to "Unknown" gracefully.
 */

const BROWSER_PATTERNS = [
  // Order matters — more specific patterns first
  [/Edg(?:e|A|iOS)?\/(\S+)/i,          "Edge"],
  [/OPR\/(\S+)/i,                       "Opera"],
  [/SamsungBrowser\/(\S+)/i,            "Samsung Internet"],
  [/UCBrowser\/(\S+)/i,                 "UC Browser"],
  [/CriOS\/(\S+)/i,                     "Chrome iOS"],
  [/FxiOS\/(\S+)/i,                     "Firefox iOS"],
  [/Chrome\/(\S+)/i,                    "Chrome"],
  [/Firefox\/(\S+)/i,                   "Firefox"],
  [/Version\/(\S+).*Safari/i,           "Safari"],
  [/Safari\/(\S+)/i,                    "Safari"],
  [/Trident.*rv:(\S+)/i,               "IE"],
  [/MSIE (\S+)/i,                       "IE"],
];

const OS_PATTERNS = [
  [/Windows NT 10/i,                    "Windows 10+"],
  [/Windows NT 6\.3/i,                  "Windows 8.1"],
  [/Windows NT 6\.2/i,                  "Windows 8"],
  [/Windows NT 6\.1/i,                  "Windows 7"],
  [/Windows/i,                          "Windows"],
  [/Mac OS X (\d+[._]\d+)/i,           "macOS"],
  [/Macintosh/i,                        "macOS"],
  [/CrOS/i,                             "Chrome OS"],
  [/Android (\d+\.?\d*)/i,             "Android"],
  [/iPhone|iPad|iPod/i,                 "iOS"],
  [/Linux/i,                            "Linux"],
];

const BOT_RE = /bot|crawl|spider|slurp|feed|wget|curl|http|python|java|go-http|node-fetch/i;

/**
 * @param {string} ua — raw User-Agent header value
 * @returns {{ browser: string, browserVersion: string, os: string, device: string }}
 */
export function parseUserAgent(ua) {
  if (!ua || typeof ua !== "string") {
    return { browser: "Unknown", browserVersion: "", os: "Unknown", device: "Unknown" };
  }

  // Bot detection
  if (BOT_RE.test(ua)) {
    return { browser: "Bot", browserVersion: "", os: "Server", device: "Bot" };
  }

  // ── Browser ──────────────────────────────────────────────────────────────
  let browser = "Unknown";
  let browserVersion = "";
  for (const [pattern, name] of BROWSER_PATTERNS) {
    const match = ua.match(pattern);
    if (match) {
      browser = name;
      browserVersion = (match[1] || "").split(".").slice(0, 2).join(".");
      break;
    }
  }

  // ── OS ───────────────────────────────────────────────────────────────────
  let os = "Unknown";
  for (const [pattern, name] of OS_PATTERNS) {
    const match = ua.match(pattern);
    if (match) {
      os = name;
      // Enrich Android/iOS with version
      if (name === "Android" && match[1]) os = `Android ${match[1]}`;
      if (name === "macOS" && match[1]) os = `macOS ${match[1].replace(/_/g, ".")}`;
      break;
    }
  }

  // ── Device ───────────────────────────────────────────────────────────────
  let device = "Desktop";
  if (/Mobile|Android.*Mobile|iPhone|iPod/i.test(ua)) device = "Mobile";
  else if (/Tablet|iPad|Android(?!.*Mobile)/i.test(ua)) device = "Tablet";

  return { browser, browserVersion, os, device };
}
