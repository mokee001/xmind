# 首次准备识别框、后台任务与 HEIC 解码修复 · 2026-10-10

用户更新 App 后仍停在首次准备失败页，具体错误为 `Invalid observation region`。
服务器记录确认先有 13 次选片上传 HTTP 200，随后上传 HTTP 422，重复重试失败。
前次 App 1.3.9（32）的 multipart 兼容性修复已使请求到达服务器。

## 本次修复

- 上传适配器将有限、有序、与图片相交的真实识别框裁到图片可见边界，并以
  `source_box` 保留原坐标。分类标签、置信度、人脸数不变；正常范围的观察值不变。
  非有限、反向、零面积、完全在图外的框，以及无效置信度仍拒绝，不制造人物身份。
- 后台 worker 的日志为 `Failed to connect to bus: Permission denied`。
  `ProtectHome=true` 隐藏了 `/run/user/999`，与配置的用户管理器 socket 冲突。
  服务改用 `ProtectHome=tmpfs` 并只读绑定 photowall UID 999 的运行目录，其他家目录继续隐藏。
  现有服务的 1 GiB/1 核、用户推理 slice 5 GiB/2 核、禁用 swap、任务时限和清理规则保持。
- 两处均在独立选片网关修复，兼容当前 App 1.3.9（32），不新增界面或要求重新配网。
- 手机再次上传后，服务器已保存照片由 13 张增至 36 张，其中 2 处识别框完成边界归一化。
  随后的真实 worker 已运行 Ente 识别，但读取 HEIC 的 GPS/EXIF 时抛出
  `PIL.UnidentifiedImageError`。父进程注册的 HEIC 解码器不会自动传入新的 Python 子进程。
  新增 `tools/run_baseline_ente.py`，在子进程中注册现有 `pillow_heif` 后，通过 `runpy`
  执行冻结目录原有的 `tools/run_ente_lab.py`；冻结代码优先导入，命令参数原样转交。
  `run_production_recollections.py` 的基准校验和真实模型执行流程保持不变。

## 验证及部署

- 29 项 Python 回归通过：9 项上传协议、19 项快照/隔离/资源控制、1 项真实模板生成夹具。
  新回归验证边界框经真实上传入口传入 ingest、原分类结果不变、保留原坐标，且不接受损坏观察值。
- 先在相同服务隔离条件下验证非 root 用户可创建限额 scope，随后在实际网关挂载命名空间复验通过。
- 使用实际 photowall 账号校验冻结运行环境：54 个规则文件及 5 个模型通过固定提交
  `c1c5683eb00c232123832a47f25ddd0d5e3e6e56` 的完整性验证。未换模型、阈值或主题规则。
  本地工作区的基准检查仍报告上一版的六处差异，归档已保留；不将其当作工作区基准通过。
- 部署只替换 `backend/routers/selection.py`，新增对应 service drop-in 并重启 8001 选片网关。
  原 8000 服务与 `server.py` 未覆盖，校验值仍为
  `255c821821dfbf456e7a57601722fa8aa67850b7b6a1c4bc1acf2cb984cc545d`。两个健康检查通过。
- 上传接口原 SHA256 为 `ea90391495eb3ac8094330d8c2b34b304353d21f0f5703d0cc2a7d4b5a716633`，
  修复后为 `65d4ddcb5064718564e07843c5da016867147d7a638ae362e13ff4f5f52e1010`。
- HEIC 回归使用临时生成的 16×16 合成图片：在全新子进程中读取完整像素与 EXIF，
  验证冻结根目录和 tools 目录优先于外部同名模块，并验证 CLI 参数传递；本地 1 项测试通过。
- 线上以实际 photowall 用户（UID 999）、冻结环境的 Python 执行独立合成图片探针：
  未注册解码器的新进程复现 `UnidentifiedImageError`，已安装的 helper 成功读取 HEIF
  像素与 EXIF；临时图片及模拟脚本已清理。此探针未访问用户照片、未执行真实筛选。
- HEIC 部署只更新工作区适配器 `tools/run_production_recollections.py` 并新增 helper，
  不修改 `/opt/photowall/recollection-v1`，无需重启服务。线上安装值再次核对一致：
  launcher SHA256 `1abea4e853c622980faf47550990a75e680501ca47492ce384c618a5f2aa63a5`；
  helper SHA256 `e5795af6e86c9c22eccb7b00ef8b38e6a2f128fabffa0ef6e7834e3c1f51fc7c`。
  部署后用实际账号再次校验冻结目录，54 个文件与 5 个模型全部通过。
  本地 `--models` 校验仍有既存的 6 处代码差异，并报告模型 runtime 缺失；未据此运行本地推理。

本机记录：`outputs/vision-upload-recovery-20261010/`。线上备份与配置记录：
`/opt/photowall/releases/vision-upload-recovery-20261010/`。回滚恢复其中的
`selection.before.py`，移除本次创建的 `20-user-runtime.conf`，daemon-reload 后重启选片网关。
不删除照片、模型、候选集或其他任务改动。
HEIC 适配器如需单独回滚，恢复同一备份目录的 `run_production_recollections.before.py`；
恢复父启动器后可移除新增 helper，冻结代码与用户数据均无须改动。

真实手机上传恢复已有服务器记录；HEIC 修复后的真实整轮生成、投送及屏幕完成回执仍需现场核对，
状态见本机 `diagnosis.json`。解码探针通过不代表已完成真实上屏。
本次排查工具未上传私人照片、未手动发布画面、未部署旧主服务缺失的账号/偏好/展示历史接口。
