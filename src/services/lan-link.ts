/**
 * Direct phone-to-TV link over the local network.
 *
 * The companion remote previously relayed every keypress through a public MQTT
 * broker on the open internet. That costs 150-400ms per press, caps payloads
 * (which is why the synced catalogue was truncated to a few hundred rows), and
 * puts the user's provider credentials on a third-party broker in cleartext.
 *
 * This module keeps the broker for *signalling only* — the few packets needed to
 * introduce the two devices — and then moves all traffic onto a WebRTC
 * DataChannel. When both devices sit on the same Wi-Fi the candidate pair that
 * wins is a host-to-host route, so commands never leave the house: typically
 * 2-8ms, no size cap, and no broker involvement at all.
 *
 * MQTT stays hot underneath as a fallback, so a network that blocks peer-to-peer
 * traffic (client isolation on guest Wi-Fi, for instance) degrades to the old
 * behaviour instead of breaking.
 */

export type LanLinkRole = 'tv' | 'remote';
export type LanLinkStatus = 'idle' | 'signalling' | 'connecting' | 'connected' | 'failed';

export interface LanLinkHandlers {
  /** Called with each fully reassembled application message from the peer. */
  onMessage: (data: any) => void;
  onStatusChange?: (status: LanLinkStatus, detail?: string) => void;
  /** Publishes a signalling blob over the broker. */
  publishSignal: (payload: any) => void;
}

interface ChunkEnvelope {
  __q_chunk: { id: string; i: number; n: number };
  d: string;
}

/**
 * SCTP will happily accept larger messages, but several Android WebView builds
 * drop anything much past 64KB without reporting an error. 16KB is the size
 * every implementation agrees on.
 */
const CHUNK_SIZE = 16000;

/**
 * No STUN server is listed first: with an empty ICE server list the browser
 * gathers host candidates only, which is exactly the same-subnet path we want
 * and keeps pairing working with no internet at all. A public STUN server is
 * appended so devices on separate VLANs can still find each other.
 */
const ICE_SERVERS: RTCIceServer[] = [{ urls: 'stun:stun.l.google.com:19302' }];

export class QuantumLanLink {
  private role: LanLinkRole;
  private handlers: LanLinkHandlers;
  private pc: RTCPeerConnection | null = null;
  private channel: RTCDataChannel | null = null;
  private status: LanLinkStatus = 'idle';
  private pendingCandidates: RTCIceCandidateInit[] = [];
  private remoteDescriptionSet = false;
  private chunkBuffers = new Map<string, { parts: string[]; received: number; n: number }>();
  private sessionId = Math.random().toString(36).slice(2, 10);
  private peerSessionId: string | null = null;
  private retryTimer: any = null;
  private retries = 0;

  constructor(role: LanLinkRole, handlers: LanLinkHandlers) {
    this.role = role;
    this.handlers = handlers;
  }

  get connected(): boolean {
    return this.channel?.readyState === 'open';
  }

  get currentStatus(): LanLinkStatus {
    return this.status;
  }

  private setStatus(status: LanLinkStatus, detail?: string): void {
    if (this.status === status) return;
    this.status = status;
    this.handlers.onStatusChange?.(status, detail);
  }

  private supported(): boolean {
    return typeof RTCPeerConnection !== 'undefined';
  }

  /**
   * The remote drives the handshake; the TV stays passive until an offer lands.
   * Having exactly one side initiate avoids the glare condition where two peers
   * both send offers and neither can apply the other's.
   */
  start(): void {
    if (!this.supported()) {
      this.setStatus('failed', 'WebRTC unavailable');
      return;
    }

    // Announce either way. Whichever device starts second would otherwise miss
    // the other's opening move entirely: an offer sent before the TV was
    // listening is simply lost, and nothing would resend it until ICE gave up
    // thirty seconds later.
    this.announce();

    if (this.role === 'remote') {
      this.createOffer().catch(err => {
        console.warn('[QuantumLanLink] Offer failed:', err?.message || err);
        this.scheduleRetry();
      });
    }
  }

  /** Tells any peer already listening that this device is here. */
  announce(): void {
    this.handlers.publishSignal({ kind: 'hello', from: this.sessionId, role: this.role });
  }

  private buildPeerConnection(): RTCPeerConnection {
    const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });

    pc.onicecandidate = event => {
      if (event.candidate) {
        this.handlers.publishSignal({
          kind: 'ice',
          from: this.sessionId,
          role: this.role,
          candidate: event.candidate.toJSON()
        });
      }
    };

    pc.onconnectionstatechange = () => {
      if (pc.connectionState === 'connected') {
        this.setStatus('connected', this.describeRoute());
      } else if (pc.connectionState === 'failed' || pc.connectionState === 'disconnected') {
        this.setStatus('failed', pc.connectionState);
        this.scheduleRetry();
      }
    };

    // The TV never creates a channel of its own; it adopts the remote's.
    pc.ondatachannel = event => this.adoptChannel(event.channel);

    return pc;
  }

  private adoptChannel(channel: RTCDataChannel): void {
    this.channel = channel;
    channel.binaryType = 'arraybuffer';

    channel.onopen = () => {
      this.retries = 0;
      this.setStatus('connected', this.describeRoute());
    };
    channel.onclose = () => {
      this.setStatus('failed', 'channel closed');
      this.scheduleRetry();
    };
    channel.onerror = () => {
      this.setStatus('failed', 'channel error');
    };
    channel.onmessage = event => this.receive(event.data);
  }

  private describeRoute(): string {
    return 'Direct LAN';
  }

  private async createOffer(): Promise<void> {
    this.teardownPeer();
    this.setStatus('signalling');

    const pc = this.buildPeerConnection();
    this.pc = pc;

    // ordered+reliable: command order matters (a volume ramp must not shuffle)
    // and the catalogue transfer cannot tolerate loss.
    this.adoptChannel(pc.createDataChannel('quantum', { ordered: true }));

    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);

    this.handlers.publishSignal({
      kind: 'offer',
      from: this.sessionId,
      role: this.role,
      sdp: pc.localDescription?.sdp
    });
    this.setStatus('connecting');
  }

  /** Feeds one signalling blob received over the broker into the handshake. */
  async handleSignal(payload: any): Promise<void> {
    if (!payload || !payload.kind || !this.supported()) return;
    // Ignore our own echoes — both transports loop messages back to the sender.
    if (payload.from && payload.from === this.sessionId) return;

    try {
      if (payload.kind === 'hello') {
        // A peer just came up. The TV stays passive; the remote re-offers so a
        // TV that started after it still gets a handshake, and so a link that
        // dropped is re-established as soon as the other side reappears.
        if (this.role === 'remote' && payload.role === 'tv' && !this.connected) {
          this.retries = 0;
          await this.createOffer();
        } else if (this.role === 'tv' && payload.role === 'remote') {
          this.announce();
        }
      } else if (payload.kind === 'offer' && this.role === 'tv') {
        await this.acceptOffer(payload);
      } else if (payload.kind === 'answer' && this.role === 'remote') {
        await this.acceptAnswer(payload);
      } else if (payload.kind === 'ice') {
        await this.acceptCandidate(payload);
      }
    } catch (err: any) {
      console.warn('[QuantumLanLink] Signal handling failed:', err?.message || err);
    }
  }

  private async acceptOffer(payload: any): Promise<void> {
    this.teardownPeer();
    this.setStatus('signalling');
    this.peerSessionId = payload.from || null;

    const pc = this.buildPeerConnection();
    this.pc = pc;

    await pc.setRemoteDescription({ type: 'offer', sdp: payload.sdp });
    this.remoteDescriptionSet = true;
    await this.drainPendingCandidates();

    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);

    this.handlers.publishSignal({
      kind: 'answer',
      from: this.sessionId,
      to: payload.from,
      role: this.role,
      sdp: pc.localDescription?.sdp
    });
    this.setStatus('connecting');
  }

  private async acceptAnswer(payload: any): Promise<void> {
    if (!this.pc || this.pc.signalingState !== 'have-local-offer') return;
    this.peerSessionId = payload.from || null;
    await this.pc.setRemoteDescription({ type: 'answer', sdp: payload.sdp });
    this.remoteDescriptionSet = true;
    await this.drainPendingCandidates();
  }

  private async acceptCandidate(payload: any): Promise<void> {
    if (!payload.candidate) return;
    // Candidates routinely arrive before the description they belong to; holding
    // them back rather than dropping them is what makes pairing reliable on
    // slower TV hardware where SDP processing lags the broker round-trip.
    if (!this.pc || !this.remoteDescriptionSet) {
      this.pendingCandidates.push(payload.candidate);
      return;
    }
    await this.pc.addIceCandidate(payload.candidate).catch(() => {});
  }

  private async drainPendingCandidates(): Promise<void> {
    if (!this.pc) return;
    const queued = this.pendingCandidates.splice(0);
    for (const candidate of queued) {
      await this.pc.addIceCandidate(candidate).catch(() => {});
    }
  }

  /** @returns true when the payload went out over the direct link. */
  send(data: any): boolean {
    if (!this.connected || !this.channel) return false;

    try {
      const json = JSON.stringify(data);
      if (json.length <= CHUNK_SIZE) {
        this.channel.send(json);
        return true;
      }

      const id = Math.random().toString(36).slice(2, 10);
      const total = Math.ceil(json.length / CHUNK_SIZE);
      for (let i = 0; i < total; i++) {
        const envelope: ChunkEnvelope = {
          __q_chunk: { id, i, n: total },
          d: json.slice(i * CHUNK_SIZE, (i + 1) * CHUNK_SIZE)
        };
        this.channel.send(JSON.stringify(envelope));
      }
      return true;
    } catch (err: any) {
      console.warn('[QuantumLanLink] Send failed:', err?.message || err);
      return false;
    }
  }

  private receive(raw: any): void {
    let parsed: any;
    try {
      parsed = JSON.parse(typeof raw === 'string' ? raw : new TextDecoder().decode(raw));
    } catch {
      return;
    }

    if (!parsed || !parsed.__q_chunk) {
      this.handlers.onMessage(parsed);
      return;
    }

    const { id, i, n } = parsed.__q_chunk;
    let buffer = this.chunkBuffers.get(id);
    if (!buffer) {
      buffer = { parts: new Array(n).fill(''), received: 0, n };
      this.chunkBuffers.set(id, buffer);
    }
    if (buffer.parts[i] === '') {
      buffer.parts[i] = parsed.d;
      buffer.received++;
    }
    if (buffer.received < buffer.n) return;

    this.chunkBuffers.delete(id);
    try {
      this.handlers.onMessage(JSON.parse(buffer.parts.join('')));
    } catch {
      /* incomplete or corrupt reassembly — drop it */
    }
  }

  /**
   * Backs off on repeated failures so a network that simply cannot carry
   * peer-to-peer traffic does not spin the radio. MQTT keeps working throughout.
   */
  private scheduleRetry(): void {
    if (this.role !== 'remote') return;
    if (this.retryTimer) return;
    if (this.retries >= 5) return;

    const delay = Math.min(30000, 2000 * Math.pow(2, this.retries)) + Math.random() * 750;
    this.retries++;
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      if (this.connected) return;
      this.createOffer().catch(() => this.scheduleRetry());
    }, delay);
  }

  private teardownPeer(): void {
    this.remoteDescriptionSet = false;
    this.pendingCandidates = [];
    this.chunkBuffers.clear();
    try {
      this.channel?.close();
    } catch {
      /* already gone */
    }
    try {
      this.pc?.close();
    } catch {
      /* already gone */
    }
    this.channel = null;
    this.pc = null;
  }

  close(): void {
    if (this.retryTimer) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
    this.teardownPeer();
    this.setStatus('idle');
  }
}
