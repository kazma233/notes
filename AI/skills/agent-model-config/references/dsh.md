# deepseek harness (dsh)

配置文件：全局 `$DSH_HOME/settings.yaml`（默认 `~/.dsh/settings.yaml`）；官方文档未提供项目级 settings，用户要项目级时明确告知仅全局可用。密钥存 `$DSH_HOME/.credentials.yaml` 或环境变量。配置生效无需重启，下一次请求即生效。官方文档：<https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/user/guide/providers.md>，完整字段见同仓库 `docs/config-catalog.md#deepseek-aidsh-llm-pi-ai`。

## 字段映射（models.dev → settings.yaml）

| models.dev | dsh 字段 |
|------------|----------|
| `env[0]` | `apiKeyEnv: ENV` |
| `npm` 推断 | `api`（协议名同 pi） |
| provider `api` | `baseURL` |
| model `id` | `models[].id` |
| `limit.context` / `limit.output` | `contextWindow` / `maxTokens` |
| `modalities.input` 含 image | `input: [text, image]` |
| `reasoning_options` | `reasoningEfforts`，如 `high: high`、`max: max` |

## 样例（自定义路由 + 默认模型）

```yaml
llm-pi-ai:
  providers:
    my-gateway:
      apiKeyEnv: EXAMPLE_API_KEY
      api: openai-completions
      baseURL: https://api.example.com/v1
      models:
        - id: vendor/model-x
          contextWindow: 262144
          maxTokens: 32768

agent-default-model:
  provider: my-gateway
  model: vendor/model-x
```

路由名即 provider id，一旦使用不可改（请求、会话日志都引用它）。

## 验证

重启 dsh 后 Settings → Models 出现该路由且可选中；发起一次请求确认无 `MISSING_CREDENTIAL`/`UNKNOWN_MODEL`。网关拒绝请求时优先加 `compat.supportsDeveloperRole: false` 和 `compat.maxTokensField: max_tokens`。
