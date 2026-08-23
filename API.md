# API 接口契约（前后端对接依据）

> 本文是 **A（后端）** 与 **C（前端 App/Web）** 的对接白纸黑字依据。
> 改字段/改路径 = 破坏契约，必须先在群里说一声、并同步更新本文。
> 服务地址默认 `http://<Mac-IP>:8000`，本机调试用 `http://localhost:8000`。

约定：
- 所有返回都是 JSON（图片类接口除外，返回二进制）。
- 时间字段 `date` 是字符串，空串表示"由后端用今天"。
- 标签（tags/filters）是英文小写词，如 `warm`、`food`、`person_1`。

**GET `/healthz`** — 生产健康检查，不依赖照片、设备或账号状态。
```json
{ "status": "ok", "storage_ready": true }
```
当运行时照片、输出或存储目录不可读写时返回 `503`，并将 `status` 设为 `degraded`。

---

## 一、归属划分

| 前缀 / 路径 | 负责人 | 文件 |
|---|---|---|
| `/api/authorize` `/api/upload` `/api/photos` `/api/known_photos` | A | `backend/server.py` |
| `/api/generate` `/api/suggest_filters` | A | `backend/server.py` |
| `/api/cluster_people` `/api/people` `/api/retag` `/api/smart_albums` | A | `backend/server.py` |
| `/api/label` `/api/train` `/api/model` | A | `backend/server.py` |
| `/api/devices/bootstrap` `/api/devices/auto-claim` `/api/devices/*` | A | `backend/server.py` |
| `/ws/display` `/output/{name}` `/api/thumb/{name}` `/photos/{name}` | A | `backend/server.py` |
| `/api/frame_id` `/api/frame.jpg` | Legacy LCD only | `backend/server.py` |
| `/api/stickers` `/api/upload_sticker` `/api/sticker.png/{name}` | B | `backend/routers/content.py` |
| `/api/templates` `/api/upload_template` `/api/delete_template` `/api/template_preview/{tid}.png` | B | `backend/routers/content.py` |
| `/api/studio/preview` | B | `backend/routers/content.py` |

---

## 二、核心链路

### 0. BLE 首次绑定与重新配网（A）

设备没有网络配置时广播 `PhotoWall-XXXX` BLE 服务。App 连接后要求用户按住设备
BOOT 键确认，通过 BLE 读取一次性 `setup_token`，让设备扫描附近 Wi-Fi，并将所选
SSID、密码和固定云端地址发送给设备。设备联网后向云端 bootstrap；App 使用下列
接口自动绑定，不需要输入配对码。临时热点网页保留为兼容恢复路径，不是 App 主流程。

**POST `/api/devices/auto-claim`** — Body：
```json
{ "device_id": "pwe6-90E5B1D6E300", "setup_token": "<32-char token>", "name": "客厅照片墙" }
```
令牌仅在设备 bootstrap 后有效 10 分钟，只能使用一次。成功返回 `device` 和
`account_token`。原 `POST /api/devices/claim` 继续保留，作为手动恢复路径。

**POST `/api/devices/{device_id}/reprovision`** — Header：
`X-Account-Token: <account_token>`。保留设备绑定和相册账户，下发重新配网命令。
设备下一次轮询收到：
```json
{ "command": "reprovision", "preserve_binding": true }
```
设备清除原 Wi-Fi、重启并重新广播 BLE；新 Wi-Fi 配置成功后继续使用原设备与账户凭据。

**DELETE `/api/devices/{device_id}`** — Header：
`X-Account-Token: <account_token>`。立即撤销 App 绑定，并让设备清除 Wi-Fi 和设备凭据。
设备下一次轮询收到：
```json
{ "command": "reprovision", "preserve_binding": false }
```
设备确认后从服务端设备表移除，再次添加必须完整执行 BLE 配网和自动绑定。

### 1. 相册授权 / 上传（A）

App 调用本节以及“画面生成 / 人物”接口时统一携带
`X-Account-Token: <account_token>`。服务端按账户隔离照片、已识别文件名、人物和智能相簿；
不带 Header 的调用只进入旧版 `legacy` 调试空间。

**POST `/api/authorize`** — 扫描服务器 `photos/` 目录并全部打标（调试用）。
返回：
```json
{ "authorized": true, "count": 42, "photos": [ /* 见下方 Photo */ ] }
```

**POST `/api/upload`** — App 上传照片（`multipart/form-data`）。
Query 参数：
| 参数 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `auto` | int | 0 | 1=上传后自动选图→套模板→上屏 |
| `template` | string | daily_polaroid | 模板 id |
| `title` | string | 我的一天 | 标题 |
| `date` | string | "" | 日期，空=今天 |
| `filters` | string | "" | 逗号分隔的筛选维度，如 `warm,food` |

Body：`files`（可多张）。
返回：
```json
{
  "saved": 3, "count": 40, "removed_duplicates": 2,
  "photos": [ /* Photo[] */ ],
  "wall": { /* auto=1 时才有，见 Wall */ }
}
```

**GET `/api/photos`** → `{ "photos": Photo[] }`
**GET `/api/known_photos`** → `{ "names": string[] }`（已见过的文件名，用于**增量上传**：App 只传不在此集合里的新照片）

### 2. 画面生成（A）

**POST `/api/generate`** — Body（JSON）：
```json
{
  "template": "daily_polaroid",
  "title": "我的一天",
  "date": "",
  "filters": ["warm", "food"],
  "exclude_filters": ["person_2"]
}
```

`exclude_filters` 用于“不展示”人物或主题；命中任一排除标签的照片都不会进入候选，
优先级高于 `filters` ，也不会因为主题回退而重新入选。
返回 `Wall`；相册为空返回 `400 {"error": "..."}`。

**GET `/api/suggest_filters`** — "更懂你的相册"，返回真实存在且占比够高的可选筛选：
```json
{
  "total": 40,
  "suggestions": {
    "color": [ {"tag":"warm","count":18,"ratio":0.45} ],
    "theme": [ {"tag":"food","count":12,"ratio":0.30} ],
    "mood":  []
  },
  "top": ["warm","food"]
}
```

### 3. 人物（A）

- **POST `/api/cluster_people`** → 聚类人脸，给照片打 `person_1/person_2…`。人脸库没装时 `{"available": false, ...}`。
- **GET `/api/people`** → `{ "people": [...], "available": bool }`
- **GET `/api/smart_albums`** → 返回该账户真实照片生成的人物、宠物、主题、情绪、色彩和精选相簿。
- **POST `/api/retag`** → 用最新规则重打库里已有照片。

### 4. 网页展示端（A）

- **WS `/ws/display`** — 展示屏订阅。生成新画面时后端 broadcast：`{ "type": "wall", ...Wall }`。
- **GET `/output/{name}`** — 取生成的 PNG。
- **GET `/api/thumb/{name}`** / **GET `/photos/{name}`** — 缩略图 / 原图。

历史兼容接口（仅供 `firmware/legacy/display_esp32`，不属于当前设备流或墨水屏测试）：

- **GET `/api/frame_id`** — 早期液晶固件轮询画面版本。
- **GET `/api/frame.jpg`** — 早期液晶固件拉取 800×480 JPEG。

### 5. 模型训练（A）

- **POST `/api/label`** — Body：`{ "wall_id": "", "samples": [ {"tag":"warm","score":1.0} ] }`（score 0=差 1=好）。
- **POST `/api/train`** — 触发训练。
- **GET `/api/model`** — 模型状态。

---

## 三、内容创作（B）

### 贴纸
- **GET `/api/stickers`** → 贴纸列表。
- **POST `/api/upload_sticker`** → 上传贴纸 PNG（`multipart/form-data`）。
- **GET `/api/sticker.png/{name}`** → 取贴纸图。

### 模板
- **GET `/api/templates`** → 模板列表（含内置 + 用户上传）。
- **POST `/api/upload_template`** → 上传模板 JSON。
- **POST `/api/delete_template`** → 删除用户模板。
- **GET `/api/template_preview/{tid}.png`** → 模板预览图（画布 **960×1280**）。

### Studio 预览
- **POST `/api/studio/preview`** — Body：`{ "template": "", "title": "...", "date": "..." }`，返回样例渲染预览。

---

## 四、数据结构

### Photo
```json
{
  "path": "/abs/path/photos/IMG_0001.HEIC",
  "filename": "IMG_0001.HEIC",
  "tags": ["warm", "food", "person_1"],
  "taken_at": 1700000000.0,
  "final_score": 0.87
}
```

### Wall（一面照片墙 = 一次生成结果）
```json
{
  "wall_id": "wall_1700000000",
  "template": "daily_polaroid",
  "title": "我的一天",
  "date": "2026-07-24",
  "image_url": "/output/wall_1700000000.png",
  "elements": ["food", "warm"],
  "filters": ["warm"],
  "filter_fallback": false,
  "chosen": [ {"filename":"IMG_0001.HEIC","final_score":0.87} ],
  "stickers": 4
}
```

---

## 五、改契约的规矩
1. **只加字段、不删字段**：前端老代码不会崩。
2. **要改路径/删字段**：先在群里同步，本文同步改，双方约定好再动。
3. **模板画布固定 960×1280**，贴纸/模板坐标都以此为基准。
4. 联调时以本文为准；本文和代码不一致 → **以代码为准并立刻回来改本文**。
