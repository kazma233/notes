# CSS structure notes

This reference distills the article "Moving away from Tailwind, and learning to structure my CSS" into a practical set of rules.

## Core idea

Do not treat moving away from Tailwind as a rejection of constraints. Keep the useful structure:

- reset
- design tokens
- component isolation
- limited utilities
- layout-owned spacing

The goal is semantic HTML plus CSS that stays easy to reason about.

## Recommended structure

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

## Practical rules

### 1. Reset

- Keep a stable reset or preflight layer.
- Use it to flatten browser differences, not to redefine the whole design system.

### 2. Tokens

- Centralize repeated values as CSS variables.
- Colors, font sizes, line heights, and spacing should not be scattered inline across files.

Example:

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

### 3. Components

- Give each component a root class.
- Keep component styles self-contained.
- Avoid rules that assume another component's internal DOM.

Example:

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

- Keep global element selectors minimal.
- Only put rules here if they are truly valid across the whole site.

Example:

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

### 5. Utilities

- Keep only a very small set of generic helpers.
- If a class carries product meaning, it belongs in a component or layout layer instead.

Example:

```css
.sr-only {
  position: absolute;
  width: 1px;
  height: 1px;
  overflow: hidden;
}
```

### 6. Spacing

- Let outer layout control vertical rhythm between blocks.
- Let components control only their own internal spacing.
- Do not patch spacing with one-off margins everywhere.

Example:

```css
.section > * + * {
  margin-top: var(--space-4);
}
```

### 7. Layout

- Separate layout primitives from business components.
- Reuse container, stack, cluster, and grid patterns.

Example:

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

### 8. Responsive behavior

- Prefer intrinsic layouts first.
- Use media queries as a complement, not as the default design primitive.

### 9. Build setup

- Keep development workflow simple.
- Use native CSS features when possible.
- Bundle for production if needed, but do not force a heavy CSS pipeline just to keep styles organized.

Example:

```css
@import "./reset.css";
@import "./tokens/colors.css";
@import "./tokens/typography.css";
@import "./base.css";
@import "./utilities.css";
@import "./layouts/section.css";
@import "./components/card.css";
```

## Migration checklist

- Keep or replace reset first.
- Extract repeated values into tokens.
- Group handwritten CSS by component boundaries.
- Move cross-section spacing rules into layout classes.
- Shrink utility usage to a deliberate small set.
- Replace breakpoint-heavy layouts with grid/flex patterns where possible.
- Stop growing a mixed Tailwind + plain CSS system unless the mix is intentionally temporary.

