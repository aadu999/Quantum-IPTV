# Quantum IPTV 🚀

[![Release](https://img.shields.io/badge/Release-v2.2.0-blue.svg)](https://github.com/aadu999/Quantum-IPTV/releases/tag/v2.2.0)
[![Platform](https://img.shields.io/badge/Platform-Android%20TV%20%7C%20Web-green.svg)](https://github.com/aadu999/Quantum-IPTV)
[![Author](https://img.shields.io/badge/Author-Adarsh%20Raveendran-orange.svg)](https://github.com/aadu999)
[![License](https://img.shields.io/badge/License-MIT-lightgrey.svg)](LICENSE)

Next-generation high-performance IPTV & VoD streaming platform meticulously engineered for **Android TV**, smart screens, and modern web environments. Built with zero-FOUT offline styling, intelligent spatial D-pad remote navigation, and native hardware immersion.

---

## 📥 Download APK (Android TV / Mobile)

You can download and install the pre-built beta release directly on your Android TV, Smart TV Box, or Android phone:

* 🚀 **[Direct Download Quantum IPTV v2.2.0 APK](https://raw.githubusercontent.com/aadu999/Quantum-IPTV/feature/android-tv-apk/releases/Quantum-IPTV-v2.2.0.apk)**
* 📦 **[GitHub Releases Download](https://github.com/aadu999/Quantum-IPTV/releases/download/v2.2.0/Quantum-IPTV-v2.2.0.apk)**

> **Tip for Android TV / Fire TV Users**: You can enter the direct download link into the **Downloader** app on your TV, or copy `releases/Quantum-IPTV-v2.2.0.apk` to a USB drive / install via ADB:
> ```bash
> adb install -r Quantum-IPTV-v2.2.0.apk
> ```

> **Signing**: the attached APK is signed with the Android **debug** certificate, because
> no release keystore was configured when it was built. It installs and runs fine by
> sideload, which is how most Android TV boxes take it — but it cannot be published to
> Play, and it should not be treated as a distributable artifact. To produce one, build
> from source with a keystore configured; see **Signing a release build** below.

---

## ✨ Key Features in v2.2.0

## 🧠 Playback Resilience Core

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

### 📡 Quant Remote, served by the television

On the Android app the TV **serves the remote itself**. It opens a port on the local
network, hands the phone the remote interface straight out of the APK, and takes commands
back over plain HTTP — so pairing needs no internet at all, and neither the catalogue nor
the provider credentials ever leave the house.

The QR code encodes the TV's own LAN address together with a pairing secret, re-resolved
each time it is shown so a network change cannot produce a code that scans and then times
out. Every request must present that secret. When this path is available the public broker
and the WebRTC handshake are not started at all.

Where a port cannot be opened — the browser build, or a phone on a different network — the
remote falls back to a **direct WebRTC DataChannel**, with the MQTT broker used only to
introduce the two devices. Signalling is signed with the same pairing secret, so knowing
the room id is not enough to drive someone's television, and stream URLs are stripped of
account credentials before anything is relayed.

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
- **Season and episode browsing**: seasons, per-episode stills, plot, duration and a watched-progress bar, with a labelled placeholder when a provider publishes no still.
- **Resume and autoplay**: every title remembers where it was left off, and finishing an episode rolls into the next one in the season. Resume points are traded directly between paired devices over the local link, so a phone and a TV agree without any account or cloud service.
- **Browsing never disturbs playback**: opening the explorer to look at another season does not change what is on screen, what plays next, or where the current title's position is recorded.
- **Dead channels ranked down**: channels that repeatedly fail to play are badged and sorted to the bottom of their category instead of being presented as working.
- **Failure diagnosis**: when something genuinely cannot play, the app says why — provider rejection, an unpublished episode, an undecodable container — rather than showing a spinner and then nothing. `quantumDiagnostics()` in the console prints a shareable, credential-redacted report.
- **Dedicated Seek Focus**: Video timeline seeking is restricted to intentional seekbar selection, avoiding accidental skipping during channel browsing.

### ⚡ Offline Styling & Zero-FOUT
- **Local Tailwind CSS Engine**: Self-contained offline stylesheet bundle, eliminating the "raw HTML without styles" flash during boot.
- **Bundled icons, MQTT and QR**: Font Awesome, `mqtt` and `qrcode` are compiled into the bundle rather than fetched from a CDN at runtime. Previously, an unreachable CDN left every icon-only player button collapsed to a ~14×10px target and silently disabled the companion remote. The pairing QR is now rendered on-device instead of being requested from a third-party image service.
- **Remaining network dependency**: web fonts still load from Google Fonts. That degrades gracefully to system fonts rather than breaking layout, but it is the one external asset left.
- **Instant Dark Theme**: Hard-coded dark boot palette (`#030712`) and native system splash integration.

### 🌐 Advanced Stream & Playlist Protocols
- **Xtream Codes & M3U8 Integration**: Robust support for M3U playlists and Xtream API authentication.
- **Selective Live Channel Filtering**: Configurable option to filter live channels from Xtream while preserving M3U playlists.
- **CORS & TS Stream Proxying**: Built-in proxy fallback support for stubborn transport streams.
- **Remote pairing**: QR-code pairing to a companion phone remote, served over the LAN by the television itself where possible and relayed only as a fallback.

---

## 🛠️ Metadata & Credits

* **Creator & Lead Developer**: **Adarsh Raveendran**
  * Email: [hello@adarsh.one](mailto:hello@adarsh.one)
  * GitHub: [@aadu999](https://github.com/aadu999)
  * Repository: [https://github.com/aadu999/Quantum-IPTV](https://github.com/aadu999/Quantum-IPTV)
* **Version**: `2.2.0` (Build `3`)
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

# 4. Compile the release APK
cd android
./gradlew assembleRelease

# The generated APK will be at:
# android/app/build/outputs/apk/release/app-release.apk
```

### Signing a release build

Without a keystore the release build is signed with the Android debug certificate and
warns loudly that the result must not be distributed. To produce a publishable APK,
supply a keystore either through the environment:

```bash
export QUANTUM_KEYSTORE_FILE=/secure/path/quantum-release.jks
export QUANTUM_KEYSTORE_PASSWORD=...
export QUANTUM_KEY_ALIAS=...
export QUANTUM_KEY_PASSWORD=...
cd android && ./gradlew assembleRelease
```

or through `android/keystore.properties` (git-ignored, alongside `*.jks` and
`*.keystore`):

```properties
storeFile=/secure/path/quantum-release.jks
storePassword=...
keyAlias=...
keyPassword=...
```

Keep the keystore outside the repository and back it up: Android identifies an app by its
signing certificate, and losing it means no future build can update an existing install.
