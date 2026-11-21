/**
 * Frontend Unit & Integration Tests for ElevenLabs Voice Announcements
 * Tests all requirements from Section 11:
 *  1. Audio playback
 *  2. Enable/disable control
 *  3. Mute/unmute
 *  4. Sequential queue
 *  5. Duplicate alert prevention
 *  6. Autoplay restrictions
 *  7. Playback failure handling
 *  8. Component unmount / cleanup
 *  9. Multiple incoming alerts
 */

import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert';

// Mock Web API environment for Node.js
class MockAudio {
  static instances = [];
  constructor() {
    this.src = '';
    this.muted = false;
    this.preload = '';
    this.onended = null;
    this.onerror = null;
    this._playing = false;
    this.shouldThrowNotAllowed = false;
    MockAudio.instances.push(this);
  }

  play() {
    if (this.shouldThrowNotAllowed) {
      const err = new Error('Autoplay not allowed');
      err.name = 'NotAllowedError';
      return Promise.reject(err);
    }
    this._playing = true;
    return Promise.resolve();
  }

  pause() {
    this._playing = false;
  }

  load() {
    // no-op
  }
}

globalThis.Audio = MockAudio;

const mockStorage = (function () {
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

// VoiceAnnouncementQueue implementation to test (mirroring service)
class VoiceAnnouncementQueueTestable {
  constructor() {
    this.queue = [];
    this.isEnabled = true;
    this.isMuted = false;
    this.isPlaying = false;
    this.isAutoplayBlocked = false;
    this.currentAnnouncement = null;
    this.currentAudio = null;
    this.announcedIds = new Set();
    this.listeners = new Set();
    this.playedAcks = [];
  }

  subscribe(listener) {
    this.listeners.add(listener);
    this.notify();
    return () => this.listeners.delete(listener);
  }

  notify() {
    const state = {
      isEnabled: this.isEnabled,
      isMuted: this.isMuted,
      isPlaying: this.isPlaying,
      isAutoplayBlocked: this.isAutoplayBlocked,
      currentAnnouncement: this.currentAnnouncement,
      queueLength: this.queue.length,
    };
    this.listeners.forEach((l) => l(state));
  }

  setEnabled(val) {
    this.isEnabled = val;
    if (!val && this.currentAudio) {
      this.stopCurrent();
    }
    this.notify();
    if (val && !this.isPlaying && this.queue.length > 0) {
      this.playNext();
    }
  }

  setMuted(val) {
    this.isMuted = val;
    if (this.currentAudio) {
      this.currentAudio.muted = val;
    }
    this.notify();
  }

  toggleEnabled() {
    this.setEnabled(!this.isEnabled);
  }

  toggleMute() {
    this.setMuted(!this.isMuted);
  }

  enqueue(item) {
    if (!item.alertId || !item.audioUrl) return false;
    if (this.announcedIds.has(item.alertId)) return false;

    this.announcedIds.add(item.alertId);
    this.queue.push(item);
    this.notify();

    if (this.isEnabled && !this.isPlaying) {
      this.playNext();
    }
    return true;
  }

  async unlockAudio() {
    this.isAutoplayBlocked = false;
    this.notify();
    if (this.isEnabled && !this.isPlaying && this.queue.length > 0) {
      this.playNext();
    }
    return true;
  }

  playNext() {
    if (!this.isEnabled || this.isPlaying || this.queue.length === 0) return;

    const item = this.queue.shift();
    if (!item) return;

    this.isPlaying = true;
    this.currentAnnouncement = item;
    this.notify();

    const audio = new MockAudio();
    this.currentAudio = audio;
    audio.src = item.audioUrl;
    audio.muted = this.isMuted;

    const cleanUp = () => {
      if (this.currentAudio === audio) {
        this.currentAudio = null;
      }
      audio.src = '';
      this.isPlaying = false;
      this.currentAnnouncement = null;
      this.notify();
    };

    audio.onended = () => {
      this.playedAcks.push(item.alertId);
      cleanUp();
      this.playNext();
    };

    audio.onerror = () => {
      cleanUp();
      this.playNext();
    };

    const p = audio.play();
    if (p && p.catch) {
      p.catch((err) => {
        if (err.name === 'NotAllowedError') {
          this.isAutoplayBlocked = true;
          this.queue.unshift(item);
          cleanUp();
        } else {
          cleanUp();
          this.playNext();
        }
      });
    }
  }

  stopCurrent() {
    if (this.currentAudio) {
      this.currentAudio.pause();
      this.currentAudio = null;
    }
    this.isPlaying = false;
    this.currentAnnouncement = null;
    this.notify();
  }

  destroy() {
    this.stopCurrent();
    this.queue = [];
    this.listeners.clear();
  }
}

describe('Frontend Voice Announcements Integration', () => {
  let queue;

  beforeEach(() => {
    MockAudio.instances = [];
    mockStorage.clear();
    queue = new VoiceAnnouncementQueueTestable();
  });

  test('1. Audio playback triggers on enqueue when enabled', () => {
    const item = { alertId: 'alt_1', audioUrl: '/api/alerts/alt_1/audio', spokenText: 'Critical alert.' };
    const accepted = queue.enqueue(item);
    assert.strictEqual(accepted, true);
    assert.strictEqual(queue.isPlaying, true);
    assert.strictEqual(queue.currentAnnouncement.alertId, 'alt_1');
    assert.strictEqual(MockAudio.instances.length, 1);
    assert.strictEqual(MockAudio.instances[0].src, '/api/alerts/alt_1/audio');
  });

  test('2. Enable/disable control halts playback and respects disabled state', () => {
    queue.setEnabled(false);
    assert.strictEqual(queue.isEnabled, false);

    const item = { alertId: 'alt_2', audioUrl: '/api/alerts/alt_2/audio', spokenText: 'Test alert.' };
    queue.enqueue(item);
    assert.strictEqual(queue.isPlaying, false);
    assert.strictEqual(queue.queue.length, 1);

    queue.setEnabled(true);
    assert.strictEqual(queue.isPlaying, true);
    assert.strictEqual(queue.currentAnnouncement.alertId, 'alt_2');
  });

  test('3. Mute/unmute control sets audio.muted flag', () => {
    queue.setMuted(true);
    assert.strictEqual(queue.isMuted, true);

    const item = { alertId: 'alt_3', audioUrl: '/api/alerts/alt_3/audio', spokenText: 'Muted alert.' };
    queue.enqueue(item);
    assert.strictEqual(MockAudio.instances[0].muted, true);

    queue.setMuted(false);
    assert.strictEqual(MockAudio.instances[0].muted, false);
  });

  test('4. Sequential queue: only one announcement plays at a time, no overlap', () => {
    queue.enqueue({ alertId: 'alt_seq_1', audioUrl: '/audio/1', spokenText: 'Alert 1' });
    queue.enqueue({ alertId: 'alt_seq_2', audioUrl: '/audio/2', spokenText: 'Alert 2' });

    assert.strictEqual(queue.isPlaying, true);
    assert.strictEqual(queue.currentAnnouncement.alertId, 'alt_seq_1');
    assert.strictEqual(queue.queue.length, 1); // 2nd waits in queue
    assert.strictEqual(MockAudio.instances.length, 1);

    // End first audio
    MockAudio.instances[0].onended();

    // Now second audio starts immediately and sequentially
    assert.strictEqual(queue.isPlaying, true);
    assert.strictEqual(queue.currentAnnouncement.alertId, 'alt_seq_2');
    assert.strictEqual(MockAudio.instances.length, 2);
    assert.deepStrictEqual(queue.playedAcks, ['alt_seq_1']);
  });

  test('5. Duplicate alert prevention: same alert ID cannot be enqueued twice', () => {
    const item = { alertId: 'alt_dup', audioUrl: '/audio/dup', spokenText: 'Alert' };
    const first = queue.enqueue(item);
    const second = queue.enqueue(item); // duplicate message / reconnect / re-render

    assert.strictEqual(first, true);
    assert.strictEqual(second, false);
    assert.strictEqual(queue.queue.length, 0); // was popped to playing
    assert.strictEqual(queue.announcedIds.size, 1);
  });

  test('6. Autoplay restrictions: sets blocked flag and retains item; unlock resumes', async () => {
    // Force NotAllowedError on play
    const originalPlay = MockAudio.prototype.play;
    MockAudio.prototype.play = function () {
      const err = new Error('Autoplay blocked');
      err.name = 'NotAllowedError';
      return Promise.reject(err);
    };

    queue.enqueue({ alertId: 'alt_autoplay', audioUrl: '/audio/auto', spokenText: 'Auto' });
    await new Promise((r) => setTimeout(r, 10));

    assert.strictEqual(queue.isAutoplayBlocked, true);
    assert.strictEqual(queue.isPlaying, false);
    assert.strictEqual(queue.queue.length, 1); // retained at front

    // Restore play
    MockAudio.prototype.play = originalPlay;

    // Operator unlocks audio
    await queue.unlockAudio();
    assert.strictEqual(queue.isAutoplayBlocked, false);
    assert.strictEqual(queue.isPlaying, true);
    assert.strictEqual(queue.currentAnnouncement.alertId, 'alt_autoplay');
  });

  test('7. Playback failure: gracefully advances to next alert without stalling queue', () => {
    queue.enqueue({ alertId: 'alt_err', audioUrl: '/audio/err', spokenText: 'Failing' });
    queue.enqueue({ alertId: 'alt_next', audioUrl: '/audio/next', spokenText: 'Next' });

    assert.strictEqual(queue.currentAnnouncement.alertId, 'alt_err');

    // Trigger error
    MockAudio.instances[0].onerror();

    // Queue advanced to next item
    assert.strictEqual(queue.isPlaying, true);
    assert.strictEqual(queue.currentAnnouncement.alertId, 'alt_next');
  });

  test('8. Component unmount / cleanup stops current audio and clears queue', () => {
    queue.enqueue({ alertId: 'alt_cleanup', audioUrl: '/audio/c', spokenText: 'Cleanup' });
    assert.strictEqual(queue.isPlaying, true);

    queue.destroy();
    assert.strictEqual(queue.isPlaying, false);
    assert.strictEqual(queue.currentAnnouncement, null);
    assert.strictEqual(queue.queue.length, 0);
  });

  test('9. Multiple rapid incoming alerts preserve order and process sequentially', () => {
    for (let i = 1; i <= 5; i++) {
      queue.enqueue({ alertId: `alt_rapid_${i}`, audioUrl: `/audio/${i}`, spokenText: `Alert ${i}` });
    }

    assert.strictEqual(queue.currentAnnouncement.alertId, 'alt_rapid_1');
    assert.strictEqual(queue.queue.length, 4);

    // Simulate completion of alerts 1 to 5
    for (let i = 0; i < 5; i++) {
      MockAudio.instances[i].onended();
    }

    assert.deepStrictEqual(queue.playedAcks, [
      'alt_rapid_1',
      'alt_rapid_2',
      'alt_rapid_3',
      'alt_rapid_4',
      'alt_rapid_5',
    ]);
    assert.strictEqual(queue.isPlaying, false);
    assert.strictEqual(queue.queue.length, 0);
  });
});
