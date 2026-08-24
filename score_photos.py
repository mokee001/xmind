"""
score_photos.py — VLM 打分脚本 (千问 qwen3-vl-plus)

用法(在 pet-calendar 目录下,venv 激活状态):
    python score_photos.py --folder pet-only              # 先跑验证集(35 张)
    python score_photos.py --folder pet-only --limit 5    # 只跑前 5 张试水
    python score_photos.py --folder raw                   # prompt 调好后跑完整相册

功能:
    - 扫描文件夹,自动过滤视频/非图片文件
    - 支持 HEIC 格式(通过 pillow-heif)
    - 读取 EXIF 拍摄时间(DateTimeOriginal / DateTimeDigitized)
    - 并发调用 qwen3-vl-plus 视觉模型,输出结构化 JSON
    - 结果缓存到 cache/scores.json (MD5 作 key,重跑跳过已处理)
    - 失败自动重试,中途崩溃不丢结果
"""

import os
import sys
import json
import hashlib
import base64
import argparse
import io
from pathlib import Path
from datetime import datetime
from concurrent.futures import ThreadPoolExecutor, as_completed
from threading import Lock

from PIL import Image, ImageOps
from PIL.ExifTags import TAGS
import pillow_heif
from dotenv import load_dotenv
import dashscope
from dashscope import MultiModalConversation

# 让 Pillow 支持 HEIC
pillow_heif.register_heif_opener()

# 加载 .env
load_dotenv()
dashscope.api_key = os.getenv("DASHSCOPE_API_KEY")
if not dashscope.api_key:
    print("错误: 找不到 DASHSCOPE_API_KEY, 请检查 .env 文件")
    sys.exit(1)

# ---------------- 配置 ----------------
# 默认模型 (旧模型, 历史 scores.json 用这个跑的)
# 通过 --model 参数可以切换到新模型(比如 qwen3-vl-max-latest 等)
DEFAULT_MODEL = "qwen3-vl-plus"
PHOTO_EXTS = {".jpg", ".jpeg", ".heic", ".png", ".webp"}
VIDEO_EXTS = {".mov", ".mp4", ".m4v", ".avi", ".mkv"}
MAX_CONCURRENT = 6
MAX_RETRY = 3
CACHE_FILE = "cache/scores.json"
JPEG_QUALITY = 85
MAX_IMAGE_SIZE = 1280  # 长边像素,压小节省 token

cache_lock = Lock()

# ---------------- Prompt ----------------
SYSTEM_PROMPT = """你是一位「宠物日历」的策展编辑, 精通用一句短小、生活化、有个人味道的中文 caption 记录宠物瞬间。

评估原则:
1. 判断这张照片是否适合放进宠物月历(主体是猫/狗/其他宠物且值得展示)
2. 从「生活瞬间价值 life_moment」和「技术质量 technical_quality」两个维度打分
3. 判断最佳版面尺寸(S/H/V)
4. 生成一句符合个人风格的中文 caption

【关键】我们要的是**生活感**,不是**摄影感**:
- 轻微模糊但抓到动态瞬间的照片(motion blur)非常宝贵,是 life_moment 高分素材,不要因为不清晰就判低
- 只有 out_of_focus(失焦看不出主体) 才应剔除
- 允许人物出现(包括正脸),人宠互动照片情感浓度高
- 多只宠物同框是加分项,通常适合 H 或 V

版面尺寸判断(依据是**主体构图方向**,不是照片画幅方向):
- S(单格): 主体聚焦、蜷缩、方形感、脸部特写
- H(横向跨 2 格): 主体横向延伸(横躺、并排、多主体并列)
- V(竖向跨 2 格): 主体纵向延伸(坐立、跳起、抱着、脸部大特写、爬高)

【严格剔除】按以下顺序检查, 满足任一条就直接 is_pet=false, 不考虑生活感/情感/caption 可能性:

一、截图/UI 类识别 (最优先, 只要有以下特征之一就 false):
- 画面里有超过 5 个字的连续中文/英文文字段落
- 画面顶部/底部有状态栏、导航栏、按钮、点赞收藏图标、评论区样式
- 画面有社交平台特征(小红书/微博/朋友圈/Instagram 的界面元素)
- 画面有明显的白色/浅色边框区域包裹一张内嵌照片(典型的截图套截图结构)
- 图片长宽比是手机屏幕比例(9:19.5 或类似) 且四周有明显 UI 元素
即使截图里的内容是一张漂亮宠物照片, 也必须 false。因为原图不在用户手上, 无法进入日历。

二、主体完整性(次优先):
- 画面里只有宠物的局部(比如只拍到耳朵/尾巴/一只爪子/一小片毛)且看不到脸和身体主要轮廓 → false
- 例:一张只拍到猫耳朵、看不到猫脸和身体的照片 → false
- 例:一张只有半个尾巴出画的照片 → false
- 反例:清晰的猫脸大特写 → true(脸就是主体, 完整可辨)
- 反例:宠物趴在人腿上只露上半身 → true(身体主要部分可辨)

三、模糊分级(需要仔细分辨):
- motion blur 抓到动态瞬间, 能看清宠物在做什么(扑、跳、跑、甩头) → true, life_moment 可高
- 轻度模糊, 主体清晰可辨 → true
- 中度到高度模糊, 只能通过轮廓猜出是宠物, 无法辨认表情/动作/品种 → false
- 完全失焦, 一片糊 → false
判断准则:如果你要为这张照片写 caption, 却只能写「一只糊糊的猫」而写不出任何具体动作/表情/场景细节, 那就是应该 false 的模糊程度。

四、构图/场景:
- 纯风景、纯物品、纯食物、纯人像(画面里根本没宠物) → false
- 宠物在画面里占比 < 15%(明显配角背景) → false
- 大合影里凑巧带宠物, 视觉主体是多个人 → false
- 文档扫描、二维码、表情包(带文字的搞笑图) → false

判断顺序: 先跑一二三四, 任一命中直接 false, 后续字段可用默认值。不要因为「说不定能配个 caption」保留不合格照片。

Caption 风格样本(仅供参考语气,不是可以照抄的模板):
- 「亲薯你」「嘿嘿开心到模糊」「伪装成海豹」— 谐音、自嘲、比喻
- 「放开本咪」「本咪在思考猫生」— 拟宠第一人称
- 「喜欢待在妈身上的胖胖面包」「和妈妈一起午睡」— 用宠物昵称+日常叙事
- 「又抱在一起啃」「吃我一拳」— 观察者视角带调侃

从样本里学的是**语气**(轻松、有观察、有个人味),不是具体词句。

Caption 严格要求:
- 4-12 字为主,禁止「这是一只可爱的猫...」这种描述句
- 【禁止套用】不要反复使用「放开本咪」「本咪 xx」「xx 已就位」「xx 守卫/岗哨/门岗」这类模板句式。多张照片同类场景时,必须换不同措辞。样本里的具体句子最多整个批次里出现 1 次,超过 1 次的样本句就算违规
- 【禁止套路】不要每张 human-interaction 照片都写「放开本咪」变体;不要每张守望照片都写「xx 已就位」;要根据这张照片的具体细节(表情、姿态、光线、周围环境)写出这张照片独有的一句
- 【括号严格限制】默认不使用括号补充。只有在照片存在极强的视觉反差(比如宠物做严肃表情但姿态很傻、看似凶但实际很萌)时,才用一个短括号点破反差。20 张里最多 1 张可以带括号,其余全部使用无括号的自然短句。判断标准:如果去掉括号内容,句子还能独立成立且表达完整,那就一定要去掉括号。绝对不允许「xx 就位(xxx)」「本咪 xx(xxx)」这种把括号当调味料塞进去的写法
- 每一句都要能让人一眼看出「就是在说这张照片」而不是随便一张同类照片都能配"""

USER_PROMPT = """请分析这张照片, 返回严格符合以下格式的 JSON (不要有 JSON 之外的任何文字, 不要 markdown 代码块):

{
  "is_pet": true/false,
  "pet_count": 数字,
  "pet_relation": "多只宠物时描述关系, 单只为 null",
  "has_human": true/false,
  "has_face": true/false,
  "human_pet_interaction": 0-5,
  "blur_type": "none" 或 "motion" 或 "out_of_focus",
  "technical_quality": 0-10,
  "life_moment": 0-10,
  "scene": "简短场景描述",
  "activity": "宠物在做什么",
  "caption": "符合上面风格的中文短句",
  "dominant_color": "#RRGGBB",
  "subject_position": "center/left/right/top/bottom",
  "subject_ratio": 0-100,
  "pet_id": "宠物特征标签",
  "face_score": 0-10,
  "shot_type": "close_up" 或 "half_body" 或 "full_body" 或 "other",
  "subject_fully_visible": true/false,
  "body_orientation": "horizontal" 或 "vertical" 或 "square",
  "pose_and_expression": "姿态-表情",
  "has_nearby_objects": true/false,
  "background_complexity": 0-5,
  "hero_potential": 0-10,
  "emotion_type": "情绪标签",
  "landscape_score": 0-10,
  "landscape_type": "nature/urban/indoor/sky/water/plants/abstract/none",
  "image_orientation": "horizontal/vertical/square",
  "brightness": 0-10,
  "color_family": "色系标签",
  "color_hex_list": ["#RRGGBB", "#RRGGBB", "#RRGGBB"]
}

关于 subject_ratio (宠物占画面面积的百分比估算):
- 大头/大身体特写, 主体基本填满画面: 70-100
- 中景全身照, 主体占画面主要部分: 40-70
- 环境为主, 主体清晰可见但不占主导: 20-40
- 远景/主体较小, 只是画面一小部分: 5-20
- 多猫时按所有宠物面积总和估算

关于 pet_id (宠物特征标签,用于识别"是不是同一只宠物"):
- 格式: "颜色-花纹-毛长-品种猜测",用连字符连接
- 示例: "orange-tabby-shorthair" / "white-longhair-ragdoll" / "gray-white-shorthair" / "black-longhair-persian"
- 判断原则: 只写能明确看到的特征。同一只宠物在不同照片里的 pet_id 应该保持一致
- 多只宠物: 只描述最主要的那只 (画面占比最大或最清晰的)
- 无宠物照片: 写 "none"
- 如果实在无法判断品种,就写"unknown-breed",但颜色和毛长必须写

关于 face_score (脸部综合评分):
0-10 分,综合考虑: 脸部清晰度(30%) + 直视镜头程度(25%) + 脸部突出度(25%) + 表情辨识度(20%)
- 9-10: 大头照直视镜头 + 独特表情
- 7-8: 脸清晰但角度稍偏,或表情平淡
- 5-6: 脸可见但不是画面焦点
- 3-4: 只有半张脸或侧脸,表情不清
- 0-2: 看不清脸/背对/糊/无脸

关于 shot_type (取景类型, 拼贴海报选片核心字段):
判断这张照片是"大头照 / 半身照 / 全身照 / 其他"哪一种取景.
- close_up (大头照): 猫的头/脸占画面 ≥ 1/3, 身体大部分不入画或明显裁切在画外.
  眼睛/鼻子/胡须清晰突出, 观感是"贴脸怼镜头"
- half_body (半身照): 头 + 上半身可见, 后半身/腿部/尾巴被裁切出画.
  脸部占画面显著位置但不是唯一焦点
- full_body (全身照): 从头到尾完整入画 (含尾巴或四肢).
  脸相对较小 (通常 <15% 画面), 观感是"整只猫在画面里"
- other: 背影 / 完全侧面无脸 / 被物体严重遮挡看不清取景类型 / 无宠物
判断准则: 尾巴或四肢是否完整入画是关键分水岭 —— 完整入画就是 full_body,
被裁掉大半就是 half_body 或 close_up.

关于 subject_fully_visible (主体是否"取景完整", 拼贴海报 hero 位选片关键字段):
判断宠物"在当前取景类型下"是否完整入画, 没有被画面边缘裁到关键结构.
判断标准根据 shot_type 不同而不同:
- 若 shot_type = close_up (大头照): 头部完整入画 (两只耳朵、下巴、脸颊完整轮廓可辨) → true
  头部被裁 (耳朵尖出画不算, 但耳朵根部被裁 / 半个头 / 下巴出画 / 脸颊被裁一半) → false
- 若 shot_type = half_body (半身照): 头 + 上半身在画面里, 头部完整没被裁 → true
  头部本身被裁 (半个头露在外面 / 耳朵缺失 / 脸颊出画) → false
- 若 shot_type = full_body (全身照): 头 + 四肢 + 尾巴完整入画 → true; 缺一部分 → false
- 若 shot_type = other: 通常 false (背影/严重遮挡本身就是取景不完整)
允许胡须尖端、耳尖等细小结构轻微超出画面边缘 (物理上无法完全避免, 不影响 true 判断).
关键是"整体轮廓被裁"还是"细节末梢出画": 前者 false, 后者 true.

关于 body_orientation (宠物主体构图方向):
- horizontal: 主体横向延展 (横躺、并排走、多主体横排、长身影)
- vertical: 主体纵向延展 (坐立、跳起、脸部大特写有上下张力、竖抱)
- square: 主体聚焦中心 (蜷缩、正面头部特写、圆形团子姿态)
- 无宠物: 写 "square" (占位)

关于 pose_and_expression (姿态-表情组合):
- 格式: "姿态-表情",用连字符连接
- 姿态词: sitting/lying/standing/jumping/curled/stretching/walking/perched
- 表情词: alert/sleepy/playful/grumpy/curious/sassy/relaxed/scared/happy
- 示例: "sitting-alert" / "lying-sleepy" / "curled-relaxed"
- 无宠物: 写 "none-none"

关于 has_nearby_objects (拼贴海报选片关键字段, 判断抠图会不会翻车):
- true: 画面里除了宠物本体外, 有显著紧挨着 / 叠在宠物身边 / 与宠物在视觉上难以分离的其他物体
  - 例子: 猫抱着玩偶、宠物旁边有零食袋、宠物挨着大玩具、宠物半躺在被子里露出脸
- false: 宠物周围环境干净, 或只有远景家具(不紧挨)
  - 例子: 宠物趴纯地板、窗台环境纯色、宠物在草地上无杂物
- 边界: 项圈/铃铛/挂饰 不算 (视为宠物一部分)

关于 background_complexity (背景复杂度 0-5):
- 0: 极简/纯色 (棚拍白底、纯色墙、桌面反射光)
- 1-2: 简单 (纯色背景 + 少量远景物件)
- 3: 中等 (家居环境, 有若干识别度物件但不杂乱)
- 4-5: 复杂 (堆满物品、乱糟糟房间、多个显著物件)

关于 hero_potential (作为海报主视觉/封面/大图的潜力 0-10):
综合考虑: 构图完整度 + 表情戏剧性 + 眼神冲击 + 拍摄意图强度 + 视觉焦点
- 9-10: 大头照 + 直视镜头 + 独特表情 + 构图完整 (能压住场)
- 6-8: 中景 + 清晰主体 + 一般表情
- 3-5: 普通日常照, 不够抢眼
- 0-2: 主体小/不清晰/无冲击力
- 无宠物: 0

关于 emotion_type (情绪标签, 用于主题化选片):
单选一个: sleepy/alert/playful/grumpy/curious/sassy/relaxed/focused/surprised/happy
- 无宠物或看不清表情: 写 "unknown"

关于 landscape_score (作为拼贴海报"背景铺满画布"的适合度 0-10):
- 9-10: 视野开阔、构图有纵深或宽广感、色彩饱和度适中、无喧宾夺主的主体
  - 例子: 蓝天云海、远山湖泊、金色晚霞、公园远景
- 6-8: 场景合适但有次要元素
- 3-5: 场景可用但主体太抢眼 (比如有明显人像/宠物特写)
- 0-2: 完全不适合作背景 (纯人像特写、宠物特写、截图、文档、极复杂杂乱场景)
- 判断准则: 想象这张照片被 40% 透明度盖住 + 上面贴宠物抠图, 会不会好看

关于 landscape_type (场景大类, 单选):
- nature: 自然风光 (山川草原、森林、田野)
- urban: 城市街道、建筑、都市景观
- indoor: 室内场景 (餐厅、家居、咖啡馆等)
- sky: 天空为主 (纯天空、云海、日出日落)
- water: 水域为主 (海、湖、河、溪流)
- plants: 花草植物特写或近景
- abstract: 抽象/纹理/几何图案 (纯色墙面、纹理特写)
- none: 无明显场景 (纯宠物特写、纯人像、截图、文档等)

关于 image_orientation (整张照片的画幅方向, 不是主体方向):
- horizontal: 横构图 (宽 > 高)
- vertical: 竖构图 (高 > 宽)
- square: 近似方形

关于 brightness (整体亮度 0-10):
- 8-10: 明亮 (白天户外、亮室内)
- 5-7: 中等 (室内正常光线、阴天)
- 2-4: 偏暗 (夜晚有灯光、傍晚)
- 0-1: 极暗 (夜景、黑暗环境)

关于 color_family (整体主色系, 单选):
- blue: 蓝色系 (天空、海水、深蓝布、藏青)
- green: 绿色系 (草地、树林、绿植、深绿)
- red: 红色系 (红叶、红花、正红/暗红/酒红物件)
- pink: 粉色系 (樱花、朝霞、粉墙、粉色物件)
- purple: 紫色系 (紫花、暮色、薰衣草、紫墙)
- yellow: 黄色系 (向日葵、明亮黄、柠檬黄、黄墙、灯光)
- orange: 橙色系 (夕阳、橙叶、橙红/橙黄、火焰色)
- earth: 土黄棕色系 (沙滩、木地板、砖墙、干草、驼色、米色、深棕)
- white: 白色系 (雪、白墙、白布、纯白背景)
- black: 黑色系 (夜景、暗背景、深色主导)
- gray: 灰色系 (阴天、水泥、素灰)
- mixed: 多色混杂无主导色 (花丛、复杂街景、乱色场景)
- 判断准则: 想象你把画面模糊到只剩色块, 主要色块是什么色系

关于 color_hex_list (3 个主色的 hex 值, 从占比最大到最小排列):
- 数组格式: ["#RRGGBB", "#RRGGBB", "#RRGGBB"]
- 示例: ["#5B8FBA", "#7AA9C8", "#D4C4A8"]
- 跟 dominant_color 不同: 这里给 top 3 而不是仅 top 1

打分总原则:
- life_moment >= 8: 独特有趣温馨的瞬间(打哈欠特写、多宠互动、和人亲密、罕见动作)
- life_moment 4-7: 常规日常照片
- life_moment 0-3: 平淡无叙事
- blur_type=motion 通常 life_moment 较高
- caption 必须符合风格样本, 不要写「一只可爱的猫在...」这种句式

只输出 JSON, 不要任何解释。"""

# ---------------- 工具函数 ----------------
def file_md5(path):
    h = hashlib.md5()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(65536), b""):
            h.update(chunk)
    return h.hexdigest()

def extract_shot_date(path):
    """返回 'YYYY-MM-DD' 或 None, 兼容 HEIC/JPEG"""
    try:
        img = Image.open(path)
        exif = img.getexif()  # 新 API,对 HEIC 更友好
        if not exif:
            return None

        candidates = {}
        # 先看顶层 EXIF (通常有 DateTime, 是文件修改时间)
        for tag_id, val in exif.items():
            tag_name = TAGS.get(tag_id, tag_id)
            if tag_name in ("DateTimeOriginal", "DateTimeDigitized", "DateTime"):
                candidates[tag_name] = val

        # HEIC 的详细 EXIF 在 Exif IFD (0x8769) 里
        try:
            exif_ifd = exif.get_ifd(0x8769)
            for tag_id, val in exif_ifd.items():
                tag_name = TAGS.get(tag_id, tag_id)
                if tag_name in ("DateTimeOriginal", "DateTimeDigitized"):
                    candidates[tag_name] = val
        except Exception:
            pass

        # 优先级: Original > Digitized > DateTime
        for key in ("DateTimeOriginal", "DateTimeDigitized", "DateTime"):
            if key in candidates and candidates[key]:
                val = candidates[key]
                if isinstance(val, bytes):
                    val = val.decode("utf-8", errors="ignore")
                return datetime.strptime(str(val).strip(), "%Y:%m:%d %H:%M:%S").strftime("%Y-%m-%d")
    except Exception as e:
        print(f"  ⚠️  EXIF 读取失败 {path.name}: {e}")
    return None

def image_to_base64(path):
    """转 base64 JPEG, 处理 EXIF 旋转 + 尺寸压缩"""
    img = Image.open(path)
    img = ImageOps.exif_transpose(img)  # 自动按 EXIF Orientation 旋转
    w, h = img.size
    if max(w, h) > MAX_IMAGE_SIZE:
        ratio = MAX_IMAGE_SIZE / max(w, h)
        img = img.resize((int(w * ratio), int(h * ratio)), Image.LANCZOS)
    if img.mode != "RGB":
        img = img.convert("RGB")
    buf = io.BytesIO()
    img.save(buf, format="JPEG", quality=JPEG_QUALITY)
    return base64.b64encode(buf.getvalue()).decode("utf-8")

def parse_json_from_response(text):
    """从可能包含 markdown 代码块的文本里提取 JSON"""
    text = text.strip()
    if text.startswith("```"):
        # 去掉 ```json ... ``` 或 ``` ... ```
        parts = text.split("```")
        if len(parts) >= 2:
            text = parts[1]
            if text.lower().startswith("json"):
                text = text[4:]
    text = text.strip().strip("`").strip()
    return json.loads(text)

def call_vlm(image_path, model=None, retry=0):
    """调用 VLM, 返回 dict 或 None"""
    model = model or DEFAULT_MODEL
    try:
        b64 = image_to_base64(image_path)
        response = MultiModalConversation.call(
            model=model,
            messages=[
                {"role": "system", "content": [{"text": SYSTEM_PROMPT}]},
                {"role": "user", "content": [
                    {"image": f"data:image/jpeg;base64,{b64}"},
                    {"text": USER_PROMPT},
                ]},
            ],
        )
        if response.status_code != 200:
            raise RuntimeError(f"API {response.status_code}: {response.code} {response.message}")

        content = response.output.choices[0].message.content
        if isinstance(content, list):
            text = "".join(item.get("text", "") for item in content if isinstance(item, dict))
        else:
            text = str(content)

        return parse_json_from_response(text)
    except Exception as e:
        if retry < MAX_RETRY:
            return call_vlm(image_path, model=model, retry=retry + 1)
        print(f"  ❌ {image_path.name}: {e}")
        return None

# ---------------- 缓存 ----------------
def load_cache():
    p = Path(CACHE_FILE)
    if p.exists():
        with open(p, "r", encoding="utf-8") as f:
            return json.load(f)
    return {}

def save_cache(cache):
    p = Path(CACHE_FILE)
    p.parent.mkdir(exist_ok=True, parents=True)
    with cache_lock:
        with open(p, "w", encoding="utf-8") as f:
            json.dump(cache, f, ensure_ascii=False, indent=2)

# ---------------- 处理单张 ----------------
def process_photo(path, cache, model=None, force=False):
    md5 = file_md5(path)
    if md5 in cache and not force:
        return path.name, "cached", cache[md5]
    result = call_vlm(path, model=model)
    if result is None:
        return path.name, "failed", None
    result["shot_date"] = extract_shot_date(path)
    result["path"] = str(path)
    result["filename"] = path.name
    result["md5"] = md5
    result["_model"] = model or DEFAULT_MODEL  # 记录用哪个模型跑的
    with cache_lock:
        cache[md5] = result
    return path.name, "ok", result

# ---------------- 主流程 ----------------
def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--folder", default="pet-only",
                        help="要处理的文件夹 (pet-only / raw)")
    parser.add_argument("--concurrent", type=int, default=MAX_CONCURRENT,
                        help="并发数, 默认 6")
    parser.add_argument("--limit", type=int, default=None,
                        help="只处理前 N 张 (调试用)")
    parser.add_argument("--model", default=DEFAULT_MODEL,
                        help=f"使用的 VLM 模型, 默认 {DEFAULT_MODEL}")
    parser.add_argument("--force", action="store_true",
                        help="强制重新打分, 忽略 cache 里已有的 md5 (加了新字段/改了 prompt 后要重打时用)")
    args = parser.parse_args()

    folder = Path(args.folder)
    if not folder.exists():
        print(f"错误: 文件夹 {folder} 不存在")
        sys.exit(1)

    all_files = list(folder.iterdir())
    photos = sorted(f for f in all_files
                    if f.is_file() and f.suffix.lower() in PHOTO_EXTS)
    videos = [f for f in all_files if f.suffix.lower() in VIDEO_EXTS]
    others = [f for f in all_files if f.is_file()
              and f.suffix.lower() not in PHOTO_EXTS
              and f.suffix.lower() not in VIDEO_EXTS
              and f.name != "notes.txt"]

    if args.limit:
        photos = photos[:args.limit]

    print(f"📂 扫描 {folder}/")
    print(f"   照片(处理): {len(photos)}")
    print(f"   视频(跳过): {len(videos)}")
    print(f"   其他(忽略): {len(others)}")

    cache = load_cache()
    cached_md5s = set(cache.keys())

    # 预扫描哪些已缓存 (避免重复算 MD5)
    print(f"   🔍 检查缓存...")
    photo_md5s = {p: file_md5(p) for p in photos}
    already = sum(1 for p, m in photo_md5s.items() if m in cached_md5s)
    if args.force:
        to_call = len(photos)
        print(f"   已缓存: {already} (⚡ --force 已开启, 忽略缓存全量重打)")
    else:
        to_call = len(photos) - already
        print(f"   已缓存: {already}")
    print(f"   本次要调 API: {to_call}")
    print()

    if to_call > 0:
        print(f"🚀 开始并发调用 (并发={args.concurrent})...")

    results_count = {"ok": 0, "cached": 0, "failed": 0}
    completed = 0
    total = len(photos)

    print(f"   使用模型: {args.model}")
    print()

    with ThreadPoolExecutor(max_workers=args.concurrent) as executor:
        futures = {executor.submit(process_photo, p, cache, args.model, args.force): p for p in photos}
        for future in as_completed(futures):
            name, status, _ = future.result()
            results_count[status] += 1
            completed += 1
            icon = {"ok": "✅", "cached": "💾", "failed": "❌"}[status]
            print(f"[{completed:3d}/{total}] {icon} {status:8s} {name}")
            if completed % 20 == 0:
                save_cache(cache)

    save_cache(cache)
    print()
    print(f"✅ 完成: 成功 {results_count['ok']} / 缓存 {results_count['cached']} / 失败 {results_count['failed']}")
    print(f"📄 结果已保存到 {CACHE_FILE}")
    print()
    print("下一步:")
    print("  查看缓存内容:  cat cache/scores.json | python -m json.tool | less")
    print("  跑完整相册:    python score_photos.py --folder raw")

if __name__ == "__main__":
    main()
