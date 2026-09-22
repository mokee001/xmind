# 模板3 本地抠图模型

模板3的 `image_cutout` 图层需要本地背景移除模型生成透明 PNG。

## 模板包结构

- `summary.yaml`: 用于模板路由，声明模板适合的图片类型和必需能力。
- `template.json`: 用于渲染，包含 2000 x 2668 画布、图层坐标、层级关系和固定 mock 元素。
- `processing.json`: 用于图像处理，明确 12 个 `image_cutout` 图层必须执行主体分割/抠图。
- `review.json`: 用于最终验收，重点检查抠图透明度、图层顺序、mock 固定层和输出尺寸。
- `preview.png`: 模板视觉参考；规则冲突时以 JSON/YAML 为准。

## 模型

- Runtime: `rembg`
- Model: `isnet-general-use`
- Provider: `CPUExecutionProvider`
- Model file: `models/isnet-general-use.onnx`
- Bridge endpoint: `http://127.0.0.1:8766/api/cutout`

## 启动

```sh
.venv-template-lab/bin/python tools/template-lab/model_bridge.py \
  --model qwen3-vl:4b-instruct \
  --port 8766
```

模板测试台里筛选接口保持：

```text
http://127.0.0.1:8766/api/screen
```

前端会自动把 `/api/screen` 推导成 `/api/cutout` 用于抠图。
