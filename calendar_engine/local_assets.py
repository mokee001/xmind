from __future__ import annotations

import json
import shutil
import subprocess
from pathlib import Path
from typing import Any

from PIL import Image, ImageDraw


PROJECT_ROOT = Path(__file__).resolve().parents[1]
SWIFT_CUTOUT_SOURCE = PROJECT_ROOT / "tools" / "macos_foreground_cutout.swift"


class LocalAssetError(RuntimeError):
    """Raised when a required local execution asset cannot be prepared."""


def _write_json(path: Path, data: dict[str, Any]) -> None:
    path.write_text(
        json.dumps(data, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )


def generate_health_comfort_illustration(
    destination: Path,
    *,
    size: int = 1024,
) -> None:
    """Draw a transparent, single-focus hot-water-bottle and pillow asset."""

    scale = 3
    canvas_size = size * scale
    image = Image.new("RGBA", (canvas_size, canvas_size), (0, 0, 0, 0))
    draw = ImageDraw.Draw(image)
    ink = (62, 61, 65, 255)
    soft = (238, 235, 231, 210)
    width = 18 * scale

    pillow_box = (225 * scale, 135 * scale, 865 * scale, 685 * scale)
    draw.rounded_rectangle(
        pillow_box,
        radius=115 * scale,
        fill=soft,
        outline=ink,
        width=width,
    )
    draw.arc(
        (320 * scale, 235 * scale, 770 * scale, 610 * scale),
        205,
        335,
        fill=ink,
        width=10 * scale,
    )

    bottle_body = (170 * scale, 420 * scale, 620 * scale, 910 * scale)
    draw.rounded_rectangle(
        bottle_body,
        radius=105 * scale,
        fill=(246, 243, 239, 235),
        outline=ink,
        width=width,
    )
    draw.rounded_rectangle(
        (305 * scale, 330 * scale, 485 * scale, 470 * scale),
        radius=35 * scale,
        fill=(246, 243, 239, 235),
        outline=ink,
        width=width,
    )
    draw.line(
        [(250 * scale, 620 * scale), (540 * scale, 620 * scale)],
        fill=ink,
        width=9 * scale,
    )
    draw.arc(
        (260 * scale, 610 * scale, 530 * scale, 825 * scale),
        15,
        165,
        fill=ink,
        width=9 * scale,
    )
    draw.arc(
        (680 * scale, 650 * scale, 890 * scale, 860 * scale),
        195,
        320,
        fill=ink,
        width=9 * scale,
    )
    draw.arc(
        (735 * scale, 715 * scale, 920 * scale, 900 * scale),
        195,
        320,
        fill=ink,
        width=7 * scale,
    )

    image = image.resize((size, size), Image.Resampling.LANCZOS)
    destination.parent.mkdir(parents=True, exist_ok=True)
    image.save(destination, format="PNG", optimize=True)


def _compile_cutout_helper(run_dir: Path) -> Path:
    swiftc = shutil.which("swiftc")
    if not swiftc:
        raise LocalAssetError("没有找到 swiftc，无法运行 macOS 本地前景抠图")
    executable = run_dir / ".tools" / "foreground_cutout"
    if executable.is_file():
        return executable
    executable.parent.mkdir(parents=True, exist_ok=True)
    completed = subprocess.run(
        [swiftc, str(SWIFT_CUTOUT_SOURCE), "-o", str(executable)],
        capture_output=True,
        text=True,
        check=False,
    )
    if completed.returncode != 0:
        detail = completed.stderr.strip() or completed.stdout.strip()
        raise LocalAssetError(f"编译 macOS 本地抠图工具失败：{detail}")
    return executable


def _run_cutout(executable: Path, source: Path, destination: Path) -> None:
    destination.parent.mkdir(parents=True, exist_ok=True)
    completed = subprocess.run(
        [str(executable), str(source), str(destination)],
        capture_output=True,
        text=True,
        check=False,
    )
    if completed.returncode != 0 or not destination.is_file():
        detail = completed.stderr.strip() or completed.stdout.strip()
        raise LocalAssetError(detail or "macOS Vision 没有生成透明抠图")


def _fallback_cutout_to_contained(day: dict[str, Any], reason: str) -> None:
    source_index = int(day.get("placements", [{}])[0].get("source_index", 0))
    day["treatment"] = "non_cell_ratio_image"
    day["placements"] = [
        {
            "kind": "photo",
            "source_index": source_index,
            "fit": "contain",
            "box": [0.05, 0.03, 0.90, 0.94],
            "focal": [0.5, 0.5],
            "rotation": 0,
        }
    ]
    day["reason"] = f"{day.get('reason', '')} 本地抠图回退：{reason}"
    day["asset_execution"] = {
        "status": "FALLBACK",
        "from": "irregular_cutout",
        "to": "non_cell_ratio_image",
        "reason": reason,
    }


def prepare_local_assets(run_dir: Path) -> dict[str, Any]:
    run_dir = run_dir.expanduser().resolve()
    plan_path = run_dir / "treatment_plan.json"
    plan = json.loads(plan_path.read_text(encoding="utf-8"))
    cutout_helper: Path | None = None
    prepared: list[dict[str, Any]] = []
    fallbacks: list[dict[str, Any]] = []

    for day in plan.get("days", []):
        for placement in list(day.get("placements", [])):
            kind = str(placement.get("kind", ""))
            if kind not in {"cutout", "illustration"}:
                continue
            relative = Path(str(placement["asset"]))
            destination = relative if relative.is_absolute() else run_dir / relative
            if destination.is_file():
                continue
            if kind == "illustration":
                if day.get("illustration_category") != "health.comfort":
                    continue
                generate_health_comfort_illustration(destination)
                prepared.append(
                    {"day": int(day["day"]), "kind": kind, "asset": str(relative)}
                )
                continue

            source_index = int(placement.get("source_index", 0))
            source_value = day.get("sources", [])[source_index]
            source = Path(source_value)
            source = source if source.is_absolute() else run_dir / source
            try:
                cutout_helper = cutout_helper or _compile_cutout_helper(run_dir)
                _run_cutout(cutout_helper, source, destination)
                prepared.append(
                    {"day": int(day["day"]), "kind": kind, "asset": str(relative)}
                )
            except (LocalAssetError, IndexError) as error:
                _fallback_cutout_to_contained(day, str(error))
                fallbacks.append(
                    {"day": int(day["day"]), "kind": kind, "reason": str(error)}
                )
                break

    _write_json(plan_path, plan)
    report = {
        "schema_version": "1.0",
        "backend": "local_deterministic_assets",
        "prepared": prepared,
        "fallbacks": fallbacks,
    }
    report_path = run_dir / "reports" / "local_asset_report.json"
    report_path.parent.mkdir(parents=True, exist_ok=True)
    _write_json(report_path, report)
    return report
