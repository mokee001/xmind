"""
cutout_apple.py — Apple Vision Framework 抠图 (通过内嵌 Swift 代码)

原理: 用 subprocess 调用 macOS 系统级 Vision Framework 做主体抠图.
比 PyObjC 桥接更稳定, 无 Python 环境依赖问题.

依赖:
- macOS 14 Sonoma 或更新版本 (VNGenerateForegroundInstanceMaskRequest API 引入)
- Xcode Command Line Tools (自带 swift 命令)
    如果没装: 终端跑 xcode-select --install (会弹窗确认, 免费)

用法:
    from cutout_apple import cutout
    from PIL import Image
    img = Image.open("cat.jpg")
    result = cutout(img)  # 返回带 alpha 通道的 PIL RGBA Image
"""

import platform
import subprocess
import tempfile
from pathlib import Path
from PIL import Image
import pillow_heif
pillow_heif.register_heif_opener()  # 让 PIL 能读 HEIC 格式

# 内嵌 Swift 代码 (调用 Vision Framework)
SWIFT_CODE = r"""
import Foundation
import Vision
import CoreImage
import AppKit

let args = CommandLine.arguments
guard args.count == 3 else {
    FileHandle.standardError.write("Usage: swift cutout.swift <input> <output>\n".data(using: .utf8)!)
    exit(1)
}

let inputURL = URL(fileURLWithPath: args[1])
let outputURL = URL(fileURLWithPath: args[2])

guard let ciImage = CIImage(contentsOf: inputURL) else {
    FileHandle.standardError.write("Cannot load input image\n".data(using: .utf8)!)
    exit(1)
}

let handler = VNImageRequestHandler(ciImage: ciImage)

// 前景实例抠图 (bbox 裁剪已移除, 选片阶段已过滤 has_nearby_objects/bg_complexity 保证输入干净)
let request = VNGenerateForegroundInstanceMaskRequest()
do {
    try handler.perform([request])
} catch {
    FileHandle.standardError.write("Vision request failed: \(error)\n".data(using: .utf8)!)
    exit(1)
}

guard let observation = request.results?.first else {
    FileHandle.standardError.write("No foreground instances found\n".data(using: .utf8)!)
    exit(1)
}

// 只保留最大的一个前景实例 (排除画面中较小的杂物 / 玩具等)
func countNonZeroPixels(_ pixelBuffer: CVPixelBuffer) -> Int {
    CVPixelBufferLockBaseAddress(pixelBuffer, .readOnly)
    defer { CVPixelBufferUnlockBaseAddress(pixelBuffer, .readOnly) }
    let width = CVPixelBufferGetWidth(pixelBuffer)
    let height = CVPixelBufferGetHeight(pixelBuffer)
    let bytesPerRow = CVPixelBufferGetBytesPerRow(pixelBuffer)
    guard let base = CVPixelBufferGetBaseAddress(pixelBuffer) else { return 0 }
    var count = 0
    for y in 0..<height {
        let row = base.advanced(by: y * bytesPerRow).assumingMemoryBound(to: UInt8.self)
        for x in 0..<width {
            if row[x] > 128 { count += 1 }
        }
    }
    return count
}

let instancesArray = Array(observation.allInstances)
var largestInstance: Int = instancesArray[0]
var largestArea: Int = 0

if instancesArray.count > 1 {
    // 多个前景实例, 遍历找最大的 (通常是主体宠物)
    for i in instancesArray {
        do {
            let singleMask = try observation.generateScaledMaskForImage(
                forInstances: IndexSet(integer: i),
                from: handler
            )
            let area = countNonZeroPixels(singleMask)
            if area > largestArea {
                largestArea = area
                largestInstance = i
            }
        } catch {
            continue
        }
    }
    FileHandle.standardError.write(
        "Found \(instancesArray.count) instances, keeping largest (index \(largestInstance))\n"
            .data(using: .utf8)!
    )
}

do {
    let maskedBuffer = try observation.generateMaskedImage(
        ofInstances: IndexSet(integer: largestInstance),
        from: handler,
        croppedToInstancesExtent: false
    )
    let outputCI = CIImage(cvPixelBuffer: maskedBuffer)
    let context = CIContext()
    guard let cgImage = context.createCGImage(outputCI, from: outputCI.extent) else {
        FileHandle.standardError.write("Cannot create CGImage\n".data(using: .utf8)!)
        exit(1)
    }
    let bitmap = NSBitmapImageRep(cgImage: cgImage)
    guard let pngData = bitmap.representation(using: .png, properties: [:]) else {
        FileHandle.standardError.write("Cannot create PNG data\n".data(using: .utf8)!)
        exit(1)
    }
    try pngData.write(to: outputURL)
    print("OK")
} catch {
    FileHandle.standardError.write("Failed to generate mask: \(error)\n".data(using: .utf8)!)
    exit(1)
}
"""


_SWIFT_FILE_CACHE = None


def _check_environment():
    """检查 macOS 版本 + swift 命令是否可用"""
    if platform.system() != "Darwin":
        raise RuntimeError("cutout_apple 只能在 macOS 上运行")
    ver_str = platform.mac_ver()[0]
    ver = tuple(int(x) for x in ver_str.split(".")[:2])
    if ver < (14, 0):
        raise RuntimeError(
            f"需要 macOS 14 Sonoma+ (当前 {ver_str}). "
            "Apple Vision 抠图 API 需要 Sonoma 或更新的系统."
        )
    try:
        result = subprocess.run(
            ["swift", "--version"], capture_output=True, timeout=5
        )
        if result.returncode != 0:
            raise RuntimeError("swift 命令存在但返回错误")
    except FileNotFoundError:
        raise RuntimeError(
            "找不到 swift 命令. 请装 Xcode Command Line Tools:\n"
            "  终端跑: xcode-select --install"
        )


def _get_swift_file():
    """把内嵌的 Swift 代码写到临时文件, 缓存路径供多次调用复用"""
    global _SWIFT_FILE_CACHE
    if _SWIFT_FILE_CACHE and Path(_SWIFT_FILE_CACHE).exists():
        return _SWIFT_FILE_CACHE
    f = tempfile.NamedTemporaryFile(
        suffix=".swift", mode="w", delete=False, encoding="utf-8"
    )
    f.write(SWIFT_CODE)
    f.close()
    _SWIFT_FILE_CACHE = f.name
    return _SWIFT_FILE_CACHE


_ENV_CHECKED = False


def cutout(pil_img):
    """输入 PIL Image, 输出 PIL RGBA (主体抠图后, 背景透明)

    第一次调用会检查环境, 之后每次调用启动一个 Swift 子进程 (约 0.5-1 秒开销).
    """
    global _ENV_CHECKED
    if not _ENV_CHECKED:
        _check_environment()
        _ENV_CHECKED = True

    swift_file = _get_swift_file()

    # 写输入 PNG 到临时文件 (Vision 输入接 URL 稳)
    with tempfile.NamedTemporaryFile(suffix=".png", delete=False) as f_in:
        input_path = f_in.name
    with tempfile.NamedTemporaryFile(suffix=".png", delete=False) as f_out:
        output_path = f_out.name

    try:
        if pil_img.mode != "RGB":
            pil_img_rgb = pil_img.convert("RGB")
        else:
            pil_img_rgb = pil_img
        pil_img_rgb.save(input_path, format="PNG")

        result = subprocess.run(
            ["swift", swift_file, input_path, output_path],
            capture_output=True, text=True, timeout=120,
        )
        # 打印 Swift 的诊断信息 (无论成功失败, 都能看到 bbox 等中间状态)
        if result.stderr.strip():
            print("--- Swift 诊断 ---")
            print(result.stderr.strip())
            print("-----------------")
        if result.returncode != 0:
            raise RuntimeError(f"Swift 抠图失败 (returncode={result.returncode})")

        img = Image.open(output_path).convert("RGBA")
        img.load()  # 强制加载, 之后能安全删除 output_path
        return img
    finally:
        Path(input_path).unlink(missing_ok=True)
        Path(output_path).unlink(missing_ok=True)


def detect_edge_truncation(rgba, alpha_threshold=30, min_touch_pixels=20):
    """检测抠图后的主体是否被原图边缘截断.

    原理: 抠图后, 主体像素 alpha 高, 背景像素 alpha = 0.
    如果某条边缘上有主体像素, 说明主体在这条边被画面裁掉了.

    ⚠️ 阈值调校说明 (v2.5.2):
    Apple Vision 抠图的 alpha 通道在边缘处是**羽化过渡**, 不是硬 255/0 二值.
    实测触到画面边缘的主体, 最外一行/列的 alpha 峰值只在 90-115 之间.
    因此:
    - render 端消毛边用 128 阈值 (针对半透明"雾")
    - 但截断检测必须用低得多的阈值 (30) 才能捕获羽化过渡
    - min_touch_pixels 相应上调到 20, 避免噪点误判

    Args:
        rgba: PIL RGBA Image, 来自 apple_cutout() 的输出
        alpha_threshold: 判定主体像素的 alpha 下限 (默认 30, 捕获羽化)
        min_touch_pixels: 单条边至少多少像素接触才判定为"截断"

    Returns:
        dict: {"top", "bottom", "left", "right"} 每个 bool, True 表示该边被截断
    """
    from PIL import Image
    alpha = rgba.split()[-1]
    w, h = alpha.size
    top_row = [alpha.getpixel((x, 0)) for x in range(w)]
    bottom_row = [alpha.getpixel((x, h - 1)) for x in range(w)]
    left_col = [alpha.getpixel((0, y)) for y in range(h)]
    right_col = [alpha.getpixel((w - 1, y)) for y in range(h)]

    def count_over(pixels):
        return sum(1 for v in pixels if v > alpha_threshold)

    return {
        "top": count_over(top_row) >= min_touch_pixels,
        "bottom": count_over(bottom_row) >= min_touch_pixels,
        "left": count_over(left_col) >= min_touch_pixels,
        "right": count_over(right_col) >= min_touch_pixels,
    }


if __name__ == "__main__":
    # 自测: 用一张测试图片验证抠图能跑通
    import sys
    if len(sys.argv) < 2:
        print("用法: python cutout_apple.py <input.jpg>")
        sys.exit(1)
    src = sys.argv[1]
    print(f"读取: {src}")
    img = Image.open(src)
    print(f"原图尺寸: {img.size}, 模式: {img.mode}")
    print("开始抠图 (调用 Apple Vision)...")
    import time
    t = time.time()
    result = cutout(img)
    print(f"完成! 耗时 {time.time() - t:.1f} 秒")
    print(f"输出: {result.size}, 模式: {result.mode}")
    result.save("test_cutout.png")
    print("已保存: test_cutout.png")
