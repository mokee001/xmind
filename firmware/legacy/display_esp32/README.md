# ESP32-S3 + ST7262 800×480 显示屏固件 · 烧录说明

> [!IMPORTANT]
> 这是冻结的早期 4.3 寸液晶屏实验版本，仅保留作历史参考。它不是 19 寸屏固件，
> 不参与当前 App 设备流、13.3E6 墨水屏固件、自动化测试或后续双屏演示。
> 新功能和连接协议不得依赖此目录。

这块固件让 **ESP32-S3-WROOM-1 + ST7262 800×480 RGB 屏** 成为「手帐照片墙」的家庭展示屏：
手机端一生成画面，ESP32-S3 通过 WebSocket 收到通知，自动去后端拉一张
按屏幕分辨率缩好的 JPEG 并显示。

> 你的屏 **ST7262 是 RGB 并口屏**（不是 SPI），所以用 ESP32-S3 的 RGB 外设 + PSRAM 驱动，
> 库用 `Arduino_GFX`（不是 TFT_eSPI）。固件已按此重写好。

## 一、你需要什么

- ESP32-S3-WROOM-1 开发板（**必须带 PSRAM**，用于 800×480 帧缓冲；800×480×2≈768KB）
- ST7262 800×480 RGB 并口屏（本固件已按 **VIEWE UEDX80480043E-WB-A（4.3寸 800×480）官方引脚+时序** 配好）
- 后端服务运行在同一局域网的电脑上

## 二、先配置固件参数

复制本目录的 `local_config.example.h` 为 `local_config.h`，然后仅在本机配置：

```cpp
#define PHOTOWALL_WIFI_SSID "your-wifi-name"
#define PHOTOWALL_WIFI_PASS "your-wifi-password"
#define PHOTOWALL_SERVER_HOST "192.168.1.100"
#define PHOTOWALL_SERVER_MDNS "your-mac-hostname"
```

`local_config.h` 已被 Git 忽略，不要把真实网络配置写入示例文件或提交到仓库。
查电脑局域网 IP（macOS）：`ipconfig getifaddr en0`。
> 一定用局域网 IP，**不能用 localhost / 127.0.0.1**。

### 引脚（已按 VIEWE 官方确认，无需改动）
固件里 `Arduino_ESP32RGBPanel(...)` 的 GPIO 与时序取自 VIEWE 官方板级配置
`BOARD_VIEWE_UEDX80480043E_WB_A.h`：

| 信号 | GPIO | 信号 | GPIO |
|---|---|---|---|
| DE | 40 | PCLK | 42 |
| VSYNC | 41 | HSYNC | 39 |
| R0–R4 | 45,48,47,21,14 | G0–G5 | 5,6,7,15,16,4 |
| B0–B4 | 8,3,46,9,1 | 背光 BL | 2（高电平点亮）|

时序（VIEWE 官方）：PCLK **15MHz**，HFP=20 / HPW=1 / HBP=42，VFP=4 / VPW=10 / VBP=12，pclk_active_neg=1。

> 这是你这块 **VIEWE UEDX80480043E-WB-A** 的原厂参数，直接烧录即可，不用改引脚。

## 三、两种烧录方式

### 方式 A：PlatformIO（推荐）
1. VS Code 装 PlatformIO 插件，打开本目录
2. `platformio.ini` 已配好 ESP32-S3 + OPI PSRAM + 16MB Flash 和三个库
3. 点底部 → (Upload) 编译并烧录（首次会自动下载库）

### 方式 B：Arduino IDE
1. 装 ESP32 开发板支持（开发板管理器搜 esp32，用 3.x 版）
2. 库管理器装三个库：**GFX Library for Arduino**（moononsoftware）、**JPEGDEC**（bitbank2）、**WebSockets**（Links2004）
3. 工具菜单里务必设置：
   - 开发板：**ESP32S3 Dev Module**
   - **PSRAM：OPI PSRAM**（不开 PSRAM 会崩）
   - Flash Size：16MB
4. 选好端口，点上传

## 四、验证

1. 后端已在 `0.0.0.0:8000` 运行
2. ESP32-S3 上电，串口监视器（115200）应打印：
   `WiFi OK` → `WebSocket 已连接后端`
3. 手机端 App 点「生成并上屏」→ 屏幕几秒内刷新出照片墙

## 五、工作原理（双端互联）

```
手机App --POST /api/generate--> 后端渲染照片墙
后端 --WS 推送(新画面通知)--> ESP32-S3
ESP32-S3 --GET /api/frame.jpg?w=800&h=480--> 后端返回缩放JPEG(约58KB)
ESP32-S3 用 JPEGDEC 解码 -> Arduino_GFX 画到 RGB 屏
```

## 常见问题

- **屏幕全黑/花屏/偏色**：引脚与时序已按 VIEWE 官方配好，一般不会花屏。若仍异常，先确认板子确为
  VIEWE UEDX80480043E-WB-A；偏色多是某组 R/G/B 顺序问题，按原理图核对。
- **一开机就 reboot / 内存分配失败**：PSRAM 没启用。Arduino IDE 里选 OPI PSRAM；PlatformIO 已带 `memory_type=qio_opi`。
- **连不上后端**：确认电脑和板子同一 WiFi；后端用 `--host 0.0.0.0` 启动；关掉电脑防火墙对 8000 端口拦截。
- **背光不亮**：`BACKLIGHT_PIN` 改成你板子的背光 GPIO（有的板低电平点亮，则改成 `digitalWrite(BACKLIGHT_PIN, LOW)`）。
