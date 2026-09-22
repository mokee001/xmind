# 插画与文字专项校准集

本目录用于校准以下四种模式：

- `blank`
- `illustration_only`
- `text_only`
- `illustration_with_text`

## 文件

- `calibration_cases_v1.jsonl`：第一轮正例、反例与边界案例。
- `annotation_template.csv`：新增真实案例时使用的人工标注模板。
- `references/`：用户提供的 Figma 交付规则截图。

## 使用原则

1. 先判断是否存在合格真实照片。
2. 没有照片时才进入四类无图片模式判断。
3. 文字必须记录来源和原始片段。
4. 有意义文字只能进入 `text_only` 或 `illustration_with_text`。
5. `illustration_only` 只用于至少两个连续空白日期中的装饰填充。
6. 网页截图原图不进入日期格，但与用户明确相关的重要内容可以提炼为文字。
7. 插画不能增加没有证据的事件或情绪。
8. 无证据时默认留白。
9. 插画使用局部特写或单一视觉焦点；人物禁止全身构图，物品不绘制完整环境场景。

本目录是提示词校准和后续模型训练的共同数据入口。
