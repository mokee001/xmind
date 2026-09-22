# 共享相簿加入候选集 · 2026-09-08

## 当前结果

源目录为用户指定的 `/Users/wanghuan10/Desktop/共享相簿测试/`，只读处理，不复制或改写原图，也不上传照片。

- 发现 325 张 JPG/JPEG，均可读取；通过完整文件 SHA256 排除 10 个重复副本，新增 315 张。
- 加上旧七月候选 132 张，合计 447 张，数据集签名 `78b8a4d90d809fbbee2bbb2a891e663d8f47eea85a289303ec76d21963d34bf1`。
- 当前方案通过过滤 389 张，生成 10 个相册，覆盖 92 张不同照片；其中 53 张来自新相簿。基础非照片/历史复核排除 36 张、质量排除 20 张、额外 Vision 非照片排除 2 张。模型规则不保证零误判。
- Ente 447 张全部完成图片及人脸识别：428 次人脸检测，367 个未确认身份的人脸组，最大组 6 张脸，160 张有城市索引。不能把人脸次数或分组数当作真实人数。
- Ente 原版回忆计算使用有日期的 348 张，产出“翻过山丘”8 张、“Last month”10 张，共 18 张不同照片，其中 17 张来自新相簿。调试模式 3 组，额外的 `Base (current)` 不是自然首页相册。
- 现有 Ente 识别展示另有 20 个非空语义主题，以及人物总览；这是不限最低张数的识别结果，不能与 2 个原版自然回忆混称。

相册仍沿用当前策略，未在本次偷偷改造日期组的内容连贯性，也没有为凑数量放宽 Ente 原版阈值。原版语义主题先要求至少 10 个匹配候选，之后的时间/近重复过滤可能使最终相册少于 10 张。其随机轮换意味着后续重跑的成员和主题可能不同，以保存快照为准。

## 日期与模型边界

旧七月样本继续使用文件名的日精度日期。新加入的 315 张中，111 张 EXIF 拍摄日期含时区，105 张 EXIF 有拍摄日期但无时区（明确按东八区解释），99 张日期未知。脚本也支持 `fxn YYYY-MM-DD HHMMSS.xxx` 的明确文件名时间；不把文件修改时间或本次导入时间当成拍摄日期。

未知日期仍可参与当前方案的主题选片，也保留 Ente 内容、人脸识别。因为固定版本 Ente 原版回忆时间索引要求非空日期，所以将这 99 张从回忆计算输入排除，不给它们编造时间；诊断明确展示识别输入和回忆输入两种数量。

新照片基础语义使用本地 `yolov8s.pt`，画质与美观为项目现有 Pillow 像素启发式测量。强制真实 YOLO 调用，失败不回退文件名 mock。内容主题使用同版本 macOS Vision 提取器；旧 132 张 Vision 与 Ente 识别缓存按版本、摘要复用。

注意：当前方案新 315 张尚无旧 `ViT-B-32__openai` 模型向量，因此涉及混合候选的多样性选择使用现有标签回退；保留 dHash/内容签名去重及旧照片有效向量。没有把 Ente 的 MobileCLIP-S2 向量冒充旧模型、混进同一个向量空间。这轮结果不适合作为“完全同模型只改样本量”的受控效果对比。补齐同模型向量后可另存新实验。

## 文件与回退

新数据独立存放在 `outputs/selection-lab/datasets/july-shared-20260908/`：

- `cache/current-cache.json`、`cache/immich-cache.json`、`cache/dataset.json`：候选特征、旧同模型向量、样本说明。
- `state/album-features.json`：447 张真实 Vision 内容特征。
- `state/ente/`：本批 Ente 索引、输入、自然/调试结果及日志；共享已安装工具链与模型，不重新下载。
- `state/runs/`：独立结果快照；当前方案最终通过接口保存 ID `9f936c867bf342e9acc61dcc53b63751`（“共享相簿加入后 · 默认精选”），初次保存 ID `634325ce671346178e7e5e23e3bc405a` 也保留。Ente 经实验台运行入口复跑完成的自然结果快照 ID `739ad1c749e24613b865ff2b8df9e969`。
- `import-report.json`：重复副本与保留文件的对应关系，只存本地，未删除这些副本原图。

原 `outputs/immich-comparison/`、`outputs/selection-lab/runs/` 与原 Ente 索引仍保留。默认启动器读取 `outputs/selection-lab/active-dataset.json`；明确指定旧目录可忽略活动数据集并回看旧候选，例如：

```sh
python3 tools/selection_lab.py --port 8767 --cache-dir outputs/immich-comparison --state-dir outputs/selection-lab
```

这不会自动启动第二个服务，需用户或开发者实际执行。现有端口若运行其他数据集，启动器不会强行停止它；需要明确停止原进程后再切换。

重新生成合并集：

```sh
python3 tools/add_lab_photos.py '/Users/wanghuan10/Desktop/共享相簿测试' --output outputs/selection-lab/datasets/july-shared-20260908
python3 tools/build_album_features.py
python3 tools/run_ente_lab.py
```

默认后两条使用活动数据集。脚本对已经完成且文件时间/大小/版本一致的记录复用缓存；文件变更需重新导入。未来追加其他文件夹应选择新结果目录，并通过 `--base-cache` 明确以前一合并集为基础，不覆盖其他实验的数据。

Ente 缓存迁移会重新映射数据集内部照片 ID 与人脸 ID 前缀，不更改检测框或向量；有自动测试覆盖，避免加入新照片导致旧人脸错配。接口和本地运行均保持两种引擎隔离，没有修改手机 App 或线上生产策略。
