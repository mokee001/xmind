# Echoo 项目工作台 · GitHub Pages

Six tabs: 总进度、协作待办、更新与文件、产品灵感池、迭代记录、产品规范。

Owners: 硬件 mokee / 软件 静亚 / 模版 新子。

Planning v2: each owner has an editable current focus with up to three linked tasks.
Each task has an acceptance outcome and milestone; task completion updates workstream,
milestone and overall task-count progress. Initial planning is a suggestion, not live device status.
Existing v1 browser records migrate without replacing customized tasks or owners.
The first save writes a separate v2 key and preserves the original v1 data.

This branch is an isolated static deployment of `demos/project-dashboard/`.
Only the dashboard UI, its seed records, and eight allowlisted document snapshots are published.
There are no photos, model files, credentials, backend services, or local runtime data.

Edits are stored only in this browser's localStorage. They do not sync between devices or members.
Keep using the same browser to retain your changes. Clearing site data removes local changes.
The site does not require login and the initial project content is publicly viewable.
Document snapshots describe their original dates; they are not live status reports.

To preview at a project subpath, serve this directory as `/xmind/` with a static HTTP server.
The local Python version remains separate and continues using its file persistence API.
