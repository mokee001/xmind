"""Local review harness. Images/feedback stay in ignored output; key exists only in this process."""
import argparse
import base64
import copy
import getpass
import hmac
import itertools
import json
import os
import pathlib
import re
import secrets
import shutil
import subprocess
import sys
import threading
import urllib.parse
import webbrowser
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

from .blue_sky import BlueSkyQwenProvider, BlueSkyService, validate_batch, SELECTION_STRATEGY_VERSION
from .contracts import ContractError
from .cutout_verification import CutoutVerificationService, QwenCutoutProvider
from .artwork_calibration import process_artwork, processing_asset

ROOT = pathlib.Path(__file__).resolve().parents[2]
WEB = pathlib.Path(__file__).with_name("calibration.html")
ID = re.compile(r"[a-f0-9]{64}")
PREVIEW_VERSION = "imageio-verified-pixels-v2"
ERROR_MESSAGES = {
    "batch_preview_limit": "本轮详细预览合计超过6 MiB，尚未调用模型。请关闭旧测试终端并重新运行启动入口，重建符合传输大小限制的预览；已保存的样本和宠物分组会恢复。",
    "invalid_identity_review": "宠物分组请填写1到99的整数，无法确认或多宠物照片留空。",
    "review_required": "请先核对当前这批详细预览并勾选确认，再开始评分。",
    "preview_rebuild_required": "预览版本需要更新，请重新运行启动入口。",
    "invalid_sample": "本轮请选择0到20张不重复的照片。",
    "local_preview_failed": "本机未能完成详细预览或隐私检查，请查看启动窗口；尚未调用模型。",
    "local_plan_failed": "模型结果已保存，但本机选片计算未完成。请保留测试目录以便检查。",
    "local_cutout_failed": "本机抠图步骤未完成，请保留测试目录以便检查。",
    "cutout_review_required": "当前抠图复核均为待确认。请逐项选择通过或失败；部分无法确认的照片可以保留待确认。",
    "artwork_sample_required": "请先完成本轮样本确认与原照片选片，再进行抠图自动验收。",
    "local_processing_failed": "入选照片的抠图或生成步骤未完成。原评分和人工复核已保留，请检查本地测试记录。",
    "target_reference_required": "本轮测试指定宠物，请保留目标宠物的参照照片，并在样本确认后再评分。",
    "selection_result_required": "请先取得完整的原照片评估结果，再沿用评分重新选片。",
    "step_failed_or_invalid_input": "本步骤未完成，安全错误记录已保存在本地测试目录，请交由开发者检查。",
}


def read_json(path):
    return json.loads(path.read_text())


def write_json(path, value):
    temporary = path.with_suffix(path.suffix + ".tmp")
    temporary.write_text(json.dumps(value, ensure_ascii=False, indent=2, allow_nan=False))
    temporary.replace(path)


def normalize_target_reference(manifest):
    # Migrate reference-ID field names only, never old photo facts or identity results.
    result = copy.deepcopy(manifest)
    if "targetPetPhotoID" not in result and "targetCatPhotoID" in result:
        result["targetPetPhotoID"] = result["targetCatPhotoID"]
        result["targetPetGroup"] = result.get("targetCatGroup")
    return result


def public_manifest(manifest):
    manifest = normalize_target_reference(manifest)
    return {"photos": [{key: value for key, value in photo.items() if key != "sourcePath"}
                       for photo in manifest["photos"]],
            "proposedIDs": manifest["proposedIDs"], "nativeStatus": manifest["nativeStatus"],
            "previewVersion": manifest.get("previewVersion"),
            "targetPetPhotoID": manifest.get("targetPetPhotoID"),
            "targetPetGroup": manifest.get("targetPetGroup"),
            "targetProposalNativeStatus": manifest.get("targetProposalNativeStatus"),
            "unavailablePhotos": manifest.get("unavailablePhotos") or []}


def ensure_preview_cache(output, library, *, prepare_only=False, run=subprocess.run):
    """Invalidate old pixels even when a previous native scan reported success."""
    manifest_path = output / "manifest.json"
    binary = str(ROOT / ".build/debug/echoo-calibrate")
    target_context = {}
    if manifest_path.exists():
        manifest = read_json(manifest_path)
        normalized = normalize_target_reference(manifest)
        target_context = {key: normalized[key] for key in ("targetPetPhotoID", "targetPetGroup", "targetProposalNativeStatus") if normalized.get(key) is not None}
        if pathlib.Path(manifest["libraryPath"]).resolve() != library:
            raise ValueError("source_folder_mismatch")
        if manifest.get("previewVersion") != PREVIEW_VERSION:
            print("发现旧版预览缓存，正在从原照片重建；旧测试记录保留。")
            run([binary, "refresh-previews", str(library), str(output)], check=True)
        elif manifest.get("schemaVersion") != "echoo-calibration-samples-v3" or (not prepare_only and manifest["nativeStatus"] != "available"):
            run([binary, "refresh-native", str(manifest_path)], check=True)
    else:
        run([binary, "prepare", str(library), str(output)], check=True)
    manifest = read_json(manifest_path)
    if target_context:
        manifest.update(target_context)
        write_json(manifest_path, manifest)
    if manifest.get("previewVersion") != PREVIEW_VERSION:
        raise ValueError("preview_rebuild_required")
    return manifest


def render_page(manifest, report=None):
    initial = {"manifest": public_manifest(manifest), "report": report,
               "features": {"cutoutVerification": True, "retryEvaluation": True, "reselect": True,
                            "selectionStrategyVersion": SELECTION_STRATEGY_VERSION}}
    encoded = json.dumps(initial, ensure_ascii=True).replace("<", "\\u003c")
    return WEB.read_text().replace("/*ECHOO_INITIAL_DATA*/null", encoded).encode()


def identity_comparison(response, groups):
    counts = {"confirmedPairs": 0, "agree": 0, "disagree": 0, "unknown": 0}
    for pair in response["identity"]:
        a, b = groups.get(pair["leftID"]), groups.get(pair["rightID"])
        if not a or not b:
            continue
        expected = "same" if a == b else "different"
        counts["confirmedPairs"] += 1
        counts["unknown" if pair["relation"] == "unknown" else "agree" if pair["relation"] == expected else "disagree"] += 1
    return counts


class CalibrationSession:
    def __init__(self, output, api_key, binary=None):
        self.output = pathlib.Path(output).resolve()
        self.manifest = normalize_target_reference(read_json(self.output / "manifest.json"))
        self.binary = pathlib.Path(binary or ROOT / ".build/debug/echoo-calibrate")
        self.service = BlueSkyService(BlueSkyQwenProvider(api_key=api_key), allow_calibration=True)
        self.cutout_service = CutoutVerificationService(QwenCutoutProvider(api_key=api_key), allow_calibration=True)
        self.lock = threading.Lock()
        self.run = None
        self.report = None
        self.excluded = {}
        self.chosen = []
        self.groups = {}

    def execute(self, *args):
        # No shell interpolation, credentials, source paths or provider content in error logs.
        result = subprocess.run([str(self.binary), *map(str, args)], capture_output=True, timeout=300)
        if result.returncode:
            raise ValueError({"previews": "local_preview_failed", "plan": "local_plan_failed",
                              "cutouts": "local_cutout_failed", "process-selected": "local_processing_failed",
                              "verify-plan": "local_processing_failed", "render-auto": "local_processing_failed"}.get(args[0], "step_failed_or_invalid_input"))

    def review_state(self):
        if not self.run:
            return None
        return {"ids": self.chosen, "detailPrefix": self.run.name + "/", "humanGroups": self.groups}

    def restore_sample(self):
        """Restore saved results or pending samples; never call a model on startup."""
        runs = sorted((p for p in self.output.glob("run-*") if p.is_dir() and not p.is_symlink()),
                      key=lambda p: p.stat().st_mtime, reverse=True)
        for run in runs:
            if not (run / "sample-review.json").is_file():
                continue
            retry_failed = False
            restore_report = False
            if (run / "api-response.json").exists():
                calls = read_json(run / "api-response.json").get("calls", [])
                retry_failed = bool(calls) and all(call.get("status") == "failed" for call in calls)
                if (run / "result.json").is_file():
                    saved = read_json(run / "result.json")
                    restore_report = all(key in saved for key in ("ids", "response", "plan", "cutouts"))
                if not retry_failed and not restore_report:
                    return False
            elif (run / "result.json").exists():
                return False
            review, request = read_json(run / "sample-review.json"), read_json(run / "input.json")
            ids, groups = review.get("ids"), review.get("identityGroups", {})
            if request.get("targetPetPhotoID") != self.manifest.get("targetPetPhotoID"):
                return False
            known = {p["photoID"] for p in self.manifest["photos"]}
            if (not isinstance(ids, list) or not 0 <= len(ids) <= 20 or len(set(ids)) != len(ids)
                    or any(not isinstance(p, str) or p not in known for p in ids)
                    or not isinstance(groups, dict) or any(k not in ids or not isinstance(v, str)
                       or not re.fullmatch(r"[0-9]{0,2}", v) for k, v in groups.items())
                    or [p.get("photoID") for p in request.get("photos", [])] != ids):
                return False
            checked = copy.deepcopy(request)
            checked["sampleReviewed"] = True
            try:
                validate_batch(checked)
            except ContractError as error:
                if str(error) != "batch_preview_limit" or retry_failed or restore_report:
                    return False
                print("恢复上次20张以内的样本及宠物分组，正在重建有传输大小限制的详细预览；不调用模型。")
                self.execute("previews", self.output / "manifest.json", run / "ids.json", run)
                request = read_json(run / "input.json")
                checked = copy.deepcopy(request)
                checked["sampleReviewed"] = True
                validate_batch(checked)
            if restore_report:
                report = read_json(run / "result.json")
                if report.get("ids") != ids or not all(key in report for key in ("response", "plan", "cutouts")):
                    return False
                self.run, self.chosen, self.groups, self.report = run, ids, groups, report
                excluded = run / "excluded.json"
                self.excluded = read_json(excluded) if excluded.exists() else {}
                print("已恢复上次调用失败记录、已核对照片和宠物分组；点击重试才重新调用模型。" if retry_failed
                      else "已恢复上次模型结果、人工评分和抠图复核；没有重新调用模型。")
                return True
            if retry_failed:
                # Retain the original failure report. A new run is only a draft until
                # the user reviews its previews and explicitly starts evaluation.
                previous = run
                run = self.output / ("run-" + secrets.token_hex(8))
                run.mkdir(mode=0o700)
                request["requestID"] = secrets.token_hex(16)
                write_json(run / "ids.json", ids)
                write_json(run / "retry-of.json", {"run": previous.name, "reason": "all_model_calls_failed"})
                for photo in request["photos"]:
                    (run / (photo["photoID"] + ".jpg")).write_bytes(base64.b64decode(photo["jpegBase64"], validate=True))
            request["sampleReviewed"] = False
            write_json(run / "input.json", request)
            write_json(run / "sample-review.json", {"reviewed": False, "ids": ids, "identityGroups": groups})
            self.run, self.chosen, self.groups = run, ids, groups
            print("已恢复上次样本与宠物分组，请重新核对详细预览后开始评分。")
            return True
        return False

    def prepare(self, ids):
        if self.manifest.get("previewVersion") != PREVIEW_VERSION:
            raise ValueError("preview_rebuild_required")
        known = {p["photoID"] for p in self.manifest["photos"]}
        if not isinstance(ids, list) or not 0 <= len(ids) <= 20 or any(not isinstance(p, str) or p not in known for p in ids) or len(set(ids)) != len(ids):
            raise ValueError("invalid_sample")
        target = self.manifest.get("targetPetPhotoID")
        if target and ids and target not in ids:
            raise ValueError("target_reference_required")
        self.run = self.output / ("run-" + secrets.token_hex(8))
        self.run.mkdir(mode=0o700)
        write_json(self.run / "ids.json", ids)
        self.execute("previews", self.output / "manifest.json", self.run / "ids.json", self.run)
        groups = {}
        if target:
            request = read_json(self.run / "input.json")
            request["targetPetPhotoID"] = target
            write_json(self.run / "input.json", request)
            groups[target] = self.manifest.get("targetPetGroup") or "2"
        self.chosen, self.groups, self.excluded, self.report = ids, groups, {}, None
        return self.review_state()

    def generate_background(self):
        self.prepare([])
        self.evaluate({"reviewed": True, "ids": [], "groups": {}})
        return process_artwork(self, read_json, write_json)

    def evaluate(self, data):
        if self.manifest.get("previewVersion") != PREVIEW_VERSION:
            raise ValueError("preview_rebuild_required")
        if self.run is None or data.get("reviewed") is not True or data.get("ids") != self.chosen:
            raise ValueError("review_required")
        groups = data.get("groups", {})
        if not isinstance(groups, dict) or any(k not in self.chosen or not isinstance(v, str) or not re.fullmatch(r"[0-9]{0,2}", v) for k, v in groups.items()):
            raise ValueError("invalid_identity_review")
        self.groups = {k: v for k, v in groups.items() if v}
        request = read_json(self.run / "input.json")
        request["sampleReviewed"] = True
        write_json(self.run / "input.json", request)
        write_json(self.run / "sample-review.json", {"reviewed": True, "ids": self.chosen, "identityGroups": self.groups})
        response = self.service.evaluate(request, scope=str(self.output))
        write_json(self.run / "api-response.json", response)
        selected_response = copy.deepcopy(response)
        # Human groups are a local calibration reference and override, never a model result.
        for pair in selected_response["identity"]:
            a, b = self.groups.get(pair["leftID"]), self.groups.get(pair["rightID"])
            if a and b:
                pair.update(relation="same" if a == b else "different", reason="humanReviewedIdentity",
                            provenance=["human-reviewed-calibration"])
        write_json(self.run / "selection-evidence.json", selected_response)
        self.execute("plan", self.run / "input.json", self.run / "api-response.json", self.run / "api-plan.json")
        self.replan()
        self.report.update(response=response, apiPlan=read_json(self.run / "api-plan.json"),
                           identityComparison=identity_comparison(response, self.groups), humanGroups=self.groups)
        self.save_report()
        return self.report

    def retry_evaluation(self):
        """Explicitly retry failed calls using exactly the already reviewed image bytes."""
        if not self.run or not self.report:
            raise ValueError("no_result")
        calls = self.report.get("response", {}).get("calls", [])
        if not calls or not all(call.get("status") == "failed" for call in calls):
            raise ValueError("no_result")
        previous = self.run
        request = read_json(previous / "input.json")
        review = read_json(previous / "sample-review.json")
        if (review.get("reviewed") is not True or review.get("ids") != self.chosen
                or request.get("sampleReviewed") is not True
                or [p.get("photoID") for p in request.get("photos", [])] != self.chosen):
            raise ValueError("review_required")
        validate_batch(request)
        run = self.output / ("run-" + secrets.token_hex(8))
        run.mkdir(mode=0o700)
        request["requestID"] = secrets.token_hex(16)
        write_json(run / "input.json", request)
        write_json(run / "ids.json", self.chosen)
        write_json(run / "sample-review.json", review)
        write_json(run / "retry-of.json", {"run": previous.name, "reason": "explicit_failed_call_retry",
                                           "reviewedPreviewsPreserved": True})
        for photo in request["photos"]:
            (run / (photo["photoID"] + ".jpg")).write_bytes(base64.b64decode(photo["jpegBase64"], validate=True))
        self.run, self.report, self.excluded = run, None, {}
        return self.evaluate({"ids": self.chosen, "reviewed": True, "groups": review.get("identityGroups", {})})

    def prepare_next_round(self):
        if not self.run or not self.report:
            raise ValueError("no_result")
        request = read_json(self.run / "input.json")
        checked = copy.deepcopy(request)
        checked["sampleReviewed"] = True
        validate_batch(checked)
        previous = self.run
        run = self.output / ("run-" + secrets.token_hex(8))
        run.mkdir(mode=0o700)
        request.update(requestID=secrets.token_hex(16), sampleReviewed=False)
        write_json(run / "input.json", request)
        write_json(run / "ids.json", self.chosen)
        write_json(run / "sample-review.json", {"reviewed": False, "ids": self.chosen, "identityGroups": self.groups})
        write_json(run / "comparison-to.json", {"run": previous.name, "reason": "same-sample-calibration"})
        for photo in request["photos"]:
            (run / (photo["photoID"] + ".jpg")).write_bytes(base64.b64decode(photo["jpegBase64"], validate=True))
        self.run, self.report, self.excluded = run, None, {}
        return self.review_state()

    def reselect(self):
        """Fork the analysis unchanged; apply current selection rules without any model call."""
        if not self.run or not self.report:
            raise ValueError("selection_result_required")
        response = read_json(self.run / "api-response.json")
        if self.chosen and not response.get("cacheHit") and not any(c.get("status") == "completed" for c in response.get("calls", [])):
            raise ValueError("selection_result_required")
        review = read_json(self.run / "sample-review.json")
        request = read_json(self.run / "input.json")
        if review.get("reviewed") is not True or review.get("ids") != self.chosen:
            raise ValueError("review_required")
        validate_batch(request)
        if [p["photoID"] for p in request["photos"]] != self.chosen:
            raise ValueError("review_required")
        previous = self.run
        run = self.output / ("run-" + secrets.token_hex(8))
        run.mkdir(mode=0o700)
        for name in ("input.json", "ids.json", "sample-review.json", "api-response.json", "selection-evidence.json",
                     "score-review.json", "cutout-review.json"):
            if (previous / name).is_file():
                shutil.copyfile(previous / name, run / name)
        for photo in request["photos"]:
            (run / (photo["photoID"] + ".jpg")).write_bytes(base64.b64decode(photo["jpegBase64"], validate=True))
        if (previous / "cutouts").is_dir():
            shutil.copytree(previous / "cutouts", run / "cutouts")
        write_json(run / "reselection-of.json", {"run": previous.name, "strategyVersion": SELECTION_STRATEGY_VERSION,
                                                "originalAnalysisReused": True, "originalModelCalls": 0})
        self.run, self.report = run, copy.deepcopy(self.report)
        self.report.pop("processing", None)
        self.report["detailPrefix"] = run.name + "/"
        # A failed local step must still leave a recoverable report. The saved
        # old strategy stays explicit until both planning and cutout preparation finish.
        write_json(run / "result.json", self.report)
        self.execute("plan", run / "input.json", run / "api-response.json", run / "api-plan.json")
        self.replan()
        self.report.update(apiPlan=read_json(run / "api-plan.json"),
                           reselection={"sourceRun": previous.name, "originalAnalysisReused": True,
                                        "strategyVersion": SELECTION_STRATEGY_VERSION, "originalModelCalls": 0})
        self.save_report()
        return self.report

    def replan(self):
        previous = {p["photoID"]: p for p in (self.report or {}).get("cutouts", [])}
        reviewed = (self.report or {}).get("cutoutReview", {})
        write_json(self.run / "excluded.json", self.excluded)
        self.execute("plan", self.run / "input.json", self.run / "selection-evidence.json",
                     self.run / "plan.json", self.run / "excluded.json")
        plan = read_json(self.run / "plan.json")
        cutout_dir = self.run / "cutouts"
        self.execute("cutouts", self.output / "manifest.json", self.run / "plan.json", cutout_dir)
        if self.report is None:
            self.report = {}
        self.report.update(plan=plan, cutouts=read_json(cutout_dir / "cutouts.json"),
                           detailPrefix=self.run.name + "/", ids=self.chosen)
        self.report.pop("processing", None)
        # A pass belongs to this photo in this slot with this extracted asset. Moving
        # the same photo to another slot requires checking that slot's edge conditions.
        retained = {}
        for record in self.report["cutouts"]:
            identifier = record["photoID"]
            old = previous.get(identifier, {})
            unchanged = (old.get("slot") == record["slot"]
                         and old.get("filename") == record.get("filename")
                         and old.get("state") == record.get("state") == "awaitingHumanVerification")
            retained[identifier] = "pass" if unchanged and reviewed.get(identifier) == "pass" else "unknown"
        self.report["cutoutReview"] = retained
        self.report["cutoutsVerified"] = len(retained) == len(plan["selections"]) and all(v == "pass" for v in retained.values())

    def cutout_feedback(self, data):
        if self.report is None:
            raise ValueError("no_result")
        values = data.get("values")
        current = {p["photoID"]: p for p in self.report["cutouts"]}
        if not isinstance(values, dict) or set(values) != set(current) or any(v not in ("pass", "fail", "unknown") for v in values.values()):
            raise ValueError("invalid_cutout_review")
        if current and all(v == "unknown" for v in values.values()):
            raise ValueError("cutout_review_required")
        for identifier, value in values.items():
            record = current[identifier]
            if value == "pass" and record["state"] != "awaitingHumanVerification":
                raise ValueError("missing_cutout")
        write_json(self.run / "cutout-review.json", values)
        write_json(self.run / ("cutout-review-event-" + secrets.token_hex(8) + ".json"),
                   {"slots": {identifier: record["slot"] for identifier, record in current.items()}, "values": values})
        if "fail" in values.values():
            self.report["cutoutReview"] = values
            for identifier, value in values.items():
                if value == "fail":
                    slot = current[identifier]["slot"]
                    self.excluded.setdefault(slot, [])
                    if identifier not in self.excluded[slot]:
                        self.excluded[slot].append(identifier)
            self.replan()
        else:
            self.report["cutoutReview"] = values
            self.report["cutoutsVerified"] = len(values) == len(self.report["plan"]["selections"]) and all(v == "pass" for v in values.values())
        self.save_report()
        return self.report

    def score_feedback(self, data):
        if self.report is None:
            raise ValueError("no_result")
        values = data.get("values")
        dimensions = {"sharpness", "exposure", "colorNaturalness", "cutoutFeasibility", "expression", "lifelikeness", "interest"}
        if not isinstance(values, dict):
            raise ValueError("invalid_review")
        for identifier, ratings in values.items():
            if identifier not in self.chosen or not isinstance(ratings, dict) or not set(ratings) <= dimensions or any(type(v) is not int or not 1 <= v <= 5 for v in ratings.values()):
                raise ValueError("invalid_review")
        write_json(self.run / "score-review.json", values)
        self.report["humanScores"] = values
        self.save_report()
        return self.report

    def save_report(self):
        write_json(self.run / "result.json", self.report)
        (self.output / "review.html").write_bytes(render_page(self.manifest, self.report))
        write_json(self.output / "latest-run.json", {"run": self.run.name})

    def asset(self, kind, identifier):
        if kind in ("artwork", "processed", "processing-original", "processing-mask"):
            return processing_asset(self, kind, identifier)
        if not ID.fullmatch(identifier):
            raise ValueError("invalid_id")
        if kind == "preview":
            photo = next((p for p in self.manifest["photos"] if p["photoID"] == identifier), None)
            if photo is None:
                raise ValueError("missing_asset")
            path = self.output / photo["previewFilename"]
        elif kind == "detail" and self.run and identifier in self.chosen:
            path = self.run / (identifier + ".jpg")
        elif kind == "cutout" and self.run and identifier in self.chosen:
            path = self.run / "cutouts" / (identifier + ".png")
        else:
            raise ValueError("missing_asset")
        if not path.is_file() or path.is_symlink() or not path.resolve().is_relative_to(self.output):
            raise ValueError("missing_asset")
        return path.read_bytes(), "image/png" if kind == "cutout" else "image/jpeg"


def make_handler(session, token):
    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *args):
            pass
        def send(self, status, data, kind="application/json"):
            self.send_response(status)
            self.send_header("Content-Type", kind + ("; charset=utf-8" if kind in ("application/json", "text/html") else ""))
            self.send_header("Cache-Control", "no-store")
            self.send_header("X-Content-Type-Options", "nosniff")
            self.send_header("Referrer-Policy", "no-referrer")
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)
        def authorized(self):
            host = "127.0.0.1:" + str(self.server.server_address[1])
            if self.headers.get("Host") != host:
                return False
            provided = self.headers.get("X-Echoo-Token") or urllib.parse.parse_qs(urllib.parse.urlsplit(self.path).query).get("token", [""])[0]
            return hmac.compare_digest(provided, token)
        def do_GET(self):
            if not self.authorized():
                self.send(403, b'{"error":"unauthorized"}'); return
            path = urllib.parse.urlsplit(self.path).path
            if path == "/":
                self.send(200, render_page(session.manifest, session.report or session.review_state()), "text/html"); return
            parts = path.strip("/").split("/")
            try:
                if len(parts) != 2:
                    raise ValueError()
                data, kind = session.asset(*parts)
                self.send(200, data, kind)
            except (ValueError, OSError):
                self.send(404, b'{"error":"not_found"}')
        def do_POST(self):
            if not self.authorized():
                self.send(403, b'{"error":"unauthorized"}'); return
            origin = self.headers.get("Origin")
            if origin and origin != "http://127.0.0.1:" + str(self.server.server_address[1]):
                self.send(403, b'{"error":"invalid_origin"}'); return
            if not session.lock.acquire(blocking=False):
                self.send(409, b'{"error":"step_running"}'); return
            try:
                length = int(self.headers.get("Content-Length", "0"))
                if not 0 < length <= 128 * 1024 or self.headers.get("Content-Type") != "application/json":
                    raise ValueError()
                data = json.loads(self.rfile.read(length))
                if not isinstance(data, dict):
                    raise ValueError("invalid_request")
                path = urllib.parse.urlsplit(self.path).path
                if path == "/background-artwork":
                    result = session.generate_background()
                elif path == "/prepare":
                    result = session.prepare(data.get("ids"))
                elif path == "/evaluate":
                    result = session.evaluate(data)
                elif path == "/retry-evaluate":
                    result = session.retry_evaluation()
                elif path == "/new-round":
                    result = session.prepare_next_round()
                elif path == "/reselect":
                    result = session.reselect()
                elif path == "/cutout-feedback":
                    result = session.cutout_feedback(data)
                elif path == "/score-feedback":
                    result = session.score_feedback(data)
                elif path == "/process-artwork":
                    result = process_artwork(session, read_json, write_json)
                else:
                    raise ValueError()
                self.send(200, json.dumps(result, ensure_ascii=False, allow_nan=False).encode())
            except (ValueError, TypeError, KeyError, OSError, subprocess.SubprocessError) as error:
                code = str(error) if str(error) in ERROR_MESSAGES else "step_failed_or_invalid_input"
                stage = {"/prepare": "prepare", "/evaluate": "evaluate", "/retry-evaluate": "evaluate", "/new-round": "new-round", "/reselect": "selection", "/cutout-feedback": "cutout-review",
                         "/score-feedback": "score-review", "/process-artwork": "processing"}.get(urllib.parse.urlsplit(self.path).path, "request")
                # Only allowlisted codes; never exception text, provider payloads or credentials.
                print("Test step failed: stage=" + stage + " code=" + code, flush=True)
                write_json(session.output / "last-error.json", {"stage": stage, "error": code})
                self.send(400, json.dumps({"error": code, "message": ERROR_MESSAGES[code]}, ensure_ascii=False).encode())
            finally:
                session.lock.release()
    return Handler


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--library", required=True)
    parser.add_argument("--output", required=True)
    parser.add_argument("--prepare-only", action="store_true")
    args = parser.parse_args()
    output = pathlib.Path(args.output).resolve()
    library = pathlib.Path(args.library).resolve()
    if output == library or library in output.parents:
        raise SystemExit("Output must be outside the source photo folder.")
    output.mkdir(mode=0o700, parents=True, exist_ok=True)
    manifest = ensure_preview_cache(output, library, prepare_only=args.prepare_only)
    (output / "samples.html").write_bytes(render_page(manifest))
    if args.prepare_only:
        print("Local sample viewer prepared. No API requests or cutouts.")
        return
    key = os.environ.get("DASHSCOPE_API_KEY")
    if not key:
        if not sys.stdin.isatty():
            key = ""
        elif sys.stdin.isatty():
            key = getpass.getpass("请输入 Qwen API key（输入不显示；仅生成背景可留空）：")
    # No key is needed for background-only generation. Nonempty scoring requests
    # still return explicit unknown evidence when the provider is unconfigured.
    session = CalibrationSession(output, key.strip())
    del key
    print("千问模型：" + session.service.model + "（初评、复核与抠图验收统一使用）")
    session.restore_sample()
    token = secrets.token_urlsafe(24)
    server = ThreadingHTTPServer(("127.0.0.1", 0), make_handler(session, token))
    server.daemon_threads = True
    url = "http://127.0.0.1:" + str(server.server_address[1]) + "/?token=" + token
    print("复核页面已打开。" + ("已恢复结果，可直接点击自动验收并生成预览，无需重新评分。" if session.report
                                      else "先确认样本，再点击发送评分。") + "关闭本窗口或按 Ctrl+C 结束测试。")
    webbrowser.open(url)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
