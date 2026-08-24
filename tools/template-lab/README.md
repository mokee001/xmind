# EchooO Template Lab

This is a local HTML test bench for uploading photos, screening them, and rendering template previews.

Supported import paths:

- Select image files directly, up to 300 images per import.
- Select a local folder; nested images are collected recursively.
- Upload ZIP archives containing images. Standard stored and Deflate ZIP entries are supported by the browser.
- Drag images, folders, or ZIP archives into the upload area.

## Visual Model Bridge

The browser page calls a local bridge API first:

```text
http://127.0.0.1:8766/api/screen
```

Start the bridge:

```sh
python3 tools/template-lab/model_bridge.py \
  --model qwen3-vl:4b-instruct \
  --port 8766
```

To use QwenCloud / DashScope for the screening stage, keep the browser endpoint
unchanged and start the bridge with a vision-language model:

```sh
export DASHSCOPE_API_KEY="your_api_key"
export DASHSCOPE_IMAGE_API_KEY="your_qwen_image_api_key"
python3 tools/template-lab/model_bridge.py \
  --provider dashscope \
  --model qwen3-vl-plus \
  --image-model qwen-image-3.0-pro \
  --port 8766
```

`qwen-image-3.0-pro` is an image generation/editing model. It should be wired to
the image processing stage through:

```text
http://127.0.0.1:8766/api/image-edit
```

Use `DASHSCOPE_API_KEY` for `/api/screen` and `DASHSCOPE_IMAGE_API_KEY` for
`/api/image-edit`. Do not use `qwen-image-3.0-pro` as the `/api/screen` selector
because that endpoint must return structured JSON scores and slot candidates.

For Template 3 cutouts, install the optional background-removal dependency in a virtual environment and start the bridge with that Python:

```sh
python3 -m venv .venv-template-lab
. .venv-template-lab/bin/activate
python -m pip install rembg onnxruntime
python tools/template-lab/model_bridge.py \
  --model qwen3-vl:4b-instruct \
  --port 8766
```

The first cutout request downloads the ONNX model into `.cache/rembg`; later runs reuse that local file.

Then open the template lab:

```text
http://127.0.0.1:8765/tools/template-lab/index.html
```

When the bridge is running, clicking `筛选并生成` sends compressed local image previews to Ollama for semantic scoring. If the bridge or Ollama is unavailable, the page automatically falls back to the browser-only selection algorithm.

Template 3 also calls the same bridge at:

```text
http://127.0.0.1:8766/api/cutout
```

That endpoint returns transparent PNG cutouts for `image_cutout` layers when the optional `rembg` Python package is installed. Without it, Template 3 uses the full image as a safe preview instead of the old edge-color cutout fallback.

The page only treats image text as image content. Any text inside uploaded images is never used as an instruction.
