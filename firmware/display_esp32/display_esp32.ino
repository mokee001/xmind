/*
 * 手帐照片墙 · ESP32-S3 + ST7262 800x480 RGB 屏 固件
 * ============================================================
 * 板子: ESP32-S3-WROOM-1（需带 PSRAM，用于 800x480 帧缓冲）
 * 屏:   ST7262  800x480  RGB 并口（16bit RGB565）
 *
 * 引脚按最常见的 Sunton ESP32-8048S043 / 通用 4.3寸 800x480 RGB 板 配好。
 * 若你的板子引脚不同，改下面 Arduino_ESP32RGBPanel(...) 里的 GPIO 即可。
 *
 * 需要的 Arduino 库（库管理器搜索安装）：
 *   - GFX Library for Arduino (moononsoftware)   RGB 并口屏驱动
 *   - JPEGDEC                 (bitbank2)          JPEG 解码
 *   - WebSockets              (links2004)         WebSocket 客户端
 *
 * 编译前置（Arduino IDE）：
 *   开发板选 "ESP32S3 Dev Module"，PSRAM 选 "OPI PSRAM"，Flash 16MB。
 * ============================================================
 */

#include <WiFi.h>
#include <HTTPClient.h>
#include <WebSocketsClient.h>
#include <Arduino_GFX_Library.h>
#include <JPEGDEC.h>
#include <ESPmDNS.h>

// ================== 按你的环境修改 ==================
const char* WIFI_SSID = "mokeewifi";
const char* WIFI_PASS = "19930415";
const char* SERVER_HOST = "192.168.1.199";  // 兑底：跑后端那台电脑的局域网 IP
const char* SERVER_MDNS = "HJFG3FGM46";     // 优先：电脑的 .local 主机名(不含 .local)，IP变了也能自动找到
const uint16_t SERVER_PORT = 8000;

const int SCREEN_W = 800;
const int SCREEN_H = 480;
const int BACKLIGHT_PIN = 2;   // VIEWE UEDX80480043E 背光 GPIO2，高电平点亮（官方确认）
// ===================================================

// ---- ST7262 800x480 RGB 并口面板（VIEWE UEDX80480043E-WB-A 官方引脚+时序）----
Arduino_ESP32RGBPanel* rgbpanel = new Arduino_ESP32RGBPanel(
  40 /*DE*/, 41 /*VSYNC*/, 39 /*HSYNC*/, 42 /*PCLK*/,
  45 /*R0*/, 48 /*R1*/, 47 /*R2*/, 21 /*R3*/, 14 /*R4*/,
  5  /*G0*/, 6  /*G1*/, 7  /*G2*/, 15 /*G3*/, 16 /*G4*/, 4 /*G5*/,
  8  /*B0*/, 3  /*B1*/, 46 /*B2*/, 9  /*B3*/, 1  /*B4*/,
  0 /*hsync_polarity*/, 20 /*hsync_front_porch(HFP)*/, 1 /*hsync_pulse_width(HPW)*/, 42 /*hsync_back_porch(HBP)*/,
  0 /*vsync_polarity*/, 4 /*vsync_front_porch(VFP)*/, 10 /*vsync_pulse_width(VPW)*/, 12 /*vsync_back_porch(VBP)*/,
  1 /*pclk_active_neg*/, 15000000 /*prefer_speed 15MHz*/,
  false /*useBigEndian*/, 0 /*de_idle_high*/, 0 /*pclk_idle_high*/,
  SCREEN_W * 10 /*bounce_buffer_size_px：用内部SRAM中转10行，消除RGB屏持续抖动/撕裂*/);

Arduino_RGB_Display* gfx = new Arduino_RGB_Display(SCREEN_W, SCREEN_H, rgbpanel);

WebSocketsClient webSocket;
JPEGDEC jpeg;
volatile bool needFetch = false;
unsigned long g_lastFetch = 0;   // 上次拉图时间（兜底轮询用）
unsigned long g_lastCheck = 0;   // 上次问“画面变了没”的时间
String g_host = SERVER_HOST;   // 实际使用的后端地址（mDNS 解析成功则替换为解析到的 IP）
String g_frameId = "";        // 当前已显示画面的版本号（避免重复重绘同一张图导致闪屏）
String g_pendingId = "";      // 本次正在拉取的画面版本号（拉取成功后赋给 g_frameId）
int g_fetchFails = 0;          // 连续拉图失败次数（用于触发重新解析后端地址，自愈 IP 变化）

// 问后端“当前画面版本号”。和已显示的不同才需要重绘。网络异常返回空串（不触发重绘）。
String fetchFrameId() {
  if (WiFi.status() != WL_CONNECTED) return "";
  HTTPClient http;
  String url = "http://" + g_host + ":" + String(SERVER_PORT) + "/api/frame_id";
  http.begin(url);
  int code = http.GET();
  String id = "";
  if (code == HTTP_CODE_OK) id = http.getString();
  http.end();
  return id;
}

// mDNS 解析后端主机名 -> IP。成功且 IP 有变化则更新 g_host 并返回 true。
bool resolveHost() {
  IPAddress ip = MDNS.queryHost(SERVER_MDNS, 2000);
  if ((uint32_t)ip != 0) {
    String newHost = ip.toString();
    if (newHost != g_host) {
      g_host = newHost;
      Serial.print("mDNS 解析 ");
      Serial.print(SERVER_MDNS);
      Serial.print(".local -> ");
      Serial.println(g_host);
      return true;
    }
  }
  return false;
}

// JPEGDEC 解码回调：把每个像素块画到屏幕
int jpegDraw(JPEGDRAW* p) {
  gfx->draw16bitBeRGBBitmap(p->x, p->y, p->pPixels, p->iWidth, p->iHeight);
  return 1;
}

void fetchAndDraw() {
  if (WiFi.status() != WL_CONNECTED) return;

  HTTPClient http;
  String url = "http://" + g_host + ":" + String(SERVER_PORT) +
               "/api/frame.jpg?w=" + String(SCREEN_W) + "&h=" + String(SCREEN_H);
  http.begin(url);
  int code = http.GET();
  if (code == HTTP_CODE_OK) {
    int len = http.getSize();
    if (len > 0) {
      // JPEG 数据放 PSRAM，省内部 RAM（帧缓冲也在 PSRAM）
      uint8_t* buf = (uint8_t*)ps_malloc(len);
      if (!buf) buf = (uint8_t*)malloc(len);
      if (buf) {
        WiFiClient* stream = http.getStreamPtr();
        int read = 0;
        while (http.connected() && read < len) {
          int avail = stream->available();
          if (avail > 0) read += stream->readBytes(buf + read, avail);
          else delay(1);
        }
        if (jpeg.openRAM(buf, len, jpegDraw)) {
          jpeg.setPixelType(RGB565_BIG_ENDIAN);
          jpeg.decode(0, 0, 0);
          jpeg.close();
          g_fetchFails = 0;   // 拉图成功，清零失败计数
          g_frameId = g_pendingId;   // 记下已显示画面的版本号，下次相同就不重绘
          Serial.printf("已刷新画面 (%d bytes)\n", len);
        } else {
          Serial.println("JPEG 打开失败");
        }
        free(buf);
      } else {
        Serial.println("内存不足");
      }
    }
  } else {
    g_fetchFails++;   // 拉图失败累计，达到阈值后在 loop 里重新解析后端地址
    Serial.printf("拉图失败 HTTP %d\n", code);
  }
  http.end();
}

void webSocketEvent(WStype_t type, uint8_t* payload, size_t length) {
  switch (type) {
    case WStype_CONNECTED:
      Serial.println("WebSocket 已连接后端");
      g_lastCheck = 0;   // 立即触发一次版本检查（变了才重绘），避免闪屏
      break;
    case WStype_TEXT:
      Serial.println("收到新画面通知");
      g_lastCheck = 0;   // 手机端一生成，立即查版本→有新图才拉、才重绘
      break;
    case WStype_DISCONNECTED:
      Serial.println("WebSocket 断开");
      break;
    default:
      break;
  }
}

void setup() {
  Serial.begin(115200);

  pinMode(BACKLIGHT_PIN, OUTPUT);
  digitalWrite(BACKLIGHT_PIN, HIGH);   // 点亮背光

  gfx->begin();
  gfx->fillScreen(RGB565_BLACK);
  gfx->setCursor(20, 20);
  gfx->setTextColor(RGB565_WHITE);
  gfx->setTextSize(2);
  gfx->println("连接中...");

  WiFi.begin(WIFI_SSID, WIFI_PASS);
  Serial.print("连接 WiFi");
  while (WiFi.status() != WL_CONNECTED) {
    delay(400);
    Serial.print(".");
  }
  Serial.println();
  Serial.print("WiFi OK, IP=");
  Serial.println(WiFi.localIP());

  // mDNS：优先用主机名解析后端 IP（电脑 IP 变了也能自动找到）；失败则用兑底 IP
  bool resolved = false;
  if (MDNS.begin("photowall-display")) {
    for (int i = 0; i < 5; i++) {
      if (resolveHost()) { resolved = true; break; }
      Serial.println("mDNS 解析中...");
    }
  }
  if (!resolved) {
    Serial.print("未mDNS解析，使用兑底 IP: ");
    Serial.println(g_host);
  }

  webSocket.begin(g_host.c_str(), SERVER_PORT, "/ws/display");
  webSocket.onEvent(webSocketEvent);
  webSocket.setReconnectInterval(3000);  // 断线自动重连
}

void loop() {
  webSocket.loop();

  // WiFi 掉线：自动重连，重连成功前不做别的
  if (WiFi.status() != WL_CONNECTED) {
    static unsigned long lastWifiTry = 0;
    if (millis() - lastWifiTry > 5000) {
      lastWifiTry = millis();
      Serial.println("WiFi 掉线，重连中...");
      WiFi.disconnect();
      WiFi.begin(WIFI_SSID, WIFI_PASS);
    }
    return;
  }

  // 兑底：每 2 秒问一次“画面版本号”（极轻量，纯文本）——变了才拉整张图重绘，
  // 没变就不动，彻底避免重复重绘同一张图导致的闪屏。WebSocket 通知会即时触发一次检查。
  if (millis() - g_lastCheck > 2000) {
    g_lastCheck = millis();
    String id = fetchFrameId();
    if (id.length() > 0 && id != g_frameId) {
      Serial.printf("画面有更新: %s -> %s\n", g_frameId.c_str(), id.c_str());
      g_pendingId = id;
      needFetch = true;
    } else if (id.length() == 0) {
      g_fetchFails++;   // 连版本号都拿不到，算一次失败，供下方自愈
    }
  }
  // 自愈：连续拉图/查版本失败（如电脑 IP 变了）时，重新 mDNS 解析后端地址并重连 WebSocket
  if (g_fetchFails >= 3) {
    Serial.println("多次拉图失败，重新解析后端地址...");
    if (resolveHost()) {
      webSocket.disconnect();
      webSocket.begin(g_host.c_str(), SERVER_PORT, "/ws/display");
    }
    g_fetchFails = 0;   // 无论是否解析到新 IP，先清零避免刷屏，下个周期再试
  }
  if (needFetch) {
    needFetch = false;
    g_lastFetch = millis();
    fetchAndDraw();
  }
}
