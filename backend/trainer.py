"""
偏好模型 + 训练循环。

思路：
- 每个「维度标签」对应一个可学习的权重 weight[tag] ∈ [0, 1]，代表你有多喜欢这个维度。
- 人工打标产生样本 (tag, target)，target=1 好 / 0 差 / 也可连续分。
- 用梯度下降拟合这些样本（MSE + L2 正则），得到每个维度的偏好权重。
- 选图时把照片的所有 tag 权重求平均 -> 该照片的偏好分。
- 打标越多，权重越准，生成的照片墙越符合你的口味 —— 这就是长期训练的闭环。

纯 Python 实现，无需 numpy，保证开箱即跑。
"""

from __future__ import annotations

from . import store

_MODEL_KEY = "model"


def _default_model() -> dict:
    return {"weights": {}, "bias": 0.5, "trained_samples": 0, "epochs": 0}


def load_model(storage_key: str = _MODEL_KEY) -> dict:
    """Load one preference model.

    ``storage_key`` lets authenticated callers keep a model per account while
    preserving the legacy unscoped model for the original local workflow.
    """
    return store.load(storage_key, _default_model())


def save_model(model: dict, storage_key: str = _MODEL_KEY) -> None:
    store.save(storage_key, model)


def score_tags(tags: list[str], model: dict | None = None) -> float:
    """给一组标签打偏好分（0~1）。未见过的维度用 bias。"""
    model = model or load_model()
    weights = model["weights"]
    bias = model.get("bias", 0.5)
    if not tags:
        return bias
    vals = [weights.get(t, bias) for t in tags]
    return sum(vals) / len(vals)


def train(samples: list[dict], epochs: int = 200, lr: float = 0.1, l2: float = 0.01,
          storage_key: str = _MODEL_KEY) -> dict:
    """
    samples: [{"tag": "food", "score": 0.0~1.0}, ...]
    对每个维度做梯度下降，拟合其平均目标分。返回更新后的模型。
    """
    model = load_model(storage_key)
    weights = dict(model["weights"])

    # 收集每个 tag 的目标样本
    by_tag: dict[str, list[float]] = {}
    for s in samples:
        by_tag.setdefault(s["tag"], []).append(float(s["score"]))

    for tag, targets in by_tag.items():
        w = weights.get(tag, model.get("bias", 0.5))
        for _ in range(epochs):
            # MSE 梯度：dL/dw = mean(2*(w - target)) + 2*l2*w
            grad = sum(2 * (w - t) for t in targets) / len(targets) + 2 * l2 * w
            w -= lr * grad
        weights[tag] = round(min(max(w, 0.0), 1.0), 4)

    model["weights"] = weights
    model["trained_samples"] = model.get("trained_samples", 0) + len(samples)
    model["epochs"] = model.get("epochs", 0) + epochs
    save_model(model, storage_key)
    return model
