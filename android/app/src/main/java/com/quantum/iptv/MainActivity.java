package com.quantum.iptv;

import android.net.Uri;
import android.os.Bundle;
import android.view.KeyEvent;
import android.view.View;
import android.webkit.JavascriptInterface;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.widget.Toast;

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
    private long lastBackPressTime = 0;
    private Toast exitToast;

    public class AndroidTvNativeBridge {
        @JavascriptInterface
        public void exitApp() {
            runOnUiThread(() -> MainActivity.this.finish());
        }

        @JavascriptInterface
        public void showToast(String message) {
            runOnUiThread(() -> Toast.makeText(MainActivity.this, message, Toast.LENGTH_SHORT).show());
        }

        @JavascriptInterface
        public void setImmersiveFullscreen(boolean enabled) {
            runOnUiThread(() -> {
                if (enabled) {
                    getWindow().getDecorView().setSystemUiVisibility(
                        View.SYSTEM_UI_FLAG_LAYOUT_STABLE
                        | View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION
                        | View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN
                        | View.SYSTEM_UI_FLAG_HIDE_NAVIGATION
                        | View.SYSTEM_UI_FLAG_FULLSCREEN
                        | View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY
                    );
                } else {
                    getWindow().getDecorView().setSystemUiVisibility(
                        View.SYSTEM_UI_FLAG_LAYOUT_STABLE
                        | View.SYSTEM_UI_FLAG_VISIBLE
                    );
                }
            });
        }
    }

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

            // Expose native bridge to JavaScript
            webView.addJavascriptInterface(new AndroidTvNativeBridge(), "AndroidTvNative");

            // Ensure WebView can take D-Pad focus cleanly on Android TV hardware
            webView.setFocusable(true);
            webView.setFocusableInTouchMode(true);
            webView.requestFocus();

            TvWebViewClient tvClient = new TvWebViewClient(this.getBridge());
            this.getBridge().setWebViewClient(tvClient);
            webView.setWebViewClient(tvClient);
        }
    }

    @Override
    public boolean dispatchKeyEvent(KeyEvent event) {
        if (event.getAction() == KeyEvent.ACTION_DOWN) {
            int keyCode = event.getKeyCode();
            WebView webView = this.getBridge().getWebView();

            if (webView != null) {
                switch (keyCode) {
                    case KeyEvent.KEYCODE_BACK:
                        // Forward BACK to JS handler (closes modals, exits fullscreen, or handles double-tap exit)
                        webView.evaluateJavascript("window.handleAndroidTvBack ? window.handleAndroidTvBack() : false;", value -> {
                            if (!"true".equals(value)) {
                                runOnUiThread(this::handleNativeBackExit);
                            }
                        });
                        return true;

                    case KeyEvent.KEYCODE_CHANNEL_UP:
                        webView.evaluateJavascript("window.playNextWorkingChannel && window.playNextWorkingChannel();", null);
                        return true;

                    case KeyEvent.KEYCODE_CHANNEL_DOWN:
                        webView.evaluateJavascript("window.playPreviousChannel && window.playPreviousChannel();", null);
                        return true;

                    case KeyEvent.KEYCODE_MEDIA_PLAY_PAUSE:
                    case KeyEvent.KEYCODE_MEDIA_PLAY:
                    case KeyEvent.KEYCODE_MEDIA_PAUSE:
                        webView.evaluateJavascript("window.togglePlayPause && window.togglePlayPause();", null);
                        return true;

                    case KeyEvent.KEYCODE_MEDIA_FAST_FORWARD:
                        webView.evaluateJavascript("window.seekVideo && window.seekVideo(10);", null);
                        return true;

                    case KeyEvent.KEYCODE_MEDIA_REWIND:
                        webView.evaluateJavascript("window.seekVideo && window.seekVideo(-10);", null);
                        return true;

                    case KeyEvent.KEYCODE_MENU:
                        // Dedicated remote MENU button: Immediately opens Quant Remote (QR code pairing modal)
                        webView.evaluateJavascript("window.openRemoteModal && window.openRemoteModal();", null);
                        return true;

                    case KeyEvent.KEYCODE_INFO:
                    case 171: // KEYCODE_WINDOW
                    case 178: // KEYCODE_TV_INPUT
                        // Dedicated remote INFO or WINDOW button: Immediately toggles Fullscreen Mode
                        webView.evaluateJavascript("window.toggleFullscreenMode && window.toggleFullscreenMode();", null);
                        return true;

                    case KeyEvent.KEYCODE_GUIDE:
                        webView.evaluateJavascript("window.toggleTvGuide && window.toggleTvGuide();", null);
                        return true;

                    case KeyEvent.KEYCODE_PROG_RED:
                        webView.evaluateJavascript("window.handleTvColorButton && window.handleTvColorButton('red');", null);
                        return true;

                    case KeyEvent.KEYCODE_PROG_GREEN:
                        // Green button: Shortcut to open Quant Remote QR code!
                        webView.evaluateJavascript("window.openRemoteModal && window.openRemoteModal();", null);
                        return true;

                    case KeyEvent.KEYCODE_PROG_YELLOW:
                        webView.evaluateJavascript("window.handleTvColorButton && window.handleTvColorButton('yellow');", null);
                        return true;

                    case KeyEvent.KEYCODE_PROG_BLUE:
                        // Blue button: Shortcut to toggle Fullscreen Mode!
                        webView.evaluateJavascript("window.toggleFullscreenMode && window.toggleFullscreenMode();", null);
                        return true;
                }

                // Handle direct 0-9 numeric channel dialing on TV remotes
                if (keyCode >= KeyEvent.KEYCODE_0 && keyCode <= KeyEvent.KEYCODE_9) {
                    int digit = keyCode - KeyEvent.KEYCODE_0;
                    webView.evaluateJavascript("window.handleTvDigitKey && window.handleTvDigitKey(" + digit + ");", null);
                    return true;
                }
            }
        }
        return super.dispatchKeyEvent(event);
    }

    @Override
    public void onBackPressed() {
        WebView webView = this.getBridge().getWebView();
        if (webView != null) {
            webView.evaluateJavascript("window.handleAndroidTvBack ? window.handleAndroidTvBack() : false;", value -> {
                if (!"true".equals(value)) {
                    runOnUiThread(this::handleNativeBackExit);
                }
            });
        } else {
            handleNativeBackExit();
        }
    }

    private void handleNativeBackExit() {
        long now = System.currentTimeMillis();
        if (now - lastBackPressTime < 2500) {
            if (exitToast != null) exitToast.cancel();
            finish();
        } else {
            lastBackPressTime = now;
            exitToast = Toast.makeText(this, "Press BACK again to exit Quant TV", Toast.LENGTH_SHORT);
            exitToast.show();
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
