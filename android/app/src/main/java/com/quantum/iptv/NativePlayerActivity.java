package com.quantum.iptv;

import android.app.Activity;
import android.content.Intent;
import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.util.Log;
import android.view.KeyEvent;
import android.view.View;
import android.widget.ImageView;
import android.widget.TextView;

import androidx.media3.common.MediaItem;
import androidx.media3.common.PlaybackException;
import androidx.media3.common.Player;
import androidx.media3.exoplayer.ExoPlayer;
import androidx.media3.ui.PlayerView;

import java.io.IOException;
import java.io.InputStream;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

import okhttp3.OkHttpClient;
import okhttp3.Request;
import okhttp3.Response;

/**
 * Fullscreen native playback for on-demand titles the WebView's &lt;video&gt;
 * element cannot decode -- chiefly Matroska (.mkv), which Chromium never demuxes
 * however good the codec inside is. ExoPlayer's MatroskaExtractor handles the
 * container natively and decodes through the same hardware MediaCodec path as
 * everything else, so a title that showed "cannot play" in the WebView plays
 * normally here.
 *
 * A separate Activity rather than a view layered into MainActivity's WebView:
 * that WebView has no existing SurfaceView/TextureView compositing, and hybrid
 * WebView+native-video overlays are fragile across devices (z-order, hardware
 * layer compositing, transparency). A dedicated Activity gets pause/resume,
 * back navigation and screen composition from the platform for free, and
 * mirrors the existing openInExternalPlayer handoff in MainActivity -- just
 * in-process instead of to another app.
 */
public class NativePlayerActivity extends Activity {

    private static final String TAG = "NativePlayerActivity";

    public static final String EXTRA_URL = "url";
    public static final String EXTRA_TITLE = "title";
    public static final String EXTRA_START_POSITION_SEC = "startPositionSec";
    public static final String EXTRA_EPISODE_ID = "episodeId";
    public static final String EXTRA_THUMB_URL = "thumbUrl";

    /** Extras on both the periodic progress broadcast and the final Activity result. */
    public static final String RESULT_EXTRA_EPISODE_ID = "episodeId";
    public static final String RESULT_EXTRA_POSITION_SEC = "positionSec";
    public static final String RESULT_EXTRA_DURATION_SEC = "durationSec";
    /** Final-result-only extras. */
    public static final String RESULT_EXTRA_COMPLETED = "completed";
    public static final String RESULT_EXTRA_ERROR = "error";

    /**
     * Broadcast so MainActivity can forward progress into JS while this activity
     * owns the screen. Resume points must not go stale just because the viewer
     * never presses back -- the TV can lose power, or the OS can kill the app,
     * before this activity gets a chance to report a final result.
     */
    public static final String ACTION_PROGRESS = "com.quantum.iptv.NATIVE_PLAYER_PROGRESS";

    /** Matches the throttle ui/controls.ts already applies to resume writes. */
    private static final long PROGRESS_INTERVAL_MS = 5000;

    private ExoPlayer player;
    private String episodeId;
    private boolean finished = false;
    private final ExecutorService thumbExecutor = Executors.newSingleThreadExecutor();

    private final Handler progressHandler = new Handler(Looper.getMainLooper());
    private final Runnable progressTick = new Runnable() {
        @Override
        public void run() {
            reportProgress();
            progressHandler.postDelayed(this, PROGRESS_INTERVAL_MS);
        }
    };

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        applyImmersiveFullscreen();
        setContentView(R.layout.activity_native_player);
        overridePendingTransition(android.R.anim.fade_in, android.R.anim.fade_out);

        String url = getIntent().getStringExtra(EXTRA_URL);
        String title = getIntent().getStringExtra(EXTRA_TITLE);
        String thumbUrl = getIntent().getStringExtra(EXTRA_THUMB_URL);
        double startPositionSec = getIntent().getDoubleExtra(EXTRA_START_POSITION_SEC, 0);
        episodeId = getIntent().getStringExtra(EXTRA_EPISODE_ID);

        View loadingOverlay = findViewById(R.id.native_player_loading);
        TextView loadingTitle = findViewById(R.id.native_player_loading_title);
        if (loadingTitle != null) loadingTitle.setText(title == null || title.isEmpty() ? "Loading…" : title);
        loadThumbnail(thumbUrl);

        if (url == null || url.isEmpty()) {
            finishWithError("No URL provided");
            return;
        }

        PlayerView playerView = findViewById(R.id.native_player_view);
        player = new ExoPlayer.Builder(this).build();
        playerView.setPlayer(player);

        // Deferred rather than issued before prepare(): a seek requested before the
        // extractor has read anything turns into a Range request at an arbitrary
        // byte offset with no confirmation the origin honours it. Several Xtream
        // panels only accept a plain sequential request starting at byte 0 -- from
        // this token, a request for anywhere else comes back 403 -- and reject
        // that offset outright. That is exactly what "plays episode 1 but nothing
        // else" turned out to be: every other episode already had a resume point
        // above zero from earlier viewing, so its very first request was the one
        // the origin refused. Waiting for STATE_READY means the initial request is
        // always the same plain sequential one episode 1 relied on; the seek then
        // lands on data ExoPlayer already has an index for.
        final boolean[] pendingSeekApplied = {false};

        player.addListener(new Player.Listener() {
            @Override
            public void onPlayerError(PlaybackException error) {
                Log.w(TAG, "onPlayerError code=" + error.errorCode + " " + error.getMessage(), error);
                finishWithError(error.getMessage() != null ? error.getMessage() : "Playback error");
            }

            @Override
            public void onPlaybackStateChanged(int playbackState) {
                Log.d(TAG, "onPlaybackStateChanged " + playbackState
                    + " pos=" + player.getCurrentPosition() + " dur=" + player.getDuration());
                if (playbackState == Player.STATE_READY && !pendingSeekApplied[0]) {
                    pendingSeekApplied[0] = true;
                    if (startPositionSec > 0) {
                        player.seekTo((long) (startPositionSec * 1000));
                    }
                }
                if (playbackState == Player.STATE_ENDED) {
                    finishWithResult(true);
                }
            }

            // The loading overlay hides here rather than on STATE_READY: ready
            // fires as soon as the player has buffered enough to play, which on
            // a slow connection can be well before a frame is actually visible
            // -- leaving a flash of solid black between the overlay disappearing
            // and video appearing. Waiting for the first rendered frame instead
            // means the overlay is *replaced by* the video, never followed by
            // a gap.
            @Override
            public void onRenderedFirstFrame() {
                if (loadingOverlay != null) loadingOverlay.setVisibility(View.GONE);
            }
        });

        player.setMediaItem(MediaItem.fromUri(url));
        player.prepare();
        player.setPlayWhenReady(true);

        progressHandler.postDelayed(progressTick, PROGRESS_INTERVAL_MS);
    }

    /**
     * Shows the same poster the episode/movie card used in the web UI, so the
     * loading screen reads as "this title" rather than a generic app splash.
     * No image library in this project yet, so this is a plain background
     * fetch + decode over the OkHttp client already used elsewhere -- pulling
     * in Glide/Coil for one thumbnail would be a lot of weight for very
     * little.
     */
    private void loadThumbnail(String thumbUrl) {
        if (thumbUrl == null || thumbUrl.isEmpty()) return;
        ImageView thumbView = findViewById(R.id.native_player_loading_thumb);
        ImageView iconView = findViewById(R.id.native_player_loading_icon);
        if (thumbView == null) return;

        thumbExecutor.execute(() -> {
            Bitmap bitmap = null;
            OkHttpClient client = new OkHttpClient.Builder().build();
            Request request = new Request.Builder().url(thumbUrl).build();
            try (Response response = client.newCall(request).execute()) {
                if (response.isSuccessful() && response.body() != null) {
                    try (InputStream stream = response.body().byteStream()) {
                        bitmap = BitmapFactory.decodeStream(stream);
                    }
                }
            } catch (IOException ignored) {
                // No poster is not worth surfacing; the icon stays as the fallback.
            }
            Bitmap finalBitmap = bitmap;
            if (finalBitmap != null) {
                progressHandler.post(() -> {
                    if (finished) return;
                    thumbView.setImageBitmap(finalBitmap);
                    thumbView.setVisibility(View.VISIBLE);
                    if (iconView != null) iconView.setVisibility(View.GONE);
                });
            }
        });
    }

    private void applyImmersiveFullscreen() {
        getWindow().getDecorView().setSystemUiVisibility(
            View.SYSTEM_UI_FLAG_LAYOUT_STABLE
            | View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION
            | View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN
            | View.SYSTEM_UI_FLAG_HIDE_NAVIGATION
            | View.SYSTEM_UI_FLAG_FULLSCREEN
            | View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY
        );
    }

    @Override
    public void onWindowFocusChanged(boolean hasFocus) {
        super.onWindowFocusChanged(hasFocus);
        Log.d(TAG, "onWindowFocusChanged hasFocus=" + hasFocus);
        if (hasFocus) applyImmersiveFullscreen();
    }

    @Override
    protected void onPause() {
        Log.d(TAG, "onPause isFinishing=" + isFinishing());
        super.onPause();
    }

    @Override
    protected void onStop() {
        Log.d(TAG, "onStop isFinishing=" + isFinishing());
        super.onStop();
    }

    @Override
    public boolean dispatchKeyEvent(KeyEvent event) {
        Log.d(TAG, "dispatchKeyEvent keyCode=" + event.getKeyCode() + " action=" + event.getAction());
        return super.dispatchKeyEvent(event);
    }

    private void reportProgress() {
        if (player == null) return;
        long durMs = player.getDuration();
        // C.TIME_UNSET before the player has metadata; a position report with no
        // duration is not useful to the resume-tracking it feeds.
        if (durMs <= 0) return;
        Intent progress = new Intent(ACTION_PROGRESS);
        progress.setPackage(getPackageName());
        progress.putExtra(RESULT_EXTRA_EPISODE_ID, episodeId);
        progress.putExtra(RESULT_EXTRA_POSITION_SEC, player.getCurrentPosition() / 1000.0);
        progress.putExtra(RESULT_EXTRA_DURATION_SEC, durMs / 1000.0);
        sendBroadcast(progress);
    }

    private void finishWithResult(boolean completed) {
        Log.d(TAG, "finishWithResult completed=" + completed, new Throwable("trace"));
        if (finished) return;
        finished = true;
        long posMs = player != null ? player.getCurrentPosition() : 0;
        long durMs = player != null ? player.getDuration() : 0;
        Intent result = new Intent();
        result.putExtra(RESULT_EXTRA_EPISODE_ID, episodeId);
        result.putExtra(RESULT_EXTRA_POSITION_SEC, posMs / 1000.0);
        result.putExtra(RESULT_EXTRA_DURATION_SEC, durMs > 0 ? durMs / 1000.0 : 0.0);
        result.putExtra(RESULT_EXTRA_COMPLETED, completed);
        setResult(Activity.RESULT_OK, result);
        finish();
        overridePendingTransition(android.R.anim.fade_in, android.R.anim.fade_out);
    }

    private void finishWithError(String message) {
        Log.d(TAG, "finishWithError message=" + message, new Throwable("trace"));
        if (finished) return;
        finished = true;
        Intent result = new Intent();
        result.putExtra(RESULT_EXTRA_EPISODE_ID, episodeId);
        result.putExtra(RESULT_EXTRA_COMPLETED, false);
        result.putExtra(RESULT_EXTRA_ERROR, message);
        setResult(Activity.RESULT_OK, result);
        finish();
        overridePendingTransition(android.R.anim.fade_in, android.R.anim.fade_out);
    }

    @Override
    public void onBackPressed() {
        Log.d(TAG, "onBackPressed");
        finishWithResult(false);
    }

    @Override
    protected void onDestroy() {
        Log.d(TAG, "onDestroy isFinishing=" + isFinishing());
        progressHandler.removeCallbacks(progressTick);
        thumbExecutor.shutdownNow();
        if (player != null) {
            player.release();
            player = null;
        }
        super.onDestroy();
    }
}
