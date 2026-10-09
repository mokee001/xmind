# 首次上屏上传兼容性修复 · App 1.3.9（32）

2026-10-09 用户使用 PHOTOWALL-B4DC，连接完成后首次准备报
`Unsupported FormDataPart implementation`，点击重试仍出现同一错误。
原设备固件 `0.3.7-e1002.1` 的串口在 20:22:30、20:22:46（上海）均确认
云端 bootstrap HTTP 200，配网配置提交成功。这次上传问题发生在手机端。

## 原因与修复

已发布的 Expo 57 fetch 在编码 multipart 请求时不支持旧式 URI-only
`{uri, name, type}` 文件对象。统一选片上传仍用了这一格式，导致请求在
发送照片前失败；重试会重新执行相同的上传，因此无法自行恢复。

`fetchUpload.js` 使用 Expo File 读取原始字节，保留指定文件名和 MIME，
提供 fetch 编码器所需的 bytes 接口。统一选片请求显式使用 expo/fetch；
本地照片墙 prepare 的同类上传也接入此适配。XHR 使用的原生 URI 上传保留。
自动准备、生成、发布、断点及真实设备回执判断不变，不修改选片规则或新增界面流程。

## 验证

- 28 项相关 Node 回归通过，涵盖实际发布 SDK 的原错误复现、二进制 multipart
  编码、文件名与 metadata/sources 保留、缺失文件失败，以及同步断点和上屏回执。
  SDK 编码器直接来自 31 号构建的锁定依赖；仅原生文件 I/O 用合成文件替代。
- 本机 Xcode Release 归档和 App Store 签名导出成功。IPA 核对为
  `cn.mokeedesign.photowall` / `1.3.9` / `32` / iOS `17.0`，签名通过。
  原生二进制包含 LocalPhotoCurationModule、PetCutoutModule 和 observeFileAsync 标识。
- 包内 Hermes sourceHash 与本次实际 Metro JS 的 SHA1 相同；新上传适配已包含。
  依赖锁文件与 31 号构建完全一致，复用已锁定依赖与未修改的原生模块。
- 不将以上验证当作这台手机的真实相册上传和实体上屏验收；安装更新后需继续核对。
- 按约定执行代码基准检查，仍有上一版已有的六处差异：backend/dedup.py、
  selection_lab/server.py、selection_lab/static/index.html、tests/test_selection_lab.py、
  tests/test_story_albums.py、tests/test_hybrid_albums.py。本次未改这些文件，未运行
  私人图库推理或模型验证，没有以此检查宣称选片基准通过。

## 归档与发布

归档目录：`outputs/native-upload-20261009/`。独立源码快照提交
`ea8d5d5b3fe7da670de4466c04c015bf1b5006c9`。
签名包 `photo-wall-upload-fix.ipa` SHA256：
`a1f4fa661f734f0988ecf159777d796c4a7bb458a5da30e95be9c56b78d2cb95`。

实际 Apple 处理及现有 Team (Expo) 测试组关联状态，以该目录
`release-status.json` 和 `apple-state.json` 为准。上传、处理完成和测试组可见性分别核对。
本次发布沿用首次自动上屏的用户授权，不修改设备固件或部署线上后端。

2026-10-09 20:36:59（上海），Apple 确认上传成功，无错误；上传任务及构建 ID
`b9a73cdd-8815-4133-b39f-183c0db77185`。随后核对为 VALID / IN_BETA_TESTING、
未过期，并精确关联原 Team (Expo) 组 `1469f7eb-4dfa-4907-92e1-5aa09e307277`。
测试者从 TestFlight → Echooo 更新至 1.3.9（32）。临时分发钥匙串及发布密钥已清理。
