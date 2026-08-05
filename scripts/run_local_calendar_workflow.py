from __future__ import annotations

import argparse
import json
import subprocess
import sys
from pathlib import Path


PROJECT_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(PROJECT_ROOT))

from calendar_engine.local_workflow import (  # noqa: E402
    LocalWorkflowError,
    pending_assets,
    read_json,
    validate_local_configuration,
    validate_prepared_run,
    write_workflow_report,
)


def run_step(label: str, command: list[str], stages: list[dict[str, str]]) -> None:
    print(f"\n[{label}]")
    completed = subprocess.run(command, cwd=PROJECT_ROOT, check=False)
    if completed.returncode != 0:
        stages.append({"name": label, "status": "FAIL"})
        raise LocalWorkflowError(f"{label}失败，退出码 {completed.returncode}")
    stages.append({"name": label, "status": "PASS"})


def main() -> int:
    parser = argparse.ArgumentParser(
        description="运行已选图的 2026 年 7 月本地小模型决策、布局、装饰、渲染与 QA。"
    )
    parser.add_argument("--run-dir", type=Path, required=True)
    parser.add_argument("--resume", action="store_true")
    parser.add_argument("--skip-connection-test", action="store_true")
    parser.add_argument(
        "--stop-after-plan",
        action="store_true",
        help="生成处理计划和待准备资产清单后停止。",
    )
    parser.add_argument(
        "--skip-asset-preparation",
        action="store_true",
        help="不运行 macOS 本地抠图和内置线描插画资产准备。",
    )
    args = parser.parse_args()

    run_dir = args.run_dir.expanduser().resolve()
    stages: list[dict[str, str]] = []
    config: dict[str, object] = {}
    try:
        config = validate_local_configuration(PROJECT_ROOT)
        validate_prepared_run(run_dir)
        stages.append({"name": "输入与本地配置检查", "status": "PASS"})

        if not args.skip_connection_test:
            run_step(
                "Ollama 连接检查",
                [sys.executable, "scripts/test_api.py"],
                stages,
            )

        batch_command = [
            sys.executable,
            "tools/run_qwen_treatment_batch.py",
            str(run_dir),
        ]
        if args.resume:
            batch_command.append("--resume")
        run_step("逐日图片处理决策", batch_command, stages)
        run_step(
            "生成整月处理计划",
            [
                sys.executable,
                "tools/build_treatment_plan_from_qwen.py",
                "--run-dir",
                str(run_dir),
            ],
            stages,
        )

        if not args.stop_after_plan and not args.skip_asset_preparation:
            run_step(
                "本地生成抠图与插画资产",
                [
                    sys.executable,
                    "tools/prepare_local_assets.py",
                    "--run-dir",
                    str(run_dir),
                ],
                stages,
            )

        plan = read_json(run_dir / "treatment_plan.json")
        missing = pending_assets(run_dir, plan)
        asset_status = "PASS" if not missing else "NEEDS_ASSETS"
        stages.append({"name": "抠图与插画资产检查", "status": asset_status})
        if missing or args.stop_after_plan:
            status = "NEEDS_ASSETS" if missing else "PLAN_READY"
            report = write_workflow_report(
                run_dir,
                status=status,
                stages=stages,
                config=config,
                missing_assets=missing,
            )
            print(
                json.dumps(
                    {
                        "status": status,
                        "missing_assets": missing,
                        "workflow_report": str(report),
                    },
                    ensure_ascii=False,
                    indent=2,
                )
            )
            return 2 if missing else 0

        run_step(
            "生成动态贴纸计划",
            [
                sys.executable,
                "tools/build_decoration_plan.py",
                "--run-dir",
                str(run_dir),
            ],
            stages,
        )
        run_step(
            "渲染日历并执行 QA",
            [sys.executable, "-m", "calendar_engine", "--run-dir", str(run_dir)],
            stages,
        )
        run_step(
            "生成图文报告",
            [
                sys.executable,
                "tools/render_run_reports.py",
                "--run-dir",
                str(run_dir),
            ],
            stages,
        )

        output_dir = run_dir / "output"
        outputs = {
            "calendar": str(output_dir / "2026年7月_AI手帐日历.png"),
            "preview": str(output_dir / "2026年7月_AI手帐日历_预览.jpg"),
            "qa_report": str(run_dir / "reports" / "qa_report.json"),
        }
        report = write_workflow_report(
            run_dir,
            status="PASS",
            stages=stages,
            config=config,
            outputs=outputs,
        )
        print(
            json.dumps(
                {"status": "PASS", "outputs": outputs, "workflow_report": str(report)},
                ensure_ascii=False,
                indent=2,
            )
        )
        return 0
    except LocalWorkflowError as error:
        report = write_workflow_report(
            run_dir,
            status="FAIL",
            stages=stages,
            config=config,
        )
        print(
            json.dumps(
                {"status": "FAIL", "error": str(error), "workflow_report": str(report)},
                ensure_ascii=False,
            )
        )
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
