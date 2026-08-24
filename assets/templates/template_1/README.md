# Template 1: Plog Collage Calendar

This folder contains a reusable calendar generation template exported from Figma.

Latest synced Figma node: `J7QDx4EVReW4zfGsPvpoZv` / `131:748`.

## Files

- `模版1.zip`: Original template archive. It contains `scene.json` and `images.json`.
- `template.manifest.json`: Machine-readable rules for model selection, photo cropping, text generation, and rendering.
- `README.md`: Human-readable summary of the template rules.
- `(默陌专辑手写体-平面设计使用（含商用）)默陌专辑手写体4.0 (2).ttf`: Bundled handwriting font used by the `nickname` layer.

## Core Rules

- Canvas size: `2000 x 2668`.
- Fixed background layer: `bg`.
- Photo slots: `image_1` through `image_8`.
- Each photo slot has exactly one `IMAGE` fill.
- All photo slots use Figma `FILL` mode.
- Before placement, each selected album photo must be content-aware cropped to `1:1`.
- `text_1`, `text_2`, and `text_3` are three generated sentence lines based on the selected photos.
- `text_4` is a generated theme word or mood tag, such as `Traveling`.
- `nickname` comes from `app.user.nickname`.
- `nickname` must render with the bundled handwriting font asset: `(默陌专辑手写体-平面设计使用（含商用）)默陌专辑手写体4.0 (2).ttf`.
- `’Plog` is a fixed suffix and must remain unchanged.

## Runtime Flow

1. Read `template.manifest.json`.
2. Load `scene.json` and `images.json` from `模版1.zip`.
3. Select 8 high-quality photos from the user's album.
4. Crop each selected photo to square `1:1` using content-aware focus.
5. Assign cropped photos to `image_1` through `image_8`.
6. Generate `text_1` through `text_3` from the selected photos.
7. Generate `text_4` as the overall theme or mood tag.
8. Resolve `nickname` from `app.user.nickname`.
9. Load the bundled nickname handwriting font before rendering the `nickname` text layer.
10. Preserve `bg`, `’Plog`, geometry, effects, and text styles.
11. Export the final image at `2000 x 2668`.
