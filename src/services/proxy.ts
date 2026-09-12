const LAST_GOOD_PROXY_KEY = 'quantum_last_good_proxy_v1';

export function getProxiedUrl(targetUrl: string): string {
  return `/api/proxy?url=${encodeURIComponent(targetUrl)}`;
}

export function shouldProxy(targetUrl: string): boolean {
  if (!targetUrl) return false;
  // Mixed content security rule: browser blocks HTTP requests from HTTPS page
  if (typeof window !== 'undefined' && window.location.protocol === 'https:' && targetUrl.startsWith('http://')) {
    return true;
  }
  return false;
}

type ProxyBuilder = { id: string; build: (encoded: string, raw: string) => string };

const PROXY_BUILDERS: ProxyBuilder[] = [
  { id: 'self', build: encoded => `/api/proxy?url=${encoded}` },
  { id: 'corsproxy', build: encoded => `https://corsproxy.io/?${encoded}` },
  { id: 'codetabs', build: encoded => `https://api.codetabs.com/v1/proxy?quest=${encoded}` },
  { id: 'allorigins', build: encoded => `https://api.allorigins.win/raw?url=${encoded}` }
];

function isNativePlatform(): boolean {
  return (
    typeof window !== 'undefined' &&
    Boolean(
      (window as any).Capacitor?.isNativePlatform?.() ||
        (window as any).Capacitor?.getPlatform?.() === 'android' ||
        window.location.protocol === 'capacitor:'
    )
  );
}

function loadLastGoodProxy(): string | null {
  try {
    const raw = localStorage.getItem(LAST_GOOD_PROXY_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    // A proxy that worked last week may well be gone; only trust recent wins.
    if (!parsed || Date.now() - (parsed.at || 0) > 6 * 3600 * 1000) return null;
    return parsed.id || null;
  } catch {
    return null;
  }
}

function rememberGoodProxy(id: string): void {
  try {
    localStorage.setItem(LAST_GOOD_PROXY_KEY, JSON.stringify({ id, at: Date.now() }));
  } catch {
    /* storage unavailable */
  }
}

/**
 * Fetches a playlist through whichever route works, trying the most promising
 * first.
 *
 * The previous implementation walked a fixed list with a 20-second timeout on
 * each, so a user behind a blocked proxy waited up to 80 seconds before seeing
 * an error — and it relearned the same dead route on every single request. Now
 * the route that last succeeded is tried first, the timeout starts short and
 * only grows for later attempts, and the winner is remembered.
 */
export async function fetchWithProxyFallback(targetUrl: string, options: RequestInit = {}): Promise<string> {
  const encoded = encodeURIComponent(targetUrl);

  const candidates: Array<{ id: string; url: string }> = [];
  const seen = new Set<string>();
  const add = (id: string, url: string) => {
    if (seen.has(url)) return;
    seen.add(url);
    candidates.push({ id, url });
  };

  // A direct request is by far the cheapest when it is allowed at all: native
  // builds have no CORS restrictions, and a plain-HTTP page can reach plain-HTTP
  // origins without help.
  const canGoDirect =
    isNativePlatform() ||
    targetUrl.includes('iptv-org.github.io') ||
    (typeof window !== 'undefined' && window.location.protocol === 'http:' && targetUrl.startsWith('http://'));

  if (canGoDirect) add('direct', targetUrl);

  const preferred = loadLastGoodProxy();
  if (preferred) {
    const builder = PROXY_BUILDERS.find(p => p.id === preferred);
    if (builder) add(builder.id, builder.build(encoded, targetUrl));
  }
  for (const builder of PROXY_BUILDERS) {
    add(builder.id, builder.build(encoded, targetUrl));
  }

  let lastErr: any = null;

  for (let i = 0; i < candidates.length; i++) {
    const { id, url } = candidates[i];
    // Start impatient and grow: the first route is the one most likely to work,
    // so waiting long on it is wasted time when it does not.
    const timeoutMs = i === 0 ? 8000 : Math.min(20000, 8000 + i * 4000);

    try {
      const resp = await fetch(url, {
        ...options,
        headers: { Accept: '*/*', ...(options.headers || {}) },
        signal: AbortSignal.timeout(timeoutMs)
      });

      if (!resp.ok) {
        lastErr = new Error(`${id} responded ${resp.status}`);
        continue;
      }

      const text = await resp.text();
      if (!text || text.trim().length === 0) {
        lastErr = new Error(`${id} returned an empty body`);
        continue;
      }

      // Several public proxies answer with an HTML error page and a 200 status.
      // Accepting that would poison the playlist cache with a page of markup.
      if (/^\s*<(?:!doctype|html)\b/i.test(text) && !text.includes('#EXTM3U')) {
        lastErr = new Error(`${id} returned an HTML error page`);
        continue;
      }

      if (id !== 'direct') rememberGoodProxy(id);
      return text;
    } catch (e: any) {
      lastErr = e;
    }
  }

  throw lastErr || new Error(`Unable to fetch resource from ${targetUrl}`);
}
