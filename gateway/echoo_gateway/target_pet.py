"""Prepare an isolated target-pet calibration session from existing local previews."""
import argparse
import json
import pathlib
import shutil
import subprocess
import sys

from .calibration import ROOT, read_json, write_json


def prepare(config, *, binary=None, run=subprocess.run):
    source = pathlib.Path(config["sourceOutput"]).resolve()
    output = pathlib.Path(config["output"]).resolve()
    manifest = read_json(source / "manifest.json")
    library = pathlib.Path(manifest["libraryPath"]).resolve()
    target = config.get("targetPetPhotoID", config.get("targetCatPhotoID"))
    known = {p["photoID"] for p in manifest["photos"]}
    if (source == output or source in output.parents or output == library or library in output.parents
            or target not in known or target in config.get("knownOtherPetIDs", config.get("knownOtherCatIDs", []))):
        raise ValueError("invalid_target_test_configuration")
    output.mkdir(mode=0o700, parents=True, exist_ok=True)
    destination = output / "manifest.json"
    if destination.exists():
        existing = read_json(destination)
        if existing.get("targetPetPhotoID", existing.get("targetCatPhotoID")) != target or existing.get("libraryPath") != manifest["libraryPath"]:
            raise ValueError("target_output_mismatch")
        # Resume complete or pending sessions without overwriting their sample.
        if any(output.glob("run-*/sample-review.json")):
            return output, library
    for photo in manifest["photos"]:
        original = source / photo["previewFilename"]
        cached = output / photo["previewFilename"]
        if not original.resolve().is_relative_to(source) or not cached.resolve().is_relative_to(output):
            raise ValueError("invalid_preview_path")
        cached.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
        if not cached.exists():
            shutil.copyfile(original, cached)
    excluded = output / "known-other-pet-ids.json"
    write_json(excluded, config.get("knownOtherPetIDs", config.get("knownOtherCatIDs", [])))
    native = output / "native-proposal"
    executable = binary or ROOT / ".build/debug/echoo-calibrate"
    result = run([str(executable), "propose-target-sample", str(source / "manifest.json"),
                  target, str(excluded), str(native)], capture_output=True, timeout=300)
    if result.returncode:
        raise ValueError("target_sample_preparation_failed")
    proposal = read_json(native / "target-proposal.json")
    manifest.update(targetPetPhotoID=target, targetPetGroup=str(config.get("targetPetGroup", config.get("targetCatGroup", "2"))),
                    targetProposalNativeStatus=proposal["nativeStatus"], proposedIDs=proposal["proposedIDs"])
    write_json(destination, manifest)
    write_json(output / "target-test.json", {"targetPetPhotoID": target, "sourceOutput": source.name,
               "status": "awaiting_sample_review", "nativeProposal": proposal["nativeStatus"],
               "proposedCount": len(proposal["proposedIDs"]), "modelCalled": False})
    return output, library


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--configuration", required=True)
    parser.add_argument("--prepare-only", action="store_true")
    args = parser.parse_args()
    output, library = prepare(read_json(pathlib.Path(args.configuration)))
    if args.prepare_only:
        print("Isolated target-pet test prepared; awaiting sample review, no API calls.")
        return
    print("本轮固定测试指定的目标宠物；旧定稿与评分保留。相似度建议不等于同一宠物确认。", flush=True)
    subprocess.run([sys.executable, "-B", "-m", "echoo_gateway.calibration", "--library", str(library), "--output", str(output)], check=True)


if __name__ == "__main__":
    main()
