---
name: "css-structure"
description: "Use when the user wants to organize plain CSS without Tailwind, migrate away from Tailwind while keeping its useful constraints, or define practical rules for tokens, base styles, layouts, components, utilities, and spacing in a small-to-medium frontend project."
metadata: 
  inspired: "https://jvns.ca/blog/2026/05/15/moving-away-from-tailwind--and-learning-to-structure-my-css-/"
---

# CSS Structure

Turn ad-hoc CSS into a constrained structure that keeps the useful parts of Tailwind's discipline without depending on utility-heavy markup. Prefer semantic HTML, small component scopes, and a narrow set of shared rules.

## Use this skill for

- Tailwind -> plain CSS migration
- Defining CSS architecture for content sites, docs sites, and small-to-medium product frontends
- Cleaning up mixed Tailwind + handwritten CSS codebases
- Creating practical CSS rules for tokens, layouts, components, and spacing

## Workflow

1. Identify whether the problem is about tokens, base rules, layout, component scope, spacing, utilities, or build setup.
2. Keep global styles minimal. If a rule is not clearly site-wide, do not put it in `base`.
3. Prefer one root class per component and avoid cross-component styling dependencies.
4. Keep utilities rare and generic. If a class expresses product meaning or component meaning, it is not a utility.
5. Put outer spacing under layout/container control instead of scattering margins across children.
6. Prefer `grid`, `flex`, `auto-fit`, and `minmax` before reaching for multiple breakpoints.
7. If the project mixes Tailwind and handwritten CSS, recommend converging on one system instead of leaving long-term dual ownership.

## Output shape

When proposing or implementing CSS organization, default to this split:

- `reset`: browser normalization only
- `tokens`: colors, typography, spacing, radii, shadows, z-index scales
- `base`: small set of truly global element rules
- `layouts`: page/container/stack/grid primitives
- `components`: isolated component styles
- `utilities`: tiny set of generic helpers such as visually-hidden rules

## Decision rules

- If a value repeats, move it into a token.
- If a rule depends on document structure across multiple sections, it is probably layout, not component.
- If a selector needs knowledge of another component's internals, stop and refactor the boundary.
- If spacing is being fixed by local one-off margins, move the concern upward into layout.
- If responsiveness can be solved by intrinsic layout, avoid adding another breakpoint.

## Reference map

- Read `references/article-notes.md` for the distilled ideas from the article and the practical checklist.
