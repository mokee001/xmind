# 现行模板清单

用户于 2026-09-11 确认替换第三款后的预览，并最终明确：仅保留以下四款，其他都不要。

| 模板 ID | 名称 | 照片数 |
| --- | --- | --- |
| `template_1` | 日常拼贴 | 8 |
| `template_2` | 圣诞手帐 | 8 |
| `template_3` | 分层抠图拼贴 | 15（12 张抠图、3 张完整照片） |
| `denim_pet` | 宠物牛仔拼贴 | 5 |

白底画廊 `eink_portrait_gallery` 已被第三款替换；线上旧接口中的 16 款全部退出当前目录。不得将白底画廊或其他旧款作为默认值、自动回退、上传模板或生成入口恢复。

## 实现与运行状态

`backend/template_catalog.py` 是生产目录，App 的 `src/templateCatalog.js` 与其保持一致。预览、Studio、普通生成入口均拒绝旧 ID。宠物牛仔拼贴仍走专属抠图流程。普通模板照片不足 8 张时明确报错，不回退到旧款。

模板 3 配置来自 GitHub 的 `codex/template-lab-packages` 分支，已核对远端原始资源。需要现有 `rembg`、`onnxruntime` 和 `isnet-general-use.onnx`，使用既定模型，不自动下载或替换模型。缺少运行依赖时目录仍列出该款，但标为 unavailable，实际生成返回 503。此时不应宣称四款均已可生成。本机目前缺少该运行环境；布局测试中的透明占位主体不构成真实抠图验证。

本地已同步 App、后端、网页及 Studio。历史 JSON 保留作实验和回退记录，不在产品可用目录内。预览图片从 `assets/template-previews/` 静态读取，不写入应用安装目录。

截至此次核查，线上 `/api/templates` 仍返回旧 16 款，旧预览接口返回 500；服务器 SSH 连接超时，本次后端更新尚未部署。上线时必须先备份、核对远端文件后应用独立补丁，不能整体覆盖含其他任务修改的工作区。App 发布状态以 `outputs/testflight-four-templates-20260911/release-status.json` 为准。

## 已确认预览及发布来源

最终预览：`output/current-4-template-review-v2-20260911/overview.jpg`。第三款为仓库原始参考图；其余为本地布局占位预览，不是线上返回或新选片结果。

旧 `output/template-review-20260911-1420/`、`output/current-4-template-review-20260911/` 和包含白底画廊的 `output/template-catalog-migration-20260911/release/` 已作废，不得用于部署。

本次 App 独立快照基于已发布的 1.3.3（20），只合入本次模板调整，保留此前已确认的偏好页面与原生模块。源代码快照和安装包保存在 `outputs/testflight-four-templates-20260911/`。
