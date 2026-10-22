# CSS 结构笔记

本文把《Moving away from Tailwind, and learning to structure my CSS》一文提炼成一组可操作的规则。

## 核心思想

离开 Tailwind 不等于抛弃约束。保留有用的结构：

- reset
- 设计 token
- 组件隔离
- 受限的工具类
- 由布局拥有的间距

目标是语义化 HTML 加上始终容易推理的 CSS。

## 推荐结构

```txt
styles/
  index.css
  reset.css
  base.css
  utilities.css
  tokens/
    colors.css
    typography.css
    spacing.css
  layouts/
    section.css
    grid.css
  components/
    button.css
    card.css
    article-list.css
```

## 实操规则

### 1. Reset

- 保留一层稳定的 reset 或 preflight。
- 用它抹平浏览器差异，而不是重新定义整个设计系统。

### 2. Token

- 把重复的值集中为 CSS 变量。
- 颜色、字号、行高和间距不应以内联形式散落在各个文件里。

示例：

```css
:root {
  --color-text: #1f2937;
  --color-link: #d96a1d;
  --color-accent: #f91a55;

  --size-sm: 0.875rem;
  --size-md: 1rem;
  --size-lg: 1.125rem;

  --space-2: 0.5rem;
  --space-4: 1rem;
  --space-6: 1.5rem;
}
```

### 3. 组件

- 每个组件给一个根类。
- 组件样式自包含。
- 避免假定另一个组件内部 DOM 的规则。

示例：

```css
.card {
  padding: var(--space-4);
  border: 1px solid var(--color-text);
}

.card.featured {
  border-color: var(--color-accent);
}
```

### 4. Base

- 全局元素选择器保持最少。
- 只有真正全站有效的规则才放这里。

示例：

```css
html {
  line-height: 1.5;
}

body {
  color: var(--color-text);
}

a {
  color: var(--color-link);
}
```

### 5. 工具类

- 只保留极少量通用辅助类。
- 一个类若带有产品含义，它应该属于组件层或布局层。

示例：

```css
.sr-only {
  position: absolute;
  width: 1px;
  height: 1px;
  overflow: hidden;
}
```

### 6. 间距

- 让外层布局控制区块之间的纵向节奏。
- 组件只控制自己内部的间距。
- 不要到处用一次性 margin 修补间距。

示例：

```css
.section > * + * {
  margin-top: var(--space-4);
}
```

### 7. 布局

- 把布局原语与业务组件分开。
- 复用 container、stack、cluster、grid 这些模式。

示例：

```css
.section {
  --inner-width: 960px;
  padding: 3rem max(1rem, (100% - var(--inner-width)) / 2);
}

.grid-auto {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(min(100%, 24rem), 1fr));
  gap: var(--space-4);
}
```

### 8. 响应式

- 优先固有布局。
- 媒体查询是补充手段，不是默认的设计原语。

### 9. 构建配置

- 开发流程保持简单。
- 尽量使用原生 CSS 特性。
- 需要时为生产环境打包，但不要为了组织样式就强上一套重型 CSS 流水线。

示例：

```css
@import "./reset.css";
@import "./tokens/colors.css";
@import "./tokens/typography.css";
@import "./base.css";
@import "./utilities.css";
@import "./layouts/section.css";
@import "./components/card.css";
```

## 迁移清单

- 先保留或替换 reset。
- 把重复值抽成 token。
- 按组件边界归组手写 CSS。
- 把跨区块的间距规则移入布局类。
- 把工具类用量收缩到一组刻意选定的小集合。
- 尽可能用 grid/flex 模式替换依赖大量断点的布局。
- 除非混用是有意的过渡，否则停止扩大 Tailwind + 原生 CSS 的混合系统。
