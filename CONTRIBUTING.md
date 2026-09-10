# 团队协作手册（三人版）

> 面向刚上手 Git/GitHub 的同学。照着做，合并基本不会出错。

## 一、三人分工与目录归属

**原则：每人只改自己负责的目录，就几乎不会有冲突。**

| 负责人 | 角色 | 负责目录 / 文件 |
|---|---|---|
| **A** | 后端核心 / 选片智能 / 大屏出图 | `backend/`（除 `routers/content.py`）、`engine.py` 的非渲染部分、`display/`、`firmware/`、部署 |
| **B** | 内容创作（渲染 / 模板 / 贴纸 / Studio）| `backend/routers/content.py`、`backend/templates_mgr.py`、`backend/stickers.py`、`engine.py` 的渲染原语、`templates/`、`stickers/`、`studio/` |
| **C** | 采集 App / 展示前端 | `photo-wall-app/`（Expo）、`webapp/` |

> 后端接口已按人拆分：A 改 `backend/server.py`，B 改 `backend/routers/content.py`，两人日常互不碰同一个文件。

## 二、三人之间的接口契约（只有这几个，改动前必须先说一声）

- **C → A**：`POST /api/upload`、`GET /api/known_photos`、`POST /api/generate`、`GET /api/smart_albums`
- **A → 当前网页展示端**：`WS /ws/display`
- **Legacy LCD only**：`GET /api/frame_id`、`GET /api/frame.jpg?w=800&h=480`；仅供 `firmware/legacy/display_esp32`，不得用于新设备流或墨水屏测试
- **C/前端 → B**：`GET /api/templates`、`POST /api/upload_template`、`POST /api/upload_sticker`、`GET /api/stickers`、`POST /api/studio/preview`
- **A ↔ B 代码契约**：`engine.render(template, photos, context, badges, stickers)` 的函数签名。**谁要改它，两人一起确认。**

改任何接口：**先在群里说 + 更新本文件，再动代码。**

## 三、开工前的一次性准备（组长做一次）

```bash
cd photo-wall
# 1) 仓库已 init 并有干净首提交；把它推到 GitHub：
git remote add origin <你们的 GitHub 仓库地址>
git branch -M main
git push -u origin main
```

在 GitHub 仓库网页里：**Settings → Branches → Add rule**，勾选
`Require a pull request before merging`（禁止直接推 main，必须走 PR）。

> ⚠️ 绝不能进 git 的东西（`.gitignore` 已帮你排除）：`photos/`（783M 私人照片）、
> `output/`（生成图）、`backend/data/`（每次运行都变的状态）、`node_modules/`、`*.pt`（模型权重）。
> 模型权重另行下载或找 A 拷贝，别塞进仓库。

## 四、每周协作流程（每个人照抄）

```bash
# 周一：更新 + 开自己的分支
git checkout main
git pull origin main
git checkout -b 名字-本周任务        # 例：alice-camera

# 本周：只在自己目录里改，随时提交
git add .
git commit -m "做了什么"

# 周五：推分支 → 去 GitHub 开 Pull Request → 组长看一眼 → Merge
git push origin 名字-本周任务
```

合并后，下周一每人 `git pull origin main` 就拿到别人的成果。

## 五、为什么这样就不会冲突（原理）

Git 冲突**只发生在"两个人改了同一个文件的同一行"**。避免它两招：
1. **目录隔离**：三人各管各的目录，几乎不碰同一文件。
2. **忽略会自动变动的文件**：`backend/data/`、`output/` 这些一跑程序就变，已被 `.gitignore` 排除，不进 git 就不会天天冲突。

## 六、环境搭建（新人一次）

```bash
# 后端（A/B 需要）
cd photo-wall
python3 -m pip install -r requirements.txt
python3 -m uvicorn backend.server:app --reload --port 8000
# 打开 http://localhost:8000/app（手机端）  /studio（创作平台）  /screen（大屏）

# 手机 App（C 需要）
cd photo-wall-app
npm install
npx expo start
```

## 七、踩坑清单（已知会绊倒人的点）

- **改了后端代码要重启服务**才生效（本机用 launchd：`launchctl kickstart -k gui/$(id -u)/com.photowall.backend`，等 8 秒）。
- **Python 3.9** 写类型别用 `str | None`，要用 `Optional[str]`（`from typing import Optional`），否则启动报错。
- **模板是 960×1280 竖版 / 大屏是 800×480 横屏**，竖版上大屏会有黑边。
- **贴纸/模板改动**改 `backend/routers/content.py`（B 的地盘），别去动 `server.py`。
- 手写/花体字体里没有的字符（如 `→`）会渲染成豆腐块，标注文字尽量用常见字符。

## 八、每周联调

用一台"集成机"（接了 ESP32 大屏的那台 Mac）：每周合并后跑一遍端到端——
手机拍照/选图 → 后端选片 → 渲染 → 上大屏，问题早发现。
