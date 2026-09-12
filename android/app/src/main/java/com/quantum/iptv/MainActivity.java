package com.quantum.iptv;

import android.content.Context;
import android.media.AudioManager;
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

        @JavascriptInterface
        public void unmute() {
            runOnUiThread(() -> {
                try {
                    AudioManager am = (AudioManager) getSystemService(Context.AUDIO_SERVICE);
                    if (am != null) {
                        am.adjustStreamVolume(AudioManager.STREAM_MUSIC, AudioManager.ADJUST_UNMUTE, 0);
                        am.adjustStreamVolume(AudioManager.STREAM_MUSIC, AudioManager.ADJUST_SAME, AudioManager.FLAG_SHOW_UI);
                    }
                } catch (Exception ignored) {}
            });
        }

        @JavascriptInterface
        public void mute() {
            runOnUiThread(() -> {
                try {
                    AudioManager am = (AudioManager) getSystemService(Context.AUDIO_SERVICE);
                    if (am != null) {
                        am.adjustStreamVolume(AudioManager.STREAM_MUSIC, AudioManager.ADJUST_MUTE, AudioManager.FLAG_SHOW_UI);
                    }
                } catch (Exception ignored) {}
            });
        }

        @JavascriptInterface
        public void toggleMute() {
            runOnUiThread(() -> {
                try {
                    AudioManager am = (AudioManager) getSystemService(Context.AUDIO_SERVICE);
                    if (am != null) {
                        am.adjustStreamVolume(AudioManager.STREAM_MUSIC, AudioManager.ADJUST_TOGGLE_MUTE, AudioManager.FLAG_SHOW_UI);
                    }
                } catch (Exception ignored) {}
            });
        }
    }

    private void applyImmersiveFullscreen() {
        runOnUiThread(() -> {
            try {
                getWindow().getDecorView().setSystemUiVisibility(
                    View.SYSTEM_UI_FLAG_LAYOUT_STABLE
                    | View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION
                    | View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN
                    | View.SYSTEM_UI_FLAG_HIDE_NAVIGATION
                    | View.SYSTEM_UI_FLAG_FULLSCREEN
                    | View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY
                );
            } catch (Exception ignored) {}
        });
    }

    @Override
    public void onResume() {
        super.onResume();
        applyImmersiveFullscreen();
    }

    @Override
    public void onWindowFocusChanged(boolean hasFocus) {
        super.onWindowFocusChanged(hasFocus);
        if (hasFocus) {
            applyImmersiveFullscreen();
        }
    }

    @Override
    public void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        applyImmersiveFullscreen();

        // Direct hardware volume keys on TV remote to multimedia audio stream
        setVolumeControlStream(AudioManager.STREAM_MUSIC);

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
        int action = event.getAction();
        int keyCode = event.getKeyCode();
        WebView webView = this.getBridge().getWebView();

        if (webView != null) {
            // Handle dedicated Volume, Mute, Channel, and Media keys on TV remotes
            switch (keyCode) {
                case KeyEvent.KEYCODE_VOLUME_UP:
                    if (action == KeyEvent.ACTION_DOWN) {
                        try {
                            AudioManager audioManager = (AudioManager) getSystemService(Context.AUDIO_SERVICE);
                            if (audioManager != null) {
                                audioManager.adjustStreamVolume(AudioManager.STREAM_MUSIC, AudioManager.ADJUST_RAISE, AudioManager.FLAG_SHOW_UI);
                            }
                        } catch (Exception ignored) {}
                        webView.evaluateJavascript("window.handleNativeVolumeUp && window.handleNativeVolumeUp();", null);
                    }
                    return true;

                case KeyEvent.KEYCODE_VOLUME_DOWN:
                    if (action == KeyEvent.ACTION_DOWN) {
                        try {
                            AudioManager audioManager = (AudioManager) getSystemService(Context.AUDIO_SERVICE);
                            if (audioManager != null) {
                                audioManager.adjustStreamVolume(AudioManager.STREAM_MUSIC, AudioManager.ADJUST_LOWER, AudioManager.FLAG_SHOW_UI);
                            }
                        } catch (Exception ignored) {}
                        webView.evaluateJavascript("window.handleNativeVolumeDown && window.handleNativeVolumeDown();", null);
                    }
                    return true;

                case KeyEvent.KEYCODE_VOLUME_MUTE:
                case KeyEvent.KEYCODE_MUTE:
                    if (action == KeyEvent.ACTION_DOWN) {
                        try {
                            AudioManager audioManager = (AudioManager) getSystemService(Context.AUDIO_SERVICE);
                            if (audioManager != null) {
                                audioManager.adjustStreamVolume(AudioManager.STREAM_MUSIC, AudioManager.ADJUST_TOGGLE_MUTE, AudioManager.FLAG_SHOW_UI);
                            }
                        } catch (Exception ignored) {}
                    }
                    return true;

                case KeyEvent.KEYCODE_CHANNEL_UP:
                case KeyEvent.KEYCODE_PAGE_UP:
                case KeyEvent.KEYCODE_MEDIA_NEXT:
                case 260: // KEYCODE_TV_PROGRAM_UP (common on European / Thomson / Skyworth DVB platforms)
                case 272: // KEYCODE_TV_CHANNEL_UP
                case 274: // KEYCODE_MEDIA_STEP_FORWARD
                    if (action == KeyEvent.ACTION_DOWN) {
                        webView.evaluateJavascript("window.playNextChannel ? window.playNextChannel() : (window.playNextWorkingChannel && window.playNextWorkingChannel());", null);
                    }
                    return true;

                case KeyEvent.KEYCODE_CHANNEL_DOWN:
                case KeyEvent.KEYCODE_PAGE_DOWN:
                case KeyEvent.KEYCODE_MEDIA_PREVIOUS:
                case 261: // KEYCODE_TV_PROGRAM_DOWN (common on European / Thomson / Skyworth DVB platforms)
                case 273: // KEYCODE_TV_CHANNEL_DOWN
                case 275: // KEYCODE_MEDIA_STEP_BACKWARD
                    if (action == KeyEvent.ACTION_DOWN) {
                        webView.evaluateJavascript("window.playPreviousChannel && window.playPreviousChannel();", null);
                    }
                    return true;

                case KeyEvent.KEYCODE_BACK:
                    if (action == KeyEvent.ACTION_DOWN) {
                        webView.evaluateJavascript("window.handleAndroidTvBack ? window.handleAndroidTvBack() : false;", value -> {
                            if (!"true".equals(value)) {
                                runOnUiThread(this::handleNativeBackExit);
                            }
                        });
                    }
                    return true;

                case KeyEvent.KEYCODE_MEDIA_PLAY_PAUSE:
                case KeyEvent.KEYCODE_MEDIA_PLAY:
                case KeyEvent.KEYCODE_MEDIA_PAUSE:
                    if (action == KeyEvent.ACTION_DOWN) {
                        webView.evaluateJavascript("window.togglePlayPause && window.togglePlayPause();", null);
                    }
                    return true;

                case KeyEvent.KEYCODE_MEDIA_FAST_FORWARD:
                    if (action == KeyEvent.ACTION_DOWN) {
                        webView.evaluateJavascript("window.seekVideo && window.seekVideo(10, true);", null);
                    }
                    return true;

                case KeyEvent.KEYCODE_MEDIA_REWIND:
                    if (action == KeyEvent.ACTION_DOWN) {
                        webView.evaluateJavascript("window.seekVideo && window.seekVideo(-10, true);", null);
                    }
                    return true;

                case KeyEvent.KEYCODE_MENU:
                    if (action == KeyEvent.ACTION_DOWN) {
                        // Dedicated remote MENU button: Immediately opens Quant Remote (QR code pairing modal)
                        webView.evaluateJavascript("window.openRemoteModal && window.openRemoteModal();", null);
                    }
                    return true;

                case KeyEvent.KEYCODE_INFO:
                case 171: // KEYCODE_WINDOW
                case 178: // KEYCODE_TV_INPUT
                    if (action == KeyEvent.ACTION_DOWN) {
                        // Dedicated remote INFO or WINDOW button: Immediately toggles Fullscreen Mode
                        webView.evaluateJavascript("window.toggleFullscreenMode && window.toggleFullscreenMode();", null);
                    }
                    return true;

                case KeyEvent.KEYCODE_GUIDE:
                    if (action == KeyEvent.ACTION_DOWN) {
                        webView.evaluateJavascript("window.toggleTvGuide && window.toggleTvGuide();", null);
                    }
                    return true;

                case KeyEvent.KEYCODE_PROG_RED:
                    if (action == KeyEvent.ACTION_DOWN) {
                        webView.evaluateJavascript("window.handleTvColorButton && window.handleTvColorButton('red');", null);
                    }
                    return true;

                case KeyEvent.KEYCODE_PROG_GREEN:
                    if (action == KeyEvent.ACTION_DOWN) {
                        // Green button: Shortcut to open Quant Remote QR code!
                        webView.evaluateJavascript("window.openRemoteModal && window.openRemoteModal();", null);
                    }
                    return true;

                case KeyEvent.KEYCODE_PROG_YELLOW:
                    if (action == KeyEvent.ACTION_DOWN) {
                        webView.evaluateJavascript("window.handleTvColorButton && window.handleTvColorButton('yellow');", null);
                    }
                    return true;

                case KeyEvent.KEYCODE_PROG_BLUE:
                    if (action == KeyEvent.ACTION_DOWN) {
                        // Blue button: Shortcut to toggle Fullscreen Mode!
                        webView.evaluateJavascript("window.toggleFullscreenMode && window.toggleFullscreenMode();", null);
                    }
                    return true;
            }

            // Handle direct 0-9 numeric channel dialing on TV remotes
            if (keyCode >= KeyEvent.KEYCODE_0 && keyCode <= KeyEvent.KEYCODE_9) {
                if (action == KeyEvent.ACTION_DOWN) {
                    int digit = keyCode - KeyEvent.KEYCODE_0;
                    webView.evaluateJavascript("window.handleTvDigitKey && window.handleTvDigitKey(" + digit + ");", null);
                }
                return true;
            }

            // Offer every remaining keycode to the web layer before falling through.
            // OEM remotes emit vendor-specific codes for P+/P-, GUIDE and colour
            // buttons that are not in the AOSP constant set, so the switch above
            // can never be exhaustive. onNativeTvKey() consults a runtime-editable
            // map and reports back whether it consumed the key; anything it does
            // not claim still reaches the WebView as a normal DOM key event.
            if (action == KeyEvent.ACTION_DOWN && !event.isCanceled()) {
                webView.evaluateJavascript(
                    "window.onNativeTvKey ? window.onNativeTvKey(" + keyCode + ") : false;", null);
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
                    return executeProxyStream(request, targetUrl);
                }
            }

            return super.shouldInterceptRequest(view, request);
        }

        private WebResourceResponse executeProxyStream(WebResourceRequest request, String targetUrl) {
            try {
                Request.Builder reqBuilder = new Request.Builder()
                        .url(targetUrl)
                        .header("User-Agent", "VLC/3.0.18 LibVLC/3.0.18")
                        .header("Accept", "*/*");

                if (request != null && request.getRequestHeaders() != null) {
                    for (Map.Entry<String, String> entry : request.getRequestHeaders().entrySet()) {
                        String key = entry.getKey();
                        if ("Range".equalsIgnoreCase(key) || "If-Range".equalsIgnoreCase(key)) {
                            reqBuilder.header(key, entry.getValue());
                        }
                    }
                }

                Response resp = httpClient.newCall(reqBuilder.build()).execute();
                if (!resp.isSuccessful() && resp.code() != 206) {
                    return new WebResourceResponse("text/plain", "UTF-8", 502, "Bad Gateway", createCorsHeaders(), new ByteArrayInputStream("Proxy error".getBytes(StandardCharsets.UTF_8)));
                }

                String contentType = resp.header("Content-Type", "application/octet-stream");
                String mimeType = "application/octet-stream";
                if (contentType != null) {
                    mimeType = contentType.contains(";") ? contentType.split(";")[0].trim() : contentType;
                }

                Map<String, String> responseHeaders = createCorsHeaders();
                if (resp.header("Content-Range") != null) responseHeaders.put("Content-Range", resp.header("Content-Range"));
                if (resp.header("Content-Length") != null) responseHeaders.put("Content-Length", resp.header("Content-Length"));
                if (resp.header("Accept-Ranges") != null) responseHeaders.put("Accept-Ranges", resp.header("Accept-Ranges"));

                InputStream stream = resp.body().byteStream();
                int statusCode = resp.code();
                String reasonPhrase = (resp.message() == null || resp.message().isEmpty()) ? "OK" : resp.message();

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

                return new WebResourceResponse(mimeType, null, statusCode, reasonPhrase, responseHeaders, stream);
            } catch (Exception e) {
                return new WebResourceResponse("text/plain", "UTF-8", 500, "Internal Server Error", createCorsHeaders(), new ByteArrayInputStream((e.getMessage() != null ? e.getMessage() : "Error").getBytes(StandardCharsets.UTF_8)));
            }
        }
    }
}
