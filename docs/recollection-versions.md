# 回忆精选版本记录

## recollections-v1.0.0 · 2026-09-09

用户确认保留的基准版本：8 个精选集统一展示，推荐内容排在前面，不区分「更多回忆」。每组 13～24 张。选片结果快照：`30a3c41466d0e8680374615a`。

本地版本目录：`outputs/recollection-versions/recollections-v1.0.0/`。

- `site/`：冻结的局域网预览页面、展示顺序、相册成员、封面、照片预览。无需原图、模型或原服务即可重新提供浏览和播放。
- `result.json`：完整结果、规则、模型标识和当时本地偏好记录。分享页顺序取自冻结时的局域网服务，因此与后续观看记录无关。
- `source/`：当时的页面、选片模块和相关后端源码副本，供后续代码回退时提取、比较；后端副本为依赖参考，不应整目录覆盖到共享工作区。
- `inputs.tar.gz`：本批特征缓存、Ente 识别证据、历史过滤输入、回忆快照和运行配置。模型权重与全尺寸原图不重复备份；重新计算仍需要原有模型环境及原图。
- `manifest.json`：版本号、数据集、结果编号、模型指纹、Git 基础提交及所有文件的 SHA-256 校验值。

这是包含未提交代码的**本地版本存档**，不是指向旧 Git 提交的标签。照片和缓存继续留在 Git 忽略目录中；合并代码时需单独保存版本目录。

### 校验

```sh
python3 tools/recollection_versions.py verify recollections-v1.0.0
```

### 回看这一版

```sh
python3 tools/recollection_versions.py serve recollections-v1.0.0 --port 8870
```

打开 `http://127.0.0.1:8870/recollections`。局域网可追加 `--host 本机局域网IP`。当前已启动的存档地址为 `http://10.23.53.163:8870/recollections`，IP 变化时需重启服务。

此入口验证文件后直接读取存档，避免重新评分或覆盖现有代码。若需把筛选算法也切回这一版，应从 `source/` 提取相应模块及依赖，在独立分支检查差异、回放验证后集成；不要直接覆盖同时进行的 App 或固件工作。

### 保存下一版

```sh
python3 tools/recollection_versions.py freeze recollections-v1.1.0 --url http://本机局域网IP:8769
```

同版本号不可覆盖。创建时验证预览成员与本地结果一致、主规则代码与快照指纹匹配，并保存页面和图片副本。
