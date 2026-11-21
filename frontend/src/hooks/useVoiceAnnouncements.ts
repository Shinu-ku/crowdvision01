import { useEffect, useState } from 'react';
import {
  voiceAnnouncementQueue,
  AnnouncementItem,
} from '../services/voiceAnnouncementQueue';
import {
  alertBatchManager,
  BatchManagerState,
} from '../services/alertBatchManager';

export function useVoiceAnnouncements() {
  const [queueState, setQueueState] = useState({
    isEnabled: true,
    isMuted: false,
    isPlaying: false,
    isAutoplayBlocked: false,
    currentAnnouncement: null as AnnouncementItem | null,
    queueLength: 0,
  });

  const [batchState, setBatchState] = useState<BatchManagerState>({
    isBatchingActive: false,
    pendingZoneCount: 0,
    totalAlertsInBatch: 0,
    remainingTimeMs: 0,
    activeBatchZones: [],
  });

  useEffect(() => {
    const unsubQueue = voiceAnnouncementQueue.subscribe((updated) => {
      setQueueState(updated);
    });
    const unsubBatch = alertBatchManager.subscribe((updated) => {
      setBatchState(updated);
    });
    return () => {
      unsubQueue();
      unsubBatch();
    };
  }, []);

  return {
    ...queueState,
    batchState,
    setEnabled: (val: boolean) => voiceAnnouncementQueue.setEnabled(val),
    setMuted: (val: boolean) => voiceAnnouncementQueue.setMuted(val),
    toggleEnabled: () => voiceAnnouncementQueue.toggleEnabled(),
    toggleMute: () => voiceAnnouncementQueue.toggleMute(),
    unlockAudio: () => voiceAnnouncementQueue.unlockAudio(),
    enqueue: (item: AnnouncementItem) => voiceAnnouncementQueue.enqueue(item),
    stopCurrent: () => voiceAnnouncementQueue.stopCurrent(),
  };
}
