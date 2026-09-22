# 相册结果可视化对比

入口：`http://127.0.0.1:8766/#compare`，也可以在首页点击“两套相册对比”。仅本机运行，不发布、不上传照片，不修改原图、缓存或生产策略。

## 怎么看

1. **相册总览**：左侧是项目已有识别与成册规则的结果；右侧是固定版本 Ente 源码实跑的自然回忆。两列使用相同尺寸，不按相册数补齐；保留各自封面、相册顺序、成员和组内顺序。封面下面的四张缩略图只是组内前四张预览，不是额外选片。
2. 点击封面进入**逐张对照**。另一侧有共同成员时，按照片成员 Jaccard 最高建议一组；零共同成员则留空。这个建议不表示语义相同，不是人物身份或活动匹配。左右下拉菜单可以独立换组。
3. “全部照片”保留各自组内顺序；“仅看本对相册的差异”“仅看本对共同照片”只过滤当前展示，不修改相册。单张图片采用原比例显示，点击从该张打开已有大图/播放相册。
4. 整套结果的共同/独有统计与当前两组的统计分开标注。整套统计按照片 ID 去重后的成员并集计算，不能把跨主题重复出现的照片重复计数，也不是原全局 Top 20 页面的入选数。

## 2026-09-08 的真实数据

候选为七月照片与共享相簿合并后的 447 张，数据集签名：

`78b8a4d90d809fbbee2bbb2a891e663d8f47eea85a289303ec76d21963d34bf1`

| 当前默认规则输出 | 相册数 | 不同照片 |
| --- | ---: | ---: |
| 项目当前方案 | 10 | 92 |
| Ente 自然回忆 | 2 | 18 |

共同 12 张，仅当前方案 80 张，仅 Ente 6 张。联合覆盖 98 张。

- 左侧本轮相册结果 ID：`9466ef2ab0a6768b0e1f7457`。
- 右侧已保存自然回忆快照：`739ad1c749e24613b865ff2b8df9e969`。
- 对比开发没有重跑识别、调整阈值、改造日期聚合或制造成员差异；使用已完成的识别与结果。左侧可按当前实验参数重新生成，右侧仍是成功实跑快照，页面折叠说明中记录双方版本。

## 必须保留的边界

- 这是独立引擎的输出比较，不是把 Ente 特征接入同一选片器、只替换一个变量的受控实验，也不是完整 Ente 手机 App 或线上生产效果。
- 自然回忆不混入 `ente_recognition` 主题识别、人物总览或 `debug_all_candidates`。真实自然结果为 0 时显示 0；尚无结果时明确缺失，不回退到另一套引擎。
- 两边必须来自相同数据集；检查当前方案 provenance、Ente 快照 dataset_id 与 result.signature.dataset。数据不符或封面/成员损坏时报错，不绘制误导性对比。
- 输入照片相同，但资格规则不同：当前方案有照片-only、画质与内容过滤；Ente 原版未套用同一过滤链。Ente 识别 447 张，日期已知的 348 张进入回忆计算，99 张未知日期只参与识别。未入选不能直接解释成识别失败。
- 当前方案只保有旧 132 张的同模型 CLIP 向量，缺向量的混合池使用标签多样性回退；Ente 使用独立 MobileCLIP-S2 空间。新照片补齐原模型向量前，不据此得出纯模型优劣结论。
- 当前方案日期组仍可能混杂主体，Ente 的成册数也受样本、日期、原版门槛和随机轮换影响。多、少、重合率均不是质量评分，需实际看图评估。

## 实现与验证

- `selection_lab/static/album-comparison.js`：纯展示模型、并集差异、建议配对与两列视图，不调用选片模型。
- `selection_lab/static/app.js`：`#compare` 路由、实验台集成、复用已有大图播放，模型来源随相册正确标注。
- `selection_lab/static/engines.css`：响应式双列；窄屏上下排列。
- `selection_lab/server.py`：只增加静态脚本白名单，不增加上传或外网访问。
- `tests/test_album_comparison.cjs`：无浏览器单元测试；设置 `LAB_COMPARISON_LIVE=1` 后增加 8766 本机接口集成测试，不重跑 Ente 或任何识别模型。

验证命令：

```sh
node --check selection_lab/static/app.js
node --check selection_lab/static/album-comparison.js
LAB_COMPARISON_LIVE=1 node --test tests/test_album_comparison.cjs
python3 -m unittest discover -s tests -p 'test_selection_lab.py'
python3 -m unittest discover -s tests -p 'test_ente_entry.py'
python3 -m unittest discover -s tests -p 'test_album_collections.py'
```

12 项比较测试（含真实本地数据）和 55 项原实验台/Ente 入口/成册回归已通过。另校验静态资源、双方封面接口为 200。未做浏览器截图、DOM 检查或点击验收；浏览器实际视觉表现尚未通过这类验收。
