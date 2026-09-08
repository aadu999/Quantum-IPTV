import { defineConfig } from 'vite';
import path from 'path';

export default defineConfig({
  plugins: [
    {
      name: 'api-proxy-plugin',
      configureServer(server) {
        server.middlewares.use(async (req, res, next) => {
          if (req.url && req.url.includes('/api/proxy')) {
            try {
              const urlObj = new URL(req.url, 'http://localhost');
              const targetUrl = urlObj.searchParams.get('url');
              if (!targetUrl) {
                res.statusCode = 400;
                res.end('Missing target URL parameter');
                return;
              }

              const headers: Record<string, string> = {
                'User-Agent': 'IPTVSmartersPlayer/3.1.5 (Linux; Android 11)',
                'Accept': '*/*'
              };
              if (req.headers.range) {
                headers['Range'] = req.headers.range as string;
              }

              const response = await fetch(targetUrl, {
                headers,
                signal: AbortSignal.timeout(30000)
              });

              res.setHeader('Access-Control-Allow-Origin', '*');
              res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS, HEAD');
              res.setHeader('Access-Control-Allow-Headers', '*');
              res.setHeader('Access-Control-Expose-Headers', 'Content-Length, Content-Range, Content-Type');

              if (response.headers.get('content-type')) {
                res.setHeader('Content-Type', response.headers.get('content-type')!);
              }
              if (response.headers.get('content-length')) {
                res.setHeader('Content-Length', response.headers.get('content-length')!);
              }
              if (response.headers.get('content-range')) {
                res.setHeader('Content-Range', response.headers.get('content-range')!);
              }

              res.statusCode = response.status;
              const buffer = await response.arrayBuffer();
              res.end(Buffer.from(buffer));
              return;
            } catch (e: any) {
              res.setHeader('Access-Control-Allow-Origin', '*');
              res.statusCode = 502;
              res.end(`Proxy Error: ${e.message}`);
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
