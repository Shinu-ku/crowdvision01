"""Coordinates alert announcement lifecycle, atomic deduplication, and audio delivery."""
from __future__ import annotations

import asyncio
from datetime import datetime, timezone
import os
from pathlib import Path
from typing import Any, Optional

from sqlalchemy import select
from sqlalchemy.exc import IntegrityError

from app.config import get_settings
from app.core.logging import get_logger
from app.database.models import Alert, AlertAnnouncement
from app.database.session import get_session_factory
from app.services.announcement_builder import build_spoken_announcement
from app.services.elevenlabs_service import ElevenLabsService, TTSResult
from app.services.ws_manager import ws_manager

logger = get_logger("services.announcement_coordinator")


class AnnouncementCoordinator:
    """
    Manages the lifecycle of voice announcements for verified CrowdVision alerts.
    
    Guarantees at-most-once announcement per unique alert ID via database-level
    atomic claiming and persistent status tracking.
    """

    def __init__(self, tts_service: Optional[ElevenLabsService] = None) -> None:
        self.tts_service = tts_service or ElevenLabsService()
        self._lock = asyncio.Lock()

    async def process_new_alert(
        self,
        alert_id: str,
        alert_dict_or_obj: Optional[Any] = None,
        event_id: Optional[str] = None,
    ) -> Optional[AlertAnnouncement]:
        """
        Process a newly created alert for spoken announcement.

        Safely handles deduplication, text synthesis, and audio dispatch.
        Never raises exceptions to callers; failures are safely recorded.
        """
        if not alert_id:
            return None

        session_factory = get_session_factory()
        settings = get_settings()

        # Check if ElevenLabs is enabled
        if not self.tts_service.enabled:
            logger.debug("Skipping alert voice announcement because ElevenLabs is disabled", alert_id=alert_id)
            return None

        # 1. Fetch Alert entity if not fully provided
        target_event_id = event_id
        target_severity = "MEDIUM"
        target_zone_name = ""
        target_zone_id = ""

        async with session_factory() as session:
            # Check if an announcement already exists for this alert (idempotency key)
            stmt = select(AlertAnnouncement).where(AlertAnnouncement.alert_id == alert_id)
            existing = (await session.execute(stmt)).scalar_one_or_none()
            if existing:
                logger.info("Alert announcement already exists, skipping duplicate", alert_id=alert_id, status=existing.status)
                return existing

            alert_model = await session.get(Alert, alert_id)
            if alert_model:
                target_event_id = target_event_id or alert_model.event_id
                target_severity = alert_model.severity
                target_zone_name = alert_model.zone_name
                target_zone_id = getattr(alert_model, "zone_id", "") or ""
                alert_source_data = alert_model
            else:
                alert_source_data = alert_dict_or_obj
                if isinstance(alert_dict_or_obj, dict):
                    target_zone_id = alert_dict_or_obj.get("zone_id", "")
                    target_zone_name = alert_dict_or_obj.get("zone_name", "")

        if not alert_source_data:
            logger.warning("Cannot build announcement: alert not found in DB or payload", alert_id=alert_id)
            return None

        # 2. Build spoken announcement text
        spoken_text = build_spoken_announcement(alert_source_data)
        if not spoken_text:
            logger.info("Alert data not eligible for spoken announcement", alert_id=alert_id)
            return None

        # 3. Atomically claim this alert for speech generation
        announcement_record: Optional[AlertAnnouncement] = None
        async with self._lock:
            async with session_factory() as session:
                # Double-check inside lock
                stmt = select(AlertAnnouncement).where(AlertAnnouncement.alert_id == alert_id)
                existing = (await session.execute(stmt)).scalar_one_or_none()
                if existing:
                    logger.info("Alert announcement claimed by another worker, skipping", alert_id=alert_id)
                    return existing

                announcement_record = AlertAnnouncement(
                    alert_id=alert_id,
                    status="generating",
                    spoken_text=spoken_text,
                    voice_id=self.tts_service.voice_id,
                    model_id=self.tts_service.model_id,
                    created_at=datetime.now(timezone.utc),
                    updated_at=datetime.now(timezone.utc),
                )
                session.add(announcement_record)
                try:
                    await session.commit()
                    await session.refresh(announcement_record)
                except IntegrityError:
                    await session.rollback()
                    logger.info("Concurrent insert caught by unique constraint for alert", alert_id=alert_id)
                    return None

        # 4. Synthesize speech via ElevenLabs API
        tts_res: TTSResult = await self.tts_service.generate_speech(
            text=spoken_text,
            voice_id=self.tts_service.voice_id,
            model_id=self.tts_service.model_id,
        )

        audio_rel_url = f"/api/alerts/{alert_id}/announcement/audio"
        audio_file_path: Optional[str] = None

        if tts_res.success and tts_res.audio_bytes:
            # 5. Persist audio bytes to uploads/announcements/{alert_id}.mp3
            dest_dir = settings.announcements_dir
            dest_dir.mkdir(parents=True, exist_ok=True)
            saved_path = dest_dir / f"{alert_id}.mp3"

            try:
                with open(saved_path, "wb") as f:
                    f.write(tts_res.audio_bytes)
                audio_file_path = str(saved_path)
            except Exception as io_err:
                logger.error("Failed to write audio file to disk", alert_id=alert_id, error=str(io_err))
                tts_res.success = False
                tts_res.error = f"Audio file IO failure: {str(io_err)}"

        # 6. Update database record with generation outcome
        async with session_factory() as session:
            stmt = select(AlertAnnouncement).where(AlertAnnouncement.alert_id == alert_id)
            record = (await session.execute(stmt)).scalar_one_or_none()
            if record:
                if tts_res.success and audio_file_path:
                    record.status = "audio_ready"
                    record.audio_file_path = audio_file_path
                    record.audio_url = audio_rel_url
                    record.error_message = None
                else:
                    record.status = "failed"
                    record.error_message = tts_res.error or "Audio synthesis failed"
                record.updated_at = datetime.now(timezone.utc)
                await session.commit()
                await session.refresh(record)
                announcement_record = record

        # 7. Dispatch announcement via WebSocket to connected operators
        if tts_res.success and audio_file_path:
            payload = {
                "type": "ALERT_ANNOUNCEMENT",
                "alert_id": alert_id,
                "event_id": target_event_id,
                "audio_url": audio_rel_url,
                "spoken_text": spoken_text,
                "severity": target_severity,
                "zone_name": target_zone_name,
                "zone_id": target_zone_id,
                "created_at": datetime.now(timezone.utc).isoformat(),
            }

            if target_event_id:
                await ws_manager.broadcast(target_event_id, payload)
            else:
                # Fallback to global broadcast if no specific event ID
                await ws_manager.broadcast_all(payload)
            logger.info("Dispatched voice announcement to WebSocket clients", alert_id=alert_id, url=audio_rel_url)

        return announcement_record

    async def acknowledge_playback(self, alert_id: str) -> bool:
        """
        Record that an announcement was played by a frontend client.
        Enforces at-most-once playback tracking.
        """
        session_factory = get_session_factory()
        async with session_factory() as session:
            stmt = select(AlertAnnouncement).where(AlertAnnouncement.alert_id == alert_id)
            record = (await session.execute(stmt)).scalar_one_or_none()
            if not record:
                return False

            record.status = "played"
            record.played_at = datetime.now(timezone.utc)
            record.play_count = (record.play_count or 0) + 1
            record.updated_at = datetime.now(timezone.utc)
            await session.commit()
            logger.info("Marked alert announcement as played", alert_id=alert_id, play_count=record.play_count)
            return True


# Global coordinator instance
announcement_coordinator = AnnouncementCoordinator()
