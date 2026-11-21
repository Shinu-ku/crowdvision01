/**
 * 17-Second Alert Aggregation and Latest-Alert-Per-Zone Batching Manager.
 *
 * Consolidates incoming CrowdVision alerts into a fixed 17-second window:
 * - Groups alerts by stable zone identifier (or normalized zone name).
 * - Retains only the most recent alert for each zone.
 * - Discards older alerts from the same zone for voice announcements.
 * - Preserves the first-seen zone arrival order when emitting announcements.
 * - Safeguards critical escalations by promptly dispatching when a zone transitions to CRITICAL.
 * - Dispatches selected alerts sequentially to SingleVoicePlaybackManager.
 * - Tracks pendingAggregationIds as part of global alert lifecycle tracking.
 */

import {
  voiceAnnouncementQueue,
  AnnouncementItem,
} from './voiceAnnouncementQueue';

export interface BatchManagerState {
  isBatchingActive: boolean;
  pendingZoneCount: number;
  totalAlertsInBatch: number;
  remainingTimeMs: number;
  activeBatchZones: string[];
}

export type BatchStateListener = (state: BatchManagerState) => void;

const SEVERITY_RANKS: Record<string, number> = {
  CRITICAL: 4,
  HIGH: 3,
  MEDIUM: 2,
  MODERATE: 2,
  WARNING: 2,
  LOW: 1,
  INFO: 1,
};

export class AlertBatchManager {
  private windowDurationMs: number;
  private windowTimer: any = null;
  private windowStartTime: number | null = null;
  private pendingByZone: Map<string, AnnouncementItem> = new Map();
  private zoneFirstSeenOrder: string[] = [];
  private zoneHighestSeverityInBatch: Map<string, number> = new Map();
  private zoneHighestAnnouncedSeverity: Map<string, number> = new Map();
  private announcedAlertIds: Set<string> = new Set();
  private pendingAggregationIds: Set<string> = new Set();
  private totalAlertsReceivedInBatch: number = 0;
  private listeners: Set<BatchStateListener> = new Set();
  private playbackQueue: typeof voiceAnnouncementQueue;

  constructor(
    playbackQueue: typeof voiceAnnouncementQueue = voiceAnnouncementQueue,
    windowDurationMs: number = 17000
  ) {
    this.playbackQueue = playbackQueue;
    this.windowDurationMs = windowDurationMs;
  }

  /**
   * Subscribe to batch manager state changes (for reactive UI feedback).
   */
  public subscribe(listener: BatchStateListener): () => void {
    this.listeners.add(listener);
    this.notifyListeners();
    return () => {
      this.listeners.delete(listener);
    };
  }

  private notifyListeners(): void {
    const state = this.getState();
    this.listeners.forEach((listener) => {
      try {
        listener(state);
      } catch {
        // ignore listener errors
      }
    });
  }

  /**
   * Get current state of the batching window.
   */
  public getState(): BatchManagerState {
    let remainingTimeMs = 0;
    if (this.windowStartTime !== null) {
      const elapsed = Date.now() - this.windowStartTime;
      remainingTimeMs = Math.max(0, this.windowDurationMs - elapsed);
    }

    return {
      isBatchingActive: this.windowTimer !== null,
      pendingZoneCount: this.pendingByZone.size,
      totalAlertsInBatch: this.totalAlertsReceivedInBatch,
      remainingTimeMs,
      activeBatchZones: [...this.zoneFirstSeenOrder],
    };
  }

  public getPendingAggregationIds(): Set<string> {
    return new Set(this.pendingAggregationIds);
  }

  /**
   * Derive a stable grouping key for the alert's zone.
   * Prefers zoneId; falls back to normalized zoneName; otherwise 'unknown_zone'.
   */
  public getZoneKey(item: { zoneId?: string; zoneName?: string }): string {
    if (item.zoneId && typeof item.zoneId === 'string' && item.zoneId.trim().length > 0) {
      return item.zoneId.trim();
    }
    if (item.zoneName && typeof item.zoneName === 'string' && item.zoneName.trim().length > 0) {
      return item.zoneName.trim().toLowerCase();
    }
    return 'unknown_zone';
  }

  /**
   * Resolve numeric rank for alert severity (1-4).
   */
  public getSeverityRank(severity?: string): number {
    if (!severity) return 1;
    const norm = severity.trim().toUpperCase();
    return SEVERITY_RANKS[norm] || 1;
  }

  /**
   * Ingest a new alert announcement into the batching window.
   *
   * @param item The announcement item received from WebSocket.
   * @returns true if accepted, false if discarded (e.g. duplicate or invalid).
   */
  public addAlert(item: AnnouncementItem): boolean {
    if (!item || !item.alertId || !item.audioUrl) {
      return false;
    }

    // Deduplication check: drop if already announced or currently queued/playing
    if (
      this.announcedAlertIds.has(item.alertId) ||
      this.playbackQueue.isAlertAnnounced(item.alertId)
    ) {
      return false;
    }

    const zoneKey = this.getZoneKey(item);
    const currentSev = this.getSeverityRank(item.severity);
    const prevSevInBatch = this.zoneHighestSeverityInBatch.get(zoneKey) || 0;
    const prevAnnouncedSev = this.zoneHighestAnnouncedSeverity.get(zoneKey) || 0;

    // Start a fixed 17-second window from the first eligible alert
    if (!this.windowTimer) {
      this.windowStartTime = Date.now();
      this.windowTimer = setTimeout(() => {
        this.flushCurrentBatch();
      }, this.windowDurationMs);
    }

    this.totalAlertsReceivedInBatch++;

    // Track aggregation lifecycle ID: remove superseded ID if replacing existing zone item
    const existingForZone = this.pendingByZone.get(zoneKey);
    if (existingForZone) {
      this.pendingAggregationIds.delete(existingForZone.alertId);
    }
    this.pendingAggregationIds.add(item.alertId);

    // Preserve initial arrival order of zones
    if (!this.zoneFirstSeenOrder.includes(zoneKey)) {
      this.zoneFirstSeenOrder.push(zoneKey);
    }

    // Retain only the latest alert for this zone (replaces older alert in same zone)
    this.pendingByZone.set(zoneKey, item);
    if (currentSev > prevSevInBatch) {
      this.zoneHighestSeverityInBatch.set(zoneKey, currentSev);
    }

    // Critical escalation safeguard:
    // If a zone transitions to CRITICAL and was not previously CRITICAL, flush promptly
    // so control room operators receive safety-critical alerts without waiting the full window.
    const isCriticalEscalation = currentSev === 4 && prevSevInBatch < 4 && prevAnnouncedSev < 4;
    if (isCriticalEscalation) {
      this.zoneHighestAnnouncedSeverity.set(zoneKey, 4);
      this.flushCurrentBatch();
      return true;
    }

    this.notifyListeners();
    return true;
  }

  /**
   * Flush the current 17-second batch:
   * Takes a snapshot of the latest alert for every zone in first-seen order,
   * sends them to the sequential playback queue, and clears the batch.
   */
  public flushCurrentBatch(): AnnouncementItem[] {
    if (this.windowTimer) {
      clearTimeout(this.windowTimer);
      this.windowTimer = null;
    }
    this.windowStartTime = null;

    // Snapshot winning latest-alerts per zone in first-seen arrival order
    const selectedAlerts: AnnouncementItem[] = [];
    for (const zoneKey of this.zoneFirstSeenOrder) {
      const latest = this.pendingByZone.get(zoneKey);
      if (latest) {
        selectedAlerts.push(latest);
        this.announcedAlertIds.add(latest.alertId);
        const sev = this.getSeverityRank(latest.severity);
        const prevMax = this.zoneHighestAnnouncedSeverity.get(zoneKey) || 0;
        if (sev > prevMax) {
          this.zoneHighestAnnouncedSeverity.set(zoneKey, sev);
        }
      }
    }

    // Reset current active collection batch
    this.pendingByZone.clear();
    this.pendingAggregationIds.clear();
    this.zoneFirstSeenOrder = [];
    this.zoneHighestSeverityInBatch.clear();
    this.totalAlertsReceivedInBatch = 0;
    this.notifyListeners();

    // Deliver selected alerts to the sequential playback queue
    for (const selected of selectedAlerts) {
      this.playbackQueue.enqueue(selected);
    }

    return selectedAlerts;
  }

  /**
   * Check whether an alert ID has already been announced or selected.
   */
  public isAlertProcessed(alertId: string): boolean {
    return (
      this.announcedAlertIds.has(alertId) ||
      this.playbackQueue.isAlertAnnounced(alertId)
    );
  }

  /**
   * Clean up timers and reset state (used on app unmount or in test suites).
   */
  public destroy(): void {
    if (this.windowTimer) {
      clearTimeout(this.windowTimer);
      this.windowTimer = null;
    }
    this.windowStartTime = null;
    this.pendingByZone.clear();
    this.pendingAggregationIds.clear();
    this.zoneFirstSeenOrder = [];
    this.zoneHighestSeverityInBatch.clear();
    this.totalAlertsReceivedInBatch = 0;
    this.listeners.clear();
  }

  /**
   * Reset all memory tracking (useful in unit tests).
   */
  public reset(): void {
    this.destroy();
    this.announcedAlertIds.clear();
    this.zoneHighestAnnouncedSeverity.clear();
  }
}

export const alertBatchManager = new AlertBatchManager();
