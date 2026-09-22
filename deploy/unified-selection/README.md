# 统一选片增量部署

此目录描述 2026-09-22 已上线的独立网关。不要用工作区的整个 `backend/server.py`
覆盖现有服务器：其中可能含有其他设备任务尚未合并的差异。

## 两个代码版本

- App / 网关：`codex/app-preferences-onboarding-20260911`，本次 App 为 1.3.7（30）。
- 固定成册引擎：`codex/recollections-rules-v1.0.0` / 标签 `recollections-rules-v1.0.0`，
  提交必须为 `c1c5683eb00c232123832a47f25ddd0d5e3e6e56`。
  独立检出该提交到运行时目录，不把当前 App 分支或本地实验台当作引擎。

`tools/verify_recollection_baseline.py` 需在包含基准 Git 对象的仓库中验证固定运行时。
`tools/prepare_recollection_linux.py` 准备模型及上游固定依赖；
`tools/package_recollection_bindings.py` 可打包同版本的生成绑定。禁止把照片或私密缓存放入包内。
准备运行时不等于完成推理验收。完整推理复验后才创建运行时 `production-ready.json`；
本仓库不分发可直接绕过验收的 ready 文件，模型也不进入 Git。

## 线上服务边界

原应用保持端口 8000；`backend.selection_gateway:app` 使用 8001。Caddy 仅将：

- `/api/selection/*`；
- 带 `X-Selection-Contract: unified-recollections-v1` 的 `/api/generate`

转到新网关。其余设备连接、发布及上屏回执请求仍交给原应用。
生成预览不是上屏成功，不能代替真实设备回执。

本次只补齐原 server 模块的模板 renderer 导入，未将本地其他 server 改动合并。
`backend/template_packages.py` 及其必需模板配置、背景、贴纸和字体是运行依赖；
素材沿用已在远端确认四模板分支中的相同 Git 对象，不包含用户照片或示例成片。
宠物牛仔仍沿用已有独立流程，本次网关只处理 `template_1/2/3`，auto 沿用 template_1。

服务配置中的域名、路径和 UID 999 是当前服务器实际值。其他机器必须先核对账号 UID、
存储路径和现有 Caddy 配置，不得整文件覆盖其他站点。仅在无活动推理时调整资源配置。
网关自身限额 1 GiB / 1 核，推理用户 slice 总额 5 GiB / 2 核；账号需启用 linger，
且用户配置/缓存目录可写。配置不包含登录密钥或 API 密钥，使用服务器原环境文件。

## App 构建与测试

1. 本版签名包明确设置 `EXPO_PUBLIC_UNIFIED_SELECTION=1`、
   `EXPO_PUBLIC_API_BASE=https://api.mokeedesign.cn`、`EXPO_PUBLIC_ENABLE_TEST_DEVICE=0`。
   本地默认开关仍关闭，复现正式包必须显式传入这些环境变量。
2. iOS 最低 17.0；需要重建包含 `LocalPhotoCuration.observeFileAsync` 的原生包，
   不能只发 JS 热更新到缺少该方法的旧包。
3. 后端 API 测试：安装生产依赖与 `requirements-test.txt` 后，运行
   `PYTHONPATH=.:tests python3 -m unittest test_selection_api test_unified_selection test_selection_gateway`。
4. App 逻辑回归：
   `node --test tests/test_selection_sync.cjs tests/test_native_wall_receipts.cjs tests/test_memory_calendar.cjs tests/test_wall_app_state.cjs`。
5. `tools/prepare_selection_smoke.py` 仅使用固定公开测试样本；三张样本可验证实际推理流程，
   不能用于评价正式成册质量，也不能为满足每册至少 12 张而补图。

App 检查点与服务端来源数据分别保存。清空服务器图库不等于撤销手机相册授权；
已有手机检查点也不保证马上把所有旧图重新上传。不要以清空服务端代替完整“重新同步”流程。

## 发布与回滚

Apple 1.3.7（30）已核对 VALID / IN_BETA_TESTING 并关联原 Team (Expo) 组。
完整线上证据见 `docs/unified-selection-rollout-20260922.md`；本地 IPA、私有运行记录不入库。
回滚先恢复备份 Caddy 配置并校验重载，使流量回到原服务，再停止新网关；不删账户和数据。
清库是另一次用户明确授权的运维动作，不由任何部署脚本自动执行。
