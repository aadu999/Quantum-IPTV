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

export async function fetchWithProxyFallback(targetUrl: string, options: RequestInit = {}): Promise<string> {
  const encoded = encodeURIComponent(targetUrl);
  const proxies = [
    `/api/proxy?url=${encoded}`,
    `https://corsproxy.io/?${encoded}`,
    `https://api.allorigins.win/raw?url=${encoded}`
  ];

  if (
    targetUrl.includes('iptv-org.github.io') ||
    (typeof window !== 'undefined' && window.location.protocol === 'http:' && targetUrl.startsWith('http://'))
  ) {
    proxies.unshift(targetUrl);
  }

  let lastErr: any = null;
  for (const proxyUrl of proxies) {
    try {
      const resp = await fetch(proxyUrl, {
        ...options,
        headers: { 'Accept': '*/*', ...(options.headers || {}) },
        signal: AbortSignal.timeout(20000)
      });
      if (resp.ok) {
        const text = await resp.text();
        if (text && text.trim().length > 0) return text;
      }
    } catch (e: any) {
      lastErr = e;
    }
  }
  throw lastErr || new Error(`Unable to fetch resource from ${targetUrl}`);
}
