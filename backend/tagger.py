"""
AI 打标引擎：识别照片中的人物 / 宠物 / 场景元素 / 画质等维度。

架构说明（重要）：
- 打标结果是一组「维度标签」，每张照片 -> tags: list[str]。
- 这些 tag 就是后续「打标评分 / 模型训练」的特征维度。
- 本文件包含两部分：
    1) 真实图像信号（画质/亮度/色调）——用 Pillow 计算，是真的。
    2) 语义标签（person/dog/food...）——MVP 用确定性占位实现，
       生产环境把 detect_semantic() 换成真实模型即可（YOLOv8 / CLIP 零样本 / 云端视觉 API），
       接口不变，闭环不用改。
"""

from __future__ import annotations

import colorsys
import hashlib
import os

from PIL import Image, ImageFilter, ImageStat

# 让 Pillow 支持 iPhone 的 HEIC/HEIF 照片（装了 pillow-heif 才生效）
try:
    import pillow_heif

    pillow_heif.register_heif_opener()
except Exception:
    pass

# 维度词表：打标 / 训练都围绕这些维度展开
PEOPLE_TAGS = ["person", "group", "portrait", "selfie"]
PET_TAGS = ["dog", "cat", "pet"]
SCENE_TAGS = ["food", "landscape", "city", "indoor", "nature", "beach", "flower", "night"]

# 颜色主色调词表（由真实像素统计得到）
COLOR_TAGS = ["red", "orange", "yellow", "green", "cyan", "blue", "purple", "pink", "neutral"]

# 情绪/氛围词表（由真实亮度·饱和度·对比度信号推导，不需要额外模型）：
#   mood_fresh   清新治愈——明亮通透、色彩不重
#   mood_vivid   活力满满——高饱和 + 强对比
#   mood_vintage 文艺复古——低饱和/接近黑白、柔和
#   mood_calm    静谧氛围——偏暗/冷调、柔和
MOOD_TAGS = ["mood_fresh", "mood_vivid", "mood_vintage", "mood_calm"]


def _mood_tag(tset: set, m: dict) -> str | None:
    """从真实图像信号推导一个主导「情绪/氛围」标签（保守，取一个最贴切的）。"""
    brightness = m.get("brightness", 128)
    sat = m.get("saturation", 0.3)
    contrast = m.get("contrast", 50)
    # 活力：高饱和且高对比，画面最抓眼
    if sat > 0.45 and contrast > 60:
        return "mood_vivid"
    # 文艺复古：低饱和/接近黑白，柔和
    if sat < 0.18:
        return "mood_vintage"
    # 清新治愈：明亮通透、饱和适中
    if brightness > 165 and sat < 0.45:
        return "mood_fresh"
    # 静谧氛围：偏暗或冷调且柔和
    if brightness < 95 or (("cool" in tset) and contrast < 45):
        return "mood_calm"
    return None

# 检测器选择：环境变量 PHOTOWALL_TAGGER = "yolo" | "mock" | "auto"（默认 auto）
# auto: 装了 ultralytics 就用真实 YOLO，否则回退 mock。
_TAGGER_MODE = os.environ.get("PHOTOWALL_TAGGER", "auto").lower()


def _file_seed(path: str) -> int:
    h = hashlib.md5(os.path.basename(path).encode("utf-8")).hexdigest()
    return int(h[:8], 16)


def _hue_name(h: float, s: float) -> str:
    """HSV 主色 -> 颜色名。h,s ∈ [0,1]。饱和度过低视为中性色。"""
    if s < 0.15:
        return "neutral"
    deg = h * 360
    if deg < 15 or deg >= 345:
        return "red"
    if deg < 45:
        return "orange"
    if deg < 70:
        return "yellow"
    if deg < 165:
        return "green"
    if deg < 195:
        return "cyan"
    if deg < 255:
        return "blue"
    if deg < 300:
        return "purple"
    return "pink"


def _dhash(img: Image.Image, hash_size: int = 8) -> int:
    """差值感知哈希（dHash）：缩到 (hash_size+1)x hash_size 灰度图，
    比较相邻像素亮度得到 64bit 指纹。用于去重（见 dedup.py）。"""
    small = img.convert("L").resize((hash_size + 1, hash_size), Image.LANCZOS)
    px = list(small.getdata())
    bits = 0
    row_w = hash_size + 1
    for row in range(hash_size):
        for col in range(hash_size):
            left = px[row * row_w + col]
            right = px[row * row_w + col + 1]
            bits = (bits << 1) | (1 if left > right else 0)
    return bits


def _content_sig(img: Image.Image, grid: int = 6) -> list[int]:
    """
    内容签名：把图缩成 grid×grid 灰度网格（默认 6×6=36 个亮度值，0~255）。
    dHash 只看相邻像素梯度，对「同一场景/同一主体、构图略有差异」的照片不敏感；
    这个绝对亮度网格能补上——同一只宠物/同一桌菜的多张照片网格会很接近，
    从而被去重识别为「同主体重复」。
    """
    small = img.convert("L").resize((grid, grid), Image.LANCZOS)
    return list(small.getdata())


def _colorfulness(img: Image.Image) -> float:
    """
    Hasler-Süsstrunk 色彩丰富度（在缩略图上算，快且稳）。
    返回 0~1 归一化值：越大画面色彩越丰富/鲜活，是「好看」的一个真实信号。
    无 numpy 时退化为基于通道标准差的近似。
    """
    small = img.convert("RGB")
    small.thumbnail((128, 128))
    try:
        import numpy as np

        arr = np.asarray(small, dtype="float32")
        r, g, b = arr[..., 0], arr[..., 1], arr[..., 2]
        rg = r - g
        yb = 0.5 * (r + g) - b
        std = (rg.std() ** 2 + yb.std() ** 2) ** 0.5
        mean = (rg.mean() ** 2 + yb.mean() ** 2) ** 0.5
        raw = std + 0.3 * mean
    except Exception:
        # 退化：用 R/G/B 通道标准差的均值近似
        st = ImageStat.Stat(small)
        raw = sum(st.stddev) / len(st.stddev)
    # 注意：numpy 标量(float32)不能 JSON 序列化，务必转成 Python float
    return round(min(float(raw) / 110.0, 1.0), 3)


def _composition_score(img: Image.Image) -> float:
    """
    构图评分（0~1）：基于「三分法」的廉价近似。
    把边缘能量图切成 3×3 网格，理想构图的主体视觉能量落在三分线附近（中列/中行的
    非正中格），而不是全堆在正中（呆板）或四角（主体被切/杂乱）。
    无 numpy 时安全退化为 0.5（中性，不影响其它信号）。
    """
    try:
        import numpy as np

        edges = img.convert("L").resize((90, 90), Image.LANCZOS).filter(ImageFilter.FIND_EDGES)
        px = np.asarray(edges, dtype="float32")
        total = float(px.sum()) or 1.0
        cell = {}
        for r in range(3):
            for c in range(3):
                cell[(r, c)] = float(px[r * 30:(r + 1) * 30, c * 30:(c + 1) * 30].sum())
        center = cell[(1, 1)] / total
        corners = (cell[(0, 0)] + cell[(0, 2)] + cell[(2, 0)] + cell[(2, 2)]) / total
        # 三分线带：中行两侧 + 中列上下（能量落在这里最接近三分法交点）
        thirds = (cell[(0, 1)] + cell[(2, 1)] + cell[(1, 0)] + cell[(1, 2)]) / total
        score = 0.5 + 0.5 * thirds - 0.3 * corners - 0.25 * abs(center - 0.2)
        return round(min(max(score, 0.0), 1.0), 3)
    except Exception:
        return 0.5


def _divider_bands(img: Image.Image) -> tuple[int, int]:
    """检测「拼图 / 社媒截图」的分隔栏：内部出现近似纯色的横条或竖条，
    且条两侧都是高方差的真实内容（典型的小红书九宫格、多图拼接、带白边翻拍）。
    返回 (普通分隔条数, 纯白分隔条数)。无 numpy 时安全退化为 (0, 0)。"""
    try:
        import numpy as np

        g = img.convert("L")
        g.thumbnail((220, 220), Image.LANCZOS)
        a = np.asarray(g, dtype="float32")

        def scan(mat: "np.ndarray") -> tuple[int, int]:
            n = mat.shape[0]
            line_std = mat.std(axis=1)
            line_mean = mat.mean(axis=1)
            bands, white = 0, 0
            i, start, end = int(n * 0.12), int(n * 0.12), int(n * 0.88)
            while i < end:
                # 找到一条近似纯色的线（横/竖），并向后扩展成一整条分隔带
                if line_std[i] < 6 and (line_mean[i] > 218 or line_mean[i] < 38):
                    j = i
                    while j < end and line_std[j] < 9 and abs(line_mean[j] - line_mean[i]) < 12:
                        j += 1
                    band_w = j - i
                    if 1 <= band_w <= n * 0.18:  # 是「细条」而非大片纯色背景
                        pre = mat[max(0, i - 3):i]
                        post = mat[j:j + 3]
                        # 条两侧都要有真实内容（高方差），才算「分隔两张图」的栏
                        if pre.size and post.size and pre.std() > 18 and post.std() > 18:
                            bands += 1
                            if line_mean[i] > 218:
                                white += 1
                    i = j + 1
                else:
                    i += 1
            return bands, white

        h_bands, h_white = scan(a)      # 横向分隔（逐行扫描）
        v_bands, v_white = scan(a.T)    # 纵向分隔（转置后逐行=逐列扫描）
        return h_bands + v_bands, h_white + v_white
    except Exception:
        return 0, 0


def _has_camera_exif(img: Image.Image) -> bool:
    """判断这张图是否为「相机原生拍摄」：真机拍照都带 EXIF 相机厂商/型号
    （iPhone: Make='Apple', Model='iPhone…'）。手机截图、下载/保存、社媒接收的图片
    普遍没有相机 EXIF —— 这是区分「自己拍的 vs 截图/下载」最可靠的信号。
    读不到 EXIF 时保守返回 False（视为非拍摄）。"""
    try:
        ex = img.getexif()
        if not ex:
            return False
        make = ex.get(271)   # EXIF Make
        model = ex.get(272)  # EXIF Model
        return bool((make and str(make).strip()) or (model and str(model).strip()))
    except Exception:
        return False


def _taken_at(img: Image.Image, path: str) -> float | None:
    """取照片的「拍摄时间」unix 时间戳，用于「历史上的今天/更久以前」惊喜规则。
    优先 EXIF 拍摄时间(DateTimeOriginal)，其次 EXIF DateTime，最后回退文件修改时间。"""
    import datetime as _dt

    def _parse(s) -> float | None:
        try:
            return _dt.datetime.strptime(str(s).strip(), "%Y:%m:%d %H:%M:%S").timestamp()
        except Exception:
            return None

    try:
        ex = img.getexif()
        if ex:
            dt = None
            try:
                sub = ex.get_ifd(0x8769)  # ExifIFD：含 DateTimeOriginal(36867)/DateTimeDigitized(36868)
                dt = sub.get(36867) or sub.get(36868)
            except Exception:
                dt = None
            if not dt:
                dt = ex.get(306)  # 顶层 DateTime
            ts = _parse(dt) if dt else None
            if ts:
                return ts
    except Exception:
        pass
    try:
        return os.path.getmtime(path)
    except Exception:
        return None


def _real_image_signals(img: Image.Image) -> tuple[list[str], dict]:
    """用 Pillow 计算真实图像信号：亮度/色调/饱和度/主色/对比度/清晰度/构图方向。
    返回 (tags, metrics)，metrics 供废片过滤(_detect_junk)复用，避免重复计算。"""
    tags: list[str] = []
    rgb = img.convert("RGB")
    gray = img.convert("L")
    gray_stat = ImageStat.Stat(gray)

    # 明暗曝光
    brightness = gray_stat.mean[0]
    tags.append("bright" if brightness > 130 else "dark")
    if brightness > 180:
        tags.append("high_key")   # 高调/清新
    elif brightness < 55:
        tags.append("low_key")    # 暗调/氛围

    # 冷暖色调
    r, g, b = ImageStat.Stat(rgb).mean
    tags.append("warm" if r >= b else "cool")

    # 饱和度（鲜艳 / 素雅 / 单色）+ 主色调
    h, s, v = colorsys.rgb_to_hsv(r / 255.0, g / 255.0, b / 255.0)
    if s > 0.45:
        tags.append("vibrant")    # 鲜艳
    elif s < 0.15:
        tags.append("muted")      # 素雅
    if s < 0.08:
        tags.append("monochrome")  # 接近黑白/单色
    tags.append(_hue_name(h, s))

    # 对比度（灰度标准差）
    contrast = gray_stat.stddev[0]
    tags.append("high_contrast" if contrast > 60 else "soft")

    # 清晰度：边缘图方差越大越清晰（真实的模糊检测）
    edges = gray.filter(ImageFilter.FIND_EDGES)
    edge_var = ImageStat.Stat(edges).var[0]
    tags.append("sharp" if edge_var > 300 else "blurry")

    # 构图方向
    w, ht = img.size
    if w > ht * 1.15:
        tags.append("landscape_orient")   # 横构图
    elif ht > w * 1.15:
        tags.append("vertical_orient")    # 竖构图
    else:
        tags.append("square_orient")      # 方构图

    metrics = {
        "brightness": brightness,
        "saturation": s,
        "contrast": contrast,
        "edge_var": edge_var,
        "width": w,
        "height": ht,
    }
    # 拼图/社媒截图信号：内部纯色分隔栏（>=2 条，或至少 1 条纯白栏两侧都是内容）
    total_bands, white_bands = _divider_bands(rgb)
    metrics["collage"] = bool(total_bands >= 2 or white_bands >= 1)
    # 相机原生拍摄信号（无相机 EXIF = 截图/下载/非拍摄）
    metrics["camera"] = _has_camera_exif(img)
    return tags, metrics


# 废片原因 -> 中文说明（借鉴苹果 Photos 的 utility content filter：
# 截图/文档/单据/严重模糊/极端曝光 这类图不进精选、不上墙）
JUNK_REASONS = {
    "downloaded": "截图/下载/非拍摄",
    "screenshot": "截图/录屏",
    "document": "文档/单据/翻拍",
    "collage": "拼图/社媒截图",
    "blurry": "严重模糊",
    "exposure": "过曝或过暗",
}


def _detect_junk(path: str, colorfulness: float, m: dict) -> str | None:
    """判定是否为「废片」（不适合上墙的实用类图片），返回原因 key 或 None。
    保守判定，宁可漏杀真实照片，也不误杀。借鉴苹果 utility content filter。"""
    name = os.path.basename(path).lower()
    ext = os.path.splitext(path)[1].lower()
    w, ht = m["width"], m["height"]
    ar = (w / ht) if ht else 1.0

    # 0) 非相机原生拍摄 —— 手机截图 / 下载保存 / 社媒接收（无相机 EXIF Make/Model）。
    #    用户明确要求：上墙只要自己拍的，截图和下载/存到手机里的图片一律不上墙。
    #    真机拍照(含 iPhone HEIC)都带相机 EXIF，此规则不会误伤自己拍的照片。
    if not m.get("camera", True):
        return "downloaded"

    # 1) 文件名/录屏明确命中
    if any(k in name for k in ("screenshot", "screen_shot", "截屏", "截图", "录屏")):
        return "screenshot"

    # 2) 严重模糊（远低于普通 blurry 阈值 300）
    if m["edge_var"] < 110:
        return "blurry"

    # 3) 极端曝光（几乎纯白/纯黑，正常照片不会到这个程度）
    if m["brightness"] > 244 or m["brightness"] < 16:
        return "exposure"

    # 4) 文档/单据/翻拍：接近单色 + 很亮 + 文字类高频边缘
    if colorfulness < 0.055 and m["brightness"] > 178 and m["edge_var"] > 900:
        return "document"

    # 5) 截图：PNG 且是手机屏幕的极端长宽比（正常照片≈4:3/16:9，不会这么细长）
    if ext == ".png" and (ar < 0.5 or ar > 2.0):
        return "screenshot"

    # 6) 拼图/社媒截图（小红书九宫格、多图拼接、带白边翻拍）：内部有纯色分隔栏且两侧都是内容
    if m.get("collage"):
        return "collage"

    return None



def _detect_semantic(path: str) -> list[str]:
    """
    语义识别（人物/宠物/场景）。
    根据 PHOTOWALL_TAGGER 选择真实 YOLO 检测或 mock：
      - yolo/auto(且已安装): 真实目标检测（backend/real_tagger.py）
      - mock/auto(未安装):   文件名 hash 确定性生成，保证可复现、开箱即跑
    两种实现返回同样格式的 tag 列表，上层闭环不用改。
    """
    if _TAGGER_MODE in ("yolo", "auto"):
        try:
            from . import real_tagger
            if real_tagger.available():
                return real_tagger.detect(path)
        except Exception:
            pass  # 检测失败则回退 mock
        if _TAGGER_MODE == "yolo":
            return []  # 明确要求 yolo 但不可用时，不用假数据
    return _detect_semantic_mock(path)


def _detect_semantic_mock(path: str) -> list[str]:
    """MVP 占位：用文件名 hash 确定性生成，保证同一张图标签稳定、可复现。"""
    seed = _file_seed(path)
    tags: list[str] = []

    if seed % 10 < 6:  # 60% 有人物
        tags.append(PEOPLE_TAGS[seed % len(PEOPLE_TAGS)])
    if seed % 10 >= 8:  # 20% 有宠物
        tags.append(PET_TAGS[(seed >> 3) % len(PET_TAGS)])
        tags.append("pet")
    tags.append(SCENE_TAGS[(seed >> 5) % len(SCENE_TAGS)])
    return tags


def tag_photo(path: str) -> dict:
    """对单张照片打标，返回 {path, filename, tags, quality}。"""
    try:
        img = Image.open(path)
        img.load()  # 提前解码，坏图在这里就报错而不是后面
    except Exception:
        # 任何无法读取/解码的图（不支持的格式、损坏等）直接跳过
        return {"path": path, "filename": os.path.basename(path), "tags": [], "quality": 0.0,
                "aesthetic": 0.0, "colorfulness": 0.0, "phash": None, "csig": None}

    signals = _real_image_signals(img)
    semantic = _detect_semantic(path)
    colorfulness = _colorfulness(img)
    signal_tags, metrics = signals
    tags = set(signal_tags + semantic)
    if colorfulness > 0.45:
        tags.add("colorful")

    # 情绪/氛围维度（清新治愈/活力/文艺复古/静谧）——由真实信号推导
    mood = _mood_tag(tags, metrics)
    if mood:
        tags.add(mood)

    # 废片过滤（借鉴苹果 utility content filter）：命中则打 junk 标签并把画质清零，
    # 后续去重/选图会直接把 quality<=0 的图剔除，不上墙。
    junk_reason = _detect_junk(path, colorfulness, metrics)
    if junk_reason:
        tags.add("junk")
        tags.add(f"junk_{junk_reason}")

    tags = sorted(tags)
    phash = _dhash(img)  # 感知哈希，供去重使用
    csig = _content_sig(img)  # 内容签名（低分辨率色块），供去重识别「同一场景/主体」

    # 画质分：清晰 + 曝光合适 + 有对比 加分（用于筛掉糊图/废片）
    quality = 0.45
    if "sharp" in tags:
        quality += 0.35
    if "bright" in tags:
        quality += 0.10
    if "high_contrast" in tags:
        quality += 0.08
    if "vibrant" in tags:
        quality += 0.05
    if "low_key" in tags or "high_key" in tags:
        quality -= 0.05  # 过暗/过曝轻微扣分
    quality = round(min(max(quality, 0.0), 1.0), 3)

    # 废片直接判 0 分（比任何画质惩罚都强），确保被下游剔除
    if junk_reason:
        quality = 0.0


    # 美观度分：综合清晰度 + 色彩丰富度 + 构图（三分法）+ 曝光对比，用于「优先选好看的」
    composition = _composition_score(img)
    aesthetic = 0.38 * quality + 0.34 * colorfulness + 0.22 * composition
    if "high_contrast" in tags:
        aesthetic += 0.06
    aesthetic = round(min(max(aesthetic, 0.0), 1.0), 3)

    return {
        "path": path,
        "filename": os.path.basename(path),
        "tags": tags,
        "quality": quality,
        "aesthetic": aesthetic,
        "composition": composition,
        "colorfulness": colorfulness,
        "camera_exif": bool(metrics.get("camera")),
        "taken_at": _taken_at(img, path),
        "phash": phash,
        "csig": csig,
    }
