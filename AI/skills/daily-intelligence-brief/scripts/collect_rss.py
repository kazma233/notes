#!/usr/bin/env python3
"""抓取 RSS、Atom 与 OPML 中近 24 小时的文章，并维护来源状态。"""

from __future__ import annotations

import argparse
import calendar
import concurrent.futures
import json
import os
import sys
import tempfile
import urllib.error
import urllib.request
import xml.etree.ElementTree as ET
from dataclasses import dataclass
from datetime import datetime, timedelta
from html.parser import HTMLParser
from pathlib import Path
from zoneinfo import ZoneInfo

try:
    import feedparser
    import yaml
except ImportError:
    sys.exit("缺少依赖：请安装后重试，例如 uv run --with pyyaml --with feedparser python scripts/collect_rss.py ...")

USER_AGENT = "daily-intelligence-brief/1.0"
STATE_DIR_NAME = ".daily-intelligence-brief"
STATE_FILE_NAME = "source-state.json"
FEED_TIMEOUT_SECONDS = 10
ARTICLE_TIMEOUT_SECONDS = 30


@dataclass(frozen=True)
class Source:
    name: str
    url: str
    catalog: str | None = None


class TextExtractor(HTMLParser):
    def __init__(self) -> None:
        super().__init__()
        self.parts: list[str] = []

    def handle_data(self, data: str) -> None:
        self.parts.append(data)

    def text(self) -> str:
        return " ".join(" ".join(self.parts).split())


def local_name(tag: str) -> str:
    return tag.rsplit("}", 1)[-1].lower()


def parsed_time(value: object, zone: ZoneInfo) -> datetime | None:
    if not value:
        return None
    try:
        return datetime.fromtimestamp(calendar.timegm(value), ZoneInfo("UTC")).astimezone(zone)
    except (TypeError, ValueError):
        return None


def request(url: str, timeout: float) -> tuple[int, bytes | None, str | None, dict[str, str]]:
    headers = {"User-Agent": USER_AGENT}
    with urllib.request.urlopen(urllib.request.Request(url, headers=headers), timeout=timeout) as response:
        return response.status, response.read(2_000_000), response.headers.get_content_type(), dict(response.headers.items())


def state_path(config: dict[str, object]) -> Path:
    report_dir = Path(str(config["report_dir"])).expanduser()
    return report_dir / STATE_DIR_NAME / STATE_FILE_NAME


def read_state(path: Path) -> dict[str, dict[str, object]]:
    if not path.exists():
        return {}
    try:
        content = json.loads(path.read_text())
    except (OSError, json.JSONDecodeError) as error:
        raise RuntimeError(f"状态文件不可用：{path} ({type(error).__name__})") from error
    if not isinstance(content, dict):
        raise RuntimeError(f"状态文件格式错误：{path}")
    return content


def write_state(path: Path, state: dict[str, dict[str, object]]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    descriptor, temporary = tempfile.mkstemp(prefix="source-state-", suffix=".json", dir=path.parent)
    try:
        with os.fdopen(descriptor, "w") as file:
            json.dump(state, file, ensure_ascii=False, indent=2, sort_keys=True)
            file.write("\n")
        os.replace(temporary, path)
    except BaseException:
        Path(temporary).unlink(missing_ok=True)
        raise


def parse_opml(payload: bytes, catalog: str) -> list[Source]:
    root = ET.fromstring(payload)
    if local_name(root.tag) != "opml":
        raise ValueError("返回内容不是 OPML")
    sources = []
    for outline in root.iter():
        url = outline.attrib.get("xmlUrl")
        if url:
            sources.append(Source(outline.attrib.get("title") or outline.attrib.get("text") or url, url, catalog))
    return sources


def parse_entries(
    payload: bytes, source: Source, zone: ZoneInfo
) -> tuple[list[dict[str, object]], datetime | None, str | None]:
    feed = feedparser.parse(payload)
    if not feed.version:
        raise ValueError("返回内容不是 RSS 或 Atom")
    result = []
    for entry in feed.entries:
        time_kind = "published" if entry.get("published_parsed") else "updated" if entry.get("updated_parsed") else None
        entry_time = parsed_time(entry.get(f"{time_kind}_parsed") if time_kind else None, zone)
        result.append({
            "source": source.name,
            "source_url": source.url,
            "catalog": source.catalog,
            "title": entry.get("title"),
            "url": entry.get("link"),
            "published_at": entry_time,
            "time_kind": time_kind,
            "feed_summary": entry.get("summary") or entry.get("description"),
        })
    feed_updated = parsed_time(feed.feed.get("updated_parsed") or feed.feed.get("published_parsed"), zone)
    warning = type(feed.bozo_exception).__name__ if feed.bozo else None
    return result, feed_updated, warning


def source_status(
    source: Source,
    prior: dict[str, object],
    zone: ZoneInfo,
    checked_at: datetime,
) -> tuple[list[dict[str, object]], dict[str, object], str | None]:
    try:
        status, payload, _, headers = request(source.url, FEED_TIMEOUT_SECONDS)
        base = {
            "type": "rss",
            "name": source.name,
            "catalog": source.catalog,
            "checked_at": checked_at.isoformat(),
            "http_status": status,
            "etag": headers.get("ETag") or prior.get("etag"),
            "last_modified": headers.get("Last-Modified") or prior.get("last_modified"),
        }
        entries, feed_updated, parse_warning = parse_entries(payload or b"", source, zone)
        if not entries:
            return [], {
                **base,
                "status": "empty",
                "error": None,
                "parse_warning": parse_warning,
                "feed_updated_at": feed_updated.isoformat() if feed_updated else None,
                "time_kind": "feed_updated" if feed_updated else None,
            }, None
        dated_entries = [entry for entry in entries if entry["published_at"] is not None]
        if not dated_entries:
            return [], {
                **base,
                "status": "partial",
                "error": "RSS 条目缺少文章级发布时间",
                "parse_warning": parse_warning,
                "feed_updated_at": feed_updated.isoformat() if feed_updated else None,
                "time_kind": "feed_updated" if feed_updated else None,
            }, "RSS 条目缺少文章级发布时间"
        latest = max(dated_entries, key=lambda entry: entry["published_at"])
        return entries, {
            **base,
            "status": "ok",
            "error": None,
            "parse_warning": parse_warning,
            "latest_entry_at": latest["published_at"].isoformat(),
            "time_kind": latest["time_kind"],
        }, None
    except Exception as error:
        return [], {
            **prior,
            "name": source.name,
            "catalog": source.catalog,
            "checked_at": checked_at.isoformat(),
            "status": "error",
            "error": f"{type(error).__name__}: {str(error)[:180]}",
        }, f"RSS 获取失败：{type(error).__name__}"


def article_body(url: str) -> tuple[str | None, str | None]:
    try:
        status, body, content_type, _ = request(url, ARTICLE_TIMEOUT_SECONDS)
        if status != 200 or "html" not in (content_type or ""):
            return None, f"正文不是 HTML ({content_type or '未知类型'})"
        parser = TextExtractor()
        parser.feed((body or b"").decode("utf-8", errors="replace"))
        text = parser.text()
        return (text, None) if text else (None, "正文为空")
    except Exception as error:  # 单篇正文失败不能阻断其他来源。
        return None, f"正文获取失败：{type(error).__name__}"


def configured_sources(config: dict[str, object]) -> list[Source]:
    return [Source(str(item["name"]), str(item["url"])) for item in config.get("rss_sources", [])]


def opml_sources(config: dict[str, object]) -> tuple[list[Source], list[dict[str, object]]]:
    sources = []
    failures = []
    for catalog in config.get("opml_sources", []):
        try:
            status, payload, _, _ = request(str(catalog["url"]), FEED_TIMEOUT_SECONDS)
            if status != 200:
                raise RuntimeError(f"HTTP {status}")
            sources.extend(parse_opml(payload or b"", str(catalog["name"])))
        except Exception as error:
            failures.append({
                "stage": "opml_catalog",
                "source": str(catalog["name"]),
                "url": str(catalog["url"]),
                "reason": f"OPML 获取或解析失败：{type(error).__name__}",
            })
    return sources, failures


def unique_sources(sources: list[Source]) -> list[Source]:
    unique: dict[str, Source] = {}
    for source in sources:
        unique.setdefault(source.url, source)
    return list(unique.values())


def collect_sources(
    sources: list[Source],
    state: dict[str, dict[str, object]],
    zone: ZoneInfo,
    checked_at: datetime,
    concurrency: int,
    stage: str,
) -> tuple[list[dict[str, object]], list[dict[str, object]], int]:
    entries: list[dict[str, object]] = []
    failures: list[dict[str, object]] = []
    executor = concurrent.futures.ThreadPoolExecutor(max_workers=concurrency)
    futures = {
        executor.submit(source_status, source, state.get(source.url, {}), zone, checked_at): source
        for source in sources
    }
    for future in concurrent.futures.as_completed(futures):
        source = futures[future]
        result, record, error = future.result()
        state[source.url] = record
        if error:
            failures.append({"stage": stage, "source": source.name, "url": source.url, "reason": error})
        entries.extend(result)
    executor.shutdown(wait=True, cancel_futures=True)
    return entries, failures, len(sources)


def parse_window_time(value: str, zone: ZoneInfo, option: str) -> datetime:
    try:
        parsed = datetime.fromisoformat(value)
    except ValueError as error:
        raise ValueError(f"{option} 必须是 ISO 8601 时间") from error
    return parsed.replace(tzinfo=zone) if parsed.tzinfo is None else parsed.astimezone(zone)


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--config", required=True, type=Path)
    parser.add_argument("--start", help="时间窗起点，ISO 8601；未提供时取当前时刻前 24 小时")
    parser.add_argument("--end", help="时间窗终点，ISO 8601；未提供时取运行时刻")
    args = parser.parse_args()
    config = yaml.safe_load(args.config.read_text()) or {}
    zone = ZoneInfo(str(config["timezone"]))
    concurrency = int(config.get("rss_concurrency", 1))
    if concurrency < 1:
        raise ValueError("rss_concurrency 必须大于 0")
    now = datetime.now(zone)
    checked_at = parse_window_time(args.end, zone, "--end") if args.end else now
    start = parse_window_time(args.start, zone, "--start") if args.start else checked_at - timedelta(hours=24)
    if start > checked_at:
        raise ValueError("--start 不能晚于 --end")
    path = state_path(config)
    state = read_state(path)
    failures: list[dict[str, object]] = []
    direct_sources = unique_sources(configured_sources(config))
    direct_entries, direct_failures, direct_processed = collect_sources(
        direct_sources, state, zone, checked_at, concurrency, "direct_rss"
    )
    failures.extend(direct_failures)

    catalog_sources, catalog_failures = opml_sources(config)
    failures.extend(catalog_failures)
    direct_urls = {source.url for source in direct_sources}
    opml_feed_sources = [source for source in unique_sources(catalog_sources) if source.url not in direct_urls]
    opml_entries, opml_failures, opml_processed = collect_sources(
        opml_feed_sources, state, zone, checked_at, concurrency, "opml_rss"
    )
    failures.extend(opml_failures)
    all_entries = direct_entries + opml_entries

    recent = []
    for entry in all_entries:
        published = entry["published_at"]
        if not entry["title"] or not entry["url"] or published is None:
            failures.append({"stage": "rss_entry", "source": entry["source"], "url": entry["source_url"], "reason": "RSS 条目缺少标题、链接或可解析发布时间"})
        elif start <= published <= checked_at:
            entry["published_at"] = published.isoformat()
            recent.append(entry)

    with concurrent.futures.ThreadPoolExecutor(max_workers=concurrency) as executor:
        futures = {executor.submit(article_body, str(entry["url"])): entry for entry in recent}
        for future in concurrent.futures.as_completed(futures):
            entry = futures[future]
            entry["content"], entry["content_error"] = future.result()

    write_state(path, state)
    output = {
        "window": {"start": start.isoformat(), "end": checked_at.isoformat(), "timezone": config["timezone"]},
        "feed_timeout_seconds": FEED_TIMEOUT_SECONDS,
        "article_timeout_seconds": ARTICLE_TIMEOUT_SECONDS,
        "direct_rss": {"configured": len(direct_sources), "processed": direct_processed},
        "opml_rss": {"discovered": len(opml_feed_sources), "processed": opml_processed},
        "items": recent,
        "failures": sorted(failures, key=lambda item: (str(item["source"]), str(item["url"]))),
        "state_file": str(path),
    }
    print(json.dumps(output, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
