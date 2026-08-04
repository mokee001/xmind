# 手帐照片墙 · 排版引擎原型 (阶段0 核心验证)

> 2026 年 7 月 AI 手帐日历独立引擎见
> [docs/calendar/README.md](docs/calendar/README.md)。当前分支仅增加可调用模块，
> 不修改现有照片墙 API。

> 👥 **团队协作看这里** → [CONTRIBUTING.md](CONTRIBUTING.md)（分工、目录归属、每周 Git 流程、踩坑清单）
> 🔌 **前后端对接看这里** → [API.md](API.md)（接口路径、入参出参、字段归属）

把手机相册里的几张照片，自动填进「手帐风格」的模版，渲染成一张成品图。
这是整个项目最关键的一环——先验证「排版好不好看」，再谈硬件。

## 目录结构

```
photo-wall/
├── engine.py           # 排版渲染引擎（核心）
├── main.py             # 命令行入口
├── make_samples.py     # 生成占位示例照片（没有照片时用）
├── templates/          # 手帐模版（JSON 参数化布局）
│   ├── travel_grid.json
│   ├── daily_polaroid.json
│   └── monthly_collage.json
├── photos/             # 放你自己的照片（jpg/png）
├── output/             # 渲染结果
└── requirements.txt
```

## 快速开始

```bash
cd photo-wall
python3 -m pip install -r requirements.txt

# 1) 没有照片？先生成一批占位图
python3 make_samples.py

# 2) 用某个模版渲染
python3 main.py --template daily_polaroid --title "周末的一天" --date 2026-07-19

# 渲染所有模版看效果
python3 main.py --all --title "东京旅行" --date 2026-07-19
```

结果输出到 `output/`。

## 模版 JSON 结构说明

模版是**参数化布局**，不是死图。核心三层：

1. `canvas`   —— 画布尺寸 + 背景（纯色 / 纸纹）
2. `slots`    —— 照片槽位（位置/大小/旋转/白边/阴影），引擎按顺序把照片填进去
3. `decorations` —— 装饰层（标题、日期戳、和纸胶带、贴纸等）

这样一套模版能适配任意照片，也方便后续用 AI 批量生成新模版与素材。
详见 `templates/*.json` 里的注释字段。

---

## 软硬件互联系统（后端 + 手机端 App + 家庭屏）

在排版引擎之上，跑通了完整闭环：**相册授权 → AI 打标 → 智能选图生成 → 双端互联上屏 → 人工打标 → 训练偏好模型**。

### 目录

```
backend/          后端服务
├── server.py     FastAPI：REST + WebSocket，串起全链路
├── tagger.py     AI 打标：人物/宠物/场景/画质（真实图像信号 + 语义标签，可换真模型）
├── trainer.py    偏好模型 + 训练（每个维度一个可学习权重，梯度下降）
├── selector.py   智能选图：0.4*画质 + 0.6*偏好，挑 top-N
└── store.py      本地 JSON 存储
webapp/           手机端 App（相册授权 / 上传 / 预览 / 打标）
display/          家庭屏展示端（WebSocket 订阅，生成即实时上屏）
```

### 启动

```bash
cd photo-wall
python3 -m pip install -r requirements.txt

# 若没有照片，先造一批占位图
python3 make_samples.py

# 启动后端
python3 -m uvicorn backend.server:app --port 8000
```

打开：
- 手机端 App：http://localhost:8000/app
- 家庭屏展示端：http://localhost:8000/screen  （建议单独一个全屏窗口 / 平板）

### 使用闭环

1. 手机端点「授权相册」→ 自动扫描 `photos/` 并 AI 打标（每张显示 人物/宠物/场景/画质 维度）
2. 选模版、填标题日期，点「生成并上屏」→ 模型选图 + 渲染，**家庭屏实时刷新**（双端互联）
3. 在「打标训练」区，对本次画面涉及的**元素维度**点「好 / 差」→ 立即训练你的专属偏好模型
4. 再次生成时，选图会自动偏向你喜欢的维度、避开不喜欢的（长期越用越懂你）

### API

| 链路 | 接口 |
|---|---|
| 相册授权 | `POST /api/authorize`、`POST /api/upload` |
| 画面生成 | `POST /api/generate` |
| 双端互联 | `WS /ws/display` |
| 模型训练 | `POST /api/label`、`POST /api/train`、`GET /api/model` |

### 关于「真实 AI 识别」

`backend/tagger.py` 里：
- 画质/亮度/色调/**模糊检测**是用 Pillow 真实计算的；
- 人物/宠物/场景的语义标签，MVP 用确定性占位实现（保证可复现、开箱即跑）。
- 生产环境把 `_detect_semantic()` 换成真实模型即可（YOLOv8 检测 / CLIP 零样本 / 云端视觉 API），
  返回同样的 tag 列表，**上层选图、打标、训练闭环一行都不用改**。
