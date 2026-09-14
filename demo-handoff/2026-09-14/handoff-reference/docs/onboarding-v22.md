> 历史参考：原本机路径和待推送状态已过时。新授权为 2026-09-14 打包推送；以迁移包 README 为准。

# 首次引导 v2.2 交接

更新日期：2026-09-12（Asia/Shanghai）
状态：本机已核对，等待用户提出设计修改；交接技能与本记录仅本地创建，尚未提交或推送。
设备标签：当前 Mac；其他设备未核实。

## Git 与工作范围

- 仓库：`git@github.com:mokee001/xmind.git`
- 当前工作区：`/Users/wanghuan10/Xmind/photo-wall-onboarding-v22-20260912`
- 分支：`codex/onboarding-preview-20260912`
- 基准 HEAD：`2380b9236fec752e32eb5b1469675c6720a047c0`
- 当前 upstream：`origin/codex/onboarding-demo-v2.2`，与本地分支名不同。尚未确定此次交接的推送目标，不默认推送该 upstream。
- 页面源码：`demos/onboarding/`
- 技能创建前工作树干净。此次仅新增 `.agents/skills/project-handoff/SKILL.md` 和本记录；接手时重新核实。

## 用户决定与边界

- 在既有独立工作区修改首次引导；不创建替代工作区，不改 App 独立工作区。
- 尚未收到具体设计修改要求；不自行改设计。
- 预览确认后才能合并。最终由原协调任务负责合并已确认的 App 与首次引导改动。
- 当前不合并、不推送、不发布 TestFlight。创建交接技能不解除此限制。
- 当前人物为已标记占位头像、照片墙为本机历史样张；原精选与人物索引未同步，不能称为真实识别或筛选结果。

## 已完成与验证

- 2026-09-12 核对分支与完整 HEAD，技能创建前工作树干净。
- 检查工作区及祖先目录：未发现适用于 `demos/onboarding/` 的 AGENTS.md；`photo-wall-app/AGENTS.md` 属于其他子目录。
- 本任务此前已通过浏览器打开 `http://127.0.0.1:8772/onboarding.html`，确认首屏及照片样张加载，页面显示演示数据说明。
- 此验证仅覆盖首屏显示，不代表四步交互或真实相册功能已测试。
- 尚未进行产品代码修改。

## 运行环境：不能只靠 Git 恢复

- 当前预览地址：`http://127.0.0.1:8772/onboarding.html`。
- 实际启动器在仓库外：`/Users/wanghuan10/Xmind/photo-wall-preview-launcher/serve.py`。
- 启动器同进程提供 App 8771 与首次引导 8772，静态引导从当前工作区 `demos/onboarding/` 读取；修改引导时不能中断或修改 App 服务逻辑。
- 启动器还读取当前工作区 `tools/onboarding_preferences.py`，并从 `/Users/wanghuan10/Xmind/photo-wall/output/` 读取匹配 `*template_1*.png` 的历史样张。
- 启动器有本机绝对路径，未包含于当前仓库。第二台机器需单独准备启动器和获准使用的素材、调整本机路径；不能假定拉取仓库就会拥有这些文件。
- 本次只读取启动器核实依赖，没有复制、修改或重启它，也没有同步私人照片。
- `demos/onboarding/README.md` 描述的 `python3 tools/preview_onboarding.py` 是另一套依赖完整项目模块与图库快照的启动方式，不能直接当作当前占位预览的等价替代。

## 下一步

1. 用户提出具体首次引导修改后，仅修改本任务范围并预览验证，更新此记录。
2. 真正跨电脑交接前，核定推送授权与远端目标分支，再提交并核对远端 SHA。
3. 另一台电脑在正确项目目录拉取包含技能的分支后，可说“接着上次继续，读取项目交接记录”，或显式使用 `$project-handoff`。
4. 在第二台机器核实启动器与素材是否齐备；未验证前不宣称预览已恢复。
