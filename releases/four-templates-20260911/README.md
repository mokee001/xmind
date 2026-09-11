# 已确认四款的集成与发布快照

此目录保存用户于 2026-09-11 确认的四款模板集成内容和已发布 App 的准确源码，不自动改写本分支较旧的运行时代码。

- 模板唯一清单：../../assets/templates/catalog.json。仅日常拼贴、圣诞手帐、分层抠图拼贴、宠物牛仔拼贴；白底画廊及旧 16 款全部停用。
- App：app-source/ 是已验证并发布的 1.3.4（23）独立源码，SHA256 见 source-manifest.json。EAS 使用远端构建号，源码 app.json 的旧 buildNumber 被构建时的 23 覆盖。release-status.json 和 apple-status-23.json 记录 Apple 已处理且实际分配到 Team (Expo)。不包含安装包、凭据、运行日志或用户图库。
- 后端：backend-integration.patch 是从本次修改前工作区生成且验证过的差异；backend/new-files 是新增代码和测试；backend/reference-source 仅供核对最终集成内容，包含原有业务链路，不能整目录覆盖较旧服务器。
- 四款素材与预览在仓库 assets/；第三款预览是原始参考图，其他三款是布局占位图。模板 3 实际生成要求 rembg / onnxruntime / isnet-general-use.onnx；尚未执行真实抠图验证。

后端尚未部署。线上健康接口正常，但 /api/templates 仍返回旧 16 款；SSH 超时。应先备份、核对服务器当前代码，再应用补丁；有冲突需按实际版本合并，不能用本快照整仓替换。

验证记录：17 项模板及 API 检查通过；隔离设备通信生命周期通过（960045 字节 PWE6）；App JavaScript 导出、原生归档、签名及原生模块检查通过。原相册筛选基准的六处既有代码差异未被本次修改，未重跑选片推理。
