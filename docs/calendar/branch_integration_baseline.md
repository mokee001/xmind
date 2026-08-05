# 2026 年 7 月日历生成引擎：分支接入说明

## 1. 这次提交是什么

这是当前 AI 手帐日历工作流的可调用基线版本，不是神经网络权重。

它接收模型或规则层已经生成的图片处理计划，执行固定模板合成、日期层、静态装饰、动态装饰和质量检查，最终只返回通过 QA 的日历 PNG。

```text
照片整理与选图
  -> 图片处理决策模型输出 treatment_plan.json
  -> 布局或装饰决策输出 decoration_plan.json
  -> 本地日历生成引擎
  -> QA PASS
  -> 最终日历 PNG
```

## 2. 当前保证范围

- 月份：2026 年 7 月。
- 画布：1500 x 2001。
- 周起始：星期日。
- 固定图层顺序：`base -> content -> date -> overlay_sticker_static -> overlay_sticker_dynamic`。
- 抠图不增加白色描边和阴影。
- 旋转绝对值不超过 10 度。
- 每天使用 1 至 3 张照片，或使用合法的留白、插画、文字模式。
- 不允许出现连续空白日期。
- QA 失败时不向业务层返回成功结果。

当前封装不负责自动产生 `treatment_plan.json`。同事训练的模型应当接在计划生成位置，渲染和 QA 保持不变。

## 3. 安装

在项目目录运行：

```bash
python3 -m pip install -e .
```

只使用渲染功能时仅安装 Pillow。需要 OpenAI 决策模块时安装：

```bash
python3 -m pip install -e '.[decision-api]'
```

## 4. 命令行调用

```bash
calendar-engine \
  --run-dir /path/to/prepared-run \
  --output /path/to/final-calendar.png
```

`run-dir` 至少包含：

```text
prepared-run/
  treatment_plan.json
  decoration_plan.json       # 可选，无动态装饰时可省略
  proxies/                   # 计划引用的照片工作副本
  assets/                    # 插画、抠图和动态贴纸
```

内置模板会自动使用，也可以通过 `--template-dir` 覆盖。

成功输出是一行 JSON：

```json
{
  "status": "PASS",
  "calendar_path": "/path/to/final-calendar.png",
  "preview_path": "/path/to/run/output/2026年7月_AI手帐日历_预览.jpg",
  "qa_report_path": "/path/to/run/reports/qa_report.json"
}
```

## 5. Python 调用

```python
from calendar_engine import generate_july_calendar

result = generate_july_calendar(
    "/path/to/prepared-run",
    output_path="/path/to/final-calendar.png",
)

print(result.calendar_path)
```

## 6. 同事模型的接口边界

同事的模型不需要生成图片，也不需要操作模板。模型只需输出：

- 每天选用哪些工作图。
- 采用完整图、保留比例、圆形、椭圆、抠图、文字或插画中的哪一种处理方式。
- 裁切焦点、位置框和旋转角度。
- 动态贴纸的语义类别与候选素材。

计划写入 `treatment_plan.json` 和可选的 `decoration_plan.json` 后，调用当前引擎即可。

## 7. Git 提交边界

提交：

- `calendar_engine/`
- `calendar_ai/`
- `tools/render_july_2026.py`
- `rules/`、`prompts/`、`docs/`
- `tests/`
- `pyproject.toml`

不要提交：

- 真实用户原图和代理图。
- `runs/*/output` 与报告。
- API Key、Figma Token、`.env`。
- 带有个人电脑绝对路径的真实运行清单。

## 8. 合并前验证

```bash
python3 -m unittest discover -s tests -v
```

再用一份本地 7 月运行目录执行一次命令行调用，确认结果 JSON 的 `status` 为 `PASS`。
