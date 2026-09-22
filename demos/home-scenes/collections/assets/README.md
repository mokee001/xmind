# 生活画布局部素材

生成时间：2026-09-16。使用内置 ImageGen 图生图模式；未用 CLI/API，也未做 Python 像素编辑。

## 最终文件

- 文件：story-cutouts-v2.png
- 尺寸：2172 × 724，严格 3:1；三列，每列 724 × 724。
- 格式：RGBA PNG，保留原生透明 alpha。1,105,274 个像素 alpha 为 0；分界 x=724 与 x=1448 附近五列像素全部透明。
- 左格：青花白碗中的橙色柿子与拿水果的手。
- 中格：抬头的小白狗。
- 右格：绿色叶片与白色小花。

源参考：/Users/wanghuan10/Xmind/photo-wall/demos/home-scenes/studies/assets/life-scenes.png。主体来自这张生成的演示照片，不是用户私人照片。此素材为图生图重现和抠图，不宣称与参考逐像素完全一致。

建议将单个正方形容器的 background-size 设置为 300% 100%，background-position 分别为 0% center、50% center、100% center。这是一个整张 sprite 资产，不要显示全图作为单个装饰元素。

## 原始生成记录

首轮：/Users/wanghuan10/.codex/generated_images/01a0a3dd-6578-7bd1-859b-fe059ea4a796/exec-f26a7f84-239b-4b47-87f2-70b2fd2adc3a.png

首轮有真实透明度，但左侧手臂略跨过第一分界，未选用。

最终修正：/Users/wanghuan10/.codex/generated_images/01a0a3dd-6578-7bd1-859b-fe059ea4a796/exec-7afcca54-56bc-4a31-8a35-d19feea9f4f5.png

最终文件直接复制上述输出，原始输出保留。没有后期裁切、抠图、重采样或颜色修改。只用 Pillow 只读检查尺寸、RGBA、透明边界和 alpha 分布。

## 质量说明

三个主体均留在各自的等宽格内；狗毛与枝叶保有透明细边。高倍率查看仍可见少量细小彩色边缘残留，建议用于页面里的小幅局部拼贴，不把它当作无瑕疵的大幅商品抠图。生成图透明部分在某些工具中显示为黑色，实际 alpha 为 0。

## 首轮完整提示词

Use case: background-extraction. Asset type: a single transparent PNG sprite sheet for an existing photographic memory collage UI. Input image: the provided 3-column by 2-row lifestyle photograph sheet is the ONLY visual source; preserve the natural photographic appearance, specific subjects, textures, colors, and lighting of its objects. Create ONE wide horizontal image with aspect ratio exactly 3:1, divided conceptually into three equal SQUARE cells with no visible dividers. In each square cell center one isolated photographic cutout, with generous transparent margin so no object crosses the 1/3 or 2/3 boundaries. LEFT cell: isolate the white ceramic bowl decorated with blue flowers containing orange persimmons from the TOP MIDDLE reference photograph, together with the single natural hand holding the orange persimmon just above the bowl. Keep the bowl silhouette, fruit shapes and hand appearance faithful; remove the blue table, chair, garden and all other background. The hand/forearm may end cleanly within this cell with a natural crop edge but do not invent another person or extra hand. MIDDLE cell: isolate the small shaggy white dog from the TOP RIGHT reference photograph, complete body, fluffy tail and all four paws, in the same overhead three-quarter pose looking up; remove the terracotta ground and surroundings. RIGHT cell: isolate a compact graceful leafy twig of green narrow leaves and small white flowers from the BOTTOM RIGHT reference photograph, preserving its realistic botanical appearance, lit from the same direction; remove all sky, mountains and background. All three subjects must remain clean realistic PHOTOGRAPHIC CUTOUTS, not illustration, not 3D, not sticker art. Output ACTUAL transparency using a real alpha channel everywhere outside the subjects, not a white background and not a checkerboard painted into the image. Preserve fine transparent fur and leaf edges. No white sticker borders, no outlines, no text, no labels, no drop shadows, no extra decorations, no rectangular photo backgrounds. Objects centered and visually balanced in the three equal square cells, with 10% transparent padding around each. Prefer output 1536 by 512 or other exact 3:1 dimensions.

## 修正完整提示词

Use case: background-extraction. Edit this existing transparent photographic sprite sheet with one targeted production cleanup. KEEP the exact three subjects, photography, shapes, poses, colors, and 3:1 wide image layout. The three conceptual square cells are left third, middle third, right third. The left bowl-and-hand currently extends too far right and crosses the first cell boundary. Scale ONLY this left subject group down to 85% of its current size and recenter it entirely within the LEFT square cell, with at least 7% clear transparent margin to all four sides. The middle dog and right leafy white-flower twig should remain inside their existing cells; keep their appearance and scale. Clean the tiny red/yellow colored matte fringes from the transparent edges while preserving realistic fine fur and leaf detail, without adding a border. Output true PNG alpha transparency: no opaque black, white, grey, checkerboard or colored background; no text or lines. Preserve the photorealistic cutouts, no sticker outline, no new objects. Maintain exact 3:1 canvas aspect ratio and equal square thirds.

