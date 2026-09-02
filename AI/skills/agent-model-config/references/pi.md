# pi agent

配置文件（按范围）：

| 范围 | settings.json | models.json |
|------|---------------|-------------|
| 全局 | `~/.pi/agent/settings.json` | `~/.pi/agent/models.json` |
| 项目级 | `.pi/settings.json`（覆盖全局，需项目信任） | 不支持，仅全局 |

官方文档：<https://pi.dev/docs/latest/models>、<https://pi.dev/docs/latest/custom-provider>。

## 字段映射（models.dev → models.json）

| models.dev | pi 字段 |
|------------|---------|
| provider `api` | `baseUrl` |
| `env[0]` | `apiKey: "$ENV"`（支持 `"$ENV"` 或 `"!命令"`） |
| `npm` | `api`：`@ai-sdk/anthropic`→`anthropic-messages`，`@ai-sdk/openai`→`openai-responses`，`@ai-sdk/google-generative-ai`→`google-generative-ai`，其余→`openai-completions` |
| model `id` | `id`（必填，唯一） |
| `limit.context` / `limit.output` | `contextWindow` / `maxTokens` |
| `cost` | `cost: {input, output, cacheRead}`，`cacheWrite` 取 0 |
| `modalities.input` 含 image | `input: ["text","image"]`，否则省略 |
| `reasoning_options` | `thinkingLevelMap`，档位值映射为 `"off": null` 等（不支持档位填 `null`） |

## 最小样例

```json
{
  "providers": {
    "my-gateway": {
      "baseUrl": "https://api.example.com/v1",
      "apiKey": "$EXAMPLE_API_KEY",
      "api": "openai-completions",
      "models": [
        {
          "id": "vendor/model-x",
          "contextWindow": 262144,
          "maxTokens": 32768,
          "reasoning": true,
          "cost": { "input": 0.6, "output": 3, "cacheRead": 0.06, "cacheWrite": 0 }
        }
      ]
    }
  }
}
```

## 默认模型

按范围写入：全局 `~/.pi/agent/settings.json`，项目级 `.pi/settings.json`，键均为 `defaultProvider`、`defaultModel`、`defaultThinkingLevel`（`off`/`minimal`/`low`/`medium`/`high`/`xhigh`/`max`）。

## 验证

`pi --list-models` 出现该模型；交互模式 `/model` 可选中并能发请求。OpenAI 兼容网关被拒时按官方 troubleshooting 加 `compat.supportsDeveloperRole: false`、`compat.maxTokensField: "max_tokens"`，不要预先堆 compat。
