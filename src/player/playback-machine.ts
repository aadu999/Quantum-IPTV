import { Channel, PlaybackAttempt } from '../types';

export class QuantumPlaybackMachine {
  public state: string;
  public currentAttempt: PlaybackAttempt | null;
  public attempts: PlaybackAttempt[];

  constructor() {
    this.state = 'IDLE';
    this.currentAttempt = null;
    this.attempts = [];
  }

  transition(newState: string, details: Record<string, any> = {}): void {
    this.state = newState;
    const hudStatus = document.getElementById('hud-engine-status');
    if (hudStatus) hudStatus.textContent = newState;

    if (this.currentAttempt) {
      this.currentAttempt.events.push({ state: newState, time: Date.now(), ...details });
    }
  }

  startAttempt(channel: Channel | null, url: string): void {
    this.currentAttempt = {
      id: 'att_' + Math.random().toString(36).substring(2, 9),
      channelId: channel ? channel.id : 'unknown',
      channelName: channel ? channel.name : 'unknown',
      url: url,
      startedAt: Date.now(),
      events: [],
      outcome: null
    };
    this.transition('RESOLVING');
  }

  endAttempt(outcome: string, reason = ''): void {
    if (!this.currentAttempt) return;
    this.currentAttempt.outcome = outcome;
    this.currentAttempt.reason = reason;
    this.currentAttempt.endedAt = Date.now();
    this.currentAttempt.durationMs = this.currentAttempt.endedAt - this.currentAttempt.startedAt;

    this.attempts.unshift(this.currentAttempt);
    if (this.attempts.length > 50) this.attempts.pop();

    this.currentAttempt = null;
  }
}

export const playbackMachine = new QuantumPlaybackMachine();
(window as any).playbackMachine = playbackMachine;
