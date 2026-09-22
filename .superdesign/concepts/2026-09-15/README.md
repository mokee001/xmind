# 首页静态概念图 · 2026-09-15

用户批准探索光影纸面、回忆织毯、显影长卷三款精修首屏概念图。当前用于选择视觉方向，尚未选定，不是交互 Demo 或 App 实现。

比较页：http://127.0.0.1:8096/concepts/

## 输出

- `paper-v2.png`：最终光影纸面。v1 顶部透明瑕疵与浅灰文字已通过原生 ImageGen 定向修复；v1 作为历史保留。
- `weave-v1.png`：最终回忆织毯。
- `film-v1.png`：最终显影长卷。
- `prompts.json`：三款生成的完整原始提示词。
- `paper-v2-prompt.txt`：纸面修复的完整提示词。
- `manifest.json`：公开参考图地址、Superdesign 节点 ID、散列与版本。

全部通过内置 `image_gen.imagegen` 生成，每款独立生成。最终图尺寸均为 853×1844，RGB、不透明。生成原件保留在 Codex generated_images 目录；最终副本同时用于 `demos/home-scenes/concepts/` 静态画廊。图中人物与场景均为生成示例，没有使用或上传用户私人照片。

## 参考锁定与角色

| 方向 | 研究来源 | 借用的原则 | 独立构图决定 |
| --- | --- | --- | --- |
| 光影纸面 | James Turrell, Elemental：https://www.pacegallery.com/exhibitions/james-turrell-elemental/ | 光可成为感知空间与时间的材料 | 白色连续折面承载日期，历史影像融入纸面，没有照片卡片；不复制其具体作品 |
| 回忆织毯 | Anni Albers, Tapestry：https://www.moma.org/collection/works/2613 | 织物的材质、深浅变化和图形背景关系 | 每一段编织对应一天，海边与咖啡馆的形象直接进入织物；不复制其图案 |
| 显影长卷 | Christian Marclay, The Clock：https://www.moma.org/calendar/exhibitions/5746 | 用影像顺序使时间被感知 | 深色间隔组织日期，摄影成为连续页面的主体；不使用其作品素材 |

共同产品依据为用户本次确认的方向与此前约束：顶部连接状态、偏好和设置同级、无 Tab、仅历史内容、今天留白。示例日期固定 2026-09-15；13 日海边、11 日咖啡馆。页面底部明确标注静态示例。

## 检查

- 逐张查看构图、入口、日期与中文；纸面初稿问题已修正。
- 浏览器 878×1167：三列完整显示，图片自然比例，无横向溢出，三图均加载成功。
- 浏览器 390×844：单列完整比例展示，无横向溢出，可通过顶部锚点跳转到各方向。
- 图内控件不可操作；比较器仅原图链接与锚点可点击。
- 三张最终图已作为 reference 上传到现有 Superdesign 画布。没有调用平台付费生成，没有迁移 App 或发布 TestFlight。

下一步以用户选择的图为视觉目标，再实现动态与交互；不默认把任一方案设为胜出版本。
