import copy
import contextlib
import io
import json
import pathlib
import tempfile
import threading
import types
import unittest

from echoo_gateway.calibration import CalibrationSession, identity_comparison, make_handler, public_manifest, render_page, write_json, ensure_preview_cache, PREVIEW_VERSION
from echoo_gateway.server import make_handler as gateway_handler
from echoo_gateway.blue_sky import BlueSkyService, MAX_BATCH_JPEG_BYTES
from echoo_gateway.contracts import ContractError
from test_blue_sky import FakeProvider, complete, payload
from test_gateway import InMemorySocket


class CalibrationTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.folder = pathlib.Path(self.temp.name)
        self.ids = ["a" * 64, "b" * 64]
        self.manifest = {"schemaVersion": "test", "libraryPath": "/private/test-library",
                         "photos": [{"photoID": p, "sourceName": "sample.jpg", "sourcePath": "/private/test-library/sample.jpg",
                                     "previewFilename": p + ".jpg", "width": 10, "height": 10} for p in self.ids],
                         "nativeStatus": "unavailable", "proposedIDs": [], "previewVersion": PREVIEW_VERSION}
        write_json(self.folder / "manifest.json", self.manifest)
        self.session = CalibrationSession(self.folder, "test-key-no-network")

    def test_viewer_does_not_embed_source_paths_or_script_injection(self):
        self.manifest["photos"][0]["sourceName"] = "</script><script>bad()</script>"
        public = public_manifest(self.manifest)
        self.assertNotIn("sourcePath", json.dumps(public))
        page = render_page(self.manifest)
        self.assertNotIn(b"<script>bad()", page)
        self.assertNotIn(b"/private/test-library", page)

    def test_evaluation_requires_the_current_reviewed_sample_before_any_request(self):
        with self.assertRaises(ValueError):
            self.session.evaluate({"reviewed": True, "ids": self.ids})
        self.session.run = self.folder
        self.session.chosen = self.ids
        with self.assertRaises(ValueError):
            self.session.evaluate({"reviewed": False, "ids": self.ids})
        with self.assertRaises(ValueError):
            self.session.evaluate({"reviewed": True, "ids": list(reversed(self.ids))})

    def test_asset_traversal_is_rejected(self):
        with self.assertRaises(ValueError):
            self.session.asset("preview", "../manifest")
        with self.assertRaises(ValueError):
            self.session.asset("detail", self.ids[0])

    def test_identity_ground_truth_counts_unknown_separately(self):
        result = complete(["a", "b", "c"])
        result["identity"][0].update(relation="unknown", reason="insufficientEvidence")
        result["identity"][1].update(relation="different", reason="conflictingDistinctiveFeatures")
        comparison = identity_comparison(result, {"a": "1", "b": "1", "c": "1"})
        self.assertEqual(comparison, {"confirmedPairs": 3, "agree": 1, "disagree": 1, "unknown": 1})

    def test_cannot_accept_a_missing_cutout(self):
        self.session.report = {"cutouts": [{"photoID": self.ids[0], "slot": "photo1", "state": "extractionUnavailable"}]}
        with self.assertRaises(ValueError):
            self.session.cutout_feedback({"values": {self.ids[0]: "pass"}})

    def test_all_unknown_review_cannot_overwrite_saved_verdict(self):
        self.session.run = self.folder
        self.session.report = {"cutouts": [{"photoID": self.ids[0], "slot": "photo1", "state": "awaitingHumanVerification"}],
                               "cutoutReview": {self.ids[0]: "pass"}}
        with self.assertRaisesRegex(ValueError, "cutout_review_required"):
            self.session.cutout_feedback({"values": {self.ids[0]: "unknown"}})
        self.assertEqual(self.session.report["cutoutReview"], {self.ids[0]: "pass"})

    def test_replan_retains_pass_only_for_same_photo_slot_and_mask(self):
        self.session.run = self.folder
        self.session.chosen = self.ids
        self.session.report = {"cutouts": [
            {"photoID": self.ids[0], "slot": "photo1", "filename": "a.png", "state": "awaitingHumanVerification"},
            {"photoID": self.ids[1], "slot": "photo2", "filename": "b.png", "state": "awaitingHumanVerification"}],
            "cutoutReview": dict.fromkeys(self.ids, "pass"), "cutoutsVerified": True}
        def execute(command, *args):
            if command == "plan":
                write_json(self.folder / "plan.json", {"state": "selected", "selections": []})
            elif command == "cutouts":
                (self.folder / "cutouts").mkdir(exist_ok=True)
                write_json(self.folder / "cutouts" / "cutouts.json", [
                    {"photoID": self.ids[0], "slot": "photo1", "filename": "a.png", "state": "awaitingHumanVerification"},
                    {"photoID": self.ids[1], "slot": "photo5", "filename": "b.png", "state": "awaitingHumanVerification"}])
        self.session.execute = execute
        self.session.replan()
        self.assertEqual(self.session.report["cutoutReview"], {self.ids[0]: "pass", self.ids[1]: "unknown"})
        self.assertFalse(self.session.report["cutoutsVerified"])

    def test_final_cutout_pass_is_preserved_after_saving_scores(self):
        self.session.run = self.folder
        self.session.chosen = self.ids
        five = [str(i) * 64 for i in range(1, 6)]
        self.session.report = {"plan": {"selections": [{"photoID": p} for p in five]}, "cutouts": [
            {"photoID": identifier, "slot": "photo" + str(index + 1), "state": "awaitingHumanVerification"}
            for index, identifier in enumerate(five)]}
        self.session.save_report = lambda: None
        self.session.cutout_feedback({"values": dict.fromkeys(five, "pass")})
        self.session.score_feedback({"values": {self.ids[0]: {"sharpness": 4}}})
        self.assertTrue(self.session.report["cutoutsVerified"])
        self.assertEqual(self.session.report["cutoutReview"], dict.fromkeys(five, "pass"))

    def test_failed_cutout_excludes_only_its_slot(self):
        self.session.run = self.folder
        self.session.report = {"cutouts": [{"photoID": self.ids[0], "slot": "photo1", "state": "extractionUnavailable"}]}
        self.session.replan = lambda: None
        self.session.save_report = lambda: None
        self.session.cutout_feedback({"values": {self.ids[0]: "fail"}})
        self.assertEqual(self.session.excluded, {"photo1": [self.ids[0]]})

    def test_score_feedback_does_not_replace_model_evidence(self):
        self.session.run = self.folder
        self.session.chosen = self.ids
        self.session.report = {"response": {"evaluations": [{"photoID": self.ids[0], "scores": {"sharpness": {"value": 3}}}]}}
        self.session.save_report = lambda: None
        result = self.session.score_feedback({"values": {self.ids[0]: {"sharpness": 5}}})
        self.assertEqual(result["response"]["evaluations"][0]["scores"]["sharpness"]["value"], 3)
        self.assertEqual(result["humanScores"][self.ids[0]]["sharpness"], 5)
        with self.assertRaises(ValueError):
            self.session.score_feedback({"values": {self.ids[0]: {"sharpness": True}}})

    def test_next_round_reuses_exact_previews_and_groups_without_model_or_native_call(self):
        previous = self.pending_sample(payload(self.ids))
        self.session.run, self.session.chosen = previous, self.ids
        self.session.groups = {self.ids[0]: "2"}
        self.session.report = {"cutoutsVerified": True}
        self.session.excluded = {"photo1": [self.ids[0]]}
        before = (previous / "input.json").read_bytes()
        self.session.execute = lambda *args: self.fail("Must not reprocess originals")
        self.session.service.evaluate = lambda *args, **kwargs: self.fail("Must not call a model")
        state = self.session.prepare_next_round()
        self.assertEqual(state["ids"], self.ids)
        self.assertEqual(state["humanGroups"], {self.ids[0]: "2"})
        self.assertNotEqual(self.session.run, previous)
        self.assertEqual((previous / "input.json").read_bytes(), before)
        after = json.loads((self.session.run / "input.json").read_text())
        self.assertEqual(after["photos"], json.loads(before)["photos"])
        self.assertFalse(after["sampleReviewed"])
        self.assertIsNone(self.session.report)
        self.assertEqual(self.session.excluded, {})

    def send(self, handler, target, body, headers):
        data = json.dumps(body).encode()
        text = "POST " + target + " HTTP/1.0\r\nContent-Type: application/json\r\n"
        text += "".join(k + ": " + v + "\r\n" for k, v in headers.items())
        text += "Content-Length: " + str(len(data)) + "\r\n\r\n"
        socket = InMemorySocket(text.encode() + data)
        handler(socket, ("127.0.0.1", 0), types.SimpleNamespace(server_address=("127.0.0.1", 1234)))
        head, response = bytes(socket.output).split(b"\r\n\r\n", 1)
        return int(head.split(b" ")[1]), json.loads(response)

    def test_local_review_rejects_missing_token_and_cross_origin(self):
        handler = make_handler(self.session, "test-token")
        status, _ = self.send(handler, "/prepare", {}, {"Host": "127.0.0.1:1234"})
        self.assertEqual(status, 403)
        status, _ = self.send(handler, "/prepare", {}, {"Host": "127.0.0.1:1234", "X-Echoo-Token": "test-token", "Origin": "https://elsewhere.example"})
        self.assertEqual(status, 403)

    def test_template_route_uses_authenticated_production_contract(self):
        request = payload()
        request["mode"] = "production"
        for photo in request["photos"]:
            photo.update(admissionState="passed", themes=["pets"])
        service = BlueSkyService(FakeProvider(complete()))
        handler = gateway_handler(None, "test-token", service)
        status, result = self.send(handler, "/v1/templates/blue-sky/evaluate", request, {"Authorization": "Bearer test-token"})
        self.assertEqual(status, 200)
        self.assertEqual(result["templateVersion"], "blue-sky-pet-v2")
        status, _ = self.send(handler, "/v1/templates/blue-sky/evaluate", request, {})
        self.assertEqual(status, 401)

    def test_old_pixels_are_rebuilt_even_after_successful_native_scan(self):
        legacy = copy.deepcopy(self.manifest)
        legacy.pop("previewVersion")
        legacy["nativeStatus"] = "available"
        write_json(self.folder / "manifest.json", legacy)
        calls = []
        def run(args, **kwargs):
            calls.append(args)
            rebuilt = copy.deepcopy(self.manifest)
            rebuilt["nativeStatus"] = "available"
            write_json(self.folder / "manifest.json", rebuilt)
        result = ensure_preview_cache(self.folder, pathlib.Path(self.manifest["libraryPath"]).resolve(), run=run)
        self.assertEqual(calls[0][1], "refresh-previews")
        self.assertEqual(result["previewVersion"], PREVIEW_VERSION)

    def test_legacy_cache_cannot_start_evaluation(self):
        self.session.manifest.pop("previewVersion")
        self.session.execute = lambda *args: self.fail("Must not start another local step")
        with self.assertRaisesRegex(ValueError, "preview_rebuild_required"):
            self.session.prepare(self.ids)

    def test_preview_asset_reads_current_generation_not_old_root_jpeg(self):
        identifier = self.ids[0]
        (self.folder / "verified").mkdir()
        (self.folder / "verified" / (identifier + ".jpg")).write_bytes(b"verified-pixels")
        (self.folder / (identifier + ".jpg")).write_bytes(b"old-white-cache")
        self.session.manifest["photos"][0]["previewFilename"] = "verified/" + identifier + ".jpg"
        image, kind = self.session.asset("preview", identifier)
        self.assertEqual(image, b"verified-pixels")
        self.assertEqual(kind, "image/jpeg")

    def test_decode_unavailability_is_separate_from_template_rejection(self):
        self.manifest["unavailablePhotos"] = [{"photoID": "c" * 64, "sourceName": "unavailable.heic", "reason": "previewDecodeUnavailable"}]
        public = public_manifest(self.manifest)
        self.assertEqual(public["unavailablePhotos"][0]["reason"], "previewDecodeUnavailable")
        self.assertNotIn("eligibility", public["unavailablePhotos"][0])

    def pending_sample(self, request):
        run = self.folder / "run-recovery"
        run.mkdir()
        write_json(run / "ids.json", self.ids)
        write_json(run / "input.json", request)
        write_json(run / "sample-review.json", {"reviewed": True, "ids": self.ids,
                                               "identityGroups": {self.ids[0]: "2", self.ids[1]: ""}})
        return run

    def test_restart_restores_sample_groups_and_requires_fresh_review_without_api(self):
        run = self.pending_sample(payload(self.ids))
        self.session.execute = lambda *args: self.fail("Valid previews must not be regenerated")
        self.assertTrue(self.session.restore_sample())
        self.assertEqual(self.session.review_state()["humanGroups"][self.ids[0]], "2")
        self.assertEqual(self.session.chosen, self.ids)
        self.assertFalse(json.loads((run / "input.json").read_text())["sampleReviewed"])
        self.assertIsNone(self.session.report)

    def test_restart_rebuilds_oversized_previews_and_retains_groups(self):
        import base64
        import hashlib
        request = payload(self.ids)
        for photo in request["photos"]:
            image = base64.b64decode(photo["jpegBase64"])
            image = image[:-2] + b"\0" * (MAX_BATCH_JPEG_BYTES // 2) + image[-2:]
            photo.update(jpegBase64=base64.b64encode(image).decode(), contentDigest=hashlib.sha256(image).hexdigest())
        run = self.pending_sample(request)
        calls = []
        def execute(*args):
            calls.append(args)
            write_json(run / "input.json", payload(self.ids))
        self.session.execute = execute
        self.assertTrue(self.session.restore_sample())
        self.assertEqual(len(calls), 1)
        self.assertEqual(calls[0][0], "previews")
        self.assertEqual(self.session.groups[self.ids[0]], "2")
        self.assertFalse(json.loads((run / "sample-review.json").read_text())["reviewed"])

    def test_restart_never_replays_a_request_with_saved_model_response(self):
        run = self.pending_sample(payload(self.ids))
        write_json(run / "api-response.json", {"alreadyPaid": True})
        self.session.execute = lambda *args: self.fail("Must not replay")
        self.assertFalse(self.session.restore_sample())

    def test_restart_restores_failed_sample_as_new_review_without_replaying_calls(self):
        run = self.pending_sample(payload(self.ids))
        response = {"calls": [{"model": "previous-model", "status": "failed"}]}
        write_json(run / "api-response.json", response)
        write_json(run / "result.json", {"response": response})
        original_input = (run / "input.json").read_bytes()
        self.session.execute = lambda *args: self.fail("No native work needed for valid cached previews")
        self.session.service.evaluate = lambda *args, **kwargs: self.fail("Must not call a model on startup")
        self.assertTrue(self.session.restore_sample())
        self.assertNotEqual(self.session.run, run)
        self.assertEqual(self.session.chosen, self.ids)
        self.assertEqual(self.session.groups[self.ids[0]], "2")
        self.assertEqual((run / "input.json").read_bytes(), original_input)
        self.assertEqual(json.loads((run / "api-response.json").read_text()), response)
        self.assertFalse((self.session.run / "api-response.json").exists())
        self.assertTrue((self.session.run / (self.ids[0] + ".jpg")).is_file())
        self.assertFalse(json.loads((self.session.run / "input.json").read_text())["sampleReviewed"])

    def test_restart_restores_completed_report_and_reviews_without_model_replay(self):
        run = self.pending_sample(payload(self.ids))
        response = {"calls": [{"model": "qwen3.8-flash", "status": "completed"}]}
        report = {"response": response, "plan": {"state": "selected"}, "cutouts": [], "ids": self.ids,
                  "cutoutsVerified": True, "humanScores": {self.ids[0]: {"exposure": 3}},
                  "cutoutReview": {self.ids[0]: "pass"}}
        write_json(run / "api-response.json", response)
        write_json(run / "result.json", report)
        write_json(run / "excluded.json", {"photo1": [self.ids[1]]})
        before = (run / "result.json").read_bytes()
        self.session.execute = lambda *args: self.fail("Must not run native steps")
        self.session.service.evaluate = lambda *args, **kwargs: self.fail("Must not call a model")
        self.assertTrue(self.session.restore_sample())
        self.assertEqual(self.session.report, report)
        self.assertEqual(self.session.excluded, {"photo1": [self.ids[1]]})
        self.assertEqual((run / "result.json").read_bytes(), before)

    def test_full_failed_report_restores_without_calls_and_explicit_retry_preserves_review(self):
        request = payload(self.ids)
        run = self.pending_sample(request)
        response = {"calls": [{"status": "failed", "errorCode": "qwen_transport_failed"}]}
        report = {"ids": self.ids, "response": response, "plan": {"state": "pendingEvidence"}, "cutouts": []}
        write_json(run / "api-response.json", response)
        write_json(run / "result.json", report)
        before = {p.name: p.read_bytes() for p in run.iterdir() if p.is_file()}
        self.session.execute = lambda *args: self.fail("Do not recreate reviewed previews")
        self.session.service.evaluate = lambda *args, **kwargs: self.fail("No API call at startup")
        self.assertTrue(self.session.restore_sample())
        self.assertEqual(self.session.run, run.resolve())
        self.assertEqual(self.session.report, report)
        calls = []
        def evaluate(data):
            calls.append(data)
            return {"retry": True}
        self.session.evaluate = evaluate
        self.assertEqual(self.session.retry_evaluation(), {"retry": True})
        self.assertEqual(len(calls), 1)
        self.assertTrue(calls[0]["reviewed"])
        self.assertEqual(calls[0]["groups"][self.ids[0]], "2")
        self.assertNotEqual(self.session.run, run)
        after = json.loads((self.session.run / "input.json").read_text())
        self.assertEqual(after["photos"], request["photos"])
        self.assertNotEqual(after["requestID"], request["requestID"])
        self.assertTrue(after["sampleReviewed"])
        import base64
        for photo in after["photos"]:
            self.assertEqual((self.session.run / (photo["photoID"] + ".jpg")).read_bytes(), base64.b64decode(photo["jpegBase64"]))
        for name, data in before.items():
            self.assertEqual((run / name).read_bytes(), data)

    def test_retry_rejects_completed_or_unreviewed_request_before_model_call(self):
        run = self.pending_sample(payload(self.ids))
        self.session.run, self.session.chosen = run, self.ids
        self.session.report = {"response": {"calls": [{"status": "completed"}]}}
        with self.assertRaises(ValueError):
            self.session.retry_evaluation()
        self.session.report["response"]["calls"][0]["status"] = "failed"
        review = json.loads((run / "sample-review.json").read_text())
        review["reviewed"] = False
        write_json(run / "sample-review.json", review)
        with self.assertRaises(ValueError):
            self.session.retry_evaluation()

    def test_reselect_uses_saved_analysis_and_groups_without_model_calls_or_overwriting_source(self):
        request = payload(self.ids)
        previous = self.pending_sample(request)
        response = BlueSkyService(FakeProvider(complete(self.ids)), allow_calibration=True).evaluate(request)
        write_json(previous / "api-response.json", response)
        write_json(previous / "selection-evidence.json", response)
        report = {"ids": self.ids, "response": response, "plan": {"state": "pendingEvidence"},
                  "cutouts": [], "humanGroups": {self.ids[0]: "2"}, "humanScores": {self.ids[0]: {"sharpness": 4}}}
        write_json(previous / "result.json", report)
        before = {p.name: p.read_bytes() for p in previous.iterdir() if p.is_file()}
        self.session.run, self.session.report, self.session.chosen = previous, report, self.ids
        self.session.groups = {self.ids[0]: "2"}
        self.session.service.evaluate = lambda *a, **kw: self.fail("No model call during reselection")
        self.session.cutout_service.verify = lambda *a, **kw: self.fail("No verification model during reselection")
        commands = []
        def execute(command, *args):
            commands.append(command)
            if command == "plan":
                write_json(pathlib.Path(args[2]), {"state": "pendingEvidence", "strategyVersion": "blue-sky-selection-v3", "selections": []})
            elif command == "cutouts":
                folder = pathlib.Path(args[-1]); folder.mkdir(exist_ok=True)
                write_json(folder / "cutouts.json", [])
            else:
                self.fail("Unexpected native action")
        self.session.execute = execute
        result = self.session.reselect()
        self.assertEqual(commands, ["plan", "plan", "cutouts"])
        self.assertNotEqual(self.session.run, previous)
        self.assertEqual(result["plan"]["strategyVersion"], "blue-sky-selection-v3")
        self.assertEqual(result["humanScores"], report["humanScores"])
        self.assertEqual(result["reselection"]["originalModelCalls"], 0)
        for name, data in before.items():
            self.assertEqual((previous / name).read_bytes(), data)
        self.assertEqual((self.session.run / "input.json").read_bytes(), before["input.json"])
        self.assertEqual((self.session.run / "api-response.json").read_bytes(), before["api-response.json"])
        self.assertEqual((self.session.run / "sample-review.json").read_bytes(), before["sample-review.json"])

    def test_reselect_rejects_failed_analysis_and_unreviewed_sample(self):
        previous = self.pending_sample(payload(self.ids))
        self.session.run, self.session.chosen = previous, self.ids
        self.session.report = {"response": {"calls": []}}
        write_json(previous / "api-response.json", {"calls": [{"status": "failed"}]})
        with self.assertRaisesRegex(ValueError, "selection_result_required"):
            self.session.reselect()
        write_json(previous / "api-response.json", {"calls": [{"status": "completed"}]})
        write_json(previous / "sample-review.json", {"reviewed": False, "ids": self.ids})
        with self.assertRaisesRegex(ValueError, "review_required"):
            self.session.reselect()

    def test_interrupted_reselection_restores_saved_evidence_without_model_replay(self):
        previous = self.pending_sample(payload(self.ids))
        response = {"calls": [{"status": "completed"}]}
        write_json(previous / "api-response.json", response)
        write_json(previous / "selection-evidence.json", response)
        report = {"ids": self.ids, "response": response, "plan": {"state": "pendingEvidence"}, "cutouts": []}
        write_json(previous / "result.json", report)
        self.session.run, self.session.report, self.session.chosen = previous, report, self.ids
        self.session.execute = lambda *a: (_ for _ in ()).throw(ValueError("local_plan_failed"))
        with self.assertRaisesRegex(ValueError, "local_plan_failed"):
            self.session.reselect()
        pending = self.session.run
        restarted = CalibrationSession(self.folder, "test-key-no-network")
        restarted.service.evaluate = lambda *a, **kw: self.fail("No model replay on restart")
        restarted.execute = lambda *a: self.fail("No automatic native retry on restart")
        self.assertTrue(restarted.restore_sample())
        self.assertEqual(restarted.run.resolve(), pending.resolve())
        self.assertEqual(restarted.report["response"], response)
        self.assertNotIn("strategyVersion", restarted.report["plan"])

    def test_http_reports_transport_limit_without_leaking_exception_or_key(self):
        def fail(data):
            raise ContractError("batch_preview_limit")
        self.session.evaluate = fail
        handler = make_handler(self.session, "test-token")
        with contextlib.redirect_stdout(io.StringIO()):
            status, result = self.send(handler, "/evaluate", {}, {"Host": "127.0.0.1:1234", "X-Echoo-Token": "test-token"})
        self.assertEqual(status, 400)
        self.assertEqual(result["error"], "batch_preview_limit")
        self.assertIn("6 MiB", result["message"])
        def secret_failure(data):
            raise ValueError("SYNTHETIC_SECRET_AND_PRIVATE_TEXT")
        self.session.evaluate = secret_failure
        with contextlib.redirect_stdout(io.StringIO()) as logs:
            _, result = self.send(handler, "/evaluate", {}, {"Host": "127.0.0.1:1234", "X-Echoo-Token": "test-token"})
        self.assertNotIn("SYNTHETIC_SECRET", json.dumps(result) + logs.getvalue() + (self.folder / "last-error.json").read_text())


if __name__ == "__main__":
    unittest.main()
