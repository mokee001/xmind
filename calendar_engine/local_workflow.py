from __future__ import annotations

import json
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


LOCAL_BACKENDS = {"local_ollama", "ollama", "qwen3_vl_local"}


class LocalWorkflowError(RuntimeError):
    """Raised when the reproducible local-model workflow cannot proceed."""


def read_json(path: Path) -> dict[str, Any]:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError as error:
        raise LocalWorkflowError(f"缺少工作流文件：{path}") from error
    except json.JSONDecodeError as error:
        raise LocalWorkflowError(f"JSON 格式错误：{path}") from error


def validate_local_configuration(project_root: Path) -> dict[str, Any]:
    config = read_json(project_root / "calendar_engine" / "config.json")
    backend = str(config.get("decision_backend", "")).strip().lower()
    if backend not in LOCAL_BACKENDS:
        raise LocalWorkflowError(
            "当前 decision_backend 不是本地 Ollama，请先切换为 local_ollama"
        )
    if not config.get("local_model_enabled"):
        raise LocalWorkflowError("local_model_enabled 尚未启用")
    model = str(config.get("local_ollama_decision_model", "")).strip()
    if not model:
        raise LocalWorkflowError("没有配置本地视觉模型名称")
    if not model.endswith("-instruct"):
        raise LocalWorkflowError("本工作流要求使用显式的 -instruct 模型标签")
    return config


def validate_prepared_run(run_dir: Path) -> dict[str, Any]:
    selection = read_json(run_dir / "selection.json")
    days = selection.get("days")
    if not isinstance(days, list) or not days:
        raise LocalWorkflowError("selection.json 缺少已入选日期")
    normalized_days: list[int] = []
    for item in days:
        if not isinstance(item, dict) or "day" not in item:
            raise LocalWorkflowError("selection.json 的日期项缺少 day")
        day = int(item["day"])
        if not 1 <= day <= 31:
            raise LocalWorkflowError(f"selection.json 包含无效的 7 月日期：{day}")
        normalized_days.append(day)
        sources = item.get("sources")
        if not isinstance(sources, list) or len(sources) > 3:
            raise LocalWorkflowError(f"7 月 {day} 日 sources 必须是 0–3 项数组")
        if not sources and not isinstance(item.get("analysis_context"), dict):
            raise LocalWorkflowError(
                f"7 月 {day} 日没有照片时必须提供 analysis_context"
            )
        for source in sources:
            source_path = Path(str(source))
            resolved = source_path if source_path.is_absolute() else run_dir / source_path
            if not resolved.is_file():
                raise LocalWorkflowError(f"7 月 {day} 日缺少照片工作副本：{source}")
    if len(set(normalized_days)) != len(days):
        raise LocalWorkflowError("selection.json 存在重复日期")
    if not (run_dir / "manifest.json").is_file():
        raise LocalWorkflowError("缺少 manifest.json，无法生成完整选图与处理报告")
    return selection


def pending_assets(run_dir: Path, plan: dict[str, Any]) -> list[dict[str, Any]]:
    missing: list[dict[str, Any]] = []
    for day in plan.get("days", []):
        for placement in day.get("placements", []):
            kind = str(placement.get("kind", ""))
            if kind not in {"cutout", "illustration"}:
                continue
            relative = str(placement.get("asset", "")).strip()
            if not relative:
                missing.append(
                    {"day": int(day["day"]), "kind": kind, "asset": ""}
                )
                continue
            path = Path(relative)
            resolved = path if path.is_absolute() else run_dir / path
            if not resolved.is_file():
                missing.append(
                    {
                        "day": int(day["day"]),
                        "kind": kind,
                        "asset": relative,
                    }
                )
    return missing


def write_workflow_report(
    run_dir: Path,
    *,
    status: str,
    stages: list[dict[str, str]],
    config: dict[str, Any],
    missing_assets: list[dict[str, Any]] | None = None,
    outputs: dict[str, str] | None = None,
) -> Path:
    report = {
        "schema_version": "1.0",
        "workflow": "local_july_calendar_v1",
        "status": status,
        "updated_at": datetime.now(timezone.utc).isoformat(),
        "runtime": {
            "decision_backend": config.get("decision_backend"),
            "model": config.get("local_ollama_decision_model"),
            "endpoint": config.get("local_ollama_base_url"),
            "weights_bundled_in_git": False,
        },
        "stages": stages,
        "missing_assets": missing_assets or [],
        "outputs": outputs or {},
    }
    output = run_dir / "reports" / "local_workflow_report.json"
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(
        json.dumps(report, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )
    return output
