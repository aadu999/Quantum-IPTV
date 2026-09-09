import http from 'http';
import https from 'https';

function rewriteM3u8(content, baseUrl) {
  const lines = content.split(/\r?\n/);
  return lines
    .map(line => {
      const trimmed = line.trim();
      if (!trimmed) return line;

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

      if (trimmed.startsWith('#')) {
        return line;
      }

      try {
        const absolute = new URL(trimmed, baseUrl).href;
        return `/api/proxy?url=${encodeURIComponent(absolute)}`;
      } catch {
        return line;
      }
    })
    .join('\n');
}

function requestStream(url, clientHeaders, maxRedirects = 5) {
  return new Promise((resolve, reject) => {
    let parsed;
    try {
      parsed = new URL(url);
    } catch (e) {
      return reject(new Error(`Invalid target URL: ${url}`));
    }

    const lib = parsed.protocol === 'https:' ? https : http;
    const reqHeaders = {
      'User-Agent': 'VLC/3.0.18 LibVLC/3.0.18 (Linux; Android 11)',
      'Accept': '*/*',
      'Connection': 'keep-alive'
    };
    if (clientHeaders.range) {
      reqHeaders['Range'] = clientHeaders.range;
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

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS, HEAD");
  res.setHeader("Access-Control-Allow-Headers", "*");
  res.setHeader("Access-Control-Expose-Headers", "Content-Length, Content-Range, Content-Type, Accept-Ranges");

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  let targetUrl = null;
  if (req.url && req.url.includes('?url=')) {
    const rawParam = req.url.substring(req.url.indexOf('?url=') + 5);
    if (rawParam) {
      try {
        targetUrl = decodeURIComponent(rawParam);
      } catch (e) {
        targetUrl = rawParam;
      }
    }
  }
  if (!targetUrl && req.query && req.query.url) {
    targetUrl = req.query.url;
  }

  if (!targetUrl) {
    return res.status(400).json({ error: "Missing URL parameter" });
  }

  try {
    const { statusCode, headers: upstreamHeaders, stream, finalUrl } = await requestStream(targetUrl, req.headers);

    const contentType = upstreamHeaders['content-type'] || '';
    const isM3U8 =
      targetUrl.toLowerCase().includes('.m3u8') ||
      contentType.includes('mpegurl') ||
      contentType.includes('application/x-mpegURL');

    if (contentType) res.setHeader("Content-Type", contentType);
    if (upstreamHeaders['content-length'] && !isM3U8) {
      res.setHeader("Content-Length", upstreamHeaders['content-length']);
    }
    if (upstreamHeaders['content-range']) {
      res.setHeader("Content-Range", upstreamHeaders['content-range']);
    }
    if (upstreamHeaders['accept-ranges']) {
      res.setHeader("Accept-Ranges", upstreamHeaders['accept-ranges']);
    }

    res.status(statusCode);

    if (isM3U8) {
      const chunks = [];
      stream.on('data', chunk => chunks.push(Buffer.from(chunk)));
      stream.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf-8');
        // Do not rewrite channel URLs in M3U channel catalog playlists
        const isChannelCatalog = text.includes('#EXTINF');
        const output = isChannelCatalog ? text : rewriteM3u8(text, finalUrl);
        res.setHeader("Content-Type", "application/vnd.apple.mpegurl; charset=utf-8");
        return res.send(output);
      });
      stream.on('error', err => {
        if (!res.headersSent) {
          res.status(502).json({ error: "M3U8 stream error", message: err.message, targetUrl });
        }
      });
      return;
    }

    req.on('close', () => {
      stream.destroy();
    });
    stream.pipe(res);
  } catch (err) {
    if (!res.headersSent) {
      res.status(502).json({ error: "Failed to proxy request", message: err.message, targetUrl });
    }
  }
}