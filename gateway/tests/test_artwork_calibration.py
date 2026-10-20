import copy
import json
import pathlib
import tempfile
import unittest

from echoo_gateway.artwork_calibration import process_artwork, HIDE_ORDER
from echoo_gateway.blue_sky import SELECTION_STRATEGY_VERSION
from echoo_gateway.calibration import CalibrationSession, read_json, write_json
from echoo_gateway.cutout_verification import CutoutVerificationService, FACTS
from test_cutout_verification import payload


class DynamicProvider:
    def __init__(self, facts):
        self.facts, self.calls = facts, []
    def verify(self, photos, model):
        self.calls.append([p["photoID"] for p in photos])
        return {"evaluations": [{"photoID": p["photoID"], "facts": self.facts(p["photoID"])} for p in photos]}, {}


class ArtworkCalibrationTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.output = pathlib.Path(temporary.name)
        self.ids = [str(i) * 64 for i in range(1, 7)]
        write_json(self.output / "manifest.json", {"photos": [], "proposedIDs": [], "nativeStatus": "available"})
        self.session = CalibrationSession(self.output, "SYNTHETIC_ONLY")
        self.run = self.output / "run-test"
        self.run.mkdir()
        self.session.run, self.session.chosen = self.run, self.ids
        self.original = {"state": "selected", "strategyVersion": SELECTION_STRATEGY_VERSION, "selections": [
            {"photoID": identifier, "slot": "photo" + str(i + 1)} for i, identifier in enumerate(self.ids[:5])]}
        write_json(self.run / "plan.json", self.original)
        write_json(self.run / "sample-review.json", {"reviewed": True, "ids": self.ids})
        write_json(self.run / "input.json", {"immutable": "original-full-frame-input"})
        write_json(self.run / "selection-evidence.json", {"immutable": "original-scores-and-identity"})
        self.session.report = {"plan": copy.deepcopy(self.original), "cutoutsVerified": True,
                               "cutoutReview": dict.fromkeys(self.ids[:5], "pass"), "humanScores": {self.ids[0]: {"sharpness": 4}}}
        self.session.service.evaluate = lambda *a, **k: self.fail("Processing must not rescore originals")
        self.provider = DynamicProvider(lambda _: dict.fromkeys(FACTS, "present"))
        self.session.cutout_service = CutoutVerificationService(self.provider, allow_calibration=True)
        self.commands, self.extracted = [], []
        self.native_available = True
        self.render_failure = False
        self.session.execute = self.execute

    def execute(self, command, *args):
        self.commands.append(command)
        if command == "process-selected":
            _, plan_path, folder = args
            folder.mkdir(exist_ok=True)
            selections = read_json(plan_path)["selections"]
            ids = [p["photoID"] for p in selections] if self.native_available else []
            request = payload(ids)
            request["sampleReviewed"] = False
            write_json(folder / "verification-input.json", request)
            records = []
            for p in selections:
                if p["photoID"] in ids:
                    path = folder / (p["photoID"] + ".png")
                    if not path.exists():
                        self.extracted.append(p["photoID"])
                        path.write_bytes(b"SYNTHETIC_MASK")
                    for suffix in (".original.jpg", ".masked.jpg"):
                        (folder / (p["photoID"] + suffix)).write_bytes(b"SYNTHETIC_PREVIEW")
                    records.append(dict(p, filename=p["photoID"] + ".png"))
                else:
                    records.append(dict(p, state="extractionUnavailable"))
            write_json(folder / "cutouts.json", records)
        elif command == "verify-plan":
            plan_path, request, response, destination = args
            evidence = {p["photoID"]: p for p in read_json(response)["evaluations"]}
            verdicts = []
            for p in read_json(plan_path)["selections"]:
                facts = evidence.get(p["photoID"], {}).get("facts", dict.fromkeys(FACTS, "unknown"))
                required = ["correctSubject", "anatomyPreserved", "backgroundRemoved"]
                failed = [k for k in required if facts[k] == "absent"]
                pending = [k for k in required if facts[k] == "unknown"]
                verdicts.append(dict(p, state="failed" if failed else "pending" if pending else "passed",
                                     failed=failed, unresolved=pending))
            write_json(destination, {"allPassed": all(v["state"] == "passed" for v in verdicts), "verdicts": verdicts})
        elif command == "plan":
            _, _, destination, exclusions = args
            excluded = read_json(exclusions)
            original_by_slot = {p["slot"]: p["photoID"] for p in self.original["selections"]}
            original_ids = set(original_by_slot.values())
            for hidden_count in range(6):
                slots = ["photo"+str(i) for i in range(1,6) if "photo"+str(i) not in HIDE_ORDER[:hidden_count]]
                def assign(index, chosen):
                    if index == len(slots): return chosen
                    slot = slots[index]
                    candidates = sorted(self.ids, key=lambda p: (0 if original_by_slot.get(slot)==p else 1 if p not in original_ids else 2, p))
                    for identifier in candidates:
                        if identifier in excluded.get(slot, []) or any(p["photoID"]==identifier for p in chosen): continue
                        found = assign(index+1, chosen+[{"slot":slot,"photoID":identifier}])
                        if found is not None: return found
                    return None
                selected = assign(0, [])
                if selected is not None:
                    plan = copy.deepcopy(self.original)
                    plan.update(selections=selected, hiddenSlots=HIDE_ORDER[:hidden_count],
                                mode="standard" if hidden_count==0 else "backgroundOnly" if hidden_count==5 else "fallback")
                    write_json(destination, plan)
                    break
        elif command == "render-background":
            args[-1].write_bytes(b"SYNTHETIC_BACKGROUND")
        elif command == "render-auto":
            if self.render_failure:
                raise ValueError("local_processing_failed")
            args[-1].write_bytes(b"SYNTHETIC_ARTWORK")
        else:
            self.fail("Unexpected operation: " + command)

    def process(self):
        return process_artwork(self.session, read_json, write_json)["processing"]

    def test_start_requires_review_and_does_not_touch_provider(self):
        write_json(self.run / "sample-review.json", {"reviewed": False})
        with self.assertRaisesRegex(ValueError, "artwork_sample_required"):
            self.process()
        self.assertEqual(self.provider.calls, [])
        self.assertEqual(self.commands, [])
        write_json(self.run / "sample-review.json", {"reviewed": True, "ids": self.ids[:2]})
        with self.assertRaisesRegex(ValueError, "artwork_sample_required"):
            self.process()
        write_json(self.run / "sample-review.json", {"reviewed": True, "ids": self.ids})
        self.session.report["plan"]["selections"][0]["photoID"] = "unreviewed"
        with self.assertRaisesRegex(ValueError, "artwork_sample_required"):
            self.process()
        self.assertEqual(self.provider.calls, [])

    def test_pass_renders_bound_plan_and_preserves_human_baseline_and_original_scores(self):
        before = {name: (self.run / name).read_bytes() for name in ("input.json", "selection-evidence.json", "plan.json")}
        result = self.process()
        self.assertEqual(result["state"], "passed")
        self.assertFalse(result["productionReady"])
        self.assertEqual(self.commands, ["process-selected", "verify-plan", "render-auto"])
        self.assertEqual(self.provider.calls, [self.ids[:5]])
        self.assertEqual(self.session.report["plan"], self.original)
        self.assertTrue(self.session.report["cutoutsVerified"])
        for name, data in before.items():
            self.assertEqual((self.run / name).read_bytes(), data)
        self.assertEqual(self.session.asset("artwork", "current"), (b"SYNTHETIC_ARTWORK", "image/png"))
        self.assertEqual(self.session.asset("processing-mask", self.ids[0])[1], "image/jpeg")
        with self.assertRaises(ValueError):
            self.session.asset("processed", self.ids[5])
        with self.assertRaises(ValueError):
            self.session.asset("artwork", "../manifest")

    def test_damaged_mask_excludes_only_that_slot_and_only_new_photo_uses_native_and_api(self):
        def facts(identifier):
            result = dict.fromkeys(FACTS, "present")
            if identifier == self.ids[0]:
                result["anatomyPreserved"] = "absent"
            return result
        self.provider.facts = facts
        result = self.process()
        self.assertEqual(result["state"], "passed")
        self.assertEqual(result["excluded"], {"photo1": [self.ids[0]]})
        self.assertEqual(self.session.excluded, {})
        self.assertEqual(self.provider.calls, [self.ids[:5], [self.ids[5]]])
        self.assertEqual(self.extracted, self.ids)
        self.assertEqual(result["plan"]["selections"][0]["photoID"], self.ids[5])
        self.assertEqual(self.session.report["plan"], self.original)

    def test_unknown_processing_falls_back_without_relabeling_original_photos(self):
        self.provider.facts = lambda _: dict.fromkeys(FACTS, "unknown")
        result = self.process()
        self.assertEqual(result["state"], "passed")
        self.assertEqual(result["mode"], "backgroundOnly")
        self.assertNotIn("render-auto", self.commands)
        self.assertIn("render-background", self.commands)
        self.assertEqual(self.session.excluded, {})
        self.assertEqual(self.session.report["plan"], self.original)

    def test_native_unavailable_outputs_background_without_model_calls(self):
        self.native_available = False
        result = self.process()
        self.assertEqual(result["state"], "passed")
        self.assertEqual(result["mode"], "backgroundOnly")
        self.assertEqual(self.provider.calls, [])
        self.assertIn("render-background", self.commands)

    def test_zero_selected_photos_skips_extraction_and_verification(self):
        self.original["selections"] = []
        self.session.report["plan"] = copy.deepcopy(self.original)
        write_json(self.run / "plan.json", self.original)
        result = self.process()
        self.assertEqual(result["mode"], "backgroundOnly")
        self.assertEqual(self.commands, ["render-background"])
        self.assertEqual(self.provider.calls, [])

    def test_source_edges_do_not_trigger_replacement(self):
        def facts(_):
            values = dict.fromkeys(FACTS, "present")
            values["rightComplete"] = "absent"
            values["topComplete"] = "unknown"
            return values
        self.provider.facts = facts
        result = self.process()
        self.assertEqual(result["state"], "passed")
        self.assertEqual(result["excluded"], {})
        self.assertNotIn("plan", self.commands)

    def test_failure_is_resumable_and_error_does_not_replace_saved_reviews(self):
        self.render_failure = True
        with self.assertRaisesRegex(ValueError, "local_processing_failed"):
            self.process()
        saved = read_json(self.run / "result.json")
        self.assertEqual(saved["processing"]["state"], "pending")
        self.assertEqual(saved["processing"]["errorCode"], "processing_incomplete")
        self.assertTrue(saved["cutoutsVerified"])
        self.render_failure = False
        result = self.process()
        self.assertEqual(result["state"], "passed")
        self.assertEqual(self.extracted, self.ids[:5])
        self.assertEqual(len(self.provider.calls), 1)
        self.assertEqual(len(result["attempts"]), 2)

    def test_changed_original_selection_starts_separate_job_and_cannot_reuse_stale_artwork(self):
        first = self.process()
        self.session.report["plan"]["selections"][0]["photoID"] = self.ids[5]
        write_json(self.run / "plan.json", self.session.report["plan"])
        second = self.process()
        self.assertNotEqual(first["directory"], second["directory"])
        self.assertNotEqual(first["artifact"], second["artifact"])
        self.assertEqual(len(second["attempts"]), 1)
