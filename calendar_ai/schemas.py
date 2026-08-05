from __future__ import annotations

from enum import Enum
from typing import List, Tuple

from pydantic import BaseModel, Field


class Decision(str, Enum):
    use = "USE"
    review = "REVIEW"
    reject = "REJECT"


class TreatmentMode(str, Enum):
    proportional_full_image = "proportional_full_image"
    illustration_only = "illustration_only"
    illustration_with_text = "illustration_with_text"
    text_only = "text_only"
    non_cell_ratio_image = "non_cell_ratio_image"
    multi_irregular_cutout = "multi_irregular_cutout"
    circle_image = "circle_image"
    oval_image_with_cutout = "oval_image_with_cutout"
    irregular_cutout_with_text = "irregular_cutout_with_text"
    irregular_cutout = "irregular_cutout"
    blank = "blank"


class Anchor(str, Enum):
    center = "center"
    top_left = "top_left"
    top_right = "top_right"
    bottom_left = "bottom_left"
    bottom_right = "bottom_right"
    left_edge = "left_edge"
    right_edge = "right_edge"


class OverflowLevel(str, Enum):
    none = "none"
    safe_zone = "safe_zone"
    maximum_zone = "maximum_zone"


class TextSource(str, Enum):
    none = "none"
    user_caption = "user_caption"
    manual_annotation = "manual_annotation"
    ocr_note = "ocr_note"
    ocr_chat = "ocr_chat"
    ocr_system_screenshot = "ocr_system_screenshot"
    ocr_web_content = "ocr_web_content"
    reliable_event_metadata = "reliable_event_metadata"
    model_summary = "model_summary"


class TextLayout(str, Enum):
    none = "none"
    full_cell = "full_cell"
    bottom_band = "bottom_band"
    interleaved = "interleaved"


class IllustrationRole(str, Enum):
    none = "none"
    event = "event"
    mood = "mood"
    decorative = "decorative"


class ImageTreatmentDecision(BaseModel):
    decision: Decision
    treatment_mode: TreatmentMode
    fallback_treatment_mode: TreatmentMode
    confidence: float = Field(ge=0, le=1)
    selected_asset_indices: List[int] = Field(
        max_length=3,
        description="使用输入素材的 1-based 索引，最多 3 个"
    )
    primary_asset_index: int = Field(
        ge=0,
        le=3,
        description="主素材的 1-based 索引；无图片方案为 0",
    )
    element_count: int = Field(ge=0, le=3)
    content_type: str = Field(description="人物、宠物、食物、风景、海报、截图等")
    main_subject: str
    subject_bbox: Tuple[float, float, float, float] = Field(
        description="归一化 x1, y1, x2, y2；无法判断时为 0,0,1,1"
    )
    anchor: Anchor
    overflow_level: OverflowLevel
    rotation_degrees: float = Field(ge=-10, le=10)
    crop_focus: str
    keep_background: bool
    crop_safety: float = Field(ge=0, le=1)
    cutout_suitability: float = Field(ge=0, le=1)
    background_value: float = Field(ge=0, le=1)
    small_cell_readability: float = Field(ge=0, le=1)
    multiple_subjects: bool
    text_required: bool
    short_text: str = Field(
        max_length=24,
        description="需要文字时给出短文本；否则为空字符串；最多 24 个汉字"
    )
    text_source: TextSource
    text_source_excerpt: str = Field(
        max_length=80,
        description="支撑 short_text 的原始文字片段；没有文字证据时为空字符串",
    )
    text_is_direct_quote: bool
    text_layout: TextLayout
    illustration_required: bool
    illustration_role: IllustrationRole
    illustration_category: str = Field(
        max_length=32,
        description="用于插画素材库检索的类别；不需要插画时为空字符串",
    )
    illustration_style_id: str = Field(
        description="插画风格注册表 ID；不需要插画时为空字符串",
    )
    illustration_brief: str = Field(
        description="需要插画时描述线描插画内容；否则为空字符串"
    )
    layout_balance_needed: bool
    consecutive_blank_run_length: int = Field(
        ge=0,
        le=31,
        description="选择仅插画时填写包含当前日期的连续空白数量；其他模式为 0",
    )
    reject_reasons: List[str]
    reasons: List[str]
    matched_rule_ids: List[str]
    risks: List[str]
    executor_notes: List[str]
