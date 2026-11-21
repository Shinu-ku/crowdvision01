import React from 'react';
import { Volume2, VolumeX, Radio, AlertCircle } from 'lucide-react';
import { useVoiceAnnouncements } from '../../hooks/useVoiceAnnouncements';

interface VoiceAnnouncementControlProps {
  compact?: boolean;
}

export const VoiceAnnouncementControl: React.FC<VoiceAnnouncementControlProps> = ({ compact = false }) => {
  const {
    isEnabled,
    isMuted,
    isPlaying,
    isAutoplayBlocked,
    currentAnnouncement,
    batchState,
    toggleEnabled,
    toggleMute,
    unlockAudio,
  } = useVoiceAnnouncements();

  return (
    <div className="flex items-center space-x-2">
      {/* Autoplay Unlock Notice if blocked by browser */}
      {isAutoplayBlocked && (
        <button
          onClick={() => unlockAudio()}
          className="flex items-center space-x-1.5 px-2.5 py-1 rounded-lg bg-amber-500/20 border border-amber-500/40 text-amber-300 text-xs font-medium hover:bg-amber-500/30 transition-all animate-pulse"
          title="Click to enable control room voice announcements"
        >
          <AlertCircle className="h-3.5 w-3.5 text-amber-400" />
          <span>Click to Unlock Audio</span>
        </button>
      )}

      {/* Main Voice Announcements Control Pill */}
      <div className="flex items-center rounded-lg bg-[#070B14] border border-slate-800 p-1 text-xs">
        {/* Enable / Disable Button */}
        <button
          onClick={toggleEnabled}
          className={`flex items-center space-x-1.5 px-2.5 py-1 rounded transition-colors ${
            isEnabled
              ? 'bg-slate-800 text-cyan-400 font-medium'
              : 'text-slate-500 hover:text-slate-400'
          }`}
          title={
            isEnabled
              ? batchState.isBatchingActive
                ? `17s batch aggregation active (${batchState.pendingZoneCount} zones consolidating)`
                : 'Voice announcements are active'
              : 'Voice announcements are disabled'
          }
        >
          <Radio
            className={`h-3.5 w-3.5 ${
              isEnabled && isPlaying
                ? 'text-rose-400 animate-pulse'
                : isEnabled && batchState.isBatchingActive
                ? 'text-amber-400 animate-pulse'
                : isEnabled
                ? 'text-cyan-400'
                : 'text-slate-500'
            }`}
          />
          {!compact && (
            <span>
              {isEnabled
                ? isPlaying
                  ? 'Announcing...'
                  : batchState.isBatchingActive
                  ? `Batching (${batchState.pendingZoneCount} zones)`
                  : 'Voice Alerts'
                : 'Voice Off'}
            </span>
          )}
        </button>

        {/* Mute / Unmute Button */}
        {isEnabled && (
          <button
            onClick={toggleMute}
            className={`p-1 ml-1 rounded transition-colors ${
              isMuted ? 'text-amber-400 hover:text-amber-300' : 'text-slate-400 hover:text-white'
            }`}
            title={isMuted ? 'Unmute voice announcements' : 'Mute voice announcements'}
          >
            {isMuted ? <VolumeX className="h-3.5 w-3.5" /> : <Volume2 className="h-3.5 w-3.5" />}
          </button>
        )}
      </div>

      {/* Active Spoken Toast Bar (subtle indicator) */}
      {isPlaying && currentAnnouncement && (
        <div className="hidden lg:flex items-center space-x-1.5 px-2.5 py-1 rounded bg-rose-500/10 border border-rose-500/30 text-[11px] text-rose-300 font-mono max-w-xs truncate animate-fade-in">
          <span className="w-1.5 h-1.5 rounded-full bg-rose-400 animate-ping" />
          <span className="truncate">{currentAnnouncement.spokenText}</span>
        </div>
      )}
    </div>
  );
};
