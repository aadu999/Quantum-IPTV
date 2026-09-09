import { defineConfig } from 'vite';
import path from 'path';
import http from 'http';
import https from 'https';

function rewriteM3u8(content: string, baseUrl: string): string {
  const lines = content.split(/\r?\n/);
  return lines
    .map(line => {
      const trimmed = line.trim();
      if (!trimmed) return line;

      // Handle tags with URIs (e.g., #EXT-X-KEY:METHOD=AES-128,URI="...")
      if (trimmed.startsWith('#EXT-X-KEY:') || trimmed.startsWith('#EXT-X-MAP:')) {
        return line.replace(/URI="([^"]+)"/g, (_, uri) => {
          try {
            const absolute = new URL(uri, baseUrl).href;
            return `URI="/api/proxy?url=${encodeURIComponent(absolute)}"`;
          } catch {
            return `URI="${uri}"`;
          }
        });
      }

      // Skip comments / tags
      if (trimmed.startsWith('#')) {
        return line;
      }

      // Relative or absolute stream URI
      try {
        const absolute = new URL(trimmed, baseUrl).href;
        return `/api/proxy?url=${encodeURIComponent(absolute)}`;
      } catch {
        return line;
      }
    })
    .join('\n');
}

function requestStream(
  url: string,
  clientHeaders: Record<string, string | string[] | undefined>,
  maxRedirects = 5
): Promise<{ statusCode: number; headers: http.IncomingHttpHeaders; stream: http.IncomingMessage; finalUrl: string }> {
  return new Promise((resolve, reject) => {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch (e: any) {
      return reject(new Error(`Invalid target URL: ${url}`));
    }

    const lib = parsed.protocol === 'https:' ? https : http;
    const reqHeaders: Record<string, string> = {
      'User-Agent': 'VLC/3.0.18 LibVLC/3.0.18 (Linux; Android 11)',
      'Accept': '*/*',
      'Connection': 'keep-alive'
    };
    if (clientHeaders.range) {
      reqHeaders['Range'] = clientHeaders.range as string;
    }

    const req = lib.request(
      url,
      {
        family: 4,
        headers: reqHeaders,
        timeout: 30000
      },
      res => {
        if ([301, 302, 307, 308].includes(res.statusCode || 0) && res.headers.location && maxRedirects > 0) {
          const nextUrl = new URL(res.headers.location, url).href;
          res.resume();
          return resolve(requestStream(nextUrl, clientHeaders, maxRedirects - 1));
        }
        resolve({
          statusCode: res.statusCode || 200,
          headers: res.headers,
          stream: res,
          finalUrl: url
        });
      }
    );

    req.on('timeout', () => {
      req.destroy(new Error('Upstream timeout'));
    });
    req.on('error', reject);
    req.end();
  });
}

export default defineConfig({
  plugins: [
    {
      name: 'api-proxy-plugin',
      configureServer(server) {
        server.middlewares.use(async (req, res, next) => {
          if (req.url && req.url.includes('/api/proxy')) {
            res.setHeader('Access-Control-Allow-Origin', '*');
            res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS, HEAD');
            res.setHeader('Access-Control-Allow-Headers', '*');
            res.setHeader('Access-Control-Expose-Headers', 'Content-Length, Content-Range, Content-Type, Accept-Ranges');

            if (req.method === 'OPTIONS') {
              res.statusCode = 200;
              res.end();
              return;
            }

            try {
              let targetUrl = '';
              const idx = req.url.indexOf('?url=');
              if (idx !== -1) {
                const rawParam = req.url.substring(idx + 5);
                try {
                  targetUrl = decodeURIComponent(rawParam);
                } catch {
                  targetUrl = rawParam;
                }
              }

              if (!targetUrl) {
                res.statusCode = 400;
                res.end('Missing target URL parameter');
                return;
              }

              const { statusCode, headers: upstreamHeaders, stream, finalUrl } = await requestStream(targetUrl, req.headers);

              const contentType = (upstreamHeaders['content-type'] as string) || '';
              const isM3U8 =
                targetUrl.toLowerCase().includes('.m3u8') ||
                contentType.includes('mpegurl') ||
                contentType.includes('application/x-mpegURL');

              if (contentType) res.setHeader('Content-Type', contentType);
              if (upstreamHeaders['content-length'] && !isM3U8) {
                res.setHeader('Content-Length', upstreamHeaders['content-length']);
              }
              if (upstreamHeaders['content-range']) {
                res.setHeader('Content-Range', upstreamHeaders['content-range']);
              }
              if (upstreamHeaders['accept-ranges']) {
                res.setHeader('Accept-Ranges', upstreamHeaders['accept-ranges']);
              }

              res.statusCode = statusCode;

              if (isM3U8) {
                const chunks: Buffer[] = [];
                stream.on('data', chunk => chunks.push(Buffer.from(chunk)));
                stream.on('end', () => {
                  const text = Buffer.concat(chunks).toString('utf-8');
                  // Do not rewrite channel URLs in M3U channel catalog playlists
                  const isChannelCatalog = text.includes('#EXTINF');
                  const output = isChannelCatalog ? text : rewriteM3u8(text, finalUrl);
                  res.setHeader('Content-Type', 'application/vnd.apple.mpegurl; charset=utf-8');
                  res.end(output);
                });
                stream.on('error', err => {
                  if (!res.headersSent) {
                    res.statusCode = 502;
                    res.end(`M3U8 stream error: ${err.message}`);
                  }
                });
                return;
              }

              req.on('close', () => {
                stream.destroy();
              });
              stream.pipe(res);
              return;
            } catch (e: any) {
              if (!res.headersSent) {
                res.statusCode = 502;
                res.end(`Proxy Error: ${e.message}`);
              }
              return;
            }
          }
          next();
        });
      }
    }
  ],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src')
    }
  },
  server: {
    port: 3000
  }
});

