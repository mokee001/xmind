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
- 上传协议与 worker IPC 修复阶段只替换 `backend/routers/selection.py`，新增对应 service drop-in 并重启 8001 选片网关。
  该阶段未修改原 8000 服务与 `server.py`，其原始校验值为
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

## 同日配网重试与解绑命令恢复

- 11:59:10 原固件 `0.3.7-e1002.1` 已重新广播 `PHOTOWALL-B4DC`；
  12:00–12:02 的 `mokeewifi` 重试已达到 Wi-Fi 成功后的云端 bootstrap。
  失败位置是 Arduino `ssl_client.cpp:150` 的 TCP `SO_ERROR=104`，在 TLS 初始化之前。
  对应时段主服务未收到 bootstrap。服务器服务、443 监听及电脑侧 HTTPS 检查正常；
  这不足以判定重置来自哪一跳。当前网络是家庭路由器还是同名热点，仍待现场确认。
- App 丢失 `cloud_unreachable` 错误码并显示统一密码重试入口；固件云端失败后不自动重试，
  再配网/取消会断开现有 Wi-Fi。这些客户端恢复缺陷本轮只完成定位，尚未发布修正。
- 另在真实线上路由的隔离回归中复现：保留设备凭据重新绑定后，旧 DELETE 的
  `reprovision(false)` 命令仍可能下发，令设备再次解绑。屏幕重启/轮询早于 App 认领也会触发。
- 本轮已在旧线上服务上应用 `config/patches/server-claim-recovery-20261010.patch`：
  对未认领、无所属账号且明确待解绑的设备，在现有有效 setup 窗口内暂缓命令并返回 204；
  不续期、不绑定、不投送照片。现有窗口最多 600 秒，过期仍执行原解绑。
  只有真实认领校验成功后才清旧命令，同时清空旧墙版本及其当前帧引用；不删除照片或文件。
- 根代码 14 项、缓存线上版本 17 项回归通过，涵盖先轮询后认领、过期、重复轮询不延期、
  错误设备/账号/配网凭据拒绝、其他命令保留，以及认领后旧帧请求返回 401。
- 部署前验证线上原 SHA256，确认 AST 仅 `device_auto_claim`、`device_next` 两函数变化，
  原子替换后重启主服务；8000、8001 健康检查均通过。最终主服务 SHA256：
  `dd05f9239cecfbc832e1c8759b75cc345340b64138efc1702f69e30b2365f773`。
  备份为同一 release 目录中的 `server.before-claim-recovery.py`；如需回滚，恢复该文件并重启主服务。
  未手动恢复设备绑定、未修改配网固件。此修复不代表当前 TCP 重置或真实上屏已解决。
