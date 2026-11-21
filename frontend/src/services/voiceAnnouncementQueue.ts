import { api } from './api';

export interface AnnouncementItem {
  alertId: string;
  audioUrl: string;
  spokenText: string;
  severity?: string;
  zoneId?: string;
  zoneName?: string;
  occupancy?: number | string;
}

export type QueueStateListener = (state: {
  isEnabled: boolean;
  isMuted: boolean;
  isPlaying: boolean;
  isAutoplayBlocked: boolean;
  currentAnnouncement: AnnouncementItem | null;
  queueLength: number;
}) => void;

class VoiceAnnouncementQueue {
  private queue: AnnouncementItem[] = [];
  private isEnabled: boolean = true;
  private isMuted: boolean = false;
  private isPlaying: boolean = false;
  private isAutoplayBlocked: boolean = false;
  private currentAnnouncement: AnnouncementItem | null = null;
  private currentAudio: HTMLAudioElement | null = null;
  private announcedIds: Set<string> = new Set();
  private listeners: Set<QueueStateListener> = new Set();

  constructor() {
    // Load persisted settings
    try {
      const storedEnabled = localStorage.getItem('cv_voice_enabled');
      if (storedEnabled !== null) {
        this.isEnabled = storedEnabled === 'true';
      }
      const storedMuted = localStorage.getItem('cv_voice_muted');
      if (storedMuted !== null) {
        this.isMuted = storedMuted === 'true';
      }

      // Load session-persisted announced IDs to prevent replay on tab navigation
      const storedIds = sessionStorage.getItem('cv_announced_alerts');
      if (storedIds) {
        const parsed = JSON.parse(storedIds);
        if (Array.isArray(parsed)) {
          this.announcedIds = new Set(parsed);
        }
      }
    } catch {
      // Local storage may be restricted in sandboxed environments
    }
  }

  public subscribe(listener: QueueStateListener): () => void {
    this.listeners.add(listener);
    this.notify();
    return () => {
      this.listeners.delete(listener);
    };
  }

  private notify() {
    const state = {
      isEnabled: this.isEnabled,
      isMuted: this.isMuted,
      isPlaying: this.isPlaying,
      isAutoplayBlocked: this.isAutoplayBlocked,
      currentAnnouncement: this.currentAnnouncement,
      queueLength: this.queue.length,
    };
    this.listeners.forEach((listener) => {
      try {
        listener(state);
      } catch {
        // ignore listener errors
      }
    });
  }

  public setEnabled(enabled: boolean) {
    this.isEnabled = enabled;
    try {
      localStorage.setItem('cv_voice_enabled', String(enabled));
    } catch {
      // ignore
    }
    if (!enabled && this.currentAudio) {
      this.stopCurrent();
    }
    this.notify();
    if (enabled && !this.isPlaying && this.queue.length > 0) {
      this.playNext();
    }
  }

  public setMuted(muted: boolean) {
    this.isMuted = muted;
    try {
      localStorage.setItem('cv_voice_muted', String(muted));
    } catch {
      // ignore
    }
    if (this.currentAudio) {
      this.currentAudio.muted = muted;
    }
    this.notify();
  }

  public toggleEnabled() {
    this.setEnabled(!this.isEnabled);
  }

  public toggleMute() {
    this.setMuted(!this.isMuted);
  }

  public isAlertAnnounced(alertId: string): boolean {
    return this.announcedIds.has(alertId);
  }

  /**
   * Enqueue a newly received alert announcement.
   * Guarantees at-most-once enqueue per unique alertId.
   */
  public enqueue(item: AnnouncementItem): boolean {
    if (!item.alertId || !item.audioUrl) {
      return false;
    }

    // Deduplication check
    if (this.announcedIds.has(item.alertId)) {
      return false;
    }

    // Record as seen immediately to avoid concurrent enqueue
    this.announcedIds.add(item.alertId);
    try {
      sessionStorage.setItem('cv_announced_alerts', JSON.stringify(Array.from(this.announcedIds)));
    } catch {
      // ignore
    }

    this.queue.push(item);
    this.notify();

    if (this.isEnabled && !this.isPlaying) {
      this.playNext();
    }
    return true;
  }

  /**
   * Enqueue a batch of announcements sequentially.
   * Returns the count of successfully enqueued items.
   */
  public enqueueBatch(items: AnnouncementItem[]): number {
    let count = 0;
    for (const item of items) {
      if (this.enqueue(item)) {
        count++;
      }
    }
    return count;
  }

  /**
   * Unlock browser audio permission following operator interaction.
   */
  public async unlockAudio(): Promise<boolean> {
    try {
      // Create a short empty buffer sound or resume AudioContext
      const AudioCtx = window.AudioContext || (window as any).webkitAudioContext;
      if (AudioCtx) {
        const ctx = new AudioCtx();
        if (ctx.state === 'suspended') {
          await ctx.resume();
        }
      }

      this.isAutoplayBlocked = false;
      this.notify();

      if (this.isEnabled && !this.isPlaying && this.queue.length > 0) {
        this.playNext();
      }
      return true;
    } catch {
      return false;
    }
  }

  private playNext() {
    if (!this.isEnabled || this.isPlaying || this.queue.length === 0) {
      return;
    }

    const item = this.queue.shift();
    if (!item) return;

    this.isPlaying = true;
    this.currentAnnouncement = item;
    this.notify();

    const audio = new Audio();
    this.currentAudio = audio;
    audio.src = item.audioUrl;
    audio.muted = this.isMuted;
    audio.preload = 'auto';

    const cleanUp = () => {
      if (this.currentAudio === audio) {
        this.currentAudio = null;
      }
      audio.src = '';
      audio.load();
      this.isPlaying = false;
      this.currentAnnouncement = null;
      this.notify();
    };

    audio.onended = () => {
      cleanUp();
      // Acknowledge backend playback
      api.acknowledgeAlertAnnouncementPlayed(item.alertId).catch(() => {
        // Safe ignore
      });
      // Continue queue
      this.playNext();
    };

    audio.onerror = () => {
      cleanUp();
      // Advance to next without getting stuck
      this.playNext();
    };

    const playPromise = audio.play();
    if (playPromise !== undefined) {
      playPromise.catch((err) => {
        if (err.name === 'NotAllowedError') {
          // Browser autoplay restriction encountered
          this.isAutoplayBlocked = true;
          // Re-queue item at the front
          this.queue.unshift(item);
          cleanUp();
        } else {
          // Other playback failure (network/decode)
          cleanUp();
          this.playNext();
        }
      });
    }
  }

  public stopCurrent() {
    if (this.currentAudio) {
      try {
        this.currentAudio.pause();
        this.currentAudio.src = '';
        this.currentAudio.load();
      } catch {
        // ignore
      }
      this.currentAudio = null;
    }
    this.isPlaying = false;
    this.currentAnnouncement = null;
    this.notify();
  }

  public destroy() {
    this.stopCurrent();
    this.queue = [];
    this.listeners.clear();
  }
}

export const voiceAnnouncementQueue = new VoiceAnnouncementQueue();
