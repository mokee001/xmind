"""
真实目标检测打标器（YOLOv8 / COCO 80 类）。

把检测到的 COCO 类别映射回项目的维度词表（人物/宠物/场景/元素），
接口与 mock 完全一致：detect(path) -> list[str]。

首次运行会自动下载 yolov8n.pt（约 6MB，需联网）。
若未安装 ultralytics，本模块的 available() 返回 False，上层自动回退到 mock。
"""

from __future__ import annotations

# COCO 类别 -> 项目维度标签
_FOOD = {
    "banana", "apple", "sandwich", "orange", "broccoli", "carrot", "hot dog",
    "pizza", "donut", "cake", "cup", "bowl", "wine glass", "bottle",
    "fork", "knife", "spoon", "dining table",
}
_PET_SPECIFIC = {"dog": "dog", "cat": "cat"}
_PET_OTHER = {"bird", "horse", "sheep", "cow", "elephant", "bear", "zebra", "giraffe"}
_CITY = {"car", "bus", "train", "truck", "motorcycle", "traffic light", "bicycle", "fire hydrant", "stop sign", "parking meter"}
_TRAVEL = {"airplane", "boat", "suitcase", "backpack"}
_INDOOR = {"chair", "couch", "bed", "tv", "laptop", "sofa", "book", "keyboard", "mouse", "remote", "microwave", "oven", "refrigerator", "sink", "toilet", "clock", "vase"}
_NATURE = {"potted plant"}
_SPORT = {"sports ball", "skateboard", "surfboard", "tennis racket", "baseball bat", "frisbee", "skis", "snowboard", "kite"}

import os

_model = None
# 模型可配：环境变量 PHOTOWALL_YOLO_MODEL（默认 yolov8s，比 nano 更准）。
# 可选 yolov8n/yolov8s/yolov8m…… 首次用到会自动下载对应权重。
_MODEL_NAME = os.environ.get("PHOTOWALL_YOLO_MODEL", "yolov8s.pt")


def available() -> bool:
    try:
        import ultralytics  # noqa: F401
        return True
    except ImportError:
        return False


def _get_model():
    global _model
    if _model is None:
        from ultralytics import YOLO
        try:
            _model = YOLO(_MODEL_NAME)
        except Exception:
            # 下载失败/不可用时回退到体积最小、已缓存的 nano
            _model = YOLO("yolov8n.pt")
    return _model


def detect(path: str) -> list[str]:
    """对一张照片做真实检测，返回维度标签列表。"""
    model = _get_model()
    results = model.predict(path, verbose=False, conf=0.35)
    names = model.names

    labels: list[str] = []
    person_count = 0
    for r in results:
        for c in r.boxes.cls.tolist():
            labels.append(names[int(c)])
            if names[int(c)] == "person":
                person_count += 1

    tags: set[str] = set()
    for lbl in labels:
        if lbl == "person":
            tags.add("person")
        elif lbl in _PET_SPECIFIC:
            tags.add(_PET_SPECIFIC[lbl])
            tags.add("pet")
        elif lbl in _PET_OTHER:
            tags.add("pet")
        elif lbl in _FOOD:
            tags.add("food")
        elif lbl in _CITY:
            tags.add("city")
        elif lbl in _TRAVEL:
            tags.add("travel")
        elif lbl in _INDOOR:
            tags.add("indoor")
        elif lbl in _NATURE:
            tags.add("nature")
        elif lbl in _SPORT:
            tags.add("sport")

    # 人物数量 -> 细分 portrait / group
    if person_count >= 2:
        tags.add("group")
    elif person_count == 1:
        tags.add("portrait")

    return sorted(tags)
