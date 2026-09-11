# Echooo onboarding Demo

当前版本：v2.2。四步引导、完整相册人物头像气泡、六类主题偏好和整墙预览。

## 本次独立提交的边界

仅包含 `demos/onboarding/`、两个 Demo 服务／偏好辅助脚本、对应测试与版本说明。
不包含 App、设备固件、通用后端、模板目录、选片引擎或根项目配置的其他未提交修改。
不包含照片、人物识别数据、模型、分析缓存、密钥或安装包；没有部署网页或发布 TestFlight。

这是独立的 **Demo 源码提交**，不是可脱离项目依赖运行的完整发行包。

## 本机预览

在已配置好当前项目的工作区运行：

```sh
python3 tools/preview_onboarding.py
```

访问 <http://127.0.0.1:8772/>。已有预览时刷新即可。

完整预览需要本机现有的 `selection_lab`、`backend.template_packages` 及其依赖，
以及 `outputs/selection-lab/active-dataset.json` 所指定图库的已保存精选快照、完整人物索引和整墙样本。
这些模块和私人数据不在本次独立提交中；仅从此分支全新拉取时，不能宣称已具备完整推理／预览环境。
缺少依赖或本地快照时应报告缺失，不以随机图、其他图库或重新运行选片替代。

Demo 只在本机读取已有数据。授权、配网、整理耗时与上屏回执均为模拟，不请求真实手机相册权限、
不上传照片、不操作真实设备，也不写入正式展示偏好。

## 检查

不需要私人图库的 JavaScript 状态与源码检查：

```sh
node --check demos/onboarding/v2.js
node --check demos/onboarding/v2-state.js
node --test tests/test_onboarding_v2.cjs tests/test_onboarding_demo.cjs
```

已准备好上述本机依赖和图库后，再执行集成／投影检查：

```sh
PYTHONPATH=.:tests python3 -m unittest test_onboarding_demo test_onboarding_preferences
```

本次提交前在原工作区通过 41 项 JavaScript 检查和 17 项 Python 检查；没有浏览器视觉测试。
交互和规则边界见 [v2.2 说明](../../docs/onboarding-demo-v2.2.md)。
