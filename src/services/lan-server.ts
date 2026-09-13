/**
 * Direct television-to-phone remote, with nothing in between.
 *
 * The relayed remote needs a public broker to introduce the two devices,
 * because a web page cannot discover anything on its own network -- no mDNS, no
 * UDP, no listening socket. The native app is not a web page: it can open a
 * port. When it does, the phone fetches the remote UI from the television and
 * talks to it directly, so pairing works with the house offline, latency is a
 * LAN round trip, and no credential or catalogue ever passes through a third
 * party.
 *
 * WebRTC is not involved on this path. Its value is traversing NAT between
 * networks; both devices are on the same one, so plain HTTP is simpler, has no
 * handshake to fail, and needs no signalling channel at all.
 */

export type LanTopicHandler = (topic: string, payload: any) => void;

interface NativeBridge {
  startLanRemoteServer?: (secret: string) => string;
  stopLanRemoteServer?: () => void;
  publishLanTopic?: (topic: string, json: string) => void;
  isLanRemoteServerRunning?: () => boolean;
  getLanRemoteServerUrl?: () => string;
}

function bridge(): NativeBridge | null {
  const native = (window as any).AndroidTvNative;
  return native && typeof native.startLanRemoteServer === 'function' ? native : null;
}

// --------------------------------------------------------------- TV side

let servedUrl: string | null = null;

/**
 * Starts serving the remote from this device.
 *
 * @returns the URL to put in the QR code, or null when this is not the native
 *          app, the device has no LAN address, or no port could be bound.
 */
export function startTvLanServer(pairingSecret: string, onCommand: (cmd: any) => void): string | null {
  const native = bridge();
  if (!native || !native.startLanRemoteServer) return null;

  (window as any).onLanRemoteCommand = (json: string) => {
    try {
      onCommand(JSON.parse(json));
    } catch (e) {
      console.warn('[QuantumLan] Discarded a malformed command from the network.');
    }
  };

  try {
    const url = native.startLanRemoteServer(pairingSecret);
    servedUrl = url && url.length > 0 ? url : null;
    if (servedUrl) {
      console.log(`[QuantumLan] Serving the Quant Remote at ${servedUrl} — no broker needed.`);
    }
    return servedUrl;
  } catch (e) {
    console.warn('[QuantumLan] Could not start the on-device remote server:', e);
    return null;
  }
}

/** The base URL this television is serving the remote on, if any. */
export function getTvLanServerUrl(): string | null {
  const native = bridge();
  if (!native) return null;
  // A server that died (Wi-Fi dropped, activity recreated) must not keep
  // handing out a URL that no longer answers.
  if (native.isLanRemoteServerRunning && !native.isLanRemoteServerRunning()) return null;
  // Ask the device rather than trusting what start() returned: the television
  // keeps the same port across a network change but answers on a new address,
  // and a QR code built from the old one scans fine and then times out.
  if (native.getLanRemoteServerUrl) {
    try {
      const fresh = native.getLanRemoteServerUrl();
      if (fresh) {
        servedUrl = fresh;
        return fresh;
      }
    } catch (e) {
      // Fall through to the value start() gave us.
    }
  }
  return servedUrl;
}

/** Makes the latest value of a topic available to any polling remote. */
export function publishTvLanTopic(topic: string, payload: any): boolean {
  const native = bridge();
  if (!native || !native.publishLanTopic || !getTvLanServerUrl()) return false;
  try {
    native.publishLanTopic(topic, JSON.stringify(payload));
    return true;
  } catch (e) {
    console.warn(`[QuantumLan] Failed to publish "${topic}":`, e);
    return false;
  }
}

// ----------------------------------------------------------- remote side

let clientActive = false;
let clientSecret = '';
let clientStopped = false;

/**
 * True when this page was served by a television rather than the public build.
 *
 * Asked before the secret is sent anywhere: the phone has to know it is talking
 * to a Quant TV before it hands over the pairing secret from its URL.
 */
export async function isServedByTv(): Promise<boolean> {
  // A remote opened from the public web build is on https and cannot be served
  // by a television, so skip the probe rather than trip a mixed-content error.
  if (window.location.protocol !== 'http:') return false;
  try {
    const res = await fetch('/api/ping', { cache: 'no-store', signal: AbortSignal.timeout(3000) });
    if (!res.ok) return false;
    const body = await res.json();
    return body?.quantum === true;
  } catch (e) {
    return false;
  }
}

/** True once the phone is talking to the television directly. */
export function isLanDirectActive(): boolean {
  return clientActive;
}

/**
 * Long-polls the television for state changes.
 *
 * The server holds each request open until something actually changes, so this
 * is a single idle connection rather than a poll loop, and an update reaches
 * the phone as soon as the television produces it.
 */
export function startRemoteLanClient(pairingSecret: string, onTopic: LanTopicHandler): void {
  if (clientActive) return;
  clientActive = true;
  clientStopped = false;
  clientSecret = pairingSecret;

  let since = 0;
  let backoff = 1000;

  const pump = async (): Promise<void> => {
    while (!clientStopped) {
      try {
        const res = await fetch(`/api/sync?since=${since}&k=${encodeURIComponent(clientSecret)}`, {
          cache: 'no-store',
          // Comfortably longer than the server's hold, so a quiet television
          // does not look like a dead one.
          signal: AbortSignal.timeout(45000)
        });
        if (res.status === 403) {
          console.warn('[QuantumLan] The television rejected this remote — re-scan the QR code to pair.');
          clientActive = false;
          return;
        }
        if (!res.ok) throw new Error(`sync ${res.status}`);

        const body = await res.json();
        since = typeof body.version === 'number' ? body.version : since;
        for (const [topic, payload] of Object.entries(body.changed || {})) {
          onTopic(topic, payload);
        }
        backoff = 1000;
      } catch (e) {
        if (clientStopped) return;
        // The television may be asleep or off the network; keep trying, but
        // back off so a phone left on the remote screen does not spin.
        await new Promise(r => setTimeout(r, backoff));
        backoff = Math.min(backoff * 2, 15000);
      }
    }
  };

  void pump();
}

export function stopRemoteLanClient(): void {
  clientStopped = true;
  clientActive = false;
}

/** Posts a command straight to the television. @returns false if it did not land. */
export async function sendLanCommand(cmd: any): Promise<boolean> {
  if (!clientActive) return false;
  try {
    const res = await fetch(`/api/cmd?k=${encodeURIComponent(clientSecret)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(cmd),
      signal: AbortSignal.timeout(6000)
    });
    return res.ok;
  } catch (e) {
    return false;
  }
}
