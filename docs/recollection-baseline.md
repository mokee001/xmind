# 后续相册筛选的默认基准

用户确认日期：2026-09-10。

- 完整提交：`c1c5683eb00c232123832a47f25ddd0d5e3e6e56`。
- 标签：`recollections-rules-v1.0.0`。
- 分支：`codex/recollections-rules-v1.0.0`。
- 固定清单：`config/recollection_rules_v1.0.0.json`，含 54 个文件及 5 个模型／词表指纹。
- 规则说明：`docs/recollection-rules-v1.0.0.md`。

此提交固定的是算法及依赖代码，不是某一批照片的相册成员。核对时，当前工作区的
54 个文件与提交一致；不需要切换分支或覆盖其他未提交工作。

## 默认用哪条链路

`selection_lab.recollection_feed.build_feed(lab)` 为后续生成主题相册的默认入口，
`/recollections` 为对应结果页，`/api/recollections` 为已保存结果接口。
可使用仓库中的 `打开回忆精选.command` 启动本地页面。

旧实验台的 `#memories` 是每册 8～40 张的统一回忆方案，不是这次确认的最终入口。
`#stories`、`#hybrid`、`#ente`、`#compare` 继续保留作明确标注的实验／对照。
不得仅因 URL 带有 `view=memories` 就认定页面应用了本基准。

本基准先排除非照片与不合格画质，再由本地 Vision、Ente MobileCLIP-S2、
时间及地点证据构造内容主题／旅程，先去重再成册，每册 12～24 张；
质量、美感、回忆价值和多样性共同参与选片。最多 4 个优先推荐，页面仍展示其余
未隐藏的合格相册。当前预定义内容主题为艺术、宠物、餐桌、自然、舞台。
本版不是任意主题发现系统，也不是按已识别的每一个人物自动成册的完整产品。

原先确认的 8 个相册是样本结果，不是配额。加入新照片后，成员、封面和相册数量
可以变化；不能通过固定 ID 或强行凑张数来复刻旧结果。

## 每次生成前

```sh
python3 tools/verify_recollection_baseline.py --models
```

校验工具只读取文件：从上述完整 Git 提交读取权威清单，对工作区代码、本地清单、
模型实际字节及运行配置中的模型指纹做检查。代码或模型不一致时返回非零退出码，
不自动修改、回退或下载。无模型的代码检查环境可省略 `--models`，其结果会明确标为
未检查模型。该检查不等于验证所有运行库或证明每个前端／线上入口都调用了本引擎。

确认当前数据集及对应特征、模型、历史排除项均准备好后，使用：

```sh
python3 tools/verify_recollection_baseline.py --models && python3 tools/run_recollection_feed.py
```

后一个命令会生成当前数据集的新结果，验证可重复生成、成员数量及其他缓存不变，
更新该数据集的 `recollections/latest.json`；旧快照继续保留。仅检查代码版本时，
不要执行生成命令。更换图库应创建独立数据集，不复制旧图库的结果或偏好。

仓库约定要求使用上述校验后生成的流程；历史实验入口仍可独立运行，未被删掉或
强制替换。此次固定基准不代表已经改造 App 或部署线上服务。

## 回归与后续修改

```sh
PYTHONPATH=.:tests python3 -m unittest test_recollection_baseline test_recollection_feed test_memory_experiment test_story_albums test_hybrid_albums test_album_collections test_selection_lab
```

这些测试使用合成数据，覆盖最低张数、去重、排除词、推荐限制、人物／旅程证据及
快照隔离；不是以通过测试代替人工评价真实选片效果。

后续默认沿用本版，不主动更改阈值、主题提示词、模型、权重或聚合策略。
用户明确要求升级时，在新版本和独立结果中记录变化与回归结果，保留该提交及旧快照。
不要重写此版本清单来掩盖差异，也不要为了使用此版本整仓回退 App、后端或固件修改。
