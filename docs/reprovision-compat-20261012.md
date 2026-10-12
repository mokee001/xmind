# 旧主服务重新配网兼容候选（2026-10-12，未部署）

本次仅保存候选补丁与回归，尚未修改线上主服务，也没有改动当前工作区的
`backend/server.py`、设备绑定或固件。它不解决 Wi-Fi 成功后、到达服务器之前的 TCP 104 重置。

## 兼容缺口与限定范围

2026-10-12 17:32，App 对真实屏幕的重新配网请求五次返回 404。线上 OpenAPI
及源码确认缺少 `/api/devices/{device_id}/reprovision`；不能把这一缺口当成后续
Wi-Fi 服务不可达的根因。旧服务的删除接口同时将保留绑定标记固定为 false，
因此仅新增一个路由不足以支持“更换 Wi-Fi 但保留绑定”。

精确候选：`config/patches/server-reprovision-compat-20261012.patch`。

- 应用前服务器文件 SHA256：`5ad66096ab702b185dae28334624b259d5386e7cc08437eca840faf578898846`。
- 应用后候选 SHA256：`2b5d631299fe0635d9e7a411069f782c64c5b9bfaba3520ce4a5a355ebf64ba7`。
- 修改五个已有函数：`_public_device`、`_queue_reprovision`、`device_bootstrap`、
  `device_next`、`device_status`；新增一个请求模型与 `device_reprovision` 路由。
- 当前 owner 验证及输入校验完成后才修改状态；新配网证明必须精确匹配 owner
  为该设备登记的证明，且仍在 600 秒窗口内。没有提供证明的普通重启不能消除待执行命令。
- 保留绑定的配网不会清除已有墙版本、账号或历史身份；删除仍保留原有解绑行为。
- AST 回归确认其他函数、类型、导入和模块语句不变，包含 10 月 10 日的认领及历史修复。

## 回归方式

`tests/test_legacy_reprovision_patch.py` 从缓存的**实际旧线上源码**开始，在临时目录
执行 `git apply`，核对前后 SHA 后再运行合成 MemoryStore 和实际 FastAPI HTTP 契约测试。
不会加载运行中的后端或读取真实设备数据。

```sh
PHOTOWALL_LEGACY_REPROVISION_SOURCE=/path/to/exact/server-before.py \
  python3 -m unittest discover -s tests -p test_legacy_reprovision_patch.py
```

须使用 Python 3.10 以上。未设置环境变量时，默认读取忽略目录中的
`outputs/wifi-recheck-20261012/server-before.py`。源码缺失或 Python 版本不支持时明确跳过；
源码 SHA 不符则失败，不用工作区的新服务器文件代替线上基准。

生产虚拟环境 Python 3.12.3、FastAPI 0.141.1、Pydantic 2.13.4 下，实际应用标准补丁后
33 项全部通过。覆盖空请求体、空 JSON、错类型 422、鉴权失败及引用式 store 不变、
跨设备与过期证明拒绝、重复配网、丢失 ACK、保留绑定、原删除与认领恢复。
独立审查另通过相同 33 项及历史路由 9 项、历史核心 14 项。

## 尚存边界与上线条件

物理重置后的无设备凭据请求使用 owner 的证明成功换取新凭据后，该证明立即消费。
若成功响应丢失，重复使用旧证明会被拒绝，需要 owner 重新登记证明。
有效设备凭据附带过期或不匹配证明时可以正常报到，但不能消除待配网命令；App 须重新登记证明。

部署前须重新核对线上 SHA，并备份原文件及所有者/权限。只应用此精确补丁，不能覆盖其他
任务的主服务器修改。线上两个 API 进程均引用 `server.py`，上线时须统筹进程刷新及健康核对。
真实设备的重新配网 POST 会触发硬件操作，不能拿它作为无副作用的上线探针。

此兼容候选没有执行部署、服务重启、真实重新配网命令、生成、投送或设备数据修复。
源码与回归独立存档，不代表手机或设备已收到这项更新。
本机证据、快照、测试日志及候选状态位于 `outputs/wifi-recheck-20261012/`。
