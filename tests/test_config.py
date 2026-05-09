import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from petcompanion import config


class ConfigTests(unittest.TestCase):
    def test_normalize_config_clamps_bubble_duration(self):
        normalized = config.normalize_config({"bubbleDurationSeconds": 99, "custom": {}})
        self.assertEqual(normalized["bubbleDurationSeconds"], 30)

    def test_load_config_merges_default_bubble_duration(self):
        with tempfile.TemporaryDirectory() as tmp:
            tmp_path = Path(tmp)
            config_dir = tmp_path / "pet-companion"
            config_dir.mkdir(parents=True)
            (config_dir / "pet.json").write_text(
                '{"petId":"tux","custom":{"name":"Buddy"}}\n',
                encoding="utf-8",
            )
            with patch("petcompanion.config._config_dir", return_value=config_dir):
                loaded = config.load_config()
        self.assertEqual(loaded["bubbleDurationSeconds"], 3)


if __name__ == "__main__":
    unittest.main()
