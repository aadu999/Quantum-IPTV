package com.quantum.iptv;

import android.annotation.SuppressLint;
import android.annotation.TargetApi;
import android.app.PictureInPictureParams;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.content.res.Configuration;
import android.media.AudioManager;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.util.Rational;
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
import java.util.Collections;
import java.util.HashMap;
import java.util.HashSet;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.TimeUnit;

import okhttp3.OkHttpClient;
import okhttp3.Request;
import okhttp3.Response;

public class MainActivity extends BridgeActivity {

    private OkHttpClient httpClient;
    private long lastBackPressTime = 0;
    private Toast exitToast;
    private QuantumLanRemoteServer lanRemoteServer;

    /**
     * Keycodes the web layer has said it will handle itself.
     *
     * Replaced wholesale rather than mutated: it is written from the JavaScript
     * bridge thread and read on the UI thread during key dispatch, and swapping
     * an immutable snapshot needs no lock and no concurrent collection (whose
     * newKeySet() is API 24 anyway, above this app's minimum of 23).
     */
    private volatile Set<Integer> claimedKeyCodes = Collections.emptySet();

    /**
     * Brings up the on-device remote server and hands commands it receives to
     * the web layer, which already knows how to act on them.
     */
    private String startLanRemoteServer(String pairingSecret) {
        if (lanRemoteServer == null) {
            lanRemoteServer = new QuantumLanRemoteServer(this, json -> runOnUiThread(() -> {
                WebView webView = this.getBridge().getWebView();
                if (webView == null) return;
                // Passed as a JSON string literal rather than spliced in raw: the
                // body arrives from the network, and pasting it into a script
                // would make any phone on the Wi-Fi able to run code in the app.
                webView.evaluateJavascript(
                    "window.onLanRemoteCommand && window.onLanRemoteCommand(" + jsonStringLiteral(json) + ");", null);
            }));
        }
        return lanRemoteServer.start(pairingSecret);
    }

    /** Best-guess MIME type from a stream URL's extension. */
    private static String mimeForUrl(String url) {
        String lower = url.toLowerCase(Locale.ROOT);
        int q = lower.indexOf('?');
        if (q >= 0) lower = lower.substring(0, q);
        if (lower.endsWith(".mkv")) return "video/x-matroska";
        if (lower.endsWith(".avi")) return "video/x-msvideo";
        if (lower.endsWith(".mp4") || lower.endsWith(".m4v")) return "video/mp4";
        if (lower.endsWith(".mov")) return "video/quicktime";
        if (lower.endsWith(".ts") || lower.endsWith(".m2ts")) return "video/mp2t";
        if (lower.endsWith(".m3u8")) return "application/x-mpegURL";
        if (lower.endsWith(".webm")) return "video/webm";
        if (lower.endsWith(".flv")) return "video/x-flv";
        if (lower.endsWith(".wmv")) return "video/x-ms-wmv";
        return "video/*";
    }

    /** Quotes arbitrary text as a JavaScript string literal. */
    private static String jsonStringLiteral(String raw) {
        StringBuilder sb = new StringBuilder(raw.length() + 16);
        sb.append('"');
        for (int i = 0; i < raw.length(); i++) {
            char c = raw.charAt(i);
            switch (c) {
                case '"': sb.append("\\\""); break;
                case '\\': sb.append("\\\\"); break;
                case '\n': sb.append("\\n"); break;
                case '\r': sb.append("\\r"); break;
                case '\t': sb.append("\\t"); break;
                default:
                    // Escape controls, and the line separators that are legal in
                    // JSON but terminate a JavaScript string literal.
                    if (c < 0x20 || c == 0x2028 || c == 0x2029) {
                        sb.append(String.format(Locale.ROOT, "\\u%04x", (int) c));
                    } else {
                        sb.append(c);
                    }
            }
        }
        return sb.append('"').toString();
    }

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

        /**
         * True on Android TV / leanback devices. The web layer uses this to keep
         * phone-only affordances (such as Picture-in-Picture) off the TV, where
         * they are meaningless and would add another D-pad focus stop.
         */
        @JavascriptInterface
        public boolean isTvDevice() {
            try {
                return getPackageManager().hasSystemFeature(PackageManager.FEATURE_LEANBACK);
            } catch (Exception e) {
                return false;
            }
        }

        /**
         * Puts the activity into Picture-in-Picture.
         *
         * Android's WebView does not implement the HTMLVideoElement
         * requestPictureInPicture() API, so inside the APK the web call is a
         * no-op and the whole activity has to be handed to the system instead.
         * Returns false when unavailable so the caller can fall back or hide the
         * control rather than appearing to do nothing.
         */
        // minSdk is 23, and PictureInPictureParams is API 26. The guards below are
        // the real protection; the annotation stops lint from flagging the class
        // reference inside the lambda, where it does not always carry the
        // surrounding version check through.
        @TargetApi(Build.VERSION_CODES.O)
        @JavascriptInterface
        public boolean enterPictureInPicture() {
            if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return false;
            try {
                if (getPackageManager().hasSystemFeature(PackageManager.FEATURE_LEANBACK)) return false;
                if (!getPackageManager().hasSystemFeature(PackageManager.FEATURE_PICTURE_IN_PICTURE)) return false;
            } catch (Exception e) {
                return false;
            }

            runOnUiThread(() -> {
                if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return;
                try {
                    PictureInPictureParams.Builder builder = new PictureInPictureParams.Builder();
                    // Android rejects ratios outside roughly 1:2.39..2.39:1, so an
                    // odd stream aspect must be clamped rather than passed through.
                    builder.setAspectRatio(new Rational(16, 9));
                    enterPictureInPictureMode(builder.build());
                } catch (Exception ignored) {}
            });
            return true;
        }

        /**
         * Starts serving the Quant Remote off this television.
         *
         * @return the base URL a phone should open, or "" when no LAN address or
         *         port was available -- the web layer then falls back to the
         *         broker-relayed remote.
         */
        @JavascriptInterface
        public String startLanRemoteServer(String pairingSecret) {
            String url = MainActivity.this.startLanRemoteServer(pairingSecret);
            return url == null ? "" : url;
        }

        @JavascriptInterface
        public void stopLanRemoteServer() {
            if (lanRemoteServer != null) lanRemoteServer.stop();
        }

        /** Makes the latest value of a topic available to polling remotes. */
        @JavascriptInterface
        public void publishLanTopic(String topic, String json) {
            if (lanRemoteServer != null) lanRemoteServer.publish(topic, json);
        }

        /**
         * Records which remote keycodes the web layer will consume, as a
         * comma-separated list. dispatchKeyEvent() has to decide synchronously
         * whether to swallow a key, and evaluateJavascript() cannot answer in
         * time, so the web layer publishes the set up front instead.
         */
        /**
         * Hands a stream to whatever app on the device can play it.
         *
         * Providers publish a great deal of Matroska, which no WebView can
         * decode however good the codec inside is -- on one real account 84% of
         * series episodes were .mkv. Those titles are not broken, they are
         * simply not playable *here*; VLC or MX Player handle them without
         * complaint. Passing the stream out is the difference between a dead
         * catalogue entry and a watchable episode.
         *
         * @return false when nothing on the device offers to handle it, so the
         *         web layer can say so rather than appearing to do nothing.
         */
        @JavascriptInterface
        public boolean openInExternalPlayer(String url, String title) {
            if (url == null || url.isEmpty()) return false;
            try {
                Intent intent = new Intent(Intent.ACTION_VIEW);
                // A concrete type gets the intent in front of video players;
                // several ignore a bare ACTION_VIEW on an unknown extension.
                intent.setDataAndType(Uri.parse(url), mimeForUrl(url));
                intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                intent.putExtra("title", title == null ? "" : title);
                // The extras MX Player and VLC read for a display title.
                intent.putExtra("secure_uri", true);

                if (intent.resolveActivity(getPackageManager()) == null) return false;
                startActivity(intent);
                return true;
            } catch (Exception e) {
                return false;
            }
        }

        @JavascriptInterface
        public void setClaimedTvKeyCodes(String csv) {
            Set<Integer> next = new HashSet<>();
            if (csv != null) {
                for (String part : csv.split(",")) {
                    String trimmed = part.trim();
                    if (trimmed.isEmpty()) continue;
                    try {
                        next.add(Integer.parseInt(trimmed));
                    } catch (NumberFormatException ignored) {
                        // A malformed entry must not drop the rest of the map.
                    }
                }
            }
            claimedKeyCodes = Collections.unmodifiableSet(next);
        }

        @JavascriptInterface
        public boolean isLanRemoteServerRunning() {
            return lanRemoteServer != null && lanRemoteServer.isRunning();
        }

        /**
         * Re-derives the URL rather than echoing the one start() returned: a
         * television that changes network keeps the same open port but answers
         * on a different address, and a QR code showing the old one scans fine
         * and then times out.
         */
        @JavascriptInterface
        public String getLanRemoteServerUrl() {
            if (lanRemoteServer == null || !lanRemoteServer.isRunning()) return "";
            String url = lanRemoteServer.currentUrl();
            return url == null ? "" : url;
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
        if (!isInPipMode()) {
            applyImmersiveFullscreen();
        }
    }

    @Override
    public void onWindowFocusChanged(boolean hasFocus) {
        super.onWindowFocusChanged(hasFocus);
        // In PiP the window is unfocused and tiny; re-asserting immersive
        // fullscreen there fights the system and can resize the surface.
        if (hasFocus && !isInPipMode()) {
            applyImmersiveFullscreen();
        }
    }

    private boolean isInPipMode() {
        return Build.VERSION.SDK_INT >= Build.VERSION_CODES.N && isInPictureInPictureMode();
    }

    /**
     * Lets the web layer strip its chrome down to bare video while the window is
     * a PiP tile, and restore it on the way back out.
     */
    @TargetApi(Build.VERSION_CODES.O)
    @Override
    public void onPictureInPictureModeChanged(boolean isInPictureInPictureMode, Configuration newConfig) {
        super.onPictureInPictureModeChanged(isInPictureInPictureMode, newConfig);
        WebView webView = this.getBridge().getWebView();
        if (webView != null) {
            webView.evaluateJavascript(
                "window.onNativePipModeChanged && window.onNativePipModeChanged(" + isInPictureInPictureMode + ");", null);
        }
        if (!isInPictureInPictureMode) {
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
    public void onDestroy() {
        // The socket outlives the activity otherwise, and the next launch finds
        // its port taken and quietly serves the remote one port over.
        if (lanRemoteServer != null) {
            lanRemoteServer.stop();
            lanRemoteServer = null;
        }
        super.onDestroy();
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
            // can never be exhaustive.
            //
            // Whether the web layer consumes a key is decided from the set it
            // published via setClaimedTvKeyCodes(), not from what
            // onNativeTvKey() returns: evaluateJavascript() is asynchronous, so
            // that return value arrived long after this method had to answer and
            // was discarded. A claimed key therefore reached the WebView as a DOM
            // event as well and was acted on twice -- one press of P+ skipping
            // two channels. Unclaimed keys still fall through untouched.
            if (claimedKeyCodes.contains(keyCode)) {
                if (action == KeyEvent.ACTION_DOWN && !event.isCanceled()) {
                    webView.evaluateJavascript(
                        "window.onNativeTvKey && window.onNativeTvKey(" + keyCode + ");", null);
                }
                // The matching ACTION_UP is swallowed too, so the page never sees
                // a keyup without its keydown.
                return true;
            }

            if (action == KeyEvent.ACTION_DOWN && !event.isCanceled()) {
                // Unclaimed: let the web layer see it (it may learn the code for
                // a remote we do not know yet), then pass it on as normal.
                webView.evaluateJavascript(
                    "window.onNativeTvKey && window.onNativeTvKey(" + keyCode + ");", null);
            }
        }
        return super.dispatchKeyEvent(event);
    }

    /**
     * Back is handled entirely here: the web layer gets first refusal (to close
     * a modal or leave fullscreen), and only a second press within 2.5s exits.
     * Delegating to super would finish the activity on the first press, which is
     * the behaviour this override exists to replace.
     */
    @SuppressLint("MissingSuperCall")
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
