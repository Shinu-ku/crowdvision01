"""ElevenLabs Text-to-Speech API client for CrowdVision alert announcements."""
from __future__ import annotations

from dataclasses import dataclass
from typing import Optional

import httpx

from app.config import get_settings
from app.core.logging import get_logger

logger = get_logger("services.elevenlabs")

ELEVENLABS_TTS_BASE_URL = "https://api.elevenlabs.io/v1/text-to-speech"


@dataclass
class TTSResult:
    """Result of an ElevenLabs text-to-speech synthesis request."""

    success: bool
    audio_bytes: Optional[bytes] = None
    error: Optional[str] = None
    error_code: Optional[str] = None


class ElevenLabsService:
    """Client for ElevenLabs Text-to-Speech REST API."""

    def __init__(
        self,
        api_key: Optional[str] = None,
        voice_id: Optional[str] = None,
        model_id: Optional[str] = None,
        output_format: Optional[str] = None,
        enabled: Optional[bool] = None,
        timeout_seconds: Optional[float] = None,
    ) -> None:
        settings = get_settings()
        self.api_key = api_key if api_key is not None else settings.elevenlabs_api_key
        self.voice_id = voice_id or settings.elevenlabs_voice_id or "tnSpp4vdxKPjI9w0GnoV"
        self.model_id = model_id or settings.elevenlabs_model_id or "eleven_flash_v2_5"
        self.output_format = output_format or settings.elevenlabs_output_format or "mp3_44100_128"
        self.enabled = enabled if enabled is not None else settings.elevenlabs_enabled
        self.timeout_seconds = timeout_seconds or getattr(settings, "elevenlabs_timeout_seconds", 15.0)

    def is_configured(self) -> bool:
        """Check whether the service is enabled and has an API key configured."""
        return bool(self.enabled and self.api_key and self.api_key.strip())

    async def generate_speech(
        self,
        text: str,
        voice_id: Optional[str] = None,
        model_id: Optional[str] = None,
        output_format: Optional[str] = None,
    ) -> TTSResult:
        """
        Convert text announcement into audio bytes using ElevenLabs TTS API.

        Never raises unhandled exceptions to the caller; returns TTSResult with error details.
        Never logs or leaks API keys.
        """
        if not self.enabled:
            logger.debug("ElevenLabs TTS is disabled by configuration")
            return TTSResult(
                success=False,
                error="ElevenLabs TTS is disabled by configuration",
                error_code="DISABLED",
            )

        if not self.api_key or not self.api_key.strip():
            logger.warning("ElevenLabs TTS requested but ELEVENLABS_API_KEY is not configured")
            return TTSResult(
                success=False,
                error="ELEVENLABS_API_KEY is not configured",
                error_code="NO_API_KEY",
            )

        if not text or not text.strip():
            return TTSResult(
                success=False,
                error="Cannot synthesize empty announcement text",
                error_code="EMPTY_TEXT",
            )

        target_voice_id = voice_id or self.voice_id
        target_model_id = model_id or self.model_id
        target_output_format = output_format or self.output_format

        endpoint_url = f"{ELEVENLABS_TTS_BASE_URL}/{target_voice_id}"
        headers = {
            "xi-api-key": self.api_key.strip(),
            "Content-Type": "application/json",
            "Accept": "audio/mpeg",
        }
        params = {
            "output_format": target_output_format,
        }
        body = {
            "text": text.strip(),
            "model_id": target_model_id,
        }

        logger.info(
            "Requesting ElevenLabs TTS synthesis",
            voice_id=target_voice_id,
            model_id=target_model_id,
            text_length=len(text),
        )

        try:
            async with httpx.AsyncClient(timeout=self.timeout_seconds) as client:
                response = await client.post(
                    endpoint_url,
                    headers=headers,
                    params=params,
                    json=body,
                )

            if response.status_code == 200:
                audio_data = response.content
                if not audio_data:
                    logger.error("ElevenLabs returned 200 OK but empty audio payload")
                    return TTSResult(
                        success=False,
                        error="ElevenLabs returned empty audio payload",
                        error_code="EMPTY_RESPONSE",
                    )
                logger.info(
                    "ElevenLabs TTS synthesis succeeded",
                    bytes_received=len(audio_data),
                    voice_id=target_voice_id,
                )
                return TTSResult(
                    success=True,
                    audio_bytes=audio_data,
                )

            # Handle specific error status codes
            status = response.status_code
            error_code = f"HTTP_{status}"
            error_msg = f"ElevenLabs API error: HTTP {status}"

            try:
                err_json = response.json()
                detail = err_json.get("detail", {})
                if isinstance(detail, dict):
                    error_msg = detail.get("message", error_msg)
                    err_status = detail.get("status")
                    if err_status:
                        error_code = str(err_status).upper()
                elif isinstance(detail, str):
                    error_msg = detail
            except Exception:
                pass

            if status in (401, 403):
                error_code = "AUTHENTICATION_FAILED"
                logger.error("ElevenLabs authentication failure. Please check ELEVENLABS_API_KEY", status_code=status)
            elif status == 402:
                error_code = "INSUFFICIENT_CREDITS"
                logger.error("ElevenLabs account has insufficient credits / quota exceeded", status_code=status)
            elif status == 429:
                error_code = "RATE_LIMIT_EXCEEDED"
                logger.warning("ElevenLabs API rate limit exceeded", status_code=status)
            else:
                logger.error("ElevenLabs API returned error status", status_code=status, detail=error_msg)

            return TTSResult(
                success=False,
                error=error_msg,
                error_code=error_code,
            )

        except httpx.TimeoutException:
            logger.error("ElevenLabs TTS request timed out", timeout_seconds=self.timeout_seconds)
            return TTSResult(
                success=False,
                error=f"ElevenLabs TTS request timed out after {self.timeout_seconds}s",
                error_code="TIMEOUT",
            )
        except httpx.RequestError as exc:
            logger.error("ElevenLabs network request failed", error=str(exc))
            return TTSResult(
                success=False,
                error=f"ElevenLabs connection failure: {str(exc)}",
                error_code="NETWORK_ERROR",
            )
        except Exception as exc:
            logger.error("Unexpected error during ElevenLabs TTS generation", error=str(exc))
            return TTSResult(
                success=False,
                error=f"Unexpected TTS generation error: {str(exc)}",
                error_code="UNEXPECTED_ERROR",
            )
