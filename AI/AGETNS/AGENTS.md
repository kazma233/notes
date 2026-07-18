## 文档与上下文

- 项目长期有效的规范、架构约束、稳定业务规则放 `{project}/AGENTS.md`。
- 项目开发沉淀放 `{project}/aidocs/`，可按用途拆分：
  - `context/`：需求口径、排障记录、联调约束、临时决策、tradeoff
  - `decisions/`：阶段性技术决策、方案取舍
  - `runbooks/`：可复用的排查、修复、发布、回滚步骤
  - `archive/`：已失效或已替代的文档
- 归档原则：长期稳定且可复用的内容写 `{project}/AGENTS.md`；过程性、阶段性内容写 `{project}/aidocs`。
- 开发过程中产生新的约束、背景、结论或取舍时，同步补充文档；纯机械修改、不产生新信息时不强制写文档。
- 可将 `context/`、`decisions/` 中稳定且反复复用的内容提炼到 `AGENTS.md` 或 `runbooks/`；失效内容移入 `archive/`，并注明替代文档或失效原因。
- 最外层的 `AGENTS.md` 是所有项目的知识，仅对所有项目生效的内容才写入到里面
