# 2026-09-22 分模块源码同步

本次响应“有改动的都推送到对应模块”，保存现有工作区源码，不新增产品逻辑，
不部署服务器、不构建或安装 App、不烧录硬件。

## 分支与模块

- 已发布 App 与统一选片接入：`codex/app-preferences-onboarding-20260911`，
  本次归档起点 `9d1a8eb`。手机安装版本不能通过 Git 推送判断。
- 剩余工作区源码：`codex/modules-sync-20260922`，按选片、模板、后端设备与家庭、
  Demo 和文档分别提交。此分支是多任务源码集成快照，不是新的生产发布版本。
- reTerminal E1002 固件：`codex/reterminal-e1002-20260922`，保留硬件独立分支。
- 旧网页 App 原型：`codex/ui-preview-20260820`，保留原分支，不能覆盖当前日历 App。
- 已确认四模板：`codex/confirmed-four-templates-20260911`；模板实验平台
  `codex/template-lab-packages` 已在远端，不重复制造提交。

## 选片版本边界

正式基准仍为 `recollections-rules-v1.0.0` / `c1c5683eb00c232123832a47f25ddd0d5e3e6e56`。
其独立分支及标签保持不变。本次只保存既有实验改动，不能把此集成快照称为基准校验通过。
代码校验发现以下六个文件与基准不同：

- `backend/dedup.py`
- `selection_lab/server.py`
- `selection_lab/static/index.html`
- `tests/test_selection_lab.py`
- `tests/test_story_albums.py`
- `tests/test_hybrid_albums.py`

未运行照片推理、未检查本地模型、未更换基准清单，也未上传或重新生成用户照片。
后续部署应沿用统一选片网关的独立基准验证流程，不直接部署此快照代替已验收服务。

## 历史成果与排除项

`demos/calendar-app/` 是当前采用的 Demo；其他视觉探索和旧引导仅保留历史。
`templates/eink_portrait_gallery.json` 仅保留历史源文件；当前可用目录由
`backend/template_catalog.py` 的四款模板控制，不恢复旧款为产品默认项。

用户照片、原图、识别结果、模型权重、依赖目录、签名私钥、安装包、日志、PID、
本机 production-ready 验收标记及根目录临时 diff/git 文件不进入此次提交。
演示用生成素材及已在远端确认模板分支中的素材随对应代码保留。

## 本次检查

在从暂存区导出的干净源码目录执行：统一选片 API/网关、人物展示范围、选片配置、
四模板目录/模板包、19 寸设备、展示记录、模拟设备和配网恢复，共 102 项 Python 测试通过。
App 选片同步、真实回执/日历/整墙状态，以及 Demo 对照/引导/反馈共 81 项 Node 测试通过；
1 项真实本地图库对照测试因未带私有图库跳过。未用这些测试代替真实硬件或模型推理验收。

旧 App 工作树的 4 个 JavaScript 文件通过 Babel JSX 语法解析；不是手机安装验证。
凭据特征扫描未发现命中。历史 Superdesign 草稿与色条工具保留少量已有行尾空格，
未为 Git 同步而改写历史源码。
