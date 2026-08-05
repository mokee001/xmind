# 日历选图输入契约 v1

## 目的

`selection.json` 是已及格选图层与本地模型处理决策层之间的稳定接口。上游可以
继续使用现有规则、视觉方法或未来选图模型，只要输出这个结构，后续 Prompt、
处理计划、动态贴纸、渲染和 QA 都不需要改动。

## 文件位置

```text
prepared-run/
  manifest.json
  selection.json
  proxies/
```

照片路径推荐写成相对运行目录的路径，不保存个人电脑绝对路径。

## 最小结构

```json
{
  "schema_version": "1.0",
  "calendar": {
    "year": 2026,
    "month": 7
  },
  "days": [
    {
      "day": 3,
      "sources": [
        "proxies/2026-07-03__001.jpg"
      ],
      "evidence_sources": [],
      "reason": "手写卡片具有明确生活记录意义",
      "analysis_context": {
        "content_type": "纸质手写卡片",
        "main_subject": "手持卡片",
        "text_candidates": []
      }
    },
    {
      "day": 19,
      "sources": [],
      "evidence_sources": [
        "聊天文字上下文"
      ],
      "reason": "当天无合格照片，但存在用户本人状态记录",
      "analysis_context": {
        "content_type": "个人健康状态",
        "text_candidates": [
          {
            "source": "user_chat",
            "text": "痛经真的很难，得好好休息"
          }
        ],
        "layout_balance_needed": true,
        "consecutive_blank_run_length": 2
      }
    }
  ]
}
```

## 硬约束

- 当前版本只接受 2026 年 7 月的 `day: 1–31`。
- 同一天只能出现一次。
- 每天 `sources` 为 0–3 项，原则上 1 张。
- 有照片时只能引用已经复制到运行目录的工作副本。
- 无照片时必须提供 `analysis_context`，供纯文字、插画加文字、纯插画或留白判断。
- `text_candidates` 必须保留来源，模型不得把总结伪装成用户原话。
- `reason` 记录上游为什么选择该素材，不承担图片处理方式决策。
- 不允许写入 API Key、Token、原图二进制或个人绝对路径。

## 层间责任

```text
选图层
  输出 selection.json：哪一天用哪些真实素材

本地 Qwen3-VL 决策层
  输出 api_decisions/dayXX.json：每张素材应如何处理

整月艺术指导层
  输出 treatment_plan.json：保证全月节奏与处理多样性

执行与渲染层
  生成抠图/插画资产、动态贴纸、最终日历和 QA 报告
```

未来把选图升级成模型时，只替换第一层；不得让处理决策模型移动照片日期或重新
选择未进入 `sources` 的原始相册素材。
