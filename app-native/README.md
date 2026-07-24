# 手帐照片墙 · 手机 App（Expo / React Native）

这是**能自动读取相册**的原生 App（网页做不到后台读相册，必须原生）。
授权一次相册后：自动挑最近的照片 → 上传后端 → 后端 AI 识别筛选 → 套模板 → 投到显示屏。
支持「自动模式」：每 5 分钟检测有没有新照片，有就自动换屏（电子相框效果）。

---

## 一次性准备（在电脑上）

1. 手机装 **Expo Go**（App Store / 应用商店搜 "Expo Go"）。
2. 电脑装了 Node（已确认 v24）。
3. 手机和电脑连**同一个 WiFi**（和显示屏也要同一个网）。

## 跑起来（推荐做法，版本最稳）

因为 Expo Go 会随时间升级 SDK，最稳的是用官方脚手架生成工程、再放入本目录的两个文件：

```bash
# 1) 在 photo-wall 目录下，用最新 SDK 生成一个空工程
cd /Users/wanghuan10/Xmind/photo-wall
npx create-expo-app@latest photo-wall-app --template blank

# 2) 用本目录准备好的文件覆盖进去
cp app-native/App.js  photo-wall-app/App.js
#   把 app-native/app.json 里的 "ios"/"android"/"plugins" 三段，
#   合并进 photo-wall-app/app.json 的 "expo" 里（权限说明用得到）

# 3) 装相册权限插件（会自动匹配当前 SDK 版本）
cd photo-wall-app
npx expo install expo-media-library

# 4) 启动
npx expo start
```

启动后终端会出现一个二维码，用**手机 Expo Go 扫码**即可打开 App。

> 想直接用本目录的 `package.json`（固定 Expo SDK 51）也行：
> `cd app-native && npm install && npx expo start`
> 但如果你的 Expo Go 是更新的 SDK，会提示版本不匹配，那就按上面的推荐做法来。

## 用法

1. App 里「后端地址」填跑服务那台电脑的地址，例如 `http://192.168.0.102:8000`
   （建议用主机名 `http://HJFG3FGM46.local:8000`，电脑 IP 变了也不怕）。
2. 选模板 → 点「**授权并自动同步上屏**」→ 第一次会弹相册授权，允许后即自动上屏。
3. 打开「**自动模式**」开关，就变成无人值守：拍了新照片自动换屏。

## 说明 / 常见问题

- **上传的是最近 12 张候选**，后端再从中挑画质/偏好最高的几张填模板（数量由模板决定）。
  想改候选数量：改 `App.js` 里的 `CANDIDATE_COUNT`。
- **连不上后端**：确认三者同一 WiFi；电脑后端在跑（`uvicorn ... --host 0.0.0.0`）；地址用电脑局域网 IP 而不是 localhost。
- **iOS 只授权了部分照片**也能用（读取被授权的那些）。
- 这是走 Expo Go 的开发调试方式；要做成能长期安装的独立 App（不依赖 Expo Go），
  后续用 `eas build` 打 ipa/apk（需要 Expo 账号）。
