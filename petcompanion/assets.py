"""Pet asset scanning and spritesheet serving."""

from __future__ import annotations

import json
from pathlib import Path

from petcompanion.config import pets_dirs

# Standard Codex 8x9 sprite atlas layout (matches codexAtlas.ts).
CODEX_ATLAS = {
    "cols": 8,
    "rows": 9,
    "rowsDef": [
        {"index": 0, "id": "idle", "frames": 6, "fps": 6},
        {"index": 1, "id": "running-right", "frames": 8, "fps": 8},
        {"index": 2, "id": "running-left", "frames": 8, "fps": 8},
        {"index": 3, "id": "waving", "frames": 4, "fps": 6},
        {"index": 4, "id": "jumping", "frames": 5, "fps": 7},
        {"index": 5, "id": "failed", "frames": 8, "fps": 7},
        {"index": 6, "id": "waiting", "frames": 6, "fps": 6},
        {"index": 7, "id": "running", "frames": 6, "fps": 8},
        {"index": 8, "id": "review", "frames": 6, "fps": 6},
    ],
}


def _bundled_pets_dir() -> Path:
    return Path(__file__).parent / "pet_static" / "assets"


def _scan_dir(base: Path, bundled: bool = False) -> list[dict]:
    pets: list[dict] = []
    if not base.is_dir():
        return pets
    for child in sorted(base.iterdir()):
        if not child.is_dir():
            continue
        manifest = child / "pet.json"
        if not manifest.exists():
            continue
        try:
            data = json.loads(manifest.read_text(encoding="utf-8"))
        except (json.JSONDecodeError, OSError):
            continue
        pet_id = data.get("id", child.name)
        spritesheet = child / data.get("spritesheetPath", "spritesheet.webp")
        pets.append(
            {
                "id": pet_id,
                "displayName": data.get("displayName", pet_id),
                "description": data.get("description", ""),
                "spritesheetUrl": f"/api/pets/{pet_id}/spritesheet",
                "spritesheetExt": spritesheet.suffix.lstrip("."),
                "author": data.get("author", ""),
                "tags": data.get("tags", []),
                "source": data.get("source", ""),
                "bundled": bundled,
            }
        )
    return pets


def scan_pets() -> list[dict]:
    bundled = _scan_dir(_bundled_pets_dir(), bundled=True)
    custom: list[dict] = []
    seen: set[str] = set()
    for base in pets_dirs():
        for pet in _scan_dir(base, bundled=False):
            pet_id = pet["id"]
            if pet_id in seen:
                continue
            seen.add(pet_id)
            custom.append(pet)
    return bundled + custom


def get_pet_spritesheet(pet_id: str) -> tuple[Path, str] | None:
    ext_map = {
        ".webp": "image/webp",
        ".png": "image/png",
        ".gif": "image/gif",
        ".svg": "image/svg+xml",
    }
    for base in (_bundled_pets_dir(), *pets_dirs()):
        for child in base.iterdir() if base.is_dir() else []:
            if not child.is_dir():
                continue
            manifest = child / "pet.json"
            if not manifest.exists():
                continue
            try:
                data = json.loads(manifest.read_text(encoding="utf-8"))
            except (json.JSONDecodeError, OSError):
                continue
            if data.get("id", child.name) == pet_id:
                sprite = child / data.get("spritesheetPath", "spritesheet.webp")
                if sprite.exists():
                    ct = ext_map.get(sprite.suffix, "application/octet-stream")
                    return sprite, ct
    return None


def resolve_pet(pet_id: str) -> dict | None:
    """Look up a pet manifest from bundled or user pet directories."""
    for base in (_bundled_pets_dir(), *pets_dirs()):
        if not base.is_dir():
            continue
        for child in base.iterdir():
            if not child.is_dir():
                continue
            manifest = child / "pet.json"
            if not manifest.exists():
                continue
            try:
                data = json.loads(manifest.read_text(encoding="utf-8"))
            except (json.JSONDecodeError, OSError):
                continue
            if data.get("id", child.name) != pet_id:
                continue
            spritesheet = child / data.get("spritesheetPath", "spritesheet.webp")
            if not spritesheet.exists():
                continue
            return {
                "id": pet_id,
                "displayName": data.get("displayName", pet_id),
                "description": data.get("description", ""),
                "spritesheetUrl": f"/api/pets/{pet_id}/spritesheet",
                "atlas": CODEX_ATLAS,
                "bundled": base == _bundled_pets_dir(),
            }
    return None


def resolve_bundled_pet(pet_id: str) -> dict | None:
    info = resolve_pet(pet_id)
    if not info or not info.get("bundled"):
        return None
    return info
