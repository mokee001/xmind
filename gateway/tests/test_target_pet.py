import json
import pathlib
import tempfile
import types
import unittest

from echoo_gateway.target_pet import prepare
from echoo_gateway.calibration import CalibrationSession, read_json, write_json, PREVIEW_VERSION


class TargetPetTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = pathlib.Path(temporary.name)
        self.source, self.output = self.root / "original-calibration", self.root / "target-calibration"
        self.source.mkdir()
        self.ids = ["a" * 64, "b" * 64]
        manifest = {"libraryPath": str(self.root / "source-photos"), "photos": [
            {"photoID": p, "previewFilename": p + ".jpg", "sourceName": "synthetic.jpg"} for p in self.ids],
            "proposedIDs": self.ids, "nativeStatus": "available", "previewVersion": PREVIEW_VERSION}
        write_json(self.source / "manifest.json", manifest)
        for p in self.ids:
            (self.source / (p + ".jpg")).write_bytes(b"synthetic-preview")
        self.config = {"sourceOutput": str(self.source), "output": str(self.output), "targetPetPhotoID": self.ids[0]}

    def native(self, args, **kwargs):
        folder = pathlib.Path(args[-1]); folder.mkdir()
        write_json(folder / "target-proposal.json", {"nativeStatus": "available", "proposedIDs": self.ids})
        return types.SimpleNamespace(returncode=0)

    def test_isolated_preparation_preserves_original_manifest_and_no_identity_is_assigned(self):
        original = (self.source / "manifest.json").read_bytes()
        output, _ = prepare(self.config, binary="fake-binary", run=self.native)
        self.assertEqual((self.source / "manifest.json").read_bytes(), original)
        self.assertEqual(read_json(output / "manifest.json")["targetPetPhotoID"], self.ids[0])
        self.assertEqual(read_json(output / "target-test.json")["status"], "awaiting_sample_review")
        self.assertFalse(read_json(output / "target-test.json")["modelCalled"])
        self.assertFalse(list(output.glob("run-*")))
        self.assertEqual((output / (self.ids[0] + ".jpg")).read_bytes(), b"synthetic-preview")

    def test_resume_does_not_overwrite_existing_sample_or_call_native(self):
        prepare(self.config, run=self.native)
        sample = self.output / "run-existing"; sample.mkdir()
        write_json(sample / "sample-review.json", {"reviewed": False})
        prepare(self.config, run=lambda *a, **k: self.fail("Resume cannot replay native or models"))
        self.assertFalse(read_json(sample / "sample-review.json")["reviewed"])

    def test_cannot_use_original_output_or_source_library_as_target_output(self):
        for destination in [self.source, self.root / "source-photos"]:
            with self.assertRaises(ValueError):
                prepare(dict(self.config, output=str(destination)), run=self.native)

    def test_target_reference_is_required_and_bound_to_prepared_request(self):
        prepare(self.config, run=self.native)
        session = CalibrationSession(self.output, "SYNTHETIC_ONLY")
        session.execute = lambda command, *args: write_json(pathlib.Path(args[-1]) / "input.json", {"photos": []})
        with self.assertRaisesRegex(ValueError, "target_reference_required"):
            session.prepare([self.ids[1]])
        state = session.prepare(self.ids)
        self.assertEqual(state["humanGroups"], {self.ids[0]: "2"})
        self.assertEqual(read_json(session.run / "input.json")["targetPetPhotoID"], self.ids[0])
