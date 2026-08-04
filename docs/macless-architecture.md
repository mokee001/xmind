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
