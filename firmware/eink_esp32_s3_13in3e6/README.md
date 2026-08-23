# PhotoWall · Waveshare ESP32-S3 13.3E6

自定义固件将官方被动 Wi-Fi Loader 改成支持局域网直传、云端轮询兜底的独立设备：

1. 没有配置时广播 `PhotoWall-XXXX` BLE 配网服务，同时创建同名临时热点作为恢复入口。
2. App 通过 BLE 让设备扫描 Wi-Fi，并发送家庭 Wi-Fi 和固定云端 API 地址。
3. 凭据保存至 ESP32 Preferences/NVS，后续开机自动联网。
4. 联网后持续提供 `http://photowall-xxxx.local` 本地服务，并通过 `_photowall._tcp` 广播。
5. App 优先在局域网直传 PWE6；设备不可达时仍可每 15 秒查询云端待显示 revision。
6. 固件校验 960045 字节 PWE6 的头部、尺寸和 SHA-256，之后写入两个 600×1600 控制器并全刷。
7. 云端画面显示成功后保存 revision，避免同一画面重复刷新。

## 配网

App 主流程无需进入系统 Wi-Fi：靠近设备、按住 BOOT 键完成物理确认、选择家庭 Wi-Fi
并输入密码即可。串口仍会打印兼容恢复热点、临时热点密码和六位配对码：

- 热点：`PhotoWall-XXXX`
- 密码：`PhotoWall` + 配对码后四位
- 配置地址：`http://192.168.4.1`

在 App 的设备管理中：

- “更换 Wi-Fi”保留绑定和设备 token，清除网络后重新进入 BLE 配网。
- “删除设备”撤销绑定，清除 Wi-Fi、设备 token 和当前 revision，再次添加时完整重新绑定。

硬件恢复出厂：上电时按住 BOOT（GPIO 0）至少 8 秒。即使固件带演示固定 Wi-Fi，
也会通过持久化 `force_setup` 标记强制进入配网，不会自动连回演示网络。

## 局域网发布

配网热点和家庭 Wi-Fi 使用同一组设备接口：

- `GET /status`：返回设备、网络和本地画面状态。
- `POST /control`：发送开发阶段的测试刷新命令。
- `POST /v1/frame`：以 `multipart/form-data` 上传字段 `frame`，内容必须是完整的 960045 字节 PWE6 文件。

`POST /v1/frame` 分块写入 PSRAM，收完后验证 PWE6 版本、`1200×1600` 尺寸、payload 长度和 SHA-256。只有全部通过才进入刷新队列；接口返回 `202`，App 通过 `GET /status` 等待 `frame_state=displayed`。

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
- 局域网 `/control` 和 `/v1/frame` 尚未鉴权，量产前需要设备会话密钥或一次性 transfer ticket。
- 云端 bootstrap/claim 是本地演示模型，生产版需设备出厂密钥和一次性 bootstrap token。
- 生产版还需 Secure Boot、Flash Encryption、签名 OTA 和 token 撤销。

## 上游来源

面板引脚及控制器初始化时序改编自 Waveshare `ESP32-S3-ePaper-13.3E6` 的 Arduino `05_Loader_esp32wf` 示例，遵循 Apache License 2.0。其余配网、PWE6 下载、摘要校验、轮询和状态上报代码为 PhotoWall 实现。
