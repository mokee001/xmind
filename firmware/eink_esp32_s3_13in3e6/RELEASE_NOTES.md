# 0.3.9-transfer

本次整理基于 `hardware/waveshare-eink-spectra6` 的 `82d194c`；固件基线为
`98d9fc7`（0.3.6）。提交的是本地现有 0.3.9-transfer 源码、传输回归测试和历史真机验证记录。

## 修改内容

- 顺序云端请求复用 HTTP/TLS 连接；读取完整 JSON 响应，切换源站或响应不完整时关闭连接。
- 云端轮询和传输期间临时关闭 Wi-Fi 省电，退出时恢复原设置。
- PWE6 负载按已校验长度读取，每块最多 4 KB；保留断流检测、空闲超时和 SHA-256 校验。
- 增加 `ECHO_TRANSFER` 阶段耗时及网络错误诊断日志。

蓝牙配网、面板驱动和设备协议沿用基线。默认云端轮询仍为 15 秒；历史 E590 的
5 秒间隔由服务器 bootstrap 返回，不是这次源码写死的全设备间隔。

## 验证

- 2026-10-29：历史记录确认编译通过、仅应用分区烧录校验通过，E590 启动日志为
  `0.3.9-transfer`。详见 [传输验证记录](../../diagnostics/transfer-optimization-2026-10-29.md)。
- 2026-11-24：整理分支时重新运行分块读取测试，AddressSanitizer 和
  UndefinedBehaviorSanitizer 检查通过；本次没有重新烧录设备。

在仓库根目录运行回归测试：

```sh
clang++ -std=c++17 -O1 -g -fsanitize=address,undefined -fno-omit-frame-pointer \
  tests/frame_reader_test.cpp -o /tmp/echoo-frame-reader-test
/tmp/echoo-frame-reader-test
```

完整固件的构建说明见 [README](README.md)。本次交付不包含 Wi-Fi 凭据、设备 token、
Flash/NVS 备份或编译产物；全量固件构建和烧录的证据来自上述历史记录。
