"""Deterministic announcement text generator for CrowdVision alerts."""
from __future__ import annotations

import re
from typing import Any, Optional


SEVERITY_PREFIXES = {
    "CRITICAL": "Critical alert.",
    "HIGH": "High-priority alert.",
    "MEDIUM": "Attention.",
    "LOW": "Information.",
}

CATEGORY_PHRASES = {
    "critical_density": "Severe crowd congestion detected at {location}.",
    "bottleneck": "Crowd bottleneck detected at {location}.",
    "counterflow": "Dangerous counterflow detected at {location}.",
    "rapid_accumulation": "Rapid crowd accumulation detected at {location}.",
    "occupancy_warning": "High crowd density detected at {location}.",
}

MAX_ANNOUNCEMENT_LENGTH = 250


def _clean_text(text: str) -> str:
    """Normalize whitespace and strip harmful or noisy characters."""
    if not text:
        return ""
    # Strip raw JSON brackets, braces, and internal IDs
    text = re.sub(r"\{.*?\}|\[.*?\]", "", text)
    # Collapse multiple spaces and trim
    text = " ".join(text.split())
    return text.strip()


def _extract_occupancy_pct(measurements: dict, description: str, title: str) -> Optional[str]:
    """Extract verified occupancy percentage from measurements, description, or title."""
    for key in ("occupancy_ratio", "occupancy", "occupancy_pct", "capacity_utilization_pct", "utilization_pct"):
        if key in measurements and measurements[key] is not None:
            val = measurements[key]
            try:
                if isinstance(val, str):
                    clean_val = val.replace("%", "").strip()
                    num = float(clean_val)
                    if key == "occupancy_ratio" and 0 < num <= 1.0:
                        num = num * 100.0
                    return f"{int(num)}" if num.is_integer() else f"{round(num, 1)}"
                elif isinstance(val, (int, float)):
                    num = float(val)
                    if (key == "occupancy_ratio" or (key == "occupancy" and num <= 1.0)) and num > 0:
                        num = num * 100.0
                    return f"{int(num)}" if num.is_integer() else f"{round(num, 1)}"
            except (ValueError, TypeError):
                continue

    for text in (description, title):
        if not text:
            continue
        m = re.search(r"(\d+(?:\.\d+)?)\s*%\s*(?:of\s+rated\s+zone\s+capacity|capacity|occupancy)?", text, re.IGNORECASE)
        if m:
            try:
                num = float(m.group(1))
                return f"{int(num)}" if num.is_integer() else f"{round(num, 1)}"
            except (ValueError, TypeError):
                pass
        m2 = re.search(r"occupancy(?:\s+ratio|\s+level|\s+reached|\s+at|\s*:)?\s*(\d+(?:\.\d+)?)\s*%?", text, re.IGNORECASE)
        if m2:
            try:
                num = float(m2.group(1))
                if 0 < num <= 1.0:
                    num = num * 100.0
                return f"{int(num)}" if num.is_integer() else f"{round(num, 1)}"
            except (ValueError, TypeError):
                pass

    return None


def _extract_people_count(measurements: dict) -> Optional[int]:
    """Extract verified people count from measurements."""
    for key in ("detected_people_in_zone", "people_count", "count", "person_count", "current_occupancy"):
        if key in measurements and measurements[key] is not None:
            try:
                return int(float(measurements[key]))
            except (ValueError, TypeError):
                continue
    return None


def build_spoken_announcement(alert: Any) -> Optional[str]:
    """
    Build a concise, deterministic spoken text announcement from actual alert fields.

    Accepts an Alert ORM model, AlertData dataclass, or dictionary representation.
    Returns None if mandatory alert data is missing or invalid.
    """
    if alert is None:
        return None

    # Extract fields from dict or object
    if isinstance(alert, dict):
        severity = alert.get("severity")
        zone_name = alert.get("zone_name") or alert.get("zone_id")
        category = alert.get("category", "")
        title = alert.get("title", "")
        description = alert.get("description", "")
        measurements = alert.get("supporting_measurements") or {}
    else:
        severity = getattr(alert, "severity", None)
        zone_name = getattr(alert, "zone_name", None) or getattr(alert, "zone_id", None)
        category = getattr(alert, "category", "") or ""
        title = getattr(alert, "title", "") or ""
        description = getattr(alert, "description", "") or ""
        measurements = getattr(alert, "supporting_measurements", {}) or {}

    if not isinstance(measurements, dict):
        measurements = {}

    if not severity or not isinstance(severity, str):
        return None

    sev_upper = severity.strip().upper()
    if sev_upper not in SEVERITY_PREFIXES and sev_upper not in ("CRITICAL", "HIGH", "MEDIUM", "LOW", "MODERATE", "INFO", "WARNING"):
        return None

    # Normalize severity to standard set
    if sev_upper == "MODERATE" or sev_upper == "WARNING":
        sev_norm = "MEDIUM"
    elif sev_upper == "INFO":
        sev_norm = "LOW"
    else:
        sev_norm = sev_upper

    prefix = SEVERITY_PREFIXES.get(sev_norm, "Alert.")

    # Location
    loc_clean = _clean_text(str(zone_name)) if zone_name else ""
    # Filter out raw uuid-like zone IDs from being spoken if not a readable name
    if re.match(r"^[0-9a-f]{8}-[0-9a-f]{4}-", loc_clean):
        location = "monitored zone"
    elif loc_clean:
        location = loc_clean
    else:
        location = "monitored area"

    # Category and condition phrase
    cat_lower = str(category).lower().strip()
    phrase_template = CATEGORY_PHRASES.get(cat_lower)

    # Check for verified occupancy and people counts
    occupancy_pct = _extract_occupancy_pct(measurements, str(description), str(title))
    people_count = _extract_people_count(measurements)

    if not phrase_template:
        # Check title if available to extract a meaningful condition
        title_clean = _clean_text(title)
        if "bottleneck" in title_clean.lower():
            phrase_template = CATEGORY_PHRASES["bottleneck"]
        elif "counterflow" in title_clean.lower():
            phrase_template = CATEGORY_PHRASES["counterflow"]
        elif "congestion" in title_clean.lower():
            phrase_template = CATEGORY_PHRASES["critical_density"]
        elif "accumulation" in title_clean.lower():
            phrase_template = CATEGORY_PHRASES["rapid_accumulation"]
        elif "density" in title_clean.lower() or "warning" in title_clean.lower():
            phrase_template = CATEGORY_PHRASES["occupancy_warning"]
        elif occupancy_pct is not None:
            phrase_template = "{location} has reached {occupancy} percent occupancy."
        elif people_count is not None:
            phrase_template = "{people_count} people detected at {location}."
        else:
            phrase_template = "Unusual crowd condition detected at {location}."

    # Format condition text
    if occupancy_pct is not None and "{occupancy}" in phrase_template:
        condition_text = phrase_template.format(location=location, occupancy=occupancy_pct)
    elif people_count is not None and "{people_count}" in phrase_template:
        condition_text = phrase_template.format(location=location, people_count=people_count)
    elif occupancy_pct is not None and cat_lower in ("occupancy_warning", "crowd_density", ""):
        condition_text = f"{location} has reached {occupancy_pct} percent occupancy."
    else:
        condition_text = phrase_template.format(location=location)

    # Optional verified action from intelligence system
    action_raw = (
        measurements.get("recommended_action")
        or measurements.get("action")
        or measurements.get("mitigation")
    )
    action_text = ""
    if action_raw and isinstance(action_raw, str):
        cleaned_action = _clean_text(action_raw).rstrip(".")
        if cleaned_action:
            action_text = f"{cleaned_action}."

    # Assemble announcement
    parts = [prefix, condition_text]
    if action_text:
        parts.append(action_text)

    spoken = " ".join(parts).strip()
    spoken = re.sub(r"\s+", " ", spoken)

    # Enforce safe length limit for control room speech
    if len(spoken) > MAX_ANNOUNCEMENT_LENGTH:
        # Trim at last sentence punctuation within limit
        clipped = spoken[:MAX_ANNOUNCEMENT_LENGTH]
        last_dot = clipped.rfind(".")
        if last_dot > len(prefix):
            spoken = clipped[: last_dot + 1]
        else:
            spoken = clipped.rstrip() + "..."

    return spoken
