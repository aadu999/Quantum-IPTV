package com.quantum.iptv;

import android.content.Context;
import android.content.res.AssetManager;
import android.util.Log;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.io.PushbackInputStream;
import java.net.Inet4Address;
import java.net.InetAddress;
import java.net.NetworkInterface;
import java.net.ServerSocket;
import java.net.Socket;
import java.net.URLDecoder;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Collections;
import java.util.Enumeration;
import java.util.HashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.atomic.AtomicBoolean;

/**
 * Serves the Quant Remote straight off the television.
 *
 * The remote used to be fetched from a public web host and had to reach the
 * phone through a public MQTT broker, which meant a living-room pairing took a
 * round trip through the internet -- and stopped working entirely when the
 * house was offline, which is exactly when someone is most likely to be
 * fiddling with an IPTV box. Both devices are on the same Wi-Fi, so the
 * television can simply be the server: it already holds the web build in its
 * APK, and it is the authority on playback state.
 *
 * The server is deliberately small. It speaks enough HTTP/1.1 to serve the
 * bundled assets and four JSON endpoints, and nothing more: no keep-alive
 * pipelining, no chunked request bodies, no ranges. Anything it does not
 * understand gets a clean 4xx rather than a guess.
 */
public class QuantumLanRemoteServer {
    private static final String TAG = "QuantumLanServer";

    /** First port tried; the next few are used if it is taken. */
    private static final int BASE_PORT = 8099;
    private static final int PORT_ATTEMPTS = 12;

    /** Cap on a request body, so a stray client cannot exhaust the heap. */
    private static final int MAX_BODY_BYTES = 2 * 1024 * 1024;

    /** How long /api/sync holds a request open before answering "nothing yet". */
    private static final long SYNC_HOLD_MS = 25_000L;

    public interface CommandListener {
        /** Called off the UI thread with the raw JSON body of a remote command. */
        void onRemoteCommand(String json);
    }

    private final Context context;
    private final CommandListener listener;
    private final AtomicBoolean running = new AtomicBoolean(false);

    private ServerSocket serverSocket;
    private ExecutorService workers;
    private Thread acceptThread;
    private int port = -1;
    private String secret = "";

    /**
     * Latest value per topic plus a version counter. A remote polls with the
     * version it last saw and gets back only what changed since, so a
     * reconnecting phone does not re-download a 5,000-channel catalogue.
     */
    private final Map<String, String> topics = new HashMap<>();
    private final Map<String, Long> topicVersions = new HashMap<>();
    private long version = 0;
    private final Object topicLock = new Object();

    public QuantumLanRemoteServer(Context context, CommandListener listener) {
        this.context = context.getApplicationContext();
        this.listener = listener;
    }

    /**
     * Binds a port and starts accepting.
     *
     * @param pairingSecret the secret the QR code carries; every API call must
     *                      present it. Static assets are served without it --
     *                      they are the same public web build, and demanding a
     *                      secret for them would only break the browser's
     *                      subresource loads.
     * @return the base URL a phone on the same network should open, or null if
     *         no port could be bound or the device has no usable LAN address.
     */
    public synchronized String start(String pairingSecret) {
        if (running.get()) return baseUrl();
        if (pairingSecret == null || pairingSecret.isEmpty()) {
            Log.w(TAG, "Refusing to start without a pairing secret.");
            return null;
        }
        String lanAddress = findLanAddress();
        if (lanAddress == null) {
            Log.w(TAG, "No LAN address available; remote will fall back to the relay.");
            return null;
        }

        ServerSocket bound = null;
        for (int i = 0; i < PORT_ATTEMPTS; i++) {
            try {
                bound = new ServerSocket(BASE_PORT + i);
                port = BASE_PORT + i;
                break;
            } catch (IOException ignored) {
                // Port in use -- try the next one.
            }
        }
        if (bound == null) {
            Log.w(TAG, "Could not bind any port in " + BASE_PORT + ".." + (BASE_PORT + PORT_ATTEMPTS - 1));
            return null;
        }

        this.secret = pairingSecret;
        this.serverSocket = bound;
        this.workers = Executors.newFixedThreadPool(6);
        running.set(true);

        acceptThread = new Thread(this::acceptLoop, "quantum-lan-accept");
        acceptThread.setDaemon(true);
        acceptThread.start();

        String url = "http://" + lanAddress + ":" + port;
        Log.i(TAG, "Quant Remote is being served at " + url);
        return url;
    }

    public synchronized void stop() {
        if (!running.getAndSet(false)) return;
        try {
            if (serverSocket != null) serverSocket.close();
        } catch (IOException ignored) {
        }
        if (workers != null) workers.shutdownNow();
        synchronized (topicLock) {
            // Release anything parked in /api/sync so its thread can exit.
            topicLock.notifyAll();
        }
        serverSocket = null;
        workers = null;
        port = -1;
    }

    public boolean isRunning() {
        return running.get();
    }

    /** The URL to advertise right now, re-resolving the device's LAN address. */
    public String currentUrl() {
        return baseUrl();
    }

    private String baseUrl() {
        String host = findLanAddress();
        return host == null || port < 0 ? null : "http://" + host + ":" + port;
    }

    /** Publishes the latest value of a topic ("state", "catalog", ...). */
    public void publish(String topic, String json) {
        if (topic == null || json == null) return;
        synchronized (topicLock) {
            version++;
            topics.put(topic, json);
            topicVersions.put(topic, version);
            topicLock.notifyAll();
        }
    }

    // ---------------------------------------------------------------- serving

    private void acceptLoop() {
        while (running.get()) {
            try {
                Socket socket = serverSocket.accept();
                workers.execute(() -> handle(socket));
            } catch (IOException e) {
                if (running.get()) Log.w(TAG, "accept failed: " + e.getMessage());
            } catch (RuntimeException e) {
                // Rejected because the pool is shutting down; nothing to do.
                if (running.get()) Log.w(TAG, "dispatch failed: " + e.getMessage());
            }
        }
    }

    private void handle(Socket socket) {
        try {
            // Long enough to cover a held /api/sync, plus slack.
            socket.setSoTimeout((int) SYNC_HOLD_MS + 15_000);
            PushbackInputStream in = new PushbackInputStream(socket.getInputStream(), 8192);
            OutputStream out = socket.getOutputStream();

            String requestLine = readLine(in);
            if (requestLine == null || requestLine.isEmpty()) return;
            String[] parts = requestLine.split(" ");
            if (parts.length < 2) {
                respond(out, 400, "text/plain", "Bad request".getBytes(StandardCharsets.UTF_8));
                return;
            }
            String method = parts[0];
            String target = parts[1];

            Map<String, String> headers = new HashMap<>();
            String header;
            while ((header = readLine(in)) != null && !header.isEmpty()) {
                int colon = header.indexOf(':');
                if (colon > 0) {
                    headers.put(
                        header.substring(0, colon).trim().toLowerCase(Locale.US),
                        header.substring(colon + 1).trim());
                }
            }

            String path = target;
            String query = "";
            int q = target.indexOf('?');
            if (q >= 0) {
                path = target.substring(0, q);
                query = target.substring(q + 1);
            }

            if ("OPTIONS".equals(method)) {
                respond(out, 204, null, new byte[0]);
                return;
            }

            if (path.startsWith("/api/")) {
                serveApi(method, path, parseQuery(query), in, headers, out);
            } else {
                serveAsset(path, out);
            }
        } catch (IOException e) {
            // Client hung up mid-request; nothing worth logging per-connection.
        } finally {
            try {
                socket.close();
            } catch (IOException ignored) {
            }
        }
    }

    private void serveApi(
        String method,
        String path,
        Map<String, String> params,
        PushbackInputStream in,
        Map<String, String> headers,
        OutputStream out) throws IOException {

        // /api/ping is the one unauthenticated endpoint: the remote page uses it
        // to learn whether it was served by a television at all, which it must
        // decide before it has anywhere to send the secret.
        if ("/api/ping".equals(path)) {
            respondJson(out, 200, "{\"quantum\":true,\"version\":1}");
            return;
        }

        if (!secret.equals(params.get("k"))) {
            respondJson(out, 403, "{\"error\":\"unpaired\"}");
            return;
        }

        switch (path) {
            case "/api/sync": {
                long since = parseLong(params.get("since"), 0);
                respondJson(out, 200, collectChanges(since));
                return;
            }
            case "/api/cmd": {
                if (!"POST".equals(method)) {
                    respondJson(out, 405, "{\"error\":\"method\"}");
                    return;
                }
                String body = readBody(in, headers);
                if (body == null) {
                    respondJson(out, 413, "{\"error\":\"too_large\"}");
                    return;
                }
                if (listener != null) listener.onRemoteCommand(body);
                respondJson(out, 200, "{\"ok\":true}");
                return;
            }
            default:
                respondJson(out, 404, "{\"error\":\"unknown\"}");
        }
    }

    /**
     * Blocks until something changes or the hold expires, then reports every
     * topic newer than {@code since}. Holding the request is what keeps the
     * remote feeling instant without polling the television in a tight loop.
     */
    private String collectChanges(long since) {
        synchronized (topicLock) {
            long deadline = System.currentTimeMillis() + SYNC_HOLD_MS;
            while (running.get() && version <= since) {
                long wait = deadline - System.currentTimeMillis();
                if (wait <= 0) break;
                try {
                    topicLock.wait(wait);
                } catch (InterruptedException e) {
                    Thread.currentThread().interrupt();
                    break;
                }
            }

            StringBuilder sb = new StringBuilder();
            sb.append("{\"version\":").append(version).append(",\"changed\":{");
            boolean first = true;
            for (Map.Entry<String, String> entry : topics.entrySet()) {
                Long v = topicVersions.get(entry.getKey());
                if (v == null || v <= since) continue;
                if (!first) sb.append(',');
                first = false;
                sb.append('"').append(jsonEscape(entry.getKey())).append("\":").append(entry.getValue());
            }
            sb.append("}}");
            return sb.toString();
        }
    }

    private void serveAsset(String path, OutputStream out) throws IOException {
        String rel = "/".equals(path) || path.isEmpty() ? "index.html" : path.substring(1);
        rel = safeDecode(rel);

        // Reject traversal before touching the AssetManager. Assets are packaged
        // read-only, but "public/../../" would still escape into the APK's other
        // directories.
        if (rel.contains("..") || rel.startsWith("/")) {
            respond(out, 400, "text/plain", "Bad path".getBytes(StandardCharsets.UTF_8));
            return;
        }

        AssetManager assets = context.getAssets();
        byte[] body;
        try {
            body = readAsset(assets, "public/" + rel);
        } catch (IOException notFound) {
            // A single-page app owns its routes: unknown paths that are not file
            // requests fall back to the shell so a deep link still loads.
            if (rel.contains(".")) {
                respond(out, 404, "text/plain", "Not found".getBytes(StandardCharsets.UTF_8));
                return;
            }
            try {
                body = readAsset(assets, "public/index.html");
            } catch (IOException e) {
                respond(out, 404, "text/plain", "Not found".getBytes(StandardCharsets.UTF_8));
                return;
            }
        }
        respond(out, 200, mimeFor(rel), body);
    }

    private static byte[] readAsset(AssetManager assets, String name) throws IOException {
        try (InputStream is = assets.open(name)) {
            ByteArrayOutputStream buf = new ByteArrayOutputStream(Math.max(1024, is.available()));
            byte[] chunk = new byte[8192];
            int read;
            while ((read = is.read(chunk)) != -1) buf.write(chunk, 0, read);
            return buf.toByteArray();
        }
    }

    // ------------------------------------------------------------ HTTP basics

    private static String readLine(PushbackInputStream in) throws IOException {
        ByteArrayOutputStream buf = new ByteArrayOutputStream(128);
        int c;
        while ((c = in.read()) != -1) {
            if (c == '\n') break;
            if (c != '\r') buf.write(c);
            if (buf.size() > 8192) throw new IOException("header too long");
        }
        if (c == -1 && buf.size() == 0) return null;
        return buf.toString("UTF-8");
    }

    /** @return the body, or null when it exceeds {@link #MAX_BODY_BYTES}. */
    private static String readBody(PushbackInputStream in, Map<String, String> headers) throws IOException {
        int length = (int) parseLong(headers.get("content-length"), 0);
        if (length <= 0) return "";
        if (length > MAX_BODY_BYTES) return null;
        byte[] body = new byte[length];
        int off = 0;
        while (off < length) {
            int read = in.read(body, off, length - off);
            if (read == -1) break;
            off += read;
        }
        return new String(body, 0, off, StandardCharsets.UTF_8);
    }

    private static void respondJson(OutputStream out, int status, String json) throws IOException {
        respond(out, status, "application/json", json.getBytes(StandardCharsets.UTF_8));
    }

    private static void respond(OutputStream out, int status, String contentType, byte[] body) throws IOException {
        StringBuilder head = new StringBuilder();
        head.append("HTTP/1.1 ").append(status).append(' ').append(statusText(status)).append("\r\n");
        if (contentType != null) head.append("Content-Type: ").append(contentType).append("\r\n");
        head.append("Content-Length: ").append(body.length).append("\r\n");
        // The remote is served from this origin, so CORS is not needed for the
        // normal path. It is allowed anyway so the page still works when a
        // browser has it open from the public build and talks back to the TV.
        head.append("Access-Control-Allow-Origin: *\r\n");
        head.append("Access-Control-Allow-Headers: Content-Type\r\n");
        head.append("Access-Control-Allow-Methods: GET, POST, OPTIONS\r\n");
        head.append("Cache-Control: no-store\r\n");
        head.append("Connection: close\r\n\r\n");
        out.write(head.toString().getBytes(StandardCharsets.UTF_8));
        out.write(body);
        out.flush();
    }

    private static String statusText(int status) {
        switch (status) {
            case 200: return "OK";
            case 204: return "No Content";
            case 400: return "Bad Request";
            case 403: return "Forbidden";
            case 404: return "Not Found";
            case 405: return "Method Not Allowed";
            case 413: return "Payload Too Large";
            default: return "OK";
        }
    }

    private static Map<String, String> parseQuery(String query) {
        Map<String, String> out = new HashMap<>();
        if (query == null || query.isEmpty()) return out;
        for (String pair : query.split("&")) {
            if (pair.isEmpty()) continue;
            int eq = pair.indexOf('=');
            if (eq < 0) out.put(safeDecode(pair), "");
            else out.put(safeDecode(pair.substring(0, eq)), safeDecode(pair.substring(eq + 1)));
        }
        return out;
    }

    private static String safeDecode(String value) {
        try {
            return URLDecoder.decode(value, "UTF-8");
        } catch (Exception e) {
            return value;
        }
    }

    private static long parseLong(String value, long fallback) {
        if (value == null) return fallback;
        try {
            return Long.parseLong(value.trim());
        } catch (NumberFormatException e) {
            return fallback;
        }
    }

    private static String jsonEscape(String value) {
        return value.replace("\\", "\\\\").replace("\"", "\\\"");
    }

    private static String mimeFor(String path) {
        String lower = path.toLowerCase(Locale.US);
        if (lower.endsWith(".html")) return "text/html; charset=utf-8";
        if (lower.endsWith(".js") || lower.endsWith(".mjs")) return "text/javascript; charset=utf-8";
        if (lower.endsWith(".css")) return "text/css; charset=utf-8";
        if (lower.endsWith(".json")) return "application/json";
        if (lower.endsWith(".svg")) return "image/svg+xml";
        if (lower.endsWith(".png")) return "image/png";
        if (lower.endsWith(".jpg") || lower.endsWith(".jpeg")) return "image/jpeg";
        if (lower.endsWith(".webp")) return "image/webp";
        if (lower.endsWith(".gif")) return "image/gif";
        if (lower.endsWith(".ico")) return "image/x-icon";
        if (lower.endsWith(".woff2")) return "font/woff2";
        if (lower.endsWith(".woff")) return "font/woff";
        if (lower.endsWith(".ttf")) return "font/ttf";
        return "application/octet-stream";
    }

    /**
     * Picks the address a phone on the same Wi-Fi can reach.
     *
     * Preferring a site-local IPv4 matters: a television commonly has several
     * interfaces up at once (Ethernet, Wi-Fi, and a dummy or VPN interface), and
     * handing the QR code a link-local or loopback address produces a code that
     * scans fine and then times out.
     */
    static String findLanAddress() {
        List<String> candidates = new ArrayList<>();
        try {
            Enumeration<NetworkInterface> ifaces = NetworkInterface.getNetworkInterfaces();
            if (ifaces == null) return null;
            for (NetworkInterface iface : Collections.list(ifaces)) {
                if (!iface.isUp() || iface.isLoopback()) continue;
                String name = iface.getName() == null ? "" : iface.getName().toLowerCase(Locale.US);
                // Skip tunnels: an address on one is routable for the TV but not
                // reachable from a phone on the same Wi-Fi.
                if (name.startsWith("tun") || name.startsWith("ppp") || name.startsWith("dummy")) continue;
                for (InetAddress addr : Collections.list(iface.getInetAddresses())) {
                    if (!(addr instanceof Inet4Address)) continue;
                    if (addr.isLoopbackAddress() || addr.isLinkLocalAddress()) continue;
                    String host = addr.getHostAddress();
                    if (host == null) continue;
                    if (addr.isSiteLocalAddress()) {
                        // Wi-Fi first when several private addresses are up.
                        if (name.startsWith("wlan") || name.startsWith("wifi")) return host;
                        candidates.add(0, host);
                    } else {
                        candidates.add(host);
                    }
                }
            }
        } catch (Exception e) {
            Log.w(TAG, "Could not enumerate interfaces: " + e.getMessage());
            return null;
        }
        return candidates.isEmpty() ? null : candidates.get(0);
    }
}
