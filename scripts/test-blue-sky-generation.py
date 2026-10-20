"""Offline, version-bound Python -> Swift checks and real native PNG output.

Synthetic evidence/masks only: this does not validate real pet recognition or Vision
segmentation accuracy. No source library, credentials or model requests are needed.
"""
import argparse
import hashlib
import json
import pathlib
import struct
import subprocess
import sys
import tempfile

ROOT = pathlib.Path(__file__).resolve().parents[1]
sys.path[:0] = [str(ROOT / "gateway"), str(ROOT / "gateway/tests"), str(ROOT / "scripts")]
from echoo_gateway.blue_sky import BlueSkyService, SELECTION_STRATEGY_VERSION, VERSION
from echoo_gateway.cutout_verification import CutoutVerificationService
from test_blue_sky import FakeProvider, complete, payload
from test_cutout_verification import FakeProvider as MaskProvider, complete as masks, payload as mask_request


def synthetic_png():
    import zlib
    def chunk(kind, data):
        return struct.pack(">I", len(data)) + kind + data + struct.pack(">I", zlib.crc32(kind + data))
    width, height = 80, 100
    pixels = b"".join(b"\0" + b"".join(bytes([218, 83, 63, 255 if 10 <= x < 70 and 10 <= y < 90 else 0])
                                      for x in range(width)) for y in range(height))
    return b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", width, height, 8, 6, 0, 0, 0)) + chunk(b"IDAT", zlib.compress(pixels)) + chunk(b"IEND", b"")


def run(output):
    output.mkdir(parents=True, exist_ok=False)
    binary = ROOT / ".build/debug/echoo-calibrate"
    def cli(*args):
        result = subprocess.run([str(binary), *map(str, args)], capture_output=True, timeout=90)
        assert result.returncode == 0, "CLI step failed: " + args[0]
    def write(folder, name, value):
        path = folder / name
        path.write_text(json.dumps(value))
        return path
    order = ["photo4", "photo3", "photo2", "photo1", "photo5"]
    species_examples = ["cat", "dog", "hamster", "parrot", "turtle", "goldfish", "rabbit"]
    checks = []
    artifacts = []
    for species in species_examples:
        for count in range(6):
            folder = output / (species + "-" + str(count)); folder.mkdir()
            ids = [hashlib.sha256((species + str(i)).encode()).hexdigest() for i in range(count)]
            request = payload(ids)
            result = complete(ids)
            for photo in result["evaluations"]:
                # All composition/pose preferences fail. Hard eligibility alone
                # must still fill the standard plan whenever five photos exist.
                photo["facts"] = dict.fromkeys(photo["facts"], "absent")
                photo["facts"]["isPet"] = "present"
                photo["notApplicablePreferences"] = ["curled", "frontStandingOrSitting"] if species in ("goldfish", "turtle") else []
            provider = FakeProvider(result)
            response = BlueSkyService(provider, allow_calibration=True).evaluate(request)
            if count == 0: assert provider.calls == []
            plan_path = folder / "plan.json"
            cli("plan", write(folder, "input.json", request), write(folder, "response.json", response), plan_path)
            plan = json.loads(plan_path.read_text())
            assert plan["state"] == "selected" and len(plan["selections"]) == count
            assert plan["strategyVersion"] == SELECTION_STRATEGY_VERSION
            assert plan["hiddenSlots"] == order[:5-count]
            assert len({p["photoID"] for p in plan["selections"]}) == count
            assert plan["posePreferredCount"] == plan["compositionPreferredCount"] == 0
            checks.append({"speciesExample": species, "count": count, "mode": plan["mode"], "passed": True})
            # One full count series is enough to exercise the species-neutral renderer.
            if species != "dog": continue
            artwork = folder / "artwork.png"
            if count == 0:
                cli("render-background", artwork)
            else:
                image = synthetic_png()
                selected_ids = [p["photoID"] for p in plan["selections"]]
                request = mask_request(selected_ids)
                for photo in request["photos"]:
                    photo["cutoutDigest"] = hashlib.sha256(image).hexdigest()
                    (folder / (photo["photoID"] + ".png")).write_bytes(image)
                write(folder, "processing-context.json", {"libraryPath": str(output / "never-read-source")})
                write(folder, "verification-input.json", request)
                response = CutoutVerificationService(MaskProvider(masks(selected_ids)), allow_calibration=True).verify(request)
                response_path = write(folder, "verification-response.json", response)
                cli("render-auto", plan_path, folder, response_path, artwork)
            assert struct.unpack(">II", artwork.read_bytes()[16:24]) == (1800, 2400)
            artifacts.append({"count": count, "path": str(artwork), "sha256": hashlib.sha256(artwork.read_bytes()).hexdigest()})
    assert len({a["sha256"] for a in artifacts}) == 6
    exported = output / "exported-template"
    cli("export-template", exported)
    config = json.loads((exported / "template.json").read_text())
    assert config["supportedSubject"] == "common-pet"
    assert config["selection"]["evidenceVersion"] == VERSION
    assert config["minimumPhotoCount"] == 0 and config["fallback"]["hideOrder"] == order
    assert all(slot["requirements"] == ["isPet"] for slot in config["layout"]["slots"])
    assert config["selection"]["objectiveOrder"] == ["requiredFacts", "maximumPosePreferenceCount", "maximumCompositionPreferenceCount", "maximumTotalKnownScore", "stablePhotoID"]
    rules_path = ROOT / "templates/pets.blue-sky-green-field/1.0.0/generation-rules.json"
    if not rules_path.exists(): rules_path = ROOT.parent / "template/generation-rules.json"
    rules = json.loads(rules_path.read_text())
    assert config["generationRulesVersion"] == rules["version"]
    assert config["supportedSpeciesExamples"] == rules["input"]["supportedSpeciesExamples"]
    for slot in config["layout"]["slots"]:
        expected = set(rules["standard"]["slots"][slot["id"]]["preferredFacts"]) | {"singlePetSubject"}
        assert set(slot["preferredFacts"]) == expected
    report = {"scope": "synthetic-contract-and-native-render-only", "liveModelCalls": 0,
              "sourcePhotosRead": 0, "speciesCount": len(species_examples), "countCases": len(checks),
              "checks": checks, "artifacts": artifacts, "runtimeSpecMatchesArchive": True}
    (output / "verification.json").write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n")
    print(json.dumps({k: report[k] for k in ["scope", "liveModelCalls", "sourcePhotosRead", "speciesCount", "countCases", "runtimeSpecMatchesArchive"]}))


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--output", type=pathlib.Path)
    args = parser.parse_args()
    if args.output:
        run(args.output.resolve())
    else:
        with tempfile.TemporaryDirectory(prefix="echoo-generation-test-") as folder:
            run(pathlib.Path(folder) / "results")
