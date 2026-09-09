package com.quantum.iptv;

import android.net.Uri;
import android.os.Bundle;
import android.view.KeyEvent;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;

import com.getcapacitor.Bridge;
import com.getcapacitor.BridgeActivity;
import com.getcapacitor.BridgeWebViewClient;

import java.io.BufferedReader;
import java.io.ByteArrayInputStream;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.nio.charset.StandardCharsets;
import java.util.HashMap;
import java.util.Map;
import java.util.concurrent.TimeUnit;

import okhttp3.OkHttpClient;
import okhttp3.Request;
import okhttp3.Response;

public class MainActivity extends BridgeActivity {

    private OkHttpClient httpClient;

    @Override
    public void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

        httpClient = new OkHttpClient.Builder()
                .followRedirects(true)
                .followSslRedirects(true)
                .connectTimeout(15, TimeUnit.SECONDS)
                .readTimeout(30, TimeUnit.SECONDS)
                .build();

        WebView webView = this.getBridge().getWebView();
        if (webView != null) {
            WebSettings settings = webView.getSettings();
            settings.setMediaPlaybackRequiresUserGesture(false);
            settings.setMixedContentMode(WebSettings.MIXED_CONTENT_ALWAYS_ALLOW);
            settings.setDomStorageEnabled(true);
            settings.setDatabaseEnabled(true);
            settings.setAllowFileAccess(true);
            settings.setAllowContentAccess(true);
            settings.setJavaScriptCanOpenWindowsAutomatically(true);
            settings.setUserAgentString("Mozilla/5.0 (Linux; Android 12; Android TV) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36 QuantTV/2.0 LibVLC/3.0.18");

            TvWebViewClient tvClient = new TvWebViewClient(this.getBridge());
            this.getBridge().setWebViewClient(tvClient);
            webView.setWebViewClient(tvClient);
        }
    }

    private static Map<String, String> createCorsHeaders() {
        Map<String, String> headers = new HashMap<>();
        headers.put("Access-Control-Allow-Origin", "*");
        headers.put("Access-Control-Allow-Methods", "GET, POST, OPTIONS, HEAD");
        headers.put("Access-Control-Allow-Headers", "*");
        headers.put("Access-Control-Max-Age", "86400");
        return headers;
    }

    private class TvWebViewClient extends BridgeWebViewClient {

        public TvWebViewClient(Bridge bridge) {
            super(bridge);
        }

        @Override
        public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
            Uri uri = request.getUrl();
            String urlString = uri.toString();

            // Intercept calls to /api/proxy?url=...
            if (urlString.contains("/api/proxy")) {
                String targetUrl = uri.getQueryParameter("url");
                if (targetUrl != null && !targetUrl.isEmpty()) {
                    return executeProxyStream(targetUrl);
                }
            }

            return super.shouldInterceptRequest(view, request);
        }

        private WebResourceResponse executeProxyStream(String targetUrl) {
            try {
                Request req = new Request.Builder()
                        .url(targetUrl)
                        .header("User-Agent", "VLC/3.0.18 LibVLC/3.0.18")
                        .header("Accept", "*/*")
                        .build();

                Response resp = httpClient.newCall(req).execute();
                if (!resp.isSuccessful() || resp.body() == null) {
                    return new WebResourceResponse("text/plain", "UTF-8", 502, "Bad Gateway", createCorsHeaders(), new ByteArrayInputStream("Proxy error".getBytes(StandardCharsets.UTF_8)));
                }

                String contentType = resp.header("Content-Type", "application/octet-stream");
                String mimeType = "application/octet-stream";
                if (contentType != null) {
                    mimeType = contentType.contains(";") ? contentType.split(";")[0].trim() : contentType;
                }

                InputStream stream = resp.body().byteStream();

                // If it is an M3U8 stream playlist, rewrite relative chunk links to /api/proxy
                if (targetUrl.toLowerCase().contains(".m3u8") || mimeType.contains("mpegurl") || mimeType.contains("m3u")) {
                    BufferedReader reader = new BufferedReader(new InputStreamReader(stream, StandardCharsets.UTF_8));
                    StringBuilder sb = new StringBuilder();
                    String line;
                    String baseUrl = targetUrl.substring(0, targetUrl.lastIndexOf('/') + 1);
                    boolean isChannelPlaylist = false;

                    while ((line = reader.readLine()) != null) {
                        if (line.startsWith("#EXTINF:")) {
                            isChannelPlaylist = true;
                        }
                        if (!isChannelPlaylist && !line.startsWith("#") && !line.trim().isEmpty()) {
                            String fullUrl;
                            if (line.startsWith("http://") || line.startsWith("https://")) {
                                fullUrl = line;
                            } else if (line.startsWith("/")) {
                                Uri u = Uri.parse(targetUrl);
                                fullUrl = u.getScheme() + "://" + u.getAuthority() + line;
                            } else {
                                fullUrl = baseUrl + line;
                            }
                            sb.append("/api/proxy?url=").append(Uri.encode(fullUrl)).append("\n");
                        } else {
                            sb.append(line).append("\n");
                        }
                    }
                    byte[] bytes = sb.toString().getBytes(StandardCharsets.UTF_8);
                    return new WebResourceResponse("application/vnd.apple.mpegurl", "UTF-8", 200, "OK", createCorsHeaders(), new ByteArrayInputStream(bytes));
                }

                return new WebResourceResponse(mimeType, null, 200, "OK", createCorsHeaders(), stream);
            } catch (Exception e) {
                return new WebResourceResponse("text/plain", "UTF-8", 500, "Internal Server Error", createCorsHeaders(), new ByteArrayInputStream((e.getMessage() != null ? e.getMessage() : "Error").getBytes(StandardCharsets.UTF_8)));
            }
        }
    }
}
