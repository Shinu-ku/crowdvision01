"""Unit and integration tests for ElevenLabs voice announcements integration."""
from __future__ import annotations

import asyncio
from datetime import datetime, timezone
import os
from pathlib import Path
from unittest.mock import AsyncMock, MagicMock, patch
import uuid

import httpx
from httpx import ASGITransport, AsyncClient
import pytest
from sqlalchemy import select

from app.config import get_settings
from app.database.models import Alert, AlertAnnouncement
from app.database.session import get_session_factory
from app.main import app
from app.services.announcement_builder import build_spoken_announcement
from app.services.announcement_coordinator import AnnouncementCoordinator, announcement_coordinator
from app.services.elevenlabs_service import ElevenLabsService, TTSResult


async def _setup_db():
    from app.database.session import init_db
    await init_db()


# ─────────────────────────────────────────────────────────────────────────────
# 1. Spoken Announcement Message Builder Tests
# ─────────────────────────────────────────────────────────────────────────────

def test_announcement_builder_critical_with_action():
    """Verify Critical alert with zone and recommended action produces clear spoken text."""
    alert = {
        "severity": "CRITICAL",
        "zone_name": "North Entrance",
        "category": "critical_density",
        "title": "Critical Density Alert: North Entrance at 98%",
        "description": "Severe overcrowding detected",
        "supporting_measurements": {
            "recommended_action": "Redirect incoming visitors to Entrance B immediately.",
            "occupancy_ratio": 0.98,
        },
    }
    spoken = build_spoken_announcement(alert)
    assert spoken is not None
    assert spoken.startswith("Critical alert.")
    assert "North Entrance" in spoken
    assert "Severe crowd congestion detected at North Entrance." in spoken
    assert "Redirect incoming visitors to Entrance B immediately." in spoken


def test_announcement_builder_high_bottleneck():
    """Verify High severity bottleneck alert spoken text."""
    alert = {
        "severity": "HIGH",
        "zone_name": "Main Stage",
        "category": "bottleneck",
        "title": "Bottleneck Detected: Main Stage",
        "supporting_measurements": {},
    }
    spoken = build_spoken_announcement(alert)
    assert spoken == "High-priority alert. Crowd bottleneck detected at Main Stage."


def test_announcement_builder_with_verified_occupancy_percentage():
    """Verify alert with occupancy percentage and recommended action produces concise voice text."""
    alert = {
        "severity": "CRITICAL",
        "zone_name": "Entrance A",
        "category": "occupancy_warning",
        "supporting_measurements": {
            "occupancy_ratio": 0.20,
            "recommended_action": "Immediate monitoring is required",
        },
    }
    spoken = build_spoken_announcement(alert)
    assert spoken == "Critical alert. Entrance A has reached 20 percent occupancy. Immediate monitoring is required."


def test_announcement_builder_with_scenario_occupancies():
    """Verify the 3 scenario examples from Section 2 produce expected announcements."""
    # Main Stage - 2.5%
    alt1 = {
        "severity": "LOW",
        "zone_name": "Main Stage",
        "supporting_measurements": {"occupancy": "2.5%"},
    }
    assert build_spoken_announcement(alt1) == "Information. Main Stage has reached 2.5 percent occupancy."

    # Entrance A - 20%
    alt2 = {
        "severity": "HIGH",
        "zone_name": "Entrance A",
        "supporting_measurements": {"occupancy_ratio": 0.20},
    }
    assert build_spoken_announcement(alt2) == "High-priority alert. Entrance A has reached 20 percent occupancy."

    # Emergency Corridor - 15%
    alt3 = {
        "severity": "MEDIUM",
        "zone_name": "Emergency Corridor",
        "supporting_measurements": {"capacity_utilization_pct": 15.0},
    }
    assert build_spoken_announcement(alt3) == "Attention. Emergency Corridor has reached 15 percent occupancy."


def test_announcement_builder_medium_accumulation():
    """Verify Medium severity accumulation alert spoken text."""
    alert = {
        "severity": "MEDIUM",
        "zone_name": "Food Court",
        "category": "rapid_accumulation",
    }
    spoken = build_spoken_announcement(alert)
    assert spoken == "Attention. Rapid crowd accumulation detected at Food Court."


def test_announcement_builder_low_information():
    """Verify Low severity informational alert spoken text."""
    alert = {
        "severity": "LOW",
        "zone_name": "East Corridor",
        "category": "counterflow",
    }
    spoken = build_spoken_announcement(alert)
    assert spoken == "Information. Dangerous counterflow detected at East Corridor."


def test_announcement_builder_missing_optional_fields():
    """Verify builder gracefully handles missing optional measurements, title, and action."""
    alert = {
        "severity": "HIGH",
        "zone_name": "Zone B",
    }
    spoken = build_spoken_announcement(alert)
    assert spoken is not None
    assert spoken.startswith("High-priority alert.")
    assert "Zone B" in spoken


def test_announcement_builder_invalid_alert_data():
    """Verify builder rejects invalid or missing mandatory alert data."""
    # None alert
    assert build_spoken_announcement(None) is None
    # Missing severity
    assert build_spoken_announcement({"zone_name": "North Gate"}) is None
    # Invalid severity string
    assert build_spoken_announcement({"severity": "UNKNOWN_SEV_123"}) is None
    # Empty alert
    assert build_spoken_announcement({}) is None


def test_announcement_builder_sanitizes_uuid_and_caps_length():
    """Verify builder replaces raw UUID zone identifiers with human terms and caps length."""
    raw_uuid = str(uuid.uuid4())
    alert = {
        "severity": "CRITICAL",
        "zone_name": raw_uuid,
        "category": "critical_density",
        "supporting_measurements": {
            "recommended_action": "A" * 500,  # overly long text
        },
    }
    spoken = build_spoken_announcement(alert)
    assert spoken is not None
    # Raw UUID must not be read out loud
    assert raw_uuid not in spoken
    assert "monitored zone" in spoken
    # Text length must not exceed safety limit
    assert len(spoken) <= 250


# ─────────────────────────────────────────────────────────────────────────────
# 2. ElevenLabs TTS Client Tests (Mocked API)
# ─────────────────────────────────────────────────────────────────────────────

@pytest.mark.asyncio
async def test_elevenlabs_service_successful_response():
    """Test successful ElevenLabs TTS response with mock audio bytes."""
    mock_audio_bytes = b"\xff\xfb\x90\x00FAKE_MP3_DATA"
    svc = ElevenLabsService(api_key="test_api_key_valid", enabled=True)

    with patch("httpx.AsyncClient.post") as mock_post:
        mock_resp = MagicMock()
        mock_resp.status_code = 200
        mock_resp.content = mock_audio_bytes
        mock_post.return_value = mock_resp

        result = await svc.generate_speech("Critical alert. Crowd congestion detected.")
        assert result.success is True
        assert result.audio_bytes == mock_audio_bytes
        assert result.error is None


@pytest.mark.asyncio
async def test_elevenlabs_service_invalid_api_key_401():
    """Test handling of invalid API key (HTTP 401)."""
    svc = ElevenLabsService(api_key="invalid_key", enabled=True)

    with patch("httpx.AsyncClient.post") as mock_post:
        mock_resp = MagicMock()
        mock_resp.status_code = 401
        mock_resp.json.return_value = {"detail": {"status": "invalid_api_key", "message": "Invalid API Key"}}
        mock_post.return_value = mock_resp

        result = await svc.generate_speech("Test announcement")
        assert result.success is False
        assert result.error_code == "AUTHENTICATION_FAILED"
        assert "Invalid API Key" in (result.error or "")


@pytest.mark.asyncio
async def test_elevenlabs_service_insufficient_credits_402():
    """Test handling of insufficient credits (HTTP 402)."""
    svc = ElevenLabsService(api_key="valid_key", enabled=True)

    with patch("httpx.AsyncClient.post") as mock_post:
        mock_resp = MagicMock()
        mock_resp.status_code = 402
        mock_resp.json.return_value = {"detail": {"status": "quota_exceeded", "message": "Insufficient credits"}}
        mock_post.return_value = mock_resp

        result = await svc.generate_speech("Test announcement")
        assert result.success is False
        assert result.error_code == "INSUFFICIENT_CREDITS"


@pytest.mark.asyncio
async def test_elevenlabs_service_rate_limit_429():
    """Test handling of rate limit (HTTP 429)."""
    svc = ElevenLabsService(api_key="valid_key", enabled=True)

    with patch("httpx.AsyncClient.post") as mock_post:
        mock_resp = MagicMock()
        mock_resp.status_code = 429
        mock_resp.json.return_value = {"detail": {"message": "Too many requests"}}
        mock_post.return_value = mock_resp

        result = await svc.generate_speech("Test announcement")
        assert result.success is False
        assert result.error_code == "RATE_LIMIT_EXCEEDED"


@pytest.mark.asyncio
async def test_elevenlabs_service_timeout():
    """Test handling of ElevenLabs API timeout."""
    svc = ElevenLabsService(api_key="valid_key", enabled=True, timeout_seconds=1.0)

    with patch("httpx.AsyncClient.post", side_effect=httpx.TimeoutException("Read timed out")):
        result = await svc.generate_speech("Test announcement")
        assert result.success is False
        assert result.error_code == "TIMEOUT"
        assert "timed out" in (result.error or "").lower()


@pytest.mark.asyncio
async def test_elevenlabs_service_missing_config():
    """Test service behavior when API key is empty or missing."""
    svc = ElevenLabsService(api_key="", enabled=True)
    result = await svc.generate_speech("Test announcement")
    assert result.success is False
    assert result.error_code == "NO_API_KEY"


@pytest.mark.asyncio
async def test_elevenlabs_service_disabled():
    """Test service behavior when disabled via configuration."""
    svc = ElevenLabsService(api_key="some_key", enabled=False)
    result = await svc.generate_speech("Test announcement")
    assert result.success is False
    assert result.error_code == "DISABLED"


# ─────────────────────────────────────────────────────────────────────────────
# 3. Deduplication and At-Most-Once Coordinator Tests
# ─────────────────────────────────────────────────────────────────────────────

@pytest.mark.asyncio
async def test_coordinator_announces_new_alert_successfully(tmp_path):
    """Test end-to-end coordinator workflow for a newly created alert."""
    await _setup_db()
    alert_id = f"alt_test_{uuid.uuid4().hex[:10]}"
    event_id = f"event_{uuid.uuid4().hex[:8]}"

    # Insert alert into DB
    session_factory = get_session_factory()
    async with session_factory() as session:
        alert = Alert(
            id=alert_id,
            event_id=event_id,
            zone_id="zone_north",
            zone_name="North Stand",
            category="critical_density",
            severity="CRITICAL",
            title="Critical Overcrowding",
            description="Crowd density at 96%",
            supporting_measurements={"recommended_action": "Open Exit 4."},
            status="ACTIVE",
        )
        session.add(alert)
        await session.commit()

    mock_tts = MagicMock(spec=ElevenLabsService)
    mock_tts.enabled = True
    mock_tts.voice_id = "test_voice"
    mock_tts.model_id = "eleven_flash_v2_5"
    mock_tts.generate_speech = AsyncMock(
        return_value=TTSResult(success=True, audio_bytes=b"AUDIO_DATA_BYTES")
    )

    coord = AnnouncementCoordinator(tts_service=mock_tts)

    announcement = await coord.process_new_alert(alert_id=alert_id, event_id=event_id)
    assert announcement is not None
    assert announcement.status == "audio_ready"
    assert announcement.audio_url == f"/api/alerts/{alert_id}/announcement/audio"
    assert announcement.audio_file_path is not None
    assert os.path.exists(announcement.audio_file_path)

    # Clean up test audio file
    try:
        os.remove(announcement.audio_file_path)
    except Exception:
        pass


@pytest.mark.asyncio
async def test_coordinator_deduplication_same_alert_announced_only_once():
    """Verify that calling coordinator multiple times with the same alert ID announces ONLY ONCE."""
    await _setup_db()
    alert_id = f"alt_dedup_{uuid.uuid4().hex[:10]}"
    event_id = f"event_{uuid.uuid4().hex[:8]}"

    session_factory = get_session_factory()
    async with session_factory() as session:
        alert = Alert(
            id=alert_id,
            event_id=event_id,
            zone_id="zone_gate",
            zone_name="Gate 1",
            category="bottleneck",
            severity="HIGH",
            title="Bottleneck at Gate 1",
            description="High congestion",
            status="ACTIVE",
        )
        session.add(alert)
        await session.commit()

    mock_tts = MagicMock(spec=ElevenLabsService)
    mock_tts.enabled = True
    mock_tts.voice_id = "test_voice"
    mock_tts.model_id = "eleven_flash_v2_5"
    mock_tts.generate_speech = AsyncMock(
        return_value=TTSResult(success=True, audio_bytes=b"AUDIO_BYTES_TEST")
    )

    coord = AnnouncementCoordinator(tts_service=mock_tts)

    # First call: should generate audio
    first_res = await coord.process_new_alert(alert_id=alert_id, event_id=event_id)
    assert first_res is not None
    assert mock_tts.generate_speech.call_count == 1

    # Second call (duplicate WebSocket message or redelivery): must NOT generate audio again
    second_res = await coord.process_new_alert(alert_id=alert_id, event_id=event_id)
    assert second_res is not None
    assert second_res.id == first_res.id
    # TTS must NOT have been called a second time
    assert mock_tts.generate_speech.call_count == 1

    # Clean up
    if first_res.audio_file_path and os.path.exists(first_res.audio_file_path):
        os.remove(first_res.audio_file_path)


@pytest.mark.asyncio
async def test_coordinator_concurrent_processing_deduplication():
    """Verify concurrent workers attempting to announce the same alert ID are deduplicated atomically."""
    await _setup_db()
    alert_id = f"alt_concurrent_{uuid.uuid4().hex[:10]}"
    event_id = f"event_{uuid.uuid4().hex[:8]}"

    session_factory = get_session_factory()
    async with session_factory() as session:
        alert = Alert(
            id=alert_id,
            event_id=event_id,
            zone_id="zone_plaza",
            zone_name="Central Plaza",
            category="rapid_accumulation",
            severity="HIGH",
            title="Rapid Accumulation",
            description="Crowd surging into plaza",
            status="ACTIVE",
        )
        session.add(alert)
        await session.commit()

    call_counter = 0

    async def mock_generate(*args, **kwargs):
        nonlocal call_counter
        call_counter += 1
        await asyncio.sleep(0.05)  # simulate network latency
        return TTSResult(success=True, audio_bytes=b"CONCURRENT_AUDIO_BYTES")

    mock_tts = MagicMock(spec=ElevenLabsService)
    mock_tts.enabled = True
    mock_tts.voice_id = "test_voice"
    mock_tts.model_id = "eleven_flash_v2_5"
    mock_tts.generate_speech = AsyncMock(side_effect=mock_generate)

    coord = AnnouncementCoordinator(tts_service=mock_tts)

    # Launch 5 concurrent calls for the exact same alert ID
    results = await asyncio.gather(
        coord.process_new_alert(alert_id=alert_id, event_id=event_id),
        coord.process_new_alert(alert_id=alert_id, event_id=event_id),
        coord.process_new_alert(alert_id=alert_id, event_id=event_id),
        coord.process_new_alert(alert_id=alert_id, event_id=event_id),
        coord.process_new_alert(alert_id=alert_id, event_id=event_id),
    )

    # Exactly 1 TTS synthesis should have run
    assert call_counter == 1

    # Clean up
    for r in results:
        if r and r.audio_file_path and os.path.exists(r.audio_file_path):
            try:
                os.remove(r.audio_file_path)
            except Exception:
                pass


@pytest.mark.asyncio
async def test_persistent_deduplication_after_restart():
    """Verify that once an announcement record is saved in DB, a new coordinator instance respects it."""
    await _setup_db()
    alert_id = f"alt_restart_{uuid.uuid4().hex[:10]}"
    event_id = f"event_{uuid.uuid4().hex[:8]}"

    session_factory = get_session_factory()
    async with session_factory() as session:
        alert = Alert(
            id=alert_id,
            event_id=event_id,
            zone_id="zone_exit",
            zone_name="Exit A",
            category="occupancy_warning",
            severity="MEDIUM",
            title="Density Warning",
            description="Moderate crowd accumulation",
            status="ACTIVE",
        )
        session.add(alert)
        ann = AlertAnnouncement(
            alert_id=alert_id,
            status="audio_ready",
            spoken_text="Attention. High crowd density detected at Exit A.",
            audio_url=f"/api/alerts/{alert_id}/announcement/audio",
        )
        session.add(ann)
        await session.commit()

    # Simulate fresh backend service restart with new coordinator instance
    mock_tts = MagicMock(spec=ElevenLabsService)
    mock_tts.enabled = True
    mock_tts.generate_speech = AsyncMock()
    fresh_coord = AnnouncementCoordinator(tts_service=mock_tts)

    result = await fresh_coord.process_new_alert(alert_id=alert_id, event_id=event_id)
    assert result is not None
    assert result.status == "audio_ready"
    # TTS should never have been called because DB already has the announcement record
    assert mock_tts.generate_speech.call_count == 0


@pytest.mark.asyncio
async def test_tts_failure_does_not_break_alert():
    """Verify that if TTS generation fails, status is marked 'failed' but no exception crashes the caller."""
    await _setup_db()
    alert_id = f"alt_fail_{uuid.uuid4().hex[:10]}"
    event_id = f"event_{uuid.uuid4().hex[:8]}"

    session_factory = get_session_factory()
    async with session_factory() as session:
        alert = Alert(
            id=alert_id,
            event_id=event_id,
            zone_id="zone_main",
            zone_name="Main Hall",
            category="critical_density",
            severity="CRITICAL",
            title="Critical Density",
            description="Hall full",
            status="ACTIVE",
        )
        session.add(alert)
        await session.commit()

    mock_tts = MagicMock(spec=ElevenLabsService)
    mock_tts.enabled = True
    mock_tts.voice_id = "test_voice"
    mock_tts.model_id = "eleven_flash_v2_5"
    mock_tts.generate_speech = AsyncMock(
        return_value=TTSResult(success=False, error="Quota exhausted (HTTP 402)", error_code="INSUFFICIENT_CREDITS")
    )

    coord = AnnouncementCoordinator(tts_service=mock_tts)
    res = await coord.process_new_alert(alert_id=alert_id, event_id=event_id)
    assert res is not None
    assert res.status == "failed"
    assert "Quota exhausted" in (res.error_message or "")

    # Alert itself must still be active and uncorrupted in DB
    async with session_factory() as session:
        db_alert = await session.get(Alert, alert_id)
        assert db_alert is not None
        assert db_alert.status == "ACTIVE"


# ─────────────────────────────────────────────────────────────────────────────
# 4. REST API Endpoint Tests for Announcements
# ─────────────────────────────────────────────────────────────────────────────

@pytest.mark.asyncio
async def test_alert_announcement_api_endpoints():
    """Test GET announcement, GET announcement audio, and POST ack-played endpoints."""
    await _setup_db()
    alert_id = f"alt_api_{uuid.uuid4().hex[:10]}"
    test_audio_path = get_settings().announcements_dir / f"{alert_id}.mp3"
    with open(test_audio_path, "wb") as f:
        f.write(b"\xff\xfbFAKE_MP3_STREAM_CONTENT")

    session_factory = get_session_factory()
    async with session_factory() as session:
        alert = Alert(
            id=alert_id,
            event_id="evt_api_test",
            zone_id="z_east",
            zone_name="East Gate",
            category="bottleneck",
            severity="HIGH",
            title="Bottleneck East Gate",
            description="Testing endpoint flow",
            status="ACTIVE",
        )
        session.add(alert)
        ann = AlertAnnouncement(
            alert_id=alert_id,
            status="audio_ready",
            spoken_text="High-priority alert. Crowd bottleneck detected at East Gate.",
            audio_file_path=str(test_audio_path),
            audio_url=f"/api/alerts/{alert_id}/announcement/audio",
        )
        session.add(ann)
        await session.commit()

    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as client:
        # 1. GET /api/alerts/{id}/announcement
        res_meta = await client.get(f"/api/alerts/{alert_id}/announcement")
        assert res_meta.status_code == 200
        data_meta = res_meta.json()
        assert data_meta["alert_id"] == alert_id
        assert data_meta["status"] == "audio_ready"
        assert "East Gate" in data_meta["spoken_text"]

        # 2. GET /api/alerts/{id}/announcement/audio
        res_audio = await client.get(f"/api/alerts/{alert_id}/announcement/audio")
        assert res_audio.status_code == 200
        assert res_audio.headers["content-type"] == "audio/mpeg"
        assert res_audio.content == b"\xff\xfbFAKE_MP3_STREAM_CONTENT"

        # 3. POST /api/alerts/{id}/announcement/ack-played
        res_ack = await client.post(f"/api/alerts/{alert_id}/announcement/ack-played")
        assert res_ack.status_code == 200
        assert res_ack.json()["played"] is True

        # Verify DB status updated to 'played'
        async with session_factory() as session:
            stmt = select(AlertAnnouncement).where(AlertAnnouncement.alert_id == alert_id)
            updated_ann = (await session.execute(stmt)).scalar_one_or_none()
            assert updated_ann.status == "played"
            assert updated_ann.play_count >= 1
            assert updated_ann.played_at is not None

    # Cleanup audio file
    if test_audio_path.exists():
        test_audio_path.unlink()
