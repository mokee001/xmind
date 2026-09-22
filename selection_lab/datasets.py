"""Local dataset routing; old caches/snapshots stay untouched."""
from pathlib import Path
from .core import ROOT, LabError, read_json

BASE_CACHE = ROOT / "outputs/immich-comparison"
BASE_STATE = ROOT / "outputs/selection-lab"
BASE_HISTORY = ROOT / "outputs/new-strategy-preview/selected.json"
ACTIVE = BASE_STATE / "active-dataset.json"


def paths(cache_dir=None, state_dir=None, historical=None):
    if cache_dir is None and state_dir is None:
        active = read_json(ACTIVE, {})
        if active:
            root = (BASE_STATE / "datasets").resolve()
            try:
                cache_dir, state_dir = Path(active["cache_dir"]).resolve(), Path(active["state_dir"]).resolve()
                cache_dir.relative_to(root); state_dir.relative_to(root)
            except (KeyError, TypeError, ValueError) as error:
                raise LabError("当前数据集配置无效；未静默切回旧照片") from error
            if not (cache_dir / "current-cache.json").is_file():
                raise LabError("当前数据集缓存缺失；请重新导入或明确选择旧数据集")
    return (Path(cache_dir or BASE_CACHE).resolve(), Path(state_dir or BASE_STATE).resolve(),
            Path(historical or BASE_HISTORY).resolve())
