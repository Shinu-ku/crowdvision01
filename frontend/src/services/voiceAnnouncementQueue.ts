/**
 * Global Single Voice Playback Authority for CrowdVision.
 *
 * Guarantees:
 * 1. MAX_CONCURRENT_ACTIVE_PLAYBACKS === 1 across the entire application.
 * 2. Strict serialization of all alert announcements (one at a time, waiting for audio.ended).
 * 3. Cross-tab exclusive playback locking via Web Locks API (navigator.locks) and BroadcastChannel sync.
 * 4. Comprehensive alert lifecycle tracking (received, aggregation, pending playback, currently playing, completed).
 * 5. Robust at-most-once playback deduplication (no duplicates on reconnect, refresh, or multiple events).
 * 6. Browser autoplay unlock compliance with fail-safe error recovery.
 */

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
  activePlaybackCount: number;
}) => void;

interface CrossTabMessage {
  type: 'ALERT_CLAIMED' | 'ALERT_COMPLETED' | 'STATE_SYNC';
  alertId?: string;
  tabId: string;
  timestamp: number;
}

export class SingleVoicePlaybackManager {
  private queue: AnnouncementItem[] = [];
  private isEnabled: boolean = true;
  private isMuted: boolean = false;
  private isAutoplayBlocked: boolean = false;
  private currentAnnouncement: AnnouncementItem | null = null;
  private sharedAudio: HTMLAudioElement | null = null;

  // Single-consumer atomic processing lock
  private isProcessingQueue: boolean = false;
  // Instrumented active playback counter: strictly 0 or 1
  private activePlaybackCount: number = 0;

  // Unique tab identifier for cross-tab leader coordination
  private tabId: string = Math.random().toString(36).substring(2) + '_' + Date.now();
  private channel: BroadcastChannel | null = null;

  // Lifecycle stage tracking (Phase 7)
  private receivedAlertIds: Set<string> = new Set();
  private pendingPlaybackIds: Set<string> = new Set();
  private currentlyPlayingAlertId: string | null = null;
  private completedAlertIds: Set<string> = new Set();

  private listeners: Set<QueueStateListener> = new Set();

  constructor() {
    this.initStorageAndState();
    this.initCrossTabChannel();
  }

  private initStorageAndState(): void {
    try {
      if (typeof localStorage !== 'undefined') {
        const storedEnabled = localStorage.getItem('cv_voice_enabled');
        if (storedEnabled !== null) {
          this.isEnabled = storedEnabled === 'true';
        }
        const storedMuted = localStorage.getItem('cv_voice_muted');
        if (storedMuted !== null) {
          this.isMuted = storedMuted === 'true';
        }

        // Load globally persisted completed alert IDs
        const storedCompleted = localStorage.getItem('cv_announced_alerts');
        if (storedCompleted) {
          const parsed = JSON.parse(storedCompleted);
          if (Array.isArray(parsed)) {
            this.completedAlertIds = new Set(parsed);
          }
        }
      }
    } catch {
      // Storage restricted or unavailable in sandboxed environment
    }
  }

  private initCrossTabChannel(): void {
    try {
      if (typeof BroadcastChannel !== 'undefined') {
        this.channel = new BroadcastChannel('crowdvision_audio_authority');
        this.channel.onmessage = (event: MessageEvent<CrossTabMessage>) => {
          this.handleCrossTabMessage(event.data);
        };
      }
    } catch {
      // BroadcastChannel unsupported in current environment
    }
  }

  private handleCrossTabMessage(msg: CrossTabMessage): void {
    if (!msg || msg.tabId === this.tabId) return;

    if (msg.type === 'ALERT_CLAIMED' && msg.alertId) {
      // Another tab has acquired the playback lock for this alert
      this.pendingPlaybackIds.delete(msg.alertId);
      this.completedAlertIds.add(msg.alertId);
      // Remove from this tab's local queue if it was pending
      this.queue = this.queue.filter((q) => q.alertId !== msg.alertId);
      this.notify();
    } else if (msg.type === 'ALERT_COMPLETED' && msg.alertId) {
      // Another tab finished playing this alert
      this.completedAlertIds.add(msg.alertId);
      this.pendingPlaybackIds.delete(msg.alertId);
      this.queue = this.queue.filter((q) => q.alertId !== msg.alertId);
      this.notify();
    }
  }

  private broadcast(type: CrossTabMessage['type'], alertId?: string): void {
    if (this.channel) {
      try {
        this.channel.postMessage({
          type,
          alertId,
          tabId: this.tabId,
          timestamp: Date.now(),
        });
      } catch {
        // Safe ignore
      }
    }
  }

  public subscribe(listener: QueueStateListener): () => void {
    this.listeners.add(listener);
    this.notify();
    return () => {
      this.listeners.delete(listener);
    };
  }

  private notify(): void {
    const state = {
      isEnabled: this.isEnabled,
      isMuted: this.isMuted,
      isPlaying: this.activePlaybackCount > 0,
      isAutoplayBlocked: this.isAutoplayBlocked,
      currentAnnouncement: this.currentAnnouncement,
      queueLength: this.queue.length,
      activePlaybackCount: this.activePlaybackCount,
    };
    this.listeners.forEach((listener) => {
      try {
        listener(state);
      } catch {
        // ignore
      }
    });
  }

  public getActivePlaybackCount(): number {
    return this.activePlaybackCount;
  }

  public getCurrentlyPlayingAlertId(): string | null {
    return this.currentlyPlayingAlertId;
  }

  public isAlertAnnounced(alertId: string): boolean {
    return (
      this.completedAlertIds.has(alertId) ||
      this.currentlyPlayingAlertId === alertId ||
      this.pendingPlaybackIds.has(alertId)
    );
  }

  public isAlertCompleted(alertId: string): boolean {
    return this.completedAlertIds.has(alertId);
  }

  public setEnabled(enabled: boolean): void {
    this.isEnabled = enabled;
    try {
      if (typeof localStorage !== 'undefined') {
        localStorage.setItem('cv_voice_enabled', String(enabled));
      }
    } catch {
      // ignore
    }
    if (!enabled) {
      this.stopCurrent();
    }
    this.notify();
    if (enabled && this.activePlaybackCount === 0 && this.queue.length > 0) {
      this.scheduleQueueProcessing();
    }
  }

  public setMuted(muted: boolean): void {
    this.isMuted = muted;
    try {
      if (typeof localStorage !== 'undefined') {
        localStorage.setItem('cv_voice_muted', String(muted));
      }
    } catch {
      // ignore
    }
    if (this.sharedAudio) {
      this.sharedAudio.muted = muted;
    }
    this.notify();
  }

  public toggleEnabled(): void {
    this.setEnabled(!this.isEnabled);
  }

  public toggleMute(): void {
    this.setMuted(!this.isMuted);
  }

  /**
   * Enqueue a validated alert for spoken playback.
   * Enforces at-most-once deduplication across all stages and tabs.
   */
  public enqueue(item: AnnouncementItem): boolean {
    if (!item || !item.alertId || !item.audioUrl) {
      return false;
    }

    // Deduplication check: drop if completed, currently playing, or already in pending playback
    if (this.isAlertAnnounced(item.alertId)) {
      return false;
    }

    this.receivedAlertIds.add(item.alertId);
    this.pendingPlaybackIds.add(item.alertId);
    this.queue.push(item);
    this.notify();

    if (this.isEnabled && this.activePlaybackCount === 0) {
      this.scheduleQueueProcessing();
    }
    return true;
  }

  /**
   * Enqueue a batch of announcements sequentially.
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
      const AudioCtx =
        (window as any).AudioContext || (window as any).webkitAudioContext;
      if (AudioCtx) {
        const ctx = new AudioCtx();
        if (ctx.state === 'suspended') {
          await ctx.resume();
        }
      }

      this.isAutoplayBlocked = false;
      this.notify();

      if (this.isEnabled && this.activePlaybackCount === 0 && this.queue.length > 0) {
        this.scheduleQueueProcessing();
      }
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Schedule queue processing through the single-consumer lock.
   */
  private scheduleQueueProcessing(): void {
    if (this.isProcessingQueue || this.activePlaybackCount > 0 || !this.isEnabled) {
      return;
    }
    this.processQueue();
  }

  /**
   * Centralized single-consumer processing loop.
   * Acquires cross-tab Web Lock before speaking each announcement.
   */
  private async processQueue(): Promise<void> {
    if (this.isProcessingQueue || this.activePlaybackCount > 0 || !this.isEnabled) {
      return;
    }

    this.isProcessingQueue = true;

    while (this.isEnabled && this.queue.length > 0 && this.activePlaybackCount === 0) {
      const item = this.queue.shift();
      if (!item) break;

      // Verify the item was not announced by another tab while queued
      if (this.completedAlertIds.has(item.alertId)) {
        this.pendingPlaybackIds.delete(item.alertId);
        continue;
      }

      // Cross-tab coordination: use Web Locks API if available
      if (typeof navigator !== 'undefined' && navigator.locks && navigator.locks.request) {
        let lockAcquired = false;
        try {
          await navigator.locks.request(
            'crowdvision_single_voice_authority',
            { mode: 'exclusive' },
            async () => {
              lockAcquired = true;
              // Check again inside the lock
              if (this.completedAlertIds.has(item.alertId)) {
                this.pendingPlaybackIds.delete(item.alertId);
                return;
              }
              await this.playSingleAnnouncement(item);
            }
          );
        } catch {
          // If lock request fails, fallback to local single playback
          if (!lockAcquired) {
            await this.playSingleAnnouncement(item);
          }
        }
      } else {
        // Fallback for environments without navigator.locks (e.g. Node tests)
        await this.playSingleAnnouncement(item);
      }
    }

    this.isProcessingQueue = false;
  }

  /**
   * Authoritative audio playback execution for exactly ONE alert.
   * Holds activePlaybackCount === 1 for the entire duration until audio.ended.
   */
  private playSingleAnnouncement(item: AnnouncementItem): Promise<void> {
    return new Promise<void>((resolve) => {
      // Invariant check: never allow > 1 concurrent playback
      if (this.activePlaybackCount > 0) {
        // Re-queue at head to prevent loss and abort duplicate
        this.queue.unshift(item);
        resolve();
        return;
      }

      this.activePlaybackCount = 1;
      this.currentlyPlayingAlertId = item.alertId;
      this.pendingPlaybackIds.delete(item.alertId);
      this.currentAnnouncement = item;

      // Broadcast to other tabs that this alert is actively claimed
      this.broadcast('ALERT_CLAIMED', item.alertId);
      this.notify();

      // Use or create the single authoritative audio element
      let audio = this.sharedAudio;
      if (!audio && typeof Audio !== 'undefined') {
        audio = new Audio();
        this.sharedAudio = audio;
      }

      if (!audio) {
        // Environment without Audio (headless/test mock fallback)
        this.finishPlayback(item);
        resolve();
        return;
      }

      audio.src = item.audioUrl;
      audio.muted = this.isMuted;
      audio.preload = 'auto';

      let isFinished = false;

      const finishOnce = () => {
        if (isFinished) return;
        isFinished = true;
        audio.onended = null;
        audio.onerror = null;
        this.finishPlayback(item);
        resolve();
      };

      audio.onended = () => {
        // Report backend playback acknowledgement
        api.acknowledgeAlertAnnouncementPlayed(item.alertId).catch(() => {});
        finishOnce();
      };

      audio.onerror = () => {
        // Playback failure: safe cleanup and advance
        finishOnce();
      };

      const playPromise = audio.play();
      if (playPromise !== undefined) {
        playPromise.catch((err: any) => {
          if (err && err.name === 'NotAllowedError') {
            // Autoplay blocked by browser
            this.isAutoplayBlocked = true;
            this.activePlaybackCount = 0;
            this.currentlyPlayingAlertId = null;
            this.currentAnnouncement = null;
            this.queue.unshift(item); // Retain item at front
            this.pendingPlaybackIds.add(item.alertId);
            this.notify();
            isFinished = true;
            audio.onended = null;
            audio.onerror = null;
            resolve();
          } else {
            // Other decode/network failure: safely advance
            finishOnce();
          }
        });
      }
    });
  }

  private finishPlayback(item: AnnouncementItem): void {
    if (this.sharedAudio) {
      try {
        this.sharedAudio.pause();
        this.sharedAudio.src = '';
      } catch {
        // ignore
      }
    }

    this.activePlaybackCount = 0;
    this.currentlyPlayingAlertId = null;
    this.currentAnnouncement = null;
    this.completedAlertIds.add(item.alertId);

    // Persist completed alert ID to storage
    try {
      if (typeof localStorage !== 'undefined') {
        localStorage.setItem(
          'cv_announced_alerts',
          JSON.stringify(Array.from(this.completedAlertIds))
        );
      }
    } catch {
      // ignore
    }

    // Broadcast completion to other tabs
    this.broadcast('ALERT_COMPLETED', item.alertId);
    this.notify();
  }

  public stopCurrent(): void {
    if (this.sharedAudio) {
      try {
        this.sharedAudio.pause();
        this.sharedAudio.src = '';
        this.sharedAudio.load();
      } catch {
        // ignore
      }
    }
    this.activePlaybackCount = 0;
    this.currentlyPlayingAlertId = null;
    this.currentAnnouncement = null;
    this.notify();
  }

  public destroy(): void {
    this.stopCurrent();
    this.queue = [];
    this.pendingPlaybackIds.clear();
    this.listeners.clear();
    if (this.channel) {
      try {
        this.channel.close();
      } catch {
        // ignore
      }
      this.channel = null;
    }
  }

  public reset(): void {
    this.destroy();
    this.receivedAlertIds.clear();
    this.completedAlertIds.clear();
    this.initCrossTabChannel();
  }
}

export const voiceAnnouncementQueue = new SingleVoicePlaybackManager();
