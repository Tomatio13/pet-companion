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
    "custom": {
        "name": "Tux",
        "glyph": "\U0001f427",
        "accent": "#2c2c2c",
        "greeting": "Hi! I'm Tux. Let's code!",
    },
}


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
        return dict(DEFAULT_PET_CONFIG)
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (json.JSONDecodeError, OSError):
        return dict(DEFAULT_PET_CONFIG)
    # Merge with defaults for forward-compat
    merged = dict(DEFAULT_PET_CONFIG)
    merged.update(data)
    custom = dict(DEFAULT_PET_CONFIG["custom"])
    custom.update(data.get("custom", {}))
    merged["custom"] = custom
    return merged


def save_config(config: dict) -> None:
    ensure_dirs()
    config_file().write_text(
        json.dumps(config, indent=2, ensure_ascii=False) + "\n",
        encoding="utf-8",
    )
