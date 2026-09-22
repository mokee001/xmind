"""Baseline verification tests; real photo data and source files stay untouched."""
import contextlib
import hashlib
import io
import json
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch

from tools import verify_recollection_baseline as baseline


class BaselineTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.file = self.root / "rule.py"
        self.file.write_bytes(b"original rule")
        self.expected = {"rule.py": hashlib.sha256(self.file.read_bytes()).hexdigest()}
        self.manifest = {"version": baseline.BASELINE_VERSION, "files": self.expected,
                         "models": {}}
        self.source = json.dumps(self.manifest).encode()
        path = self.root / baseline.MANIFEST
        path.parent.mkdir()
        path.write_bytes(self.source)

    def check(self, models=False):
        with patch.object(baseline.subprocess, "check_output", return_value=self.source) as git:
            result = baseline.verify(self.root, models=models)
            self.assertEqual(git.call_args.args[0], [
                "git", "show", f"{baseline.BASELINE_COMMIT}:{baseline.MANIFEST}"])
            return result

    def test_original_files_pass_without_writes(self):
        before = {p: p.read_bytes() for p in self.root.rglob("*") if p.is_file()}
        self.assertTrue(self.check()["ok"])
        self.assertEqual(before, {p: p.read_bytes() for p in self.root.rglob("*") if p.is_file()})

    def test_changed_rule_fails(self):
        self.file.write_bytes(b"different rule")
        self.assertEqual(self.check()["file_issues"], [{"file": "rule.py", "problem": "changed"}])

    def test_missing_file_fails(self):
        self.file.unlink()
        self.assertFalse(self.check()["ok"])

    def test_editing_manifest_does_not_bypass_commit(self):
        self.file.write_bytes(b"different rule")
        self.manifest["files"]["rule.py"] = baseline.sha256(self.file)
        (self.root / baseline.MANIFEST).write_text(json.dumps(self.manifest))
        result = self.check()
        self.assertFalse(result["ok"])
        self.assertFalse(result["manifest_verified"])
        self.assertEqual(len(result["file_issues"]), 2)

    def test_model_check_is_explicit_and_missing_runtime_fails(self):
        self.assertFalse(self.check()["models_checked"])
        result = self.check(models=True)
        self.assertTrue(result["models_checked"])
        self.assertFalse(result["ok"])

    def test_model_bytes_and_runtime_fingerprints_are_both_checked(self):
        path = self.root / "outputs/selection-lab/ente/runtime.json"
        path.parent.mkdir(parents=True)
        checksum = baseline.sha256(self.file)
        expected = {"clip_image": {"sha256": checksum}}
        runtime = {"models": {"clip_image": "rule.py"}, "model_sha256": {"clip_image": checksum}}
        path.write_text(json.dumps(runtime))
        self.assertEqual(baseline.check_models(self.root, expected), [])
        self.file.write_bytes(b"different model")
        self.assertEqual(baseline.check_models(self.root, expected)[0]["problem"], "changed")
        self.file.write_bytes(b"original rule")
        runtime["model_sha256"]["clip_image"] = "wrong"
        path.write_text(json.dumps(runtime))
        self.assertEqual(baseline.check_models(self.root, expected)[0]["problem"], "runtime_fingerprint_mismatch")

    def test_cli_fails_closed_if_git_object_is_unavailable(self):
        with patch.object(baseline, "verify", side_effect=subprocess.CalledProcessError(1, "git")):
            with contextlib.redirect_stdout(io.StringIO()) as output:
                self.assertEqual(baseline.main([]), 1)
        self.assertFalse(json.loads(output.getvalue())["ok"])

    def test_cli_nonzero_for_drift_and_zero_for_match(self):
        for ok in (True, False):
            with patch.object(baseline, "verify", return_value={"ok": ok}) as verify:
                with contextlib.redirect_stdout(io.StringIO()):
                    self.assertEqual(baseline.main(["--models"]), 0 if ok else 1)
                verify.assert_called_once_with(models=True)


if __name__ == "__main__":
    unittest.main()
