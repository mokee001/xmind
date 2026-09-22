# 2026 年 7 月 AI 手帐日历独立引擎

## 当前状态

这个目录记录 `calendar_engine/` 的接入边界。

本次分支包含已经验证过的照片导入、Qwen 处理决策、月度艺术指导、插画与抠图资产准备、日历渲染、图文报告和 QA 模块。它们尚未接入现有 FastAPI，且默认关闭，不修改：

- `backend/server.py`
- `engine.py`
- `/api/generate`
- 手机端和网页端

因此当前没有新增 HTTP API。现有照片墙功能保持原样，已有 7 月计划仍可完全离线生成。

## 当前能力

- 只接受 2026 年 7 月的处理计划。
- 输出尺寸固定为 1500 x 2001。
- 内置 Figma 导出的背景、日期、静态装饰和字体。
- 支持完整图、保留比例、圆形、椭圆、抠图、插画和文字等处理方式。
- 固定图层顺序：`base -> content -> date -> overlay_sticker_static -> overlay_sticker_dynamic`。
- 抠图不增加白色描边和阴影。
- 最终 QA 失败时，调用方不会收到成功结果。
- 可选使用 `qwen3.8-max` 为已入选素材生成结构化处理决策。
- 决策请求读取同一份规则、校准案例和 Pydantic Schema，不合规结果会被本地拦截并纠正。
- 可选使用 `qwen-image-3.0-pro` 生成空白格线描插画；普通照片处理与渲染不调用生成模型。
- 使用月度艺术指导约束整月矩形、有机轮廓和安静格的节奏，单日模型不能越过日期归属和产品硬规则。
- 内置一组由用户贴纸库校准出的透明动态贴纸；本地语义规则会为纸张、人物/宠物、风景、音乐影视和独立空白格生成稀疏装饰计划。
- 提供本地素材导入、批量决策、处理计划、透明线稿、抠图和图文报告工具。

## 不包含的内容

- 真实用户照片和代理图。
- API Key、Figma Token 和个人电脑路径。
- 训练模型权重。
- 已经启用的模型服务。配置中的 `api_enabled` 和 `qwen_image_enabled` 均为 `false`。

当前引擎的输入是模型或规则层已经准备好的运行目录：

```text
prepared-run/
  treatment_plan.json
  decoration_plan.json       # 没有动态装饰时可省略
  proxies/                   # 计划引用的照片工作副本
  assets/                    # 插画、抠图和动态贴纸
```

这些运行数据应放在 Git 忽略的 `calendar_runs/` 或 `runs/`，不要提交真实相册。

## 完整本地工作流

选图层继续复用项目原有方法。得到 `selection.json` 后，处理和渲染链路为：

```bash
python3 tools/import_real_user_july.py INPUT_PHOTO_FOLDER calendar_runs/july --year 2026 --month 7
python3 tools/run_qwen_treatment_batch.py calendar_runs/july
python3 tools/build_treatment_plan_from_qwen.py --run-dir calendar_runs/july
python3 tools/build_decoration_plan.py --run-dir calendar_runs/july
python3 -m calendar_engine --run-dir calendar_runs/july
python3 tools/render_run_reports.py --run-dir calendar_runs/july
```

动态装饰步骤不会调用模型。它读取 `treatment_plan.json` 中已经确认的内容语义，从内置透明贴纸库选择素材并生成 `decoration_plan.json`。默认每个语义类别只选一个代表日期、每月最多装饰 5 个日期格；硬上限仍是每格 2 个视觉贴纸、每月 8 个装饰日期格、所属格遮挡不超过 25%。日期数字、人物和动物面部、重要文字与票据信息不能被遮挡，空白格只允许抽象贴纸。

直接执行 `python3 -m calendar_engine` 时，如果运行目录尚无 `decoration_plan.json`，引擎也会自动执行这一步。人工已经调整过的装饰计划不会被覆盖；明确需要无动态贴纸的调试成图时可增加 `--no-auto-decoration`。

需要异形抠图时，可在 macOS 编译并调用：

```bash
swiftc tools/macos_foreground_cutout.swift -o /tmp/ai_calendar_foreground_cutout
/tmp/ai_calendar_foreground_cutout INPUT_IMAGE OUTPUT_PNG
```

Qwen 插画生成后，用本地工具转换透明背景：

```bash
python3 tools/line_art_to_transparent.py INPUT_PNG OUTPUT_PNG
```

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

## Qwen 决策模块

相关文件：

```text
calendar_ai/                         # 决策 Schema、适配器、校验和钥匙串读取
calendar_engine/config.json          # 模型名、端点和默认关闭的开关
calendar_engine/prompts/             # 决策与插画提示词
calendar_engine/rules/               # 产品硬规则
calendar_engine/training/            # 30 个校准案例与风格注册表
scripts/                              # 连接测试、单日决策和插画生成入口
docs/calendar/Qwen_API迁移与规则校准说明_v1.md
```

安全要求：任何曾出现在聊天或截图中的 Key 必须先在平台废止。新的 Key 只能放在环境变量或 macOS 钥匙串，不能写入仓库。Mac 可双击 `配置Qwen密钥.command` 保存轮换后的 Key。

建议先保持 `decision_mode: shadow`，用代表性日期对比旧计划。确认处理方式可接受率、排除规则和文字真实性后，再启用批量决策；插画模型单独抽检和启用。

## 验证

```bash
python3 -m unittest discover -s tests -v
```

测试会创建临时模板和临时计划，不读取真实用户照片。
