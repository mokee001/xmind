# PhotoWall · Waveshare ESP32-S3 13.3E6

自定义固件将官方被动 Wi-Fi Loader 改成独立云端设备：

1. 没有配置时创建 `PhotoWall-XXXX` 临时热点。
2. App 向 `http://192.168.4.1/provision` 发送家庭 Wi-Fi 和云端 API 地址。
3. 凭据保存至 ESP32 Preferences/NVS，后续开机自动联网。
4. 设备向 `/api/devices/bootstrap` 注册，之后每 15 秒查询待显示 revision。
5. 下载并校验 960045 字节 PWE6（含 SHA-256），写入两个 600×1600 控制器并全刷。
6. 显示成功后保存 revision，避免同一画面重复刷新。

## 配网

串口会打印热点、临时热点密码和六位配对码：

- 热点：`PhotoWall-XXXX`
- 密码：`PhotoWall` + 配对码后四位
- 配置地址：`http://192.168.4.1`

恢复出厂：上电时按住 BOOT（GPIO 0）至少 8 秒。清除 Wi-Fi、设备 token 和当前 revision 后重新进入配网。

## 构建和烧录

需要 PlatformIO：

```sh
pio run
pio run -t upload
pio device monitor
```

环境按真机检测结果配置为 ESP32-S3、32MB OPI Flash、16MB OPI PSRAM。当前应用保守使用 16MB 分区表。首次烧录自定义固件会替换官方 Loader；需要保留完整 32MB 官方固件备份或确保可以重新从微雪示例烧回。

## 安全边界

当前是本地/开发 MVP：

- HTTPS 暂时使用不校验证书模式，生产版必须内置 CA 或证书 pin。
- 配网热点使用派生密码，但 Wi-Fi 凭据尚未增加应用层 ECDH。
- 云端 bootstrap/claim 是本地演示模型，生产版需设备出厂密钥和一次性 bootstrap token。
- 生产版还需 Secure Boot、Flash Encryption、签名 OTA 和 token 撤销。

## 上游来源

面板引脚及控制器初始化时序改编自 Waveshare `ESP32-S3-ePaper-13.3E6` 的 Arduino `05_Loader_esp32wf` 示例，遵循 Apache License 2.0。其余配网、PWE6 下载、摘要校验、轮询和状态上报代码为 PhotoWall 实现。
