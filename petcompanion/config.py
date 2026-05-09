"""Pet companion configuration management."""

from __future__ import annotations

import json
import sys
from pathlib import Path

DEFAULT_PET_CONFIG: dict = {
    "adopted": True,
    "enabled": True,
    "petId": "tux",
    "eventMode": "full",
    "walkingEnabled": True,
    "petScale": 1,
    "bubbleDurationSeconds": 3,
    "custom": {
        "name": "Tux",
        "glyph": "\U0001f427",
        "accent": "#2c2c2c",
        "greeting": "Hi! I'm Tux. Let's code!",
    },
}

MIN_BUBBLE_DURATION_SECONDS = 1
MAX_BUBBLE_DURATION_SECONDS = 30


def _normalize_bubble_duration(value: object) -> int:
    if not isinstance(value, (int, float)) or isinstance(value, bool):
        return DEFAULT_PET_CONFIG["bubbleDurationSeconds"]
    seconds = int(round(float(value)))
    return max(MIN_BUBBLE_DURATION_SECONDS, min(MAX_BUBBLE_DURATION_SECONDS, seconds))


def normalize_config(config: dict) -> dict:
    merged = dict(DEFAULT_PET_CONFIG)
    merged.update(config)
    merged["bubbleDurationSeconds"] = _normalize_bubble_duration(
        merged.get("bubbleDurationSeconds")
    )
    custom = dict(DEFAULT_PET_CONFIG["custom"])
    custom.update(config.get("custom", {}))
    merged["custom"] = custom
    return merged


def _config_dir() -> Path:
    if sys.platform == "win32":
        base = Path.home() / "AppData" / "Local"
    else:
        base = Path.home() / ".config"
    return base / "pet-companion"


def config_file() -> Path:
    return _config_dir() / "pet.json"


def pets_dir() -> Path:
    return _config_dir() / "pets"


def legacy_codex_pets_dir() -> Path:
    return Path.home() / ".codex" / "pets"


def pets_dirs() -> list[Path]:
    primary = pets_dir()
    codex = legacy_codex_pets_dir()
    if codex == primary:
        return [primary]
    return [primary, codex]


def ensure_dirs() -> None:
    _config_dir().mkdir(parents=True, exist_ok=True)
    pets_dir().mkdir(parents=True, exist_ok=True)


def load_config() -> dict:
    path = config_file()
    if not path.exists():
        ensure_dirs()
        save_config(DEFAULT_PET_CONFIG)
        return normalize_config(DEFAULT_PET_CONFIG)
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (json.JSONDecodeError, OSError):
        return normalize_config(DEFAULT_PET_CONFIG)
    return normalize_config(data)


def save_config(config: dict) -> None:
    ensure_dirs()
    normalized = normalize_config(config)
    config_file().write_text(
        json.dumps(normalized, indent=2, ensure_ascii=False) + "\n",
        encoding="utf-8",
    )
