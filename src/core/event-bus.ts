export type QuantumEventType =
  | 'APP_STARTED'
  | 'PLAY_INTENT'
  | 'SOURCE_SELECTED'
  | 'MANIFEST_REQUEST'
  | 'MANIFEST_PARSED'
  | 'FRAG_REQUEST'
  | 'FRAG_LOADED'
  | 'FIRST_FRAME'
  | 'BUFFER_SNAPSHOT'
  | 'BUFFER_LOW'
  | 'STALL_DETECTED'
  | 'STALL_CLASSIFIED'
  | 'RECOVERY_PLANNED'
  | 'RECOVERY_EXECUTED'
  | 'SOURCE_SWITCHED'
  | 'PLAYBACK_ENDED'
  | 'NETWORK_CHANGE'
  | 'HEALTH_UPDATE';

export interface QuantumEvent<T = any> {
  id: string;
  type: QuantumEventType;
  timestamp: number;
  sessionId?: string;
  contentId?: string;
  sourceId?: string;
  data: T;
}

export type QuantumEventListener<T = any> = (event: QuantumEvent<T>) => void;

export class QuantumEventBus {
  private listeners: Map<QuantumEventType | '*', Set<QuantumEventListener>> = new Map();
  private ringBuffer: QuantumEvent[] = [];
  private maxRingBufferSize = 1000;
  private eventCounter = 0;

  constructor(maxHistory = 1000) {
    this.maxRingBufferSize = maxHistory;
  }

  emit<T = any>(
    type: QuantumEventType,
    data: T,
    meta: { sessionId?: string; contentId?: string; sourceId?: string } = {}
  ): QuantumEvent<T> {
    const event: QuantumEvent<T> = {
      id: `ev_${++this.eventCounter}_${Date.now().toString(36)}`,
      type,
      timestamp: Date.now(),
      sessionId: meta.sessionId,
      contentId: meta.contentId,
      sourceId: meta.sourceId,
      data
    };

    // Maintain in-memory circular ring buffer for forensic incident replay
    this.ringBuffer.push(event);
    if (this.ringBuffer.length > this.maxRingBufferSize) {
      this.ringBuffer.shift();
    }

    // Notify specific type listeners
    const specificListeners = this.listeners.get(type);
    if (specificListeners) {
      for (const listener of specificListeners) {
        try {
          listener(event);
        } catch (err) {
          console.error(`[QuantumEventBus] Error in listener for ${type}:`, err);
        }
      }
    }

    // Notify wildcard '*' listeners
    const wildcardListeners = this.listeners.get('*');
    if (wildcardListeners) {
      for (const listener of wildcardListeners) {
        try {
          listener(event);
        } catch (err) {
          console.error(`[QuantumEventBus] Error in wildcard listener:`, err);
        }
      }
    }

    return event;
  }

  on<T = any>(type: QuantumEventType | '*', listener: QuantumEventListener<T>): () => void {
    if (!this.listeners.has(type)) {
      this.listeners.set(type, new Set());
    }
    this.listeners.get(type)!.add(listener as QuantumEventListener);

    return () => this.off(type, listener);
  }

  off<T = any>(type: QuantumEventType | '*', listener: QuantumEventListener<T>): void {
    const set = this.listeners.get(type);
    if (set) {
      set.delete(listener as QuantumEventListener);
      if (set.size === 0) {
        this.listeners.delete(type);
      }
    }
  }

  getRecentEvents(limit = 50): QuantumEvent[] {
    return this.ringBuffer.slice(-limit);
  }

  getIncidentReplay(sessionId?: string, maxEvents = 100): QuantumEvent[] {
    let events = this.ringBuffer;
    if (sessionId) {
      events = events.filter(e => e.sessionId === sessionId);
    }
    return events.slice(-maxEvents);
  }

  formatIncidentTimeline(sessionId?: string): string {
    const events = this.getIncidentReplay(sessionId);
    if (events.length === 0) return 'No events recorded.';

    const startTime = events[0].timestamp;
    return events
      .map(e => {
        const offset = (e.timestamp - startTime).toFixed(0).padStart(6, ' ') + 'ms';
        const payload = e.data ? JSON.stringify(e.data) : '';
        return `[+${offset}] ${e.type} (session: ${e.sessionId || 'N/A'}) ${payload}`;
      })
      .join('\n');
  }

  clearHistory(): void {
    this.ringBuffer = [];
  }
}

export const eventBus = new QuantumEventBus();
if (typeof window !== 'undefined') {
  (window as any).QuantumEventBus = eventBus;
}
