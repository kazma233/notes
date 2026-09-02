---
name: agent-model-config
description: 为 pi agent、deepseek harness (dsh)、opencode 配置、查看或切换 LLM 模型与 provider，基于 models.dev API 数据生成各工具官方格式的配置块。用户要求接入新 provider/模型、修改默认模型、查看当前模型配置、生成 models.json / settings.yaml / opencode.json 配置，或提到 models.dev 时使用。
---

# Agent 模型配置

以 models.dev 为唯一数据源，为三个 agent 工具生成符合各自官方格式的模型配置。三个工具都自带模型目录（pi 内置目录、dsh 安装目录、opencode 内置目录）：目录已覆盖的 provider 只需改默认模型选择，不写配置块；只有目录外 provider 或需要覆盖参数时才写文件。

三个工具各自的配置文件位置、字段映射、样例和验证方式披露在 `references/` 下，工具与文件的对应关系：

| 目标工具 | 读取文件 |
|----------|----------|
| pi agent | [references/pi.md](references/pi.md) |
| deepseek harness (dsh) | [references/dsh.md](references/dsh.md) |
| opencode | [references/opencode.md](references/opencode.md) |

确定目标工具后，必须读取对应文件执行，不得凭记忆生成。

## 数据源

models.dev 三个端点，`catalog.json` 同时含 providers 和 models，一次拉全：

```bash
curl -s https://models.dev/catalog.json
```

| 层级 | 字段 | 含义 |
|------|------|------|
| provider | `id` / `name` | provider 标识与显示名 |
| provider | `env` | API key 的环境变量名数组，取 `env[0]` |
| provider | `npm` | AI SDK 包名，用来推断 API 协议 |
| provider | `api` | baseURL，如 `https://api.deepseek.com/v1` |
| provider | `models` | 该 provider 下的模型表 |
| model | `limit.context` / `limit.output` | 上下文窗口 / 最大输出 token |
| model | `cost` | 每百万 token 价格（USD）：`input` / `output` / `cache_read` |
| model | `reasoning` / `reasoning_options` | 是否支持思考，及 effort 档位（如 `["high","max"]`） |
| model | `modalities.input` | 含 `image` 时支持图片输入 |
| model | `interleaved.field` | 思考内容流字段名，如 `reasoning_content` |
| model | `tool_call` / `attachment` | 工具调用 / 附件能力 |

## Workflow

1. **判断任务类型**。查询类（查看当前配置、排查模型可用性）走只读路径：读配置文件、跑工具自带的列出命令（如 `pi --list-models`），只报告事实，不写任何文件。修改类才继续下面步骤。
2. **确认输入**。目标工具（pi / dsh / opencode）、provider id、模型 id、配置范围（全局还是项目级）、provider 连接方式（官方直连 / 代理或网关转发 / 私有或本地自定义）五项都要有确定值，缺一项先问。连接方式必须由用户回答，不能只凭 provider id 是否出现在 catalog 里推断（同一个 id 可能直连也可能走代理）。用户只给模糊需求（如"便宜好用的 coding 模型"）时，用 catalog 按 `family`、`cost`、`tool_call` 筛选出候选推荐，用户选定后继续。
3. **取数**。每次执行都重新 `curl -s https://models.dev/catalog.json` 解析，不得复用本地旧快照（models.dev 每天更新，旧数据会写入过期参数）；不把快照存到技能未定义的位置，如 tool-output 目录。按第 2 步的 provider id 在 catalog 中查找，命中则用其模型表、`env`、`npm`、`api` 作为事实来源。数据缺口按第 2 步的连接方式补齐：私有/本地自定义时向用户要 baseURL、API 协议和模型 id 列表；代理或网关转发时向用户要代理 baseURL，模型列表仍取自 catalog。用户说官方直连但 catalog 找不到该 id 时，先和用户核对 id 拼写或是否实为自定义/代理，不猜测。
4. **判断是否需要写配置**。情形由第 2 步用户回答的连接方式确定，第 3 步的 catalog 命中与否只影响数据来源：

   | 情形 | 例子 | 动作 |
   |------|------|------|
   | 官方直连（目录内 provider） | 换默认模型为目录已有模型 | pi 只写按范围对应的 settings.json 的 `defaultProvider`/`defaultModel`；dsh 只写 `agent-default-model`；opencode 只写顶层 `model` |
   | 代理或网关转发（目录内换 endpoint） | 经网关调用内置模型 | 只写 baseURL 覆盖块，内置模型保留：pi `{"providers": {"<id>": {"baseUrl": "..."}}}`；dsh `llm-pi-ai: providers: <id>: {baseURL: ...}`；opencode `provider.<id>.options.baseURL` |
   | 私有或本地自定义（目录外 provider） | 本地 Ollama/vLLM、私有网关 | 走下面步骤生成完整 provider 配置块 |

5. **生成配置块并展示变更**。读取目标工具对应的 references 文件（见文首分支对照表），按其字段映射生成配置块。每个字段要么来自 models.dev 事实，要么是工具默认值；密钥只写引用，不落明文。向用户展示「改哪个文件 + 完整 diff 预览 + 如何验证」，等待用户二次确认后才动文件。注意展示 diff 时不要把现有密钥的明文值打印出来。
6. **备份后写入**。用户二次确认后：先备份目标文件（同目录加时间戳后缀，如 `settings.json.bak-20260901-1430`），再读现有文件，合并保留原有字段后写入。
7. **验证**。按对应 references 文件的验证方式确认工具实际加载了该模型。验证失败时报告真实错误和备份文件路径（用于回滚），不静默吞掉，也不在未确认时追加修复。

## 通用约定

- 密钥只写引用：pi `"$ENV"`、dsh `apiKeyEnv`、opencode `{env:VAR}` 或 `/connect`。明文 key 永远不进配置文件。
- 不做兜底：请求被网关拒绝时，先暴露真实错误，再按对应工具官方 troubleshooting 加最小必要的 compat 开关。
- 二次确认前不落盘：任何配置写入都以用户对 diff 预览的确认和备份完成为前置。写入后报告「改了哪个文件、备份在哪、如何回滚、如何验证」。
