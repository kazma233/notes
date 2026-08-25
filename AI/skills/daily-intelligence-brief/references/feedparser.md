# feedparser 采集依据

仅用于 `scripts/collect_rss.py` 的 RSS/Atom 解析判断。本文依据 feedparser 6.0.14 官方文档；升级依赖后需要重新核对。

## 解析入口

- `feedparser.parse()` 是唯一的主要公开入口，可接收远程 URL、本地文件名或内存中的原始 feed 数据；采集器自行完成 HTTP 超时、条件请求和重试时，应把响应原始字节传给它解析，而不要自行按 XML 节点解析 RSS/Atom。
  - 官方来源：[Introduction](https://feedparser.readthedocs.io/en/latest/introduction/)
- `entries` 始终存在，是按原 feed 顺序排列的字典列表；空列表表示合法的空 feed，记录为 `empty`，不是请求或解析失败。
  - 官方来源：[entries](https://feedparser.readthedocs.io/en/latest/reference-entry/)
- `version` 始终存在；未知格式时为 `""`。没有条目且 `version == ""` 时可判为非 RSS/Atom 内容；不要以 XML 根节点字符串猜测格式。
  - 官方来源：[version](https://feedparser.readthedocs.io/en/latest/reference-version/)

## 条目字段与时间窗

- 使用 `entry.get("title")` 取标题。标题可能包含 HTML/XHTML，feedparser 默认会净化其中的 HTML；空标题仍不满足日报条目要求。
  - 官方来源：[entries[i].title](https://feedparser.readthedocs.io/en/latest/reference-entry-title/)
- 使用 `entry.get("link")` 取主链接。它已兼容 Atom alternate link、RSS `<link>`，以及没有 `<link>` 时可作为链接的 RSS `guid`；相对链接会被自动解析。
  - 官方来源：[entries[i].link](https://feedparser.readthedocs.io/en/latest/reference-entry-link/)、[Relative Link Resolution](https://feedparser.readthedocs.io/en/latest/resolving-relative-links/)
- 时间判断优先读取 `published_parsed`，缺失时读取 `updated_parsed`，并在状态中标记 `published` 或 `updated`，不可把后者称为发布时间。二者是 UTC 的 Python 9 元组；用 `calendar.timegm()` 转为 UTC 时间戳后再转入配置时区。
  - 官方来源：[Date Parsing](https://feedparser.readthedocs.io/en/latest/date-parsing/)、[published_parsed](https://feedparser.readthedocs.io/en/latest/reference-entry-published_parsed/)、[updated_parsed](https://feedparser.readthedocs.io/en/latest/reference-entry-updated_parsed/)
- `published` / `updated` 的原始字符串可用于报告展示或排障，但时间窗必须基于对应的 `*_parsed`。当 `*_parsed` 不存在时，保留原始值并标记“发布时间无法解析”，不要猜测时区或日期。
  - 官方来源：[published](https://feedparser.readthedocs.io/en/latest/reference-entry-published/)、[updated](https://feedparser.readthedocs.io/en/latest/reference-entry-updated/)、[Date Parsing](https://feedparser.readthedocs.io/en/latest/date-parsing/)

```python
import calendar
from datetime import datetime, timezone

def entry_time(entry):
    for kind in ("published", "updated"):
        parsed = entry.get(f"{kind}_parsed")
        if parsed:
            return datetime.fromtimestamp(calendar.timegm(parsed), timezone.utc), kind
    return None, None

feed = feedparser.parse(response_body)
for entry in feed.entries:
    title = entry.get("title")
    link = entry.get("link")
    occurred_at, time_kind = entry_time(entry)
```

## `bozo`、编码与降级

- `bozo == 1` 表示 feed 非良构 XML；`bozo_exception` 仅在 `bozo == 1` 时存在。feedparser 会尝试解析非良构 XML，因此 `bozo` 是质量告警，不等于没有可用条目。
  - 官方来源：[Bozo Detection](https://feedparser.readthedocs.io/en/latest/bozo/)、[bozo](https://feedparser.readthedocs.io/en/latest/reference-bozo/)、[bozo_exception](https://feedparser.readthedocs.io/en/latest/reference-bozo_exception/)
- 因错误编码声明导致的 `bozo`，feedparser 会继续尝试 XML 声明、BOM、安装了 `chardet` 时的探测、UTF-8 和 Windows-1252。成功恢复后仍可能有可用条目；状态应记录 `bozo_exception`，并按标题、链接和可解析时间逐条决定是否纳入。
  - 官方来源：[Character Encoding Detection](https://feedparser.readthedocs.io/en/latest/character-encoding/)
- 只有当 feed 不能识别（`version == ""`）、没有符合日报字段的条目，或条目自身缺少必需字段时才过滤。不要因 `bozo` 直接把整源判为失败。

## 链接与安全边界

- feedparser 按 XML Base 规则解析相对 URI；没有 `xml:base` 时，取回 feed 的 URL 是默认基准，HTTP 重定向后使用最终 URL。
  - 官方来源：[Relative Link Resolution](https://feedparser.readthedocs.io/en/latest/resolving-relative-links/)
- 将 `entry.link` 作为待核验 URL，仍须用正文抓取器打开原文。不要把 feed 的 `summary`、标题或搜索摘要当作事实正文。

