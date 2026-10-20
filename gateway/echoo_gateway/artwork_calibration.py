"""Explicit local action: selected-only extraction, API verification, slot fallback, preview.

The human-reviewed baseline, original scoring evidence and source photos are immutable.
Only the derived processing job owns its exclusions and replacement plan.
"""
import copy
import hashlib
import re
import secrets

from .blue_sky import SELECTION_STRATEGY_VERSION

HIDE_ORDER = ["photo4", "photo3", "photo2", "photo1", "photo5"]


def process_artwork(session, read, write):
    if (not session.run or not session.report or session.report.get("plan", {}).get("state") != "selected"
            or read(session.run / "sample-review.json").get("reviewed") is not True
            or read(session.run / "sample-review.json").get("ids") != session.chosen):
        raise ValueError("artwork_sample_required")
    source_plan = session.report["plan"]
    selections = source_plan.get("selections", [])
    if (len(selections) > 5 or source_plan.get("strategyVersion") != SELECTION_STRATEGY_VERSION
            or {p.get("slot") for p in selections} != set(HIDE_ORDER[len(HIDE_ORDER)-len(selections):])
            or len({p.get("photoID") for p in selections}) != len(selections)
            or any(p.get("photoID") not in session.chosen for p in selections)):
        raise ValueError("artwork_sample_required")
    source_signature = hashlib.sha256((session.run / "selection-evidence.json").read_bytes()
                                      + (session.run / "plan.json").read_bytes()
                                      + (session.run / "input.json").read_bytes()).hexdigest()
    previous = session.report.get("processing", {})
    name = previous.get("directory", "")
    reusable = (previous.get("sourceSignature") == source_signature
                and re.fullmatch(r"processing-[a-f0-9]{16}", name))
    folder = session.run / (name if reusable else "processing-" + secrets.token_hex(8))
    if folder.is_symlink():
        raise ValueError("invalid_processing_directory")
    folder.mkdir(mode=0o700, exist_ok=True)
    cache = folder / "cutouts"
    excluded_path, plan_path = folder / "excluded.json", folder / "plan.json"
    # An explicit action retries uncertain processing with the saved original
    # evidence. Previous attempt records and cached PNGs remain immutable/reusable.
    write(excluded_path, copy.deepcopy(session.excluded))
    write(plan_path, source_plan)
    processing = {"state": "running", "directory": folder.name, "sourceSignature": source_signature,
                  "mode": "automaticCutoutVerification", "productionReady": False,
                  "outlineParametersConfirmed": True, "templateVisualRelease": "1.0.0",
                  "artifactPrefix": session.run.name + "/" + folder.name + "/", "attempts": []}
    # Preserve previous attempts and artifact files. An explicit retry is a fresh
    # verification action; startup/restore never invokes this function.
    if reusable:
        processing["attempts"] = previous.get("attempts", [])
    session.report["processing"] = processing
    session.save_report()
    try:
        # Each unsuccessful iteration adds a previously unexcluded photo/slot pair.
        # A finite sample therefore bounds fallback without silently relaxing rules.
        for _ in range(len(session.chosen) * 5 + 1):
            plan = read(plan_path)
            processing["plan"] = plan
            if plan.get("state") != "selected":
                processing["state"] = plan.get("state", "pendingEvidence")
                break
            if not plan.get("selections"):
                artifact = "artwork-" + secrets.token_hex(8) + ".png"
                session.execute("render-background", folder / artifact)
                processing.update(state="passed", artifact=artifact, mode="backgroundOnly", userPhotoCount=0)
                break
            session.execute("process-selected", session.output / "manifest.json", plan_path, cache)
            request_path = cache / "verification-input.json"
            request = read(request_path)
            # The existing sample was explicitly reviewed, including privacy, before
            # original scoring. This action processes only selections from that sample.
            request["sampleReviewed"] = True
            write(request_path, request)
            attempt = folder / ("attempt-" + secrets.token_hex(8))
            attempt.mkdir(mode=0o700)
            write(attempt / "plan.json", plan)
            write(attempt / "verification-input.json", request)
            records = read(cache / "cutouts.json")
            processing["cutouts"] = records
            if request.get("photos"):
                response = session.cutout_service.verify(request, scope=str(session.output))
                write(attempt / "api-response.json", response)
                session.execute("verify-plan", plan_path, request_path, attempt / "api-response.json", attempt / "verdicts.json")
                checked = read(attempt / "verdicts.json")
            else:
                response = {"calls": []}
                checked = {"allPassed": False, "verdicts": [
                    {"slot": p["slot"], "photoID": p["photoID"], "state": "pending",
                     "failed": [], "unresolved": ["nativeExtraction"]} for p in plan["selections"]]}
                write(attempt / "verdicts.json", checked)
            processing["verdicts"] = checked["verdicts"]
            processing["attempts"].append({"directory": attempt.name, "calls": response["calls"],
                                            "verdicts": checked["verdicts"]})
            if checked.get("allPassed") is True:
                artifact = "artwork-" + secrets.token_hex(8) + ".png"
                session.execute("render-auto", plan_path, cache, attempt / "api-response.json", folder / artifact)
                processing.update(state="passed", artifact=artifact,
                                  mode=plan.get("mode", "standard"), userPhotoCount=len(plan["selections"]))
                break
            # Pending processing cannot certify a photo. Exclude it only in this
            # attempt, keep its original evidence, and continue to a smaller plan.
            failures = [v for v in checked["verdicts"] if v["state"] != "passed"]
            excluded = read(excluded_path)
            added = False
            for record in records:
                if record.get("state") == "extractionUnavailable":
                    # A missing native mask is independent of slot geometry. This
                    # attempt cannot reuse it in another slot; the source photo's
                    # admission/identity/score records remain unchanged.
                    for slot in HIDE_ORDER:
                        values = excluded.setdefault(slot, [])
                        if record["photoID"] not in values:
                            values.append(record["photoID"])
                            added = True
            for verdict in failures:
                values = excluded.setdefault(verdict["slot"], [])
                if verdict["photoID"] not in values:
                    values.append(verdict["photoID"])
                    added = True
            if not added:
                processing["state"] = "pending"
                break
            if response.get("calls") and all(c.get("status") == "failed" for c in response["calls"]):
                # A provider outage cannot verify any remaining photo. Produce the
                # static fallback now; do not repeatedly upload/retry the same pool.
                for slot in HIDE_ORDER:
                    excluded[slot] = list(session.chosen)
                processing["verificationUnavailable"] = True
            write(excluded_path, excluded)
            # Pure selection using original evidence. No original rescore and no
            # propagation of an extraction failure to other slots or themes.
            session.execute("plan", session.run / "input.json", session.run / "selection-evidence.json",
                            plan_path, excluded_path)
            session.save_report()
        else:
            raise ValueError("processing_fallback_exhausted")
        processing["excluded"] = read(excluded_path)
        processing["plan"] = read(plan_path)
        write(folder / "result.json", processing)
        session.save_report()
        return session.report
    except Exception:
        # Persist resumable evidence but never provider content or exception text.
        processing["state"] = "pending"
        processing["errorCode"] = "processing_incomplete"
        write(folder / "result.json", processing)
        session.save_report()
        raise


def processing_asset(session, kind, identifier):
    processing = (session.report or {}).get("processing", {})
    directory = processing.get("directory", "")
    if not session.run or not re.fullmatch(r"processing-[a-f0-9]{16}", directory):
        raise ValueError("missing_asset")
    folder = session.run / directory
    if kind == "artwork" and identifier == "current" and processing.get("state") == "passed":
        filename = processing.get("artifact", "")
        if not re.fullmatch(r"artwork-[a-f0-9]{16}\.png", filename):
            raise ValueError("missing_asset")
        path, mime = folder / filename, "image/png"
    elif kind in ("processed", "processing-original", "processing-mask"):
        records = processing.get("cutouts", [])
        if (not re.fullmatch(r"[a-f0-9]{64}", identifier)
                or not any(p.get("photoID") == identifier and p.get("filename") == identifier + ".png" for p in records)):
            raise ValueError("missing_asset")
        suffix = {"processed": ".png", "processing-original": ".original.jpg", "processing-mask": ".masked.jpg"}[kind]
        path = folder / "cutouts" / (identifier + suffix)
        mime = "image/png" if kind == "processed" else "image/jpeg"
    else:
        raise ValueError("missing_asset")
    if not path.is_file() or path.is_symlink() or not path.resolve().is_relative_to(session.output):
        raise ValueError("missing_asset")
    return path.read_bytes(), mime
