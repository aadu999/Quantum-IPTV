export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS, HEAD");
  res.setHeader("Access-Control-Allow-Headers", "*");
  res.setHeader("Access-Control-Expose-Headers", "Content-Length, Content-Range, Content-Type");

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  // Robust target URL extraction to preserve all query string parameters (username, password, action)
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
    const headers = {
      'User-Agent': 'IPTVSmartersPlayer/3.1.5 (Linux; Android 11)',
      'Accept': '*/*'
    };

    if (req.headers.range) {
      headers['Range'] = req.headers.range;
    }

    const response = await fetch(targetUrl, {
      headers,
      signal: AbortSignal.timeout(35000)
    });

    if (response.headers.get("content-type")) {
      res.setHeader("Content-Type", response.headers.get("content-type"));
    }
    if (response.headers.get("content-length")) {
      res.setHeader("Content-Length", response.headers.get("content-length"));
    }
    if (response.headers.get("content-range")) {
      res.setHeader("Content-Range", response.headers.get("content-range"));
    }

    res.status(response.status);

    const buffer = await response.arrayBuffer();
    res.send(Buffer.from(buffer));
  } catch (err) {
    res.status(502).json({ error: "Failed to proxy request", message: err.message, targetUrl });
  }
}