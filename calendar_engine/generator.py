from __future__ import annotations

import json
import shutil
import subprocess
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Any


PROJECT_ROOT = Path(__file__).resolve().parents[1]
DEFAULT_TEMPLATE_DIR = Path(__file__).resolve().parent / "templates" / "calendar_template_v1"
RENDERER_PATH = Path(__file__).resolve().parent / "renderer.py"


class GenerationError(RuntimeError):
    """Raised when the July calendar cannot be generated or fails QA."""


@dataclass(frozen=True)
class GenerationResult:
    calendar_path: Path
    preview_path: Path
    qa_report_path: Path
    qa_report: dict[str, Any]


def _read_json(path: Path) -> dict[str, Any]:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError as error:
        raise GenerationError(f"缺少运行文件：{path}") from error
    except json.JSONDecodeError as error:
        raise GenerationError(f"JSON 格式错误：{path}") from error


def _validate_run(run_dir: Path, template_dir: Path) -> None:
    if not run_dir.is_dir():
        raise GenerationError(f"运行目录不存在：{run_dir}")

    plan_path = run_dir / "treatment_plan.json"
    plan = _read_json(plan_path)
    calendar = plan.get("calendar", {})
    if (calendar.get("year"), calendar.get("month")) != (2026, 7):
        raise GenerationError("当前封装版本只保证 2026 年 7 月日历")
    if not isinstance(plan.get("days"), list) or not plan["days"]:
        raise GenerationError("treatment_plan.json 缺少日期决策")

    required_template_files = [
        template_dir / "base.png",
        template_dir / "date.png",
    ]
    missing = [str(path) for path in required_template_files if not path.exists()]
    if not any(
        (template_dir / name).exists()
        for name in ("overlay_sticker_static.png", "overlay_sticker_statistic.png")
    ):
        missing.append(str(template_dir / "overlay_sticker_static.png"))
    if missing:
        raise GenerationError("模板文件不完整：" + "、".join(missing))


def generate_july_calendar(
    run_dir: str | Path,
    *,
    template_dir: str | Path | None = None,
    output_path: str | Path | None = None,
    final_name: str = "2026年7月_AI手帐日历.png",
    preview_name: str = "2026年7月_AI手帐日历_预览.jpg",
    require_qa_pass: bool = True,
) -> GenerationResult:
    """Render a prepared July 2026 run and return only a QA-approved result."""

    resolved_run_dir = Path(run_dir).expanduser().resolve()
    resolved_template_dir = Path(template_dir or DEFAULT_TEMPLATE_DIR).expanduser().resolve()
    _validate_run(resolved_run_dir, resolved_template_dir)

    command = [
        sys.executable,
        str(RENDERER_PATH),
        "--run-dir",
        str(resolved_run_dir),
        "--template-dir",
        str(resolved_template_dir),
        "--final-name",
        final_name,
        "--preview-name",
        preview_name,
    ]
    completed = subprocess.run(
        command,
        cwd=PROJECT_ROOT,
        capture_output=True,
        text=True,
        check=False,
    )
    if completed.returncode != 0:
        detail = completed.stderr.strip() or completed.stdout.strip()
        raise GenerationError(f"日历渲染失败：{detail}")

    calendar_path = resolved_run_dir / "output" / final_name
    preview_path = resolved_run_dir / "output" / preview_name
    qa_report_path = resolved_run_dir / "reports" / "qa_report.json"
    qa_report = _read_json(qa_report_path)
    if require_qa_pass and qa_report.get("status") != "PASS":
        failures = qa_report.get("failures", [])
        detail = "；".join(str(item) for item in failures) or "未知 QA 错误"
        raise GenerationError(f"日历未通过 QA：{detail}")
    if not calendar_path.exists():
        raise GenerationError(f"渲染完成但没有找到最终图片：{calendar_path}")

    if output_path is not None:
        destination = Path(output_path).expanduser().resolve()
        destination.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(calendar_path, destination)
        calendar_path = destination

    return GenerationResult(
        calendar_path=calendar_path,
        preview_path=preview_path,
        qa_report_path=qa_report_path,
        qa_report=qa_report,
    )
