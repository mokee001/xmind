# 手机端产品化规划

## 1. 产品目标

将现有 Expo 演示端升级为家庭墨水屏管理 App，形成以下闭环：

1. 注册/登录账号
2. 发现并绑定墨水屏
3. 为设备选择可访问的系统相册
4. 上传并识别照片与人物
5. 由设备管理员决定哪些人物允许展示
6. 生成前预览、调整、确认
7. 推送并查看展示历史
8. 邀请家庭成员共同管理或投稿

> “人物展示/不展示”不是手机系统相册权限，而是产品内部的内容策略权限。系统相册权限只决定 App 能读取哪些照片；人物展示策略决定已读取照片中的哪些人物可以出现在屏幕上。

## 2. 核心对象

### Account（账号）

登录主体，拥有独立身份、会话和个人设置。

- id
- display_name
- email / phone（第一版可选其一）
- avatar_url
- created_at

### Household（家庭空间）

多人共享设备和内容策略的边界。即使第一版只有一个人，也创建默认家庭空间，避免未来迁移。

- id
- name
- owner_account_id
- created_at

### Membership（家庭成员）

账号与家庭空间的关联及权限。

- household_id
- account_id
- role: owner / admin / contributor / viewer
- status: invited / active / removed

### Device（设备）

一台实际墨水屏及其绑定关系。

- id
- serial_number
- name
- household_id
- pairing_code_hash
- loader_host
- orientation
- online_status
- last_seen_at
- firmware_version

### AlbumSource（相册来源）

记录某个账号授权给某个家庭空间/设备的相册范围，不保存 iOS 原始相册权限本身。

- id
- account_id
- household_id
- local_album_id
- local_album_name
- sync_enabled
- last_synced_at

### Photo（照片）

每张照片必须归属上传账号和家庭空间，不能继续全局共享。

- id
- household_id
- uploaded_by
- source_asset_id
- source_album_id
- storage_key
- captured_at
- processing_status
- quality / tags / hash

### Person（人物簇）

家庭空间内的人物聚类结果。

- id（稳定 UUID，不使用会随重聚类变化的 person_1）
- household_id
- display_name
- cover_photo_id
- photo_count
- recognition_status

### PersonPolicy（人物展示策略）

- household_id
- person_id
- visibility: allow / block / review
- configured_by
- updated_at

建议默认 `review`，由管理员确认后才能自动展示；对于没有检测到人脸的照片不受人物策略限制。

### WallDraft / DisplayHistory（草稿与展示历史）

- draft：候选图、选中图、顺序、模板、标题、设备、状态
- history：实际推送版本、推送人、设备、时间、结果、缩略图

## 3. 角色权限

| 能力 | Owner | Admin | Contributor | Viewer |
|---|---:|---:|---:|---:|
| 管理家庭与成员 | 是 | 否 | 否 | 否 |
| 绑定/解绑设备 | 是 | 是 | 否 | 否 |
| 修改人物展示策略 | 是 | 是 | 否 | 否 |
| 选择自己的相册并上传 | 是 | 是 | 是 | 否 |
| 创建草稿与请求推送 | 是 | 是 | 是 | 否 |
| 直接推送到设备 | 是 | 是 | 可配置为需审核 | 否 |
| 查看当前画面与历史 | 是 | 是 | 是 | 是 |

第一版不要做复杂的逐照片 ACL。以家庭空间隔离数据，以角色控制管理动作，以人物策略控制自动展示即可。

## 4. Expo 信息架构

### 未登录流程

1. 欢迎页
2. 登录/注册
3. 创建家庭或接受邀请
4. 绑定设备向导
5. 相册授权向导
6. 人物确认向导

### 登录后底部导航

#### 首页

- 当前绑定设备卡片
- 在线/离线、最后心跳
- 当前展示画面
- 快速“创建新画面”
- 待审核人物/草稿提醒

#### 相册

- 已授权相册列表
- 新增/移除相册来源
- 同步状态、照片数量、失败重试
- 系统 Limited Photos 权限提示

#### 创作/预览

- 选择设备、模板和主题
- AI 推荐候选照片
- 勾选/取消、排序、替换
- 六色墨水屏模拟预览
- 推送或保存草稿

#### 设置

- 家庭成员与邀请
- 账号管理
- 设备管理
- 人物与展示权限（二级页面）
  - 人物卡片、封面、照片数
  - 命名人物
  - 允许展示 / 不展示 / 每次审核
  - 合并误分人物、拆分误合人物（第二阶段）
- 默认显示策略
- 推送审批策略
- 退出登录/注销账号

## 5. 关键用户流程

### A. 设备连接

1. App 在局域网通过 mDNS/Bonjour 发现设备。
2. 用户选择设备，设备屏幕显示一次性配对码或二维码。
3. App 提交配对码，后端签发 device token。
4. 设备归属当前家庭空间。
5. 后续通过 device_id 管理，不再让普通用户手填 IP。

短期兼容当前官方 Loader：保留“手动输入 IP”的开发者入口，由家庭后端代理推送；不要把 Loader IP 当作正式设备身份。

### B. 相册选择与同步

1. 请求系统照片权限。
2. 展示系统相册列表，用户明确勾选要同步的相册。
3. 保存 AlbumSource；按 asset ID 增量同步。
4. 后端异步执行去重、标签与人脸聚类。
5. App 展示同步和识别进度。

### C. 人物展示策略

1. 识别出新人物后状态为 `review`。
2. 管理员在人物页查看封面和若干样例照片。
3. 选择“允许展示”“不展示”或“每次审核”。
4. 自动选图时：
   - 照片包含任一 blocked 人物 → 排除。
   - 照片包含 review 人物 → 只能进入待审核草稿。
   - 全部人物 allow → 可自动展示。
5. 管理员修改策略后，只影响未来选图，不自动删除原始照片。

### D. 预览管理

1. 后端生成 WallDraft，而不是立即上屏。
2. App 展示候选、入选原因和六色预览。
3. 用户可取消、替换、排序和换模板。
4. 确认后生成不可变 DisplayRevision 并推送。
5. 历史页支持重新展示、复制为新草稿和删除记录。

### E. 多账号

1. Owner 创建家庭空间并邀请成员。
2. 被邀请账号加入同一家庭，各自只授权自己的相册。
3. 所有照片记录上传者，但家庭管理员可统一配置人物和设备。
4. Contributor 默认不能直接改变人物策略或设备配置。
5. 成员退出时可选择移除其贡献照片或保留在家庭空间（需在加入时明确授权条款）。

## 6. 后端改造原则

### 必须先做

- 从全局 JSON 迁移到 SQLite（本地产品阶段足够）。
- 所有业务表带 household_id；照片同时带 uploaded_by。
- 增加认证会话，所有管理 API 鉴权。
- DisplayHub 按 device_id 路由，不再全局广播。
- 人物 ID 改为稳定 UUID，重聚类时保留策略映射。
- 图片文件改用不可猜测 storage key，禁止暴露本机绝对路径。

### 建议 API 分组

- `/api/v1/auth/*`：注册、登录、刷新、退出
- `/api/v1/households/*`：家庭与成员邀请
- `/api/v1/devices/*`：发现、配对、状态、推送
- `/api/v1/album-sources/*`：相册来源与同步
- `/api/v1/photos/*`：照片、处理状态、缩略图
- `/api/v1/people/*`：人物、命名、策略
- `/api/v1/drafts/*`：候选、编辑、六色预览、发布
- `/api/v1/display-history/*`：当前画面和历史

现有接口暂时保留在 `/api/*` 作为开发兼容层，新 Expo 端只接 `/api/v1/*`。

## 7. Expo 工程改造

当前单文件 App.js 应拆分为：

```text
src/
  app/                 # 路由与 Provider
  screens/
    onboarding/
    home/
    albums/
    people/
    composer/
    settings/
  components/
  api/                 # typed API client
  auth/                # token/session
  devices/             # discovery/pairing
  media/               # MediaLibrary adapter
  store/               # Zustand 或 React Query cache
  types/
```

建议使用：

- Expo Router：页面与深链路
- TanStack Query：服务端状态、缓存、重试
- expo-secure-store：会话 token
- Zustand：少量本地编辑态（草稿选择/排序）
- expo-image：缩略图缓存
- SQLite 仅用于本地上传队列；账号主数据仍由后端管理

## 8. 实施阶段

### Phase 0：产品与数据底座（1 周）

- 冻结角色、人物策略和成员退出规则
- 设计 SQLite schema 与 API contract
- 保留旧接口兼容

验收：可以创建两个账号、一个家庭、一台设备，数据不串户。

### Phase 1：账号、家庭、设备（1–2 周）

- 登录与会话
- 家庭空间、邀请、角色
- 设备列表、手动 IP 绑定兼容层、在线状态
- Expo Router 基础导航

验收：两个账号按角色访问同一设备；未授权账号不可操作。

### Phase 2：相册来源与同步（1–2 周）

- 相册选择
- 增量上传队列、进度、暂停/重试
- 照片归属与后台识别任务

验收：两个成员分别授权相册，重复照片不重复处理，上传失败可恢复。

### Phase 3：人物审核与权限（1–2 周）

- 人物列表、命名、allow/block/review
- 选图链路强制执行 PersonPolicy
- 新人物待审核通知

验收：被屏蔽人物绝不进入自动展示；待审核人物不会绕过预览直接上屏。

### Phase 4：草稿、预览与发布（1–2 周）

- WallDraft API
- 候选勾选、替换、排序
- 六色预览
- 发布到指定设备
- 历史与重新展示

验收：生成不会立即上屏；只有确认发布后设备画面改变。

### Phase 5：自动化与产品完善（后续）

- 自动更新日程、安静时段
- Contributor 审批流
- 人物误聚类修正
- mDNS/二维码正式配对
- 推送通知、远程访问与云端部署

## 9. 第一版范围建议

第一版必须有：

- 单家庭、多账号、四种角色
- 一至多台设备
- 相册来源选择和增量同步
- 人物 allow/block/review
- 草稿预览后确认推送
- 当前画面与最近历史

第一版暂不做：

- 人脸实名自动识别
- 复杂逐照片共享权限
- 社交动态/评论
- 云端跨家庭共享
- 人物关系图
- 精细排期和规则引擎

这样可以先把隐私、设备和内容管理闭环做正确，再增加自动化。