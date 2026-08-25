## 提交与 PR 规范

- Git 历史大体遵循 Conventional Commits，例如 `feat:`、`refactor:`、`style:`；推荐格式：`<type>(optional-scope): short summary`
- 保持提交聚焦且可运行；除非强相关，不要把前端和后端的大改混在同一个提交里
- PR 应包含：
  - 改了什么，以及为什么改
  - 关联的 issue 或任务（如果有）
  - API 或 UI 影响说明（有可见 UI 变化时附截图）
  - 本地验证步骤，例如 `go test ./...`、`pnpm build`