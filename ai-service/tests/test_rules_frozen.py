"""The rules baseline is frozen at v0.1.0 (see event_intel/rules_baseline_v0.1.0.json).

If this fails, a rules file changed. Do not just update the hash: give the
rules a new version, write a new record, and only tune on training or
validation articles - never on the test split.
"""

import hashlib
import json
import unittest
from pathlib import Path

from event_intel import RULES_NAME, RULES_VERSION

ROOT = Path(__file__).resolve().parents[1]
RECORD = ROOT / "event_intel" / f"rules_baseline_v{RULES_VERSION}.json"


class RulesFrozenTest(unittest.TestCase):
    def test_record_matches_version(self):
        self.assertTrue(RECORD.exists(), f"No freeze record for rules version {RULES_VERSION}")
        record = json.loads(RECORD.read_text(encoding="utf-8"))
        self.assertEqual(record["name"], RULES_NAME)
        self.assertEqual(record["version"], RULES_VERSION)
        self.assertRegex(record["git_commit"], r"^[0-9a-f]{40}$")

    def test_rules_files_unchanged(self):
        record = json.loads(RECORD.read_text(encoding="utf-8"))
        for relative, expected in record["files_sha256_lf"].items():
            data = (ROOT / relative).read_bytes().replace(b"\r\n", b"\n")
            self.assertEqual(hashlib.sha256(data).hexdigest(), expected,
                             f"{relative} changed after the v{RULES_VERSION} freeze")


if __name__ == "__main__":
    unittest.main()
