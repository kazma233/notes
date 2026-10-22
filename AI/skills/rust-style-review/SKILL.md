---
name: rust-style-review
description: "Review a Rust codebase against the Google Rust Style Guide: separates universally-applicable rules from Google-internal ones (Chrome/Fuchsia-only), runs concrete check commands, and produces a ranked findings report without modifying code. Use when asked to check or align a Rust project against the guide, or to review Rust code style."
metadata:
  source: https://google.github.io/styleguide/rustguide.html
---

# Google Rust 风格指南检查

## 规则清单（普适条款，判断依据）

- **格式化**：rustfmt 默认即指南要求（max_width=100）；`#[rustfmt::skip]` 仅限手工对齐与生成代码。
- **导入**：禁任意 glob（例外：prelude、`use super::*`、enum 方法体内 `use enum::*`）；类型用非限定名（`Regex`），顶层函数调用用模块限定（`mem::transmute`）。
- **引用**：`&T`/`&str`/`&[T]`/`Option<&T>`，不用 `&Box<T>`/`&String`/`&Vec<T>`/`&Option<T>`。
- **panic 策略**：`Option` = 原因明显的简单失败；`Result` = 可恢复、需上下文的外部错误；`panic!` = bug 与不变量违反。panic 时用 `expect("理由")` 不用 `unwrap()`；**测试代码允许 unwrap**。
- **unsafe**：每处附 `// SAFETY: <技术论证>`，写实际安全前提（句柄所有权与释放点、缓冲 NUL 终止与对齐、输出校验、fork/exec 阶段约束），不写复述代码的空话；封装为安全抽象，不让 unsafe 泄漏到业务层。
- **命名**：`as_`（借用）/`to_`（拷贝）/`into_`（消耗）语义正确；扩展 trait 加 `Ext` 后缀；返回 Result 的构造用 `try_new()`；`from_foo()` 配 `From` impl。
- **文档**：`///` 文档化项、`//!` 文档化模块（文件顶部）；公共 API 需文档；无信息量宁可省略。
- **实现**：`.into()`/`.parse()` 与复杂迭代器链的结果写显式类型；`if let` 优先于 check-then-unwrap；`assert!` 带上下文格式串；短组合器链（`.any()`）优于命令式，避免 `Iterator::for_each`；三段以上字符串拼接用 `format!`。
- **类型**：语义不同的量用 newtype 而非 type alias；命名字段优于元组；语义不明的 bool 参数换 enum（`set_xxx(bool)` 这类 setter 除外）。
- **trait**：能 `#[derive]` 不手写；语义匹配标准 trait 时实现标准 trait（如 `FromStr`）而非自定义方法。
- **配套**：`len()` 配 `is_empty()`；`new()` 配 `Default`；重要 `From` 配显式构造方法。
- **并发**：不深入已 poison 的 mutex 内部（poison 时 panic 是可接受处理）；`catch_unwind` 仅限纵深防御（如 worker 线程 panic 转错误事件）。

## 适用性判断（做结论前过滤）

指南相当一部分条款是 Google 内部（google3/Chrome/Fuchsia）约束，对独立项目**不适用**，逐条先分类再下结论，避免提出错误建议：

- Chrome 禁 async/.await、禁 std 启动线程（用内部 sequences）
- 用内部测试框架替代 `#[test]`
- `chromium::import!()`、扁平文件布局（同一 crate 不许子目录）
- `#[non_exhaustive]` / `#[must_use]` 针对「跨团队公共 API」的条款——binary 应用或私有库不适用
- 库代码必须返回迭代器而非 `Vec<T>`、参数必须 `impl IntoIterator`——应用代码放宽为可用 Vec/`&[T]`

灰度条款：避免 `Rc`/`Arc`——框架生态惯例（如 gpui 的 `Rc<dyn Fn>` 回调）属于指南自身的「替代结构过于复杂」豁免，不要报。

## 检查项（自行构造命令定位，读上下文确认）

- **任意 glob 导入**：搜 glob 形式的 `use` 语句，排除例外（prelude、`use super::*`）。
- **不灵活引用**：搜 `&Vec`、`&String`、`&Box` 形态的参数类型。
- **unwrap 分布**：分别数 unwrap 与 expect 的总量；再逐文件区分生产与测试代码（`#[cfg(test)]` 之后的 unwrap 可接受，只报生产侧）。
- **len/is_empty 配套**：定义了 `pub fn len` 的文件是否也有 `is_empty`。
- **指南敏感项存在性**：`catch_unwind`（逐处确认是否纵深防御）、`#[rustfmt::skip]`、`#[must_use]`、`#[non_exhaustive]`。
- **unsafe 的 SAFETY 覆盖**：数 unsafe 块总量，逐处看前几行是否带 SAFETY 论证，按文件统计找缺口集中的文件。
- **bool 函数参数**：搜 bool 参数，setter 除外，确认语义是否由参数名表达清楚。
- **rustfmt 配置**：有无 rustfmt.toml（无配置文件时 rustfmt 默认即符合指南）。

定位结果只是线索；每处发现必须**读上下文**确认是否真违例（如 `lock().unwrap()` 在 poison 时 panic、恰好符合「不深入 poison 数据」；glob prelude 是生态惯例）。

## 报告格式

1. **总体结论先行**（符合度高低一句话），再说明 Google 内部条款的排除口径。
2. **已符合的部分**：简短列出，给检查者信心，也避免重复检查。
3. **建议调整的点**：按值得程度排序，每项附 `文件:行号` 与具体改法；区分「必须改」与「弱建议」。
4. **顺带发现**：非指南范畴的相邻问题（如重复类型定义），只提出不顺手修。

## 边界与提醒

- unsafe 补 SAFETY 注释是最大常见缺口（FFI/PTY/系统调用项目尤甚），每条注释必须对该处 unsafe 成立的前提负责，禁止模板化套话。
- 交叉平台项目在 macOS 上检查 Windows 代码时，交叉 `cargo check` 可能被 native 构建脚本（openssl 等）挡住；退路是 `rustfmt --check --edition 2024 <file>` 做语法级验证，并在报告中标注 unverified。
- 全量测试偶发失败时，先用相同过滤器重跑并对比干净树（git stash），确认 flaky（失败集合不稳定）再排除回归嫌疑。
