---
name: daily-intelligence-brief
description: 基于 RSS、指定站点和中英文话题探索生成带来源、评分与总述的个人情报日报。用户要求汇总某个时间段的订阅、网站栏目、站内文章或关注话题时使用。
---

# 每日情报日报

根据 `references/config.yaml` 生成写入 `report_dir` 的 Markdown 日报。默认时间窗是运行时刻向前 24 小时，时间解释和展示使用配置中的 `timezone`。

## 运行前

1. 完整读取 `references/config.yaml` 和 [references/collection-rules.md](references/collection-rules.md)。配置是来源、范围、并发和输出位置的唯一来源；运行状态只写入 `<report_dir>/.daily-intelligence-brief/source-state.json`。
2. 计算时间窗。用户提供时间范围时优先采用；未带时区的时间按配置时区解释。
3. 按配置的非空分支读取规则：有 RSS 或 OPML 时读取 [references/feedparser.md](references/feedparser.md)；有 `site_sources` 时读取 [references/site-source.md](references/site-source.md)。生成内容前完整读取 [references/content-rules.md](references/content-rules.md)，写报告和交付检查前完整读取 [references/report-format.md](references/report-format.md)。
4. 所有 RSS、OPML、指定站点和 `topics` 都为空时，说明缺少的配置后停止。

## 运行手册

### 1. 采集候选

- RSS 与 OPML：运行 `uv run --with pyyaml --with feedparser python scripts/collect_rss.py --config references/config.yaml`。用户指定时间窗时传入 `--start <ISO 8601>` 和可选的 `--end <ISO 8601>`。采集器先处理直接 RSS，再展开并去重 OPML 的 `xmlUrl`，所有抓取共享 `rss_concurrency`。
- 指定站点：从配置入口、可见列表、分页、站内搜索和声明的 sitemap 在浏览器中发现候选。站点 URL 是发现入口，不是 RSS 地址或文章 URL 模板；范围、发布时间和状态按 `site-source.md` 判断。
- 主题探索：为每个 `direction` 推导中英文查询词，在浏览器中搜索、打开候选页并确认文章级发布时间。记录每个方向的查询次数、正文打开数、纳入数和失败原因。

### 2. 核验候选

按 `collection-rules.md` 的候选生命周期处理三类候选。正文可读、发布时间可确认且落在时间窗内的条目进入统一内容池；其余条目逐项记录过滤原因。质量评分只影响排序、总结和推荐阅读，不影响是否进入内容池。禁止以标题、摘要、搜索摘要或模型常识补写事实。

### 3. 合并内容池

按链接、规范化标题和同一事件去重。三类来源按相关性混排；同一事件可以合并为一项，但保留每个实际来源的独立 `ref`。正文不可读的条目不进入内容池。

### 4. 写日报

按 `content-rules.md` 为每个最终条目生成中文总结、评分、评分理由和来源。再仅依据最终条目生成日报总述，并精选 0-3 篇推荐阅读。按 `report-format.md` 写入以运行日期命名的 Markdown 文件；没有合格内容时仍生成报告。

### 5. 交付检查

完成前逐一核对时间窗内的 RSS 和指定站点候选：每条要么进入“内容”，要么在“异常与过滤”中有明确原因。每个探索纳入条目都必须使用真实 `direction` 的 `探索主题` ref，且正文已在浏览器中读取。来源状态、采集汇总和底部异常区必须与本次执行一致。
