# 主板不可用时的软件设备测试

这条链路用于 iOS 模拟器冒烟测试，不替代真实 iPhone、BLE、Wi-Fi 或墨水屏验证。
它复用正式的设备存储、家庭账户、设备列表和发布状态模型，只把真实固件上报状态
替换成受保护的测试控制接口。

## 1. 启动隔离的本地后端

在项目根目录新开终端，使用一段临时且至少 16 位的密钥：

```bash
PHOTOWALL_STORE_DIR=/tmp/photowall-software-device-store \
PHOTOWALL_DATA_DIR=/tmp/photowall-software-device-data \
PHOTOWALL_ENABLE_TEST_API=1 \
PHOTOWALL_TEST_API_KEY=local-software-device-key-2026 \
python3 -m uvicorn backend.server:app --host 127.0.0.1 --port 8000
```

不要在生产服务器设置 `PHOTOWALL_ENABLE_TEST_API=1`。未开启时，所有
`/api/test/*` 端点均返回 404。

## 2. 配置 App 的本地测试环境

编辑不会提交到 Git 的 `photo-wall-app/.env.local`：

```dotenv
EXPO_PUBLIC_API_BASE=http://127.0.0.1:8000
EXPO_PUBLIC_ENABLE_TEST_DEVICE=1
EXPO_PUBLIC_TEST_DEVICE_KEY=local-software-device-key-2026
```

改完环境变量后需要停止并重新启动 Metro；热刷新不会重新读取环境变量。

## 3. 在 iOS 模拟器操作

1. 打开 App 的“设置”。
2. 在“软件测试照片墙”中点“连接模拟照片墙”。
3. 设备会进入正式的本机安全存储和家庭账户流程。
4. 连续点“推进到下一状态”，依次验证：已排队、下载中、刷新中、完成。
5. 点“模拟刷新失败”，验证失败提示；再点“重试并推进”验证恢复。
6. 在“家庭与成员”创建邀请码，验证同设备多账户 UI。
7. 完成后点“清除模拟照片墙”。

## 4. 仍需真实硬件验证的项目

- iPhone BLE 扫描和系统蓝牙权限；
- App 内 Wi-Fi 列表、密码写入和设备联网；
- 局域网发现与控制；
- PWE6 下载、六色刷新以及真实完成状态上报；
- 断电、弱网和重启后的恢复。
