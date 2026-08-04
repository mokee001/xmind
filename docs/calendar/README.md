# 2026 年 7 月 AI 手帐日历独立引擎

## 当前状态

这个目录记录 `calendar_engine/` 的接入边界。

本次分支只提交已经验证过的日历渲染与 QA 模块，不接入现有 FastAPI，不修改：

- `backend/server.py`
- `engine.py`
- `/api/generate`
- 手机端和网页端

因此当前没有新增 HTTP API。现有照片墙功能保持原样。

## 当前能力

- 只接受 2026 年 7 月的处理计划。
- 输出尺寸固定为 1500 x 2001。
- 内置 Figma 导出的背景、日期、静态装饰和字体。
- 支持完整图、保留比例、圆形、椭圆、抠图、插画和文字等处理方式。
- 固定图层顺序：`base -> content -> date -> overlay_sticker_static -> overlay_sticker_dynamic`。
- 抠图不增加白色描边和阴影。
- 最终 QA 失败时，调用方不会收到成功结果。

## 不包含的内容

- 真实用户照片和代理图。
- API Key、Figma Token 和个人电脑路径。
- OpenAI HTTP 调用。
- 训练模型权重。
- 自动生成 `treatment_plan.json` 的模型服务。

当前引擎的输入是模型或规则层已经准备好的运行目录：

```text
prepared-run/
  treatment_plan.json
  decoration_plan.json       # 没有动态装饰时可省略
  proxies/                   # 计划引用的照片工作副本
  assets/                    # 插画、抠图和动态贴纸
```

这些运行数据应放在 Git 忽略的 `calendar_runs/`，不要提交真实相册。

## 命令行调用

在仓库根目录运行：

```bash
python3 -m calendar_engine \
  --run-dir calendar_runs/example \
  --output output/calendar_2026_07.png
```

成功时输出：

```json
{
  "status": "PASS",
  "calendar_path": "/path/to/output/calendar_2026_07.png",
  "preview_path": "/path/to/calendar_runs/example/output/2026年7月_AI手帐日历_预览.jpg",
  "qa_report_path": "/path/to/calendar_runs/example/reports/qa_report.json"
}
```

## Python 调用

```python
from calendar_engine import generate_july_calendar

result = generate_july_calendar(
    "calendar_runs/example",
    output_path="output/calendar_2026_07.png",
)

print(result.calendar_path)
```

## 后续接入位置

后续建议新增独立路由，例如 `backend/routers/calendar.py`：

```text
现有照片上传
  -> 日历日期整理
  -> 图片处理决策模型
  -> treatment_plan.json
  -> calendar_engine
  -> QA PASS
  -> 复用 /output/{name} 返回最终图片
```

不要把当前 Figma 位图模板上传到现有 `/api/templates`。现有模板是
`960 x 1280` JSON 槽位格式，与日历的分层位图模板不是同一种结构。

## 验证

```bash
python3 -m unittest tests/test_calendar_engine.py -v
```

测试会创建临时模板和临时计划，不读取真实用户照片。
