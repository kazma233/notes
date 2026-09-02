# opencode

配置文件（按范围，JSON/JSONC，按序合并、后者覆盖同键）：

| 范围 | 位置 |
|------|------|
| 全局 | `~/.config/opencode/opencode.json` |
| 项目级 | 项目根目录 `opencode.json`（覆盖全局同键，可进 git） |

密钥用 `/connect` 存 `~/.local/share/opencode/auth.json`，或 `options.apiKey: "{env:VAR}"`。官方文档：<https://opencode.ai/docs/config/>、<https://opencode.ai/docs/providers/>，完整 schema：<https://opencode.ai/config.json>。

## 字段映射（models.dev → opencode.json）

| models.dev | opencode 字段 |
|------------|---------------|
| `npm` | `npm`（原样使用） |
| provider `api` | `options.baseURL` |
| `env[0]` | `/connect` 输入 key，或 `options.apiKey: "{env:VAR}"` |
| model `id` | `models` 的 key |
| 显示名 | `name` |
| `limit.context` / `limit.output` | `limit: {context, output}` |
| `reasoning` | `reasoning` |
| `interleaved.field` | `interleaved: {field: "reasoning_content"}` |

## 样例

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "provider": {
    "my-gateway": {
      "npm": "@ai-sdk/openai-compatible",
      "name": "Example Gateway",
      "options": {
        "baseURL": "https://api.example.com/v1"
      },
      "models": {
        "vendor/model-x": {
          "name": "Model X",
          "limit": { "context": 262144, "output": 32768 },
          "reasoning": true,
          "interleaved": { "field": "reasoning_content" }
        }
      }
    }
  },
  "model": "my-gateway/vendor/model-x"
}
```

已内置的 provider（75+ 个，均来自 models.dev）不用写 `provider` 块，`/connect` 存 key 后直接 `/models` 选择，或写顶层 `"model": "provider/model-id"` 固定默认。

## 验证

`opencode debug config` 查看解析后配置，`/models` 中该模型可选中且能发请求。
