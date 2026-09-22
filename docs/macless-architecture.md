# 完全脱离 Mac 的产品架构

## 结论

当前方案不能在关闭 Mac 后工作：

- Expo 使用 `http://HJFG3FGM46.local:8000` 或 localhost。
- FastAPI、照片、JSON 状态和渲染结果都存放在 Mac。
- Waveshare 13.3E6 运行官方 Wi-Fi Loader，只能等待同一局域网内的后端主动推送到 `192.168.1.200`。
- 云服务器无法主动访问家庭局域网中的 `192.168.1.200`。

正式产品应改成：

```text
Expo 手机 App
      │ HTTPS
      ▼
云端 API ── PostgreSQL
      │
      ├── 对象存储（原图、缩略图、六色帧）
      ├── 异步任务（识别、选图、渲染、六色转换）
      └── MQTT/HTTPS 设备消息
                  ▲
                  │ ESP32 主动联网、轮询或订阅
                  │
          13.3E6 墨水屏
```

这样手机、服务器和屏幕都不依赖 Mac，也不要求手机与屏幕在同一 Wi-Fi。

## 手机授权后直连屏幕模式

如果产品要求“手机完成云端授权后，数据由手机直接发给屏幕”，采用混合架构：

```text
                                                            HTTPS
Expo 手机 ─────────────────────→ 云端 API
       │                              │
       │ ① 登录、设备归属校验          │ 账号/家庭/设备
       │ ② 上传照片                    │ 图片处理/六色帧
       │ ③ 下载六色帧和短时授权令牌     │
       │                              │
       └──── 同一局域网 HTTPS/HTTP ───→ ESP32 屏幕
                              ④ 直传帧、提交刷新
                              ⑤ 屏幕校验令牌与帧摘要
```

这个模式不需要本地 Python 后端，但**手机与屏幕必须处于同一可互访局域网**。蜂窝网络、访客 Wi-Fi、启用客户端隔离的路由器或 VPN 接管局域网路由时，手机无法直连屏幕。

### 云端授权流程

1. 用户登录云端，选择家庭和目标设备。
2. App 请求 `POST /api/v1/devices/{device_id}/transfer-ticket`。
3. 云端校验用户是否为该家庭的 owner/admin，以及设备是否属于该家庭。
4. 云端签发 2–5 分钟有效的单次 transfer ticket，至少绑定：
       - `device_id`
       - `account_id`
       - `display_revision_id`
       - `frame_sha256`
       - `exp`
       - 随机 `jti`
5. ESP32 内置云端公钥，可离线验证 ticket 签名，不需要在局域网内再次访问 Mac。
6. ESP32 拒绝过期、设备不匹配、摘要不匹配或已经使用过的 ticket。

正式版不要只在 App 中保存一个固定密码；App 可被逆向，固定共享密钥无法形成可靠设备权限。

### 局域网发现

推荐顺序：

1. BLE：首次配网与安全配对。
2. mDNS/Bonjour：正常使用时发现 `_photowall._tcp.local`。
3. 云端保存的最后局域网地址：仅作为加速缓存，不能作为设备身份。
4. 手动 IP：只保留开发者入口。

iOS 需要：

- `NSLocalNetworkUsageDescription`
- `NSBonjourServices` 中声明 `_photowall._tcp`
- 本地网络权限被拒绝时的设置引导
- 如果设备使用局域网 HTTP，需要配置 `NSAllowsLocalNetworking`；正式版优先设备 HTTPS 或使用签名帧加 ticket 降低明文控制风险

Android 需要局域网/附近设备相关权限，并适配不同系统版本的 Wi-Fi 与 mDNS 限制。

### 手机直传 API（正式固件）

屏幕提供简单的局域网 API：

```text
GET  /v1/device
      → device_id, model, firmware, panel, state, current_revision

POST /v1/transfers
Authorization: Bearer <single-use-transfer-ticket>
Content-Type: application/octet-stream
X-Frame-SHA256: ...
X-Revision-ID: ...
      body: PWE6 frame
      → transfer_id

GET  /v1/transfers/{transfer_id}
      → receiving / verified / refreshing / done / error
```

设备应先写入 staging 区，收完并校验 SHA-256 后才替换 pending revision。下载中断不能破坏当前显示画面。

### 数据路径

手机不做人物识别、模板渲染和复杂六色量化：

1. 手机上传照片或提交草稿到云端。
2. 云端 worker 生成 1200×1600 六色 PWE6 帧。
3. 手机下载约 960 KB 的 PWE6 帧到临时缓存。
4. 手机携带 transfer ticket 将文件流式发给 ESP32。
5. ESP32 校验并刷新。
6. App 把结果回报云端，屏幕也可在联网时独立上报，云端以设备上报为最终状态。

不要让手机把原始 JPEG 直接交给 ESP32 做量化；不同手机实现会造成效果不一致，ESP32 资源也不适合复杂模板处理。

### 离开局域网时的降级

“手机直连”不能覆盖远程发布。建议同一个 display revision 支持两条传输路径：

- App 发现设备在线且可达：优先手机直传。
- App 不在同一局域网：创建 cloud device job，由 ESP32 主动从对象存储拉取。

两条路径使用同一 PWE6 文件、revision 和摘要，设备通过 revision 幂等去重。这样既满足家中手机直连，也支持远程更新和自动换图。

### 当前官方 Loader 可实现的 MVP

当前 Loader 可以暂时由 Expo 复刻 Python `eink_push.py` 的协议：

1. App 从云端下载面板色码。
2. App 对左右 600 列重排。
3. 调用 `EPDY_` 初始化。
4. 每 1000 像素编码成 URL path 并发送 `LOAD_`。
5. 左侧完成后发送 `NEXT_`，右侧完成后发送 `SHOW_`。

但它有明确限制：

- Loader 不验证云端 transfer ticket，局域网内任何客户端都可能控制屏幕。
- 约 1920 个小请求，iOS 必须保持前台，切后台可能中断。
- 没有 staging、摘要校验、幂等 revision 和可靠状态恢复。
- 不能作为量产安全方案。

因此 MVP 可用来证明“无 Mac、手机局域网直传”，正式版仍需自定义固件和二进制流式 API。

## 设备端目标流程

1. ESP32 首次启动进入配网模式。
2. Expo 通过 BLE 或设备热点写入家庭 Wi-Fi 和一次性配对凭证。
3. ESP32 使用设备证书登录云端。
4. ESP32 定期请求设备 manifest，或订阅 MQTT topic。
5. manifest 的 `revision` 高于本地版本时，下载新的六色帧。
6. 校验文件大小和 SHA-256。
7. 分左右通道把六色数据写入 13.3E6 驱动并执行全刷。
8. 上报 downloading / refreshing / done / error、固件版本和最后在线时间。
9. 无新图时深度休眠或保持低频心跳。

建议下载云端已经转换好的面板数据，不要让 ESP32 执行人脸识别、模板渲染或照片量化。

## 屏幕自主连接 Wi-Fi

### 必须区分首次配网和日常联网

屏幕无法凭空知道用户家庭 Wi-Fi 的 SSID 和密码，因此首次使用至少需要一种凭据输入方式。完成一次配网后，ESP32 把凭据写入加密 NVS；以后开机、断电恢复和路由器重启都由屏幕自主完成，不需要手机、Mac 或家庭后端在场。

推荐状态机：

```text
BOOT
      │
      ├─ NVS 有凭据 ─→ CONNECTING ─→ ONLINE ─→ CLOUD_SYNC
      │                    │
      │                    └─ 连续失败/凭据失效 ─→ RECOVERY
      │
      └─ NVS 无凭据 ─→ PROVISIONING

PROVISIONING / RECOVERY
      ├─ 配网成功 ─→ 保存 NVS ─→ CONNECTING
      └─ 长按恢复键 ─→ 清除凭据 ─→ PROVISIONING
```

### 推荐方案：手机只参与首次 BLE 配网

这是消费产品体验最稳定的方案，不等于日常依赖手机：

1. 新设备启动 BLE 配网服务，同时墨水屏显示二维码和六位配对码。
2. 用户在 Expo App 扫码，验证设备序列号和配对码。
3. App 通过 BLE 把 SSID、Wi-Fi 密码和一次性云端 bootstrap token 加密发送给 ESP32。
4. ESP32 写入 NVS，关闭配网广播并连接路由器。
5. ESP32 使用 bootstrap token 换取设备长期证书；bootstrap token 立即失效。
6. 从此屏幕自行联网和拉取画面，手机可以关机或离开家庭网络。

配网数据不能明文广播。至少使用二维码中的设备临时公钥完成 ECDH，再用会话密钥加密 Wi-Fi 密码。

### 如果首次配网也禁止使用手机

只能从以下方案选择，仍然需要用户在路由器或其他终端上进行一次操作：

#### WPS 按键

- 用户按路由器 WPS，再按屏幕配网键。
- ESP32 从路由器取得 Wi-Fi 凭据。
- 操作最少，但很多新路由器已关闭 WPS，安全性和兼容性一般，不适合作为唯一方案。

#### Wi-Fi Easy Connect / DPP

- 路由器扫描屏幕二维码，或屏幕读取路由器 DPP 信息。
- 安全性优于 WPS，但家庭路由器支持率不统一，屏幕没有摄像头时流程受限。

#### 屏幕临时热点 + Captive Portal

- 屏幕启动 `PhotoWall-XXXX` 临时热点。
- 用户用任意手机、平板或电脑连接后打开配置页，选择家庭 Wi-Fi 并输入密码。
- 不依赖 App，但仍需要一台带浏览器的设备；iOS/Android captive portal 行为需要大量兼容测试。

#### 出厂预置网络

- 只适合企业统一部署或展会：提前写入固定 SSID/密码。
- 不适合普通家庭，不可能在出厂时知道每个用户的路由器凭据。

因此，真正“首次到日常完全无手机、无输入设备、兼容所有家庭路由器”的方案不存在。建议产品定义为：**手机仅负责首次配网和账号绑定，屏幕之后永久自主联网**；同时提供 WPS 或临时热点作为恢复备用。

### 自主重连策略

固件需要实现：

- 保存最多 3 个已知 Wi-Fi，按最近成功顺序尝试。
- 启动后快速连接 20–30 秒，失败后指数退避。
- 短时断网保持当前画面，不反复全刷。
- 每隔一段时间重新扫描已知网络。
- 连续 10–15 分钟失败时进入 recovery，但不要自动清除凭据。
- 长按物理键 8–10 秒才清除 Wi-Fi 和设备绑定。
- 在线后使用 NTP 校时，再建立 TLS/MQTT/HTTPS 连接。
- 路由器重启、DHCP 地址变化和云端暂时不可用时自动恢复。
- LED 或屏幕角标区分：未配网、连接中、云端离线、在线、刷新失败。

### 凭据与安全

- Wi-Fi 密码放在 ESP32 NVS，加密密钥使用 eFuse/Flash Encryption 保护。
- 每台设备拥有不同的 device key/certificate。
- Wi-Fi 凭据和云端 device token 分开存储。
- 恢复出厂同时撤销云端设备会话；仅清除 Wi-Fi 时不要解除家庭绑定。
- OTA 包必须签名验证，不能仅依赖 HTTPS 下载地址。

## 六色帧格式

建议云端生成设备可直接消费的文件：

```text
Header
- magic: PWE6
- format_version
- width: 1200
- height: 1600
- revision
- payload_size
- sha256

Payload
- 每像素 4 bit 面板色码
- 色码：0 黑、1 白、2 黄、3 红、5 蓝、6 绿
- 原生未压缩大小约 960 KB
```

可进一步按左 600 列、右 600 列分成两个文件，设备边下载边写屏，降低 PSRAM 占用。对象存储启用 gzip 并不能保证对抖动数据有很高压缩率，因此设备和云端都必须按约 1 MB/帧设计。

## 云端组成

### API 服务

保留 FastAPI，但需要：

- Linux/Docker 兼容字体和路径。
- `/api/v1` 账号、家庭、设备、相册、人物策略、草稿与发布接口。
- JWT/refresh token 或托管认证服务。
- 设备使用独立 device token/证书，不能复用用户 token。

### 数据库

从全局 JSON 迁移到 PostgreSQL：

- accounts
- households
- memberships
- devices
- album_sources
- photos
- people
- person_policies
- wall_drafts
- display_revisions
- device_jobs

所有业务数据按 `household_id` 隔离。

### 对象存储

使用 S3/R2/OSS 等保存：

- 用户原图（私有）
- 缩略图
- 渲染预览
- 面板六色帧

ESP32 只获取短时签名下载 URL，不公开桶，不把长期云密钥写进固件。

### 异步任务

照片上传后由任务队列完成：

- EXIF 处理和去重
- 标签/人物识别
- 模板渲染
- Spectra 6 显色补偿和量化
- 生成面板帧
- 创建 device job

不要在 HTTP 请求中同步执行数分钟任务。可选 Celery/RQ/Dramatiq；MVP 也可先用单独 worker 和 PostgreSQL job 表。

## ESP32 固件改造

当前官方 Loader 不适合作为最终产品固件，需要新建 13.3E6 专用固件，至少包括：

- Wi-Fi 配网和凭据安全存储
- HTTPS 客户端与 CA 校验
- 设备配对和 token 更新
- manifest 轮询或 MQTT
- 断点/失败重试
- 六色帧校验
- 13.3E6 左右通道驱动
- 刷新状态上报
- 看门狗
- OTA 固件升级
- 恢复出厂设置

不能只把当前 Python `eink_push.py` 搬到云端，因为它是“服务器主动连接局域网 Loader”；新固件必须变为“设备主动连接云端”。

## Expo 改造

- API 地址从 `.local`/localhost 改为 `https://api.example.com`。
- 使用 SecureStore 保存用户会话。
- 增加设备配网/扫码配对流程。
- 上传照片到对象存储签名 URL。
- 发布动作只创建 display revision，不直接访问设备 IP。
- 通过 API/WebSocket 查看设备在线与刷新进度。
- 普通用户不再看到或填写 `192.168.1.200`。

## 不推荐方案

### 手机直接推 Loader

理论上可以把当前 Loader 协议重写进 Expo 原生模块，但不适合作为正式产品：

- 手机必须与屏幕在同一局域网。
- iOS 后台运行和长连接容易中断。
- 每次传输 1–3 分钟，用户必须保持 App 前台。
- 远程更新、定时换图和多账号自动化无法工作。
- 官方 Loader 没有正式设备认证。

只适合短期演示，不是“完全独立运行”。

### 仅把 FastAPI 放到云端

不可行。云端无法主动连接 NAT 后面的 `192.168.1.200`，仍需要家庭网关或自拉取固件。

### Raspberry Pi/NAS 替代 Mac

这是最快的过渡方案，技术上已经不依赖 Mac：

```text
手机 → 家庭 Pi/NAS → 官方 Loader → 屏幕
```

优点是当前 `eink_push.py` 基本可复用；缺点是每个家庭仍需一台常开网关，不符合最终消费产品体验。

## 推荐实施顺序

### Phase 1：家庭网关过渡版

目标：最快关闭 Mac 后仍可用。

- 用 Raspberry Pi 4/5、NAS 或低功耗 Linux 小主机运行 Docker 后端。
- 修复 macOS 字体依赖。
- 挂载持久化照片与数据库目录。
- 保持官方 Loader 和现有局域网推送。

适合内部测试，预计 1–3 天。

### Phase 2：云端控制面

- FastAPI Docker 化并部署常驻容器。
- PostgreSQL、对象存储、任务 worker。
- Expo 改成云端认证和上传。
- 完成账号、家庭、设备、人物策略及 revision API。

适合多人和远程管理。

### Phase 3：自拉取 ESP32 固件

- 跑通 Wi-Fi 配网和设备注册。
- 下载固定测试六色帧并显示。
- 增加 revision、状态上报、失败重试。
- 增加 OTA 和设备证书。
- 替换官方 Loader。

完成后才是真正不需要 Mac 或家庭网关的版本。

### Phase 4：量产安全与稳定性

- 每设备唯一证书/密钥。
- 固件签名和安全 OTA。
- 对象 URL 短时签名。
- 隐私删除和账号注销链路。
- 离线缓存、断电恢复、灰度升级、日志和监控。

## MVP 验收标准

真正无 Mac MVP 必须满足：

1. Mac 关机，系统仍可工作。
2. 手机使用蜂窝网络也能上传并发布。
3. 屏幕只需家庭 Wi-Fi 和电源。
4. 发布后 ESP32 在 30 秒内发现新 revision。
5. 下载失败不会破坏当前画面。
6. 刷新完成后 App 能看到 done 状态。
7. 路由器重启后设备能自动恢复。
8. 云端无法直接访问家庭局域网，所有连接都由 ESP32 向外发起。
