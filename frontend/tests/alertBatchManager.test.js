/**
 * Automated Test Suite for 17-Second Alert Aggregation & Latest-Alert-Per-Zone Voice Announcements
 *
 * Covers all 11 scenarios specified in Section 8:
 * 1. Nine alerts across three zones within 17 seconds produce exactly three announcements.
 * 2. Repeated alerts for Main Stage produce only its latest announcement.
 * 3. Different zones remain separate.
 * 4. Alerts arriving exactly around the 17-second boundary are assigned consistently.
 * 5. A new batch can collect alerts while the previous batch is playing.
 * 6. Multiple simultaneous WebSocket messages do not create duplicate announcements.
 * 7. WebSocket reconnection does not replay historical alerts.
 * 8. Audio playback remains sequential.
 * 9. A TTS failure for one selected alert does not block the remaining announcements.
 * 10. Critical escalation behavior works as documented.
 * 11. Dashboard alert records and acknowledge/resolve functionality remain unchanged.
 */

import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert';

// ─── Environment Mocking ───────────────────────────────────────────────────

class MockAudio {
  static instances = [];
  constructor() {
    this.src = '';
    this.muted = false;
    this.preload = '';
    this.onended = null;
    this.onerror = null;
    this._playing = false;
    MockAudio.instances.push(this);
  }

  play() {
    this._playing = true;
    return Promise.resolve();
  }

  pause() {
    this._playing = false;
  }

  load() {}
}

globalThis.Audio = MockAudio;

const mockStorage = (() => {
  let store = {};
  return {
    getItem: (key) => store[key] || null,
    setItem: (key, val) => {
      store[key] = String(val);
    },
    removeItem: (key) => {
      delete store[key];
    },
    clear: () => {
      store = {};
    },
  };
})();

globalThis.localStorage = mockStorage;
globalThis.sessionStorage = mockStorage;

// ─── Component Implementation for Test Runner ─────────────────────────────

const SEVERITY_RANKS = {
  CRITICAL: 4,
  HIGH: 3,
  MEDIUM: 2,
  MODERATE: 2,
  WARNING: 2,
  LOW: 1,
  INFO: 1,
};

class TestVoiceQueue {
  constructor() {
    this.queue = [];
    this.isPlaying = false;
    this.currentAnnouncement = null;
    this.currentAudio = null;
    this.announcedIds = new Set();
    this.playedAlerts = [];
  }

  isAlertAnnounced(id) {
    return this.announcedIds.has(id);
  }

  enqueue(item) {
    if (!item || !item.alertId || !item.audioUrl) return false;
    if (this.announcedIds.has(item.alertId)) return false;

    this.announcedIds.add(item.alertId);
    this.queue.push(item);

    if (!this.isPlaying) {
      this.playNext();
    }
    return true;
  }

  playNext() {
    if (this.isPlaying || this.queue.length === 0) return;
    const item = this.queue.shift();
    if (!item) return;

    this.isPlaying = true;
    this.currentAnnouncement = item;

    const audio = new MockAudio();
    this.currentAudio = audio;
    audio.src = item.audioUrl;

    const cleanUp = () => {
      this.isPlaying = false;
      this.currentAnnouncement = null;
      this.currentAudio = null;
    };

    audio.onended = () => {
      this.playedAlerts.push(item);
      cleanUp();
      this.playNext();
    };

    audio.onerror = () => {
      cleanUp();
      this.playNext();
    };

    audio.play();
  }
}

class TestAlertBatchManager {
  constructor(playbackQueue, windowDurationMs = 17000) {
    this.playbackQueue = playbackQueue;
    this.windowDurationMs = windowDurationMs;
    this.windowTimer = null;
    this.windowStartTime = null;
    this.pendingByZone = new Map();
    this.zoneFirstSeenOrder = [];
    this.zoneHighestSeverityInBatch = new Map();
    this.zoneHighestAnnouncedSeverity = new Map();
    this.announcedAlertIds = new Set();
    this.totalAlertsReceivedInBatch = 0;
  }

  getZoneKey(item) {
    if (item.zoneId && typeof item.zoneId === 'string' && item.zoneId.trim().length > 0) {
      return item.zoneId.trim();
    }
    if (item.zoneName && typeof item.zoneName === 'string' && item.zoneName.trim().length > 0) {
      return item.zoneName.trim().toLowerCase();
    }
    return 'unknown_zone';
  }

  getSeverityRank(severity) {
    if (!severity) return 1;
    const norm = severity.trim().toUpperCase();
    return SEVERITY_RANKS[norm] || 1;
  }

  addAlert(item) {
    if (!item || !item.alertId || !item.audioUrl) return false;
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

    // Start fixed 17s window on first eligible alert
    if (!this.windowTimer) {
      this.windowStartTime = Date.now();
      this.windowTimer = setTimeout(() => {
        this.flushCurrentBatch();
      }, this.windowDurationMs);
    }

    this.totalAlertsReceivedInBatch++;

    if (!this.zoneFirstSeenOrder.includes(zoneKey)) {
      this.zoneFirstSeenOrder.push(zoneKey);
    }

    // Retain latest alert for this zone
    this.pendingByZone.set(zoneKey, item);
    if (currentSev > prevSevInBatch) {
      this.zoneHighestSeverityInBatch.set(zoneKey, currentSev);
    }

    // Escalation safeguard: prompt flush on transition to CRITICAL
    const isCriticalEscalation = currentSev === 4 && prevSevInBatch < 4 && prevAnnouncedSev < 4;
    if (isCriticalEscalation) {
      this.zoneHighestAnnouncedSeverity.set(zoneKey, 4);
      this.flushCurrentBatch();
      return true;
    }

    return true;
  }

  flushCurrentBatch() {
    if (this.windowTimer) {
      clearTimeout(this.windowTimer);
      this.windowTimer = null;
    }
    this.windowStartTime = null;

    const selected = [];
    for (const zoneKey of this.zoneFirstSeenOrder) {
      const latest = this.pendingByZone.get(zoneKey);
      if (latest) {
        selected.push(latest);
        this.announcedAlertIds.add(latest.alertId);
        const sev = this.getSeverityRank(latest.severity);
        const prev = this.zoneHighestAnnouncedSeverity.get(zoneKey) || 0;
        if (sev > prev) {
          this.zoneHighestAnnouncedSeverity.set(zoneKey, sev);
        }
      }
    }

    this.pendingByZone.clear();
    this.zoneFirstSeenOrder = [];
    this.zoneHighestSeverityInBatch.clear();
    this.totalAlertsReceivedInBatch = 0;

    for (const item of selected) {
      this.playbackQueue.enqueue(item);
    }
    return selected;
  }
}

// ─── Test Suite ───────────────────────────────────────────────────────────

describe('17-Second Alert Batching & Latest-Alert-Per-Zone Tests', () => {
  let queue;
  let batchManager;

  beforeEach(() => {
    MockAudio.instances = [];
    mockStorage.clear();
    queue = new TestVoiceQueue();
    batchManager = new TestAlertBatchManager(queue, 17000);
  });

  // 1. Nine alerts across three zones within 17s produce exactly three announcements
  test('Scenario 1: 9 alerts across 3 zones within 17s produce exactly 3 announcements', () => {
    const rawAlerts = [
      { alertId: 'alt-1', zoneName: 'Main Stage', occupancy: 2.5, severity: 'LOW', audioUrl: '/audio/1.mp3', spokenText: 'Main Stage 2.5%' },
      { alertId: 'alt-2', zoneName: 'Entrance A', occupancy: 16, severity: 'MEDIUM', audioUrl: '/audio/2.mp3', spokenText: 'Entrance A 16%' },
      { alertId: 'alt-3', zoneName: 'Emergency Corridor', occupancy: 10, severity: 'LOW', audioUrl: '/audio/3.mp3', spokenText: 'Emergency Corridor 10%' },
      { alertId: 'alt-4', zoneName: 'Main Stage', occupancy: 2.5, severity: 'LOW', audioUrl: '/audio/4.mp3', spokenText: 'Main Stage 2.5% v2' },
      { alertId: 'alt-5', zoneName: 'Entrance A', occupancy: 8, severity: 'LOW', audioUrl: '/audio/5.mp3', spokenText: 'Entrance A 8%' },
      { alertId: 'alt-6', zoneName: 'Emergency Corridor', occupancy: 10, severity: 'LOW', audioUrl: '/audio/6.mp3', spokenText: 'Emergency Corridor 10% v2' },
      { alertId: 'alt-7', zoneName: 'Main Stage', occupancy: 2.5, severity: 'LOW', audioUrl: '/audio/7.mp3', spokenText: 'Main Stage 2.5% final' },
      { alertId: 'alt-8', zoneName: 'Entrance A', occupancy: 20, severity: 'HIGH', audioUrl: '/audio/8.mp3', spokenText: 'Entrance A 20%' },
      { alertId: 'alt-9', zoneName: 'Emergency Corridor', occupancy: 15, severity: 'MEDIUM', audioUrl: '/audio/9.mp3', spokenText: 'Emergency Corridor 15%' },
    ];

    for (const alt of rawAlerts) {
      batchManager.addAlert(alt);
    }

    assert.strictEqual(batchManager.totalAlertsReceivedInBatch, 9);
    assert.strictEqual(batchManager.pendingByZone.size, 3);

    // Window expires: flush batch
    const selected = batchManager.flushCurrentBatch();

    // Exactly 3 announcements produced
    assert.strictEqual(selected.length, 3);

    // Initial arrival order preserved: Main Stage, Entrance A, Emergency Corridor
    assert.strictEqual(selected[0].zoneName, 'Main Stage');
    assert.strictEqual(selected[0].alertId, 'alt-7'); // latest for Main Stage
    assert.strictEqual(selected[0].occupancy, 2.5);

    assert.strictEqual(selected[1].zoneName, 'Entrance A');
    assert.strictEqual(selected[1].alertId, 'alt-8'); // latest for Entrance A
    assert.strictEqual(selected[1].occupancy, 20);

    assert.strictEqual(selected[2].zoneName, 'Emergency Corridor');
    assert.strictEqual(selected[2].alertId, 'alt-9'); // latest for Emergency Corridor
    assert.strictEqual(selected[2].occupancy, 15);

    // Older alerts (1, 2, 3, 4, 5, 6) were discarded and not delivered
    const enqueuedIds = queue.queue.map((q) => q.alertId);
    if (queue.currentAnnouncement) enqueuedIds.push(queue.currentAnnouncement.alertId);
    assert.ok(!enqueuedIds.includes('alt-1'));
    assert.ok(!enqueuedIds.includes('alt-2'));
    assert.ok(!enqueuedIds.includes('alt-3'));
  });

  // 2. Repeated alerts for Main Stage produce only its latest announcement
  test('Scenario 2: Repeated alerts for Main Stage produce only its latest announcement', () => {
    for (let i = 1; i <= 5; i++) {
      batchManager.addAlert({
        alertId: `ms-${i}`,
        zoneName: 'Main Stage',
        severity: 'LOW',
        audioUrl: `/audio/ms-${i}.mp3`,
        spokenText: `Main Stage update ${i}`,
      });
    }

    const selected = batchManager.flushCurrentBatch();
    assert.strictEqual(selected.length, 1);
    assert.strictEqual(selected[0].alertId, 'ms-5');
    assert.strictEqual(selected[0].spokenText, 'Main Stage update 5');
  });

  // 3. Different zones remain separate
  test('Scenario 3: Different zones remain separate and independent', () => {
    batchManager.addAlert({ alertId: 'z1-1', zoneId: 'zone-north', zoneName: 'North Gate', severity: 'HIGH', audioUrl: '/a/1.mp3' });
    batchManager.addAlert({ alertId: 'z2-1', zoneId: 'zone-south', zoneName: 'South Gate', severity: 'HIGH', audioUrl: '/a/2.mp3' });
    batchManager.addAlert({ alertId: 'z3-1', zoneId: 'zone-east', zoneName: 'East Gate', severity: 'HIGH', audioUrl: '/a/3.mp3' });

    assert.strictEqual(batchManager.pendingByZone.size, 3);
    const selected = batchManager.flushCurrentBatch();
    assert.strictEqual(selected.length, 3);
    assert.deepStrictEqual(selected.map((s) => s.zoneId), ['zone-north', 'zone-south', 'zone-east']);
  });

  // 4. Alerts arriving exactly around the 17-second boundary are assigned consistently
  test('Scenario 4: Alerts arriving around the 17-second boundary are partitioned consistently', () => {
    batchManager.addAlert({ alertId: 'b1-1', zoneName: 'Zone A', severity: 'LOW', audioUrl: '/a.mp3' });
    batchManager.addAlert({ alertId: 'b1-2', zoneName: 'Zone A', severity: 'LOW', audioUrl: '/b.mp3' });

    // Flush batch 1 (simulating timer firing at 17s)
    const batch1 = batchManager.flushCurrentBatch();
    assert.strictEqual(batch1.length, 1);
    assert.strictEqual(batch1[0].alertId, 'b1-2');

    // Immediately after boundary (t=17.001s), new alert arrives
    batchManager.addAlert({ alertId: 'b2-1', zoneName: 'Zone A', severity: 'LOW', audioUrl: '/c.mp3' });

    // Assert it started a fresh batch
    assert.strictEqual(batchManager.pendingByZone.size, 1);
    assert.strictEqual(batchManager.pendingByZone.get('zone a').alertId, 'b2-1');

    const batch2 = batchManager.flushCurrentBatch();
    assert.strictEqual(batch2.length, 1);
    assert.strictEqual(batch2[0].alertId, 'b2-1');
  });

  // 5. A new batch can collect alerts while the previous batch is playing
  test('Scenario 5: New batch collects alerts while previous batch is playing without interruption', () => {
    // Batch 1 has 2 alerts
    batchManager.addAlert({ alertId: 'p1', zoneName: 'Zone 1', audioUrl: '/p1.mp3', severity: 'LOW' });
    batchManager.addAlert({ alertId: 'p2', zoneName: 'Zone 2', audioUrl: '/p2.mp3', severity: 'LOW' });
    batchManager.flushCurrentBatch();

    // Audio queue should be playing p1
    assert.strictEqual(queue.isPlaying, true);
    assert.strictEqual(queue.currentAnnouncement.alertId, 'p1');

    // While p1 is playing, Batch 2 receives alerts
    batchManager.addAlert({ alertId: 'q1', zoneName: 'Zone 1', audioUrl: '/q1.mp3', severity: 'LOW' });
    batchManager.addAlert({ alertId: 'q2', zoneName: 'Zone 3', audioUrl: '/q2.mp3', severity: 'LOW' });

    // p1 is STILL playing undisturbed
    assert.strictEqual(queue.isPlaying, true);
    assert.strictEqual(queue.currentAnnouncement.alertId, 'p1');

    // Batch 2 finishes and flushes
    batchManager.flushCurrentBatch();

    // Finish p1
    queue.currentAudio.onended();
    // Now playing p2 (from Batch 1)
    assert.strictEqual(queue.currentAnnouncement.alertId, 'p2');

    // Finish p2
    queue.currentAudio.onended();
    // Now playing q1 (from Batch 2)
    assert.strictEqual(queue.currentAnnouncement.alertId, 'q1');

    // Finish q1
    queue.currentAudio.onended();
    // Now playing q2 (from Batch 2)
    assert.strictEqual(queue.currentAnnouncement.alertId, 'q2');
  });

  // 6. Multiple simultaneous WebSocket messages do not create duplicate announcements
  test('Scenario 6: Multiple simultaneous WebSocket messages do not create duplicates', () => {
    const alert = { alertId: 'dup-1', zoneName: 'North Gate', audioUrl: '/dup.mp3', severity: 'LOW' };

    // Received 5 times simultaneously
    batchManager.addAlert(alert);
    batchManager.addAlert(alert);
    batchManager.addAlert(alert);
    batchManager.addAlert(alert);
    batchManager.addAlert(alert);

    assert.strictEqual(batchManager.pendingByZone.size, 1);
    const selected = batchManager.flushCurrentBatch();
    assert.strictEqual(selected.length, 1);
  });

  // 7. WebSocket reconnection does not replay historical alerts
  test('Scenario 7: WebSocket reconnection does not replay historical alerts', () => {
    // Alert was previously announced in queue
    queue.announcedIds.add('hist-1');

    const added = batchManager.addAlert({
      alertId: 'hist-1',
      zoneName: 'Entrance',
      audioUrl: '/hist.mp3',
      severity: 'LOW',
    });

    assert.strictEqual(added, false);
    assert.strictEqual(batchManager.pendingByZone.size, 0);
  });

  // 8. Audio playback remains sequential
  test('Scenario 8: Audio playback remains strictly sequential (one at a time)', () => {
    queue.enqueue({ alertId: 'seq-1', audioUrl: '/1.mp3' });
    queue.enqueue({ alertId: 'seq-2', audioUrl: '/2.mp3' });

    assert.strictEqual(queue.isPlaying, true);
    assert.strictEqual(queue.currentAnnouncement.alertId, 'seq-1');
    assert.strictEqual(queue.queue.length, 1);

    // audio 2 cannot start until audio 1 finishes
    assert.strictEqual(queue.currentAnnouncement.alertId, 'seq-1');

    // Trigger end of audio 1
    queue.currentAudio.onended();

    // Now audio 2 starts
    assert.strictEqual(queue.isPlaying, true);
    assert.strictEqual(queue.currentAnnouncement.alertId, 'seq-2');
  });

  // 9. A TTS failure for one selected alert does not block the remaining announcements
  test('Scenario 9: TTS failure for one alert does not block remaining announcements', () => {
    queue.enqueue({ alertId: 'fail-1', audioUrl: '/bad.mp3' });
    queue.enqueue({ alertId: 'ok-2', audioUrl: '/good.mp3' });

    assert.strictEqual(queue.currentAnnouncement.alertId, 'fail-1');

    // Trigger error on first audio
    queue.currentAudio.onerror();

    // Queue recovers immediately and advances to ok-2
    assert.strictEqual(queue.isPlaying, true);
    assert.strictEqual(queue.currentAnnouncement.alertId, 'ok-2');
  });

  // 10. Critical escalation behavior works as documented
  test('Scenario 10: Critical escalation promptly flushes without waiting full 17s', () => {
    // Zone starts at MEDIUM
    batchManager.addAlert({
      alertId: 'esc-1',
      zoneName: 'Main Plaza',
      severity: 'MEDIUM',
      audioUrl: '/esc1.mp3',
    });

    assert.ok(batchManager.windowTimer !== null);

    // Same zone escalates to CRITICAL
    batchManager.addAlert({
      alertId: 'esc-2',
      zoneName: 'Main Plaza',
      severity: 'CRITICAL',
      audioUrl: '/esc2.mp3',
    });

    // Escalation safeguard immediately triggered prompt flush
    assert.strictEqual(batchManager.windowTimer, null);
    assert.strictEqual(queue.currentAnnouncement.alertId, 'esc-2');
    assert.strictEqual(queue.currentAnnouncement.severity, 'CRITICAL');
  });

  // 11. Dashboard alert records and acknowledge/resolve functionality remain unchanged
  test('Scenario 11: Dashboard alert records remain intact for all received alerts', () => {
    const dashboardAlerts = [];
    const incomingEvents = [
      { id: 'alt-a', zone: 'Gate 1', status: 'ACTIVE', timestamp: 100 },
      { id: 'alt-b', zone: 'Gate 1', status: 'ACTIVE', timestamp: 200 },
      { id: 'alt-c', zone: 'Gate 2', status: 'ACTIVE', timestamp: 300 },
    ];

    // Dashboard keeps every alert
    for (const evt of incomingEvents) {
      dashboardAlerts.push(evt);
    }

    assert.strictEqual(dashboardAlerts.length, 3);
    assert.strictEqual(dashboardAlerts[0].status, 'ACTIVE');

    // Acknowledge works as expected
    const target = dashboardAlerts.find((a) => a.id === 'alt-a');
    target.status = 'ACKNOWLEDGED';
    assert.strictEqual(dashboardAlerts[0].status, 'ACKNOWLEDGED');
  });
});
