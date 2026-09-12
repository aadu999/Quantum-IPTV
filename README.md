# Quantum IPTV 🚀

[![Release](https://img.shields.io/badge/Release-v2.1.0--beta-blue.svg)](https://github.com/aadu999/Quantum-IPTV/releases/tag/v2.1.0-beta)
[![Platform](https://img.shields.io/badge/Platform-Android%20TV%20%7C%20Web-green.svg)](https://github.com/aadu999/Quantum-IPTV)
[![Author](https://img.shields.io/badge/Author-Adarsh%20Raveendran-orange.svg)](https://github.com/aadu999)
[![License](https://img.shields.io/badge/License-MIT-lightgrey.svg)](LICENSE)

Next-generation high-performance IPTV & VoD streaming platform meticulously engineered for **Android TV**, smart screens, and modern web environments. Built with zero-FOUT offline styling, intelligent spatial D-pad remote navigation, and native hardware immersion.

---

## 📥 Download APK (Android TV / Mobile)

You can download and install the pre-built beta release directly on your Android TV, Smart TV Box, or Android phone:

* 🚀 **[Direct Download Quantum IPTV v2.1.0-beta APK](https://raw.githubusercontent.com/aadu999/Quantum-IPTV/feature/android-tv-apk/releases/Quantum-IPTV-v2.1.0-beta.apk)**
* 📦 **[GitHub Releases Download](https://github.com/aadu999/Quantum-IPTV/releases/download/v2.1.0-beta/Quantum-IPTV-v2.1.0-beta.apk)**

> **Tip for Android TV / Fire TV Users**: You can enter the direct download link into the **Downloader** app on your TV, or copy `releases/Quantum-IPTV-v2.1.0-beta.apk` to a USB drive / install via ADB:
> ```bash
> adb install -r Quantum-IPTV-v2.1.0-beta.apk
> ```

---

## ✨ Key Features in v2.1.0-beta

## 🧠 Playback Resilience Core (unreleased)

The streaming engine is built around a strict observe → diagnose → recover → fail over
pipeline. Each stage is isolated, so diagnosis stays side-effect free and only the
recovery planner is allowed to touch playback.

- **Wall-clock progress detection**: playback health is judged against elapsed real time
  rather than a fixed media-time threshold, so a stream limping along in slow motion is
  caught instead of being reported as healthy.
- **Classified stalls**: MSE buffer gaps, decoder freezes, decoder overload, live-edge
  drift, bandwidth deficit and network starvation are distinguished and treated
  differently. Bandwidth and decoder problems are acted on *while buffer remains*, so the
  correction is invisible.
- **Health-ranked failover ladder**: every source is scored from measured behaviour
  (recent fragment failures, stall seconds, startup latency) and tried in both direct and
  proxied form, with an adaptive startup budget per rung.
- **Startup timeout**: catches the common IPTV failure where the manifest parses, no error
  is ever raised, and no frame ever renders — the case every event-driven recovery path
  waits on forever.
- **Three-state circuit breaker** with exponential cooldown and single-probe recovery,
  per endpoint and per host, persisted so a cold start does not rediscover a dead CDN.
- **Dual-EWMA bandwidth estimator** (conservative min of a fast and slow half-life),
  persisted across sessions and used to seed ABR so the first fragment is chosen from
  evidence rather than a blind default.

### 📡 Quant Remote over the local network

The companion remote negotiates a **direct WebRTC DataChannel** with the TV, using the
MQTT broker only to introduce the two devices. On the same Wi-Fi, commands travel
device-to-device in single-digit milliseconds, the full catalogue syncs without the
broker's payload caps, and provider credentials never touch the public broker. MQTT
remains as an automatic fallback where peer-to-peer traffic is blocked.

The remote also gains language, group and sort filters built from the live catalogue,
plus a favourites-only toggle.

### 🗓️ Real XMLTV guide

Programme start/stop times are parsed into a per-channel index with now/next, a live
progress bar and time remaining. Channels are matched to guide entries by `tvg-id` and
normalised display name.

---

### 📺 Immersive Android TV Experience
- **Auto Fullscreen & Malayalam Startup**: Automatically boots directly into full-screen Live TV on the **Malayalam** language category without requiring manual mouse or keyboard interaction.
- **Quantum Loading Animation**: Replaced blank placeholder images with a dynamic cybernetic particle spinner and pulse rings while streams buffer.
- **True Remote Navigation**: Fine-tuned spatial navigation engineered specifically for TV remotes:
  - **No Accidental Keyboard Triggers**: Search input ignores vertical D-pad navigation; the software keyboard opens only when pressing **OK / Center**.
  - **Single-Item Stepping**: Accurate one-by-one vertical scrolling through channel lists.
  - **D-Pad Right for Favorites**: Pressing **Right Arrow** on any highlighted channel smoothly toggles its favorite status.
  - **Native Volume & Mute**: Preserves TV system mute and hardware audio levels, preventing conflicting software mutes.

### 🎬 Intelligent VoD & Series Interface
- **Balanced Dialog Sizing**: Proportionate modal info dialogs for Movies & TV Series with responsive sizing that won't overwhelm TV screens.
- **Episode Switching & Metadata**: Dynamic series episodes info and fast switching between titles.
- **Dedicated Seek Focus**: Video timeline seeking is restricted to intentional seekbar selection, avoiding accidental skipping during channel browsing.

### ⚡ Offline Styling & Zero-FOUT
- **Local Tailwind CSS Engine**: Fully self-contained 48KB offline stylesheet bundle. No external CDN script dependencies, eliminating the "raw HTML without styles" flash during boot.
- **Instant Dark Theme**: Hard-coded dark boot palette (`#030712`) and native system splash integration.

### 🌐 Advanced Stream & Playlist Protocols
- **Xtream Codes & M3U8 Integration**: Robust support for M3U playlists and Xtream API authentication.
- **Selective Live Channel Filtering**: Configurable option to filter live channels from Xtream while preserving M3U playlists.
- **CORS & TS Stream Proxying**: Built-in proxy fallback support for stubborn transport streams.
- **IoT Remote Pairing**: Real-time companion mobile remote control powered by MQTT and QR-code pairing.

---

## 🛠️ Metadata & Credits

* **Creator & Lead Developer**: **Adarsh Raveendran**
  * Email: [hello@adarsh.one](mailto:hello@adarsh.one)
  * GitHub: [@aadu999](https://github.com/aadu999)
  * Repository: [https://github.com/aadu999/Quantum-IPTV](https://github.com/aadu999/Quantum-IPTV)
* **Version**: `2.1.0-beta` (Build `2`)
* **Framework**: Capacitor 8 + Vite + TypeScript + Tailwind CSS

---

## 🏗️ Building From Source

### Prerequisites
- Node.js (v18+)
- Android Studio with Android SDK 34 / 35 and Java 17+
- Capacitor CLI

### Steps
```bash
# 1. Clone the repository
git clone git@github.com:aadu999/Quantum-IPTV.git
cd Quantum-IPTV

# 2. Install dependencies
npm install

# 3. Build web bundle and synchronize Capacitor Android project
npm run build
npx cap sync android

# 4. Compile Signed Release APK
cd android
./gradlew assembleRelease

# The generated APK will be at:
# android/app/build/outputs/apk/release/app-release.apk
```
