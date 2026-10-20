# 完整工程交付

交付日期：2026-10-20。仓库：mokee001/xmind；分支：codex/echoo-engine-admission-blue-sky。此分支以新工程作为独立根提交，保留原仓库其他分支，不引入旧工程的代码、规则、配置或缓存。

## 内容

| 目录或文件 | 内容 |
| --- | --- |
| Sources/EchooCore | 准入规则、四主题聚合、流程编排、模板路由、蓝天绿地硬条件/分层偏好及兜底分配 |
| Sources/EchooApple | 有界预览、原生分析、PhotoKit输入适配、入选宠物抠图、加工编排和原生成片 |
| Sources/EchooGateway、gateway | iOS HTTP客户端、图片安全审核与Qwen API适配、严格响应校验、本地复核工具 |
| Sources/EchooAudit、Sources/EchooCalibrate | 显式照片输入的审计工具、样本校准与渲染命令 |
| Sources/EchooApple/Resources/BlueSky | 六个原始设计素材及摘要，不含用户照片 |
| templates/pets.blue-sky-green-field/1.0.0 | 最新模板规则v3、运行参数、模型提示词、批准记录和文件摘要 |
| Tests、gateway/tests、scripts | Swift/Python测试、iOS编译、页面逻辑与跨语言生成验证、完整源码打包工具 |
| docs、README.md、AGENTS.md | 范围、策略决策、接入、契约、验证记录与维护边界 |
| 两个.command入口 | 普通本机进程的本地校准入口；首次使用需显式输入图库或准备目标宠物配置 |
| gateway/.env.example | 空凭证配置示例，不含真实密钥 |

工作边界仍为获得照片资源之后到返回海报数据。照片授权、原始库获取数量、iCloud下载决策、成品上屏与发布由宿主负责。本项目是可接入iOS宿主的Swift Package和后端源码，不包含宿主App、部署服务或生产凭证。

## 获取与运行

```sh
git clone --branch codex/echoo-engine-admission-blue-sky --single-branch https://github.com/mokee001/xmind.git echoo-engine
cd echoo-engine
sh scripts/test-swift.sh
sh scripts/check-ios.sh
node scripts/test-calibration-ui.cjs
python3 -B scripts/test-processing-contract.py
python3 -B scripts/test-blue-sky-generation.py
cd gateway
python3 -B -m unittest discover -s tests -v
```

要求Xcode及Node.js、Python；详细平台要求见根README。上述验证使用合成数据和替身服务，不需要API key或原始图库。真实API联调另按根README配置后端环境；`gateway/.env.example`不会自动加载。

## 完整源码包

`releases/echoo-engine-source-20261020.zip`包含本次公开源码、文档、测试、配置示例、两个启动入口和六个静态设计PNG；解压后进入`echoo-engine/`即可执行上面的构建与测试。与文件同目录的`.sha256`校验ZIP，包内`SHA256SUMS`校验每个文件。源码Git树与ZIP来源相同；`.git`、构建产物、依赖环境、私人照片、真实凭证、测试缓存、运行日志及本地海报均未包含。模板的独立冻结ZIP仍可在本机dist/保留，完整工程包不重复嵌套该ZIP。

复现打包时在工程根目录执行；输出必须是新文件，避免覆盖交付快照：

```sh
python3 -B scripts/package-engine.py --output /path/to/new-source-package.zip
```

## 本次状态

最新规则为blue-sky-generation-rules-v3，选片v3、宠物证据v2、原片提示词v4、抠图验收v2；布局v5、描边v3保持已批准参数。硬条件通过后按姿态、构图与边缘、已知原片通用评分逐级排序；不足时依次隐去photo4、photo3、photo2、photo1、photo5；零照片仍生成背景及固定装饰。

已通过73项Swift、100项Python测试、iOS17模块编译、页面逻辑和跨语言加工/渲染联测；42个合成数量/物种契约用例通过。1号猫0～5张六档原生成品于2026-10-20获用户确认“效果符合预期”，其中5张版与原定稿逐字节一致。私人样例与源图只留本机，不随包上传。

这些结果不代替真实多物种模型识别、身份、原生分割与iPhone性能验证。模板维持validatingAutomation；不将视觉批准或离线测试提升为生产ready。详细历史和边界见VALIDATION.md、DECISIONS.md及IOS_INTEGRATION.md。
