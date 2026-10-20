"""Offline Python → Swift contract/render integration; synthetic pixels and fake providers only."""
import copy
import hashlib
import json
import pathlib
import struct
import subprocess
import sys
import tempfile
import zlib

ROOT = pathlib.Path(__file__).resolve().parents[1]
sys.path[:0] = [str(ROOT / "gateway"), str(ROOT / "gateway/tests")]
from echoo_gateway.blue_sky import BlueSkyService, SELECTION_STRATEGY_VERSION
from echoo_gateway.cutout_verification import CutoutVerificationService
from test_blue_sky import FakeProvider as ScoreProvider, complete as scores, payload as score_request
from test_cutout_verification import FakeProvider as CutoutProvider, complete as cutouts, payload as cutout_request


def png(red=255):
    def chunk(kind, data):
        return struct.pack(">I", len(data)) + kind + data + struct.pack(">I", zlib.crc32(kind + data))
    pixels = b"".join(b"\0" + bytes([red, 60, 100, 255]) * 32 for _ in range(16))
    return (b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", 32, 16, 8, 6, 0, 0, 0))
            + chunk(b"IDAT", zlib.compress(pixels)) + chunk(b"IEND", b""))


with tempfile.TemporaryDirectory(prefix="echoo-synthetic-processing-") as directory:
    folder = pathlib.Path(directory)
    source = folder / "synthetic-source"
    source.mkdir()
    def write(name, value):
        path = folder / name
        path.write_text(json.dumps(value))
        return path
    def run(*args, success=True):
        result = subprocess.run([str(ROOT / ".build/debug/echoo-calibrate"), *map(str, args)], capture_output=True, timeout=90)
        assert (result.returncode == 0) == success, "CLI outcome mismatch: " + str(args[0])
    ids = [c * 64 for c in "abcde"]
    request = score_request(ids)
    response = BlueSkyService(ScoreProvider(scores(ids)), allow_calibration=True).evaluate(request)
    plan = folder / "plan.json"
    run("plan", write("score-input.json", request), write("score-response.json", response), plan)
    assert json.loads(plan.read_text())["state"] == "selected"
    assert json.loads(plan.read_text())["strategyVersion"] == SELECTION_STRATEGY_VERSION
    assert json.loads(plan.read_text())["posePreferredCount"] == 4
    selected = {p["slot"]: p["photoID"] for p in json.loads(plan.read_text())["selections"]}
    request = cutout_request(ids)
    image = png()
    for photo in request["photos"]:
        photo["cutoutDigest"] = hashlib.sha256(image).hexdigest()
        (folder / (photo["photoID"] + ".png")).write_bytes(image)
    request_path = write("verification-input.json", request)
    write("processing-context.json", {"libraryPath": str(source)})
    response = CutoutVerificationService(CutoutProvider(cutouts(ids)), allow_calibration=True).verify(request)
    response_path = write("cutout-response.json", response)
    verdicts = folder / "verdicts.json"
    run("verify-plan", plan, request_path, response_path, verdicts)
    assert json.loads(verdicts.read_text())["allPassed"] is True
    artwork = folder / "synthetic-artwork.png"
    run("render-auto", plan, folder, response_path, artwork)
    assert struct.unpack(">II", artwork.read_bytes()[16:24]) == (1800, 2400)
    run("render-auto", plan, folder, response_path, artwork, success=False)  # no overwrite
    run("render-auto", plan, folder, response_path, source / "forbidden.png", success=False)
    altered = copy.deepcopy(response)
    for evaluation in altered["evaluations"]:
        if evaluation["photoID"] == selected["photo1"]:
            evaluation["facts"]["rightComplete"] = "absent"
        if evaluation["photoID"] == selected["photo5"]:
            evaluation["facts"]["rightComplete"] = "unknown"
    run("verify-plan", plan, request_path, write("edge-response.json", altered), verdicts)
    values = {v["slot"]: v for v in json.loads(verdicts.read_text())["verdicts"]}
    assert values["photo1"]["state"] == "passed" and values["photo5"]["state"] == "passed"
    changed = folder / (ids[0] + ".png")
    changed.write_bytes(png(100))
    run("render-auto", plan, folder, response_path, folder / "crossed-mask.png", success=False)
    assert not (folder / "crossed-mask.png").exists()
    assert list(source.iterdir()) == []
print("Synthetic Python/Swift processing and rendering contract passed; no source photos, Vision or API requests.")
