---
name: staletip
description: Local relay lab for BIP332 stale-tip propagation on real bitcoind nodes.
colors:
  accent: "#0969da"
  accent-wash: "#eef5fe"
  accent-line: "#b6d4f7"
  amber: "#d9920b"
  amber-text: "#9a6700"
  amber-pale: "#f3d9a0"
  amber-wash: "#fff8e6"
  gray-block: "#dde0e4"
  gray-line: "#aeb3ba"
  ink: "#16181d"
  ink-hover: "#2b2e35"
  text: "#30343b"
  muted: "#646a74"
  faint: "#8b919a"
  canvas: "#f6f7f9"
  sidebar: "#fbfbfc"
  paper: "#ffffff"
  line: "#e6e8eb"
  line-soft: "#eff1f3"
  hover: "#f1f2f4"
  green: "#1a7f37"
  green-wash: "#e9f6ec"
  red: "#cf222e"
  red-wash: "#ffebe9"
typography:
  headline:
    fontFamily: "Inter, -apple-system, BlinkMacSystemFont, Segoe UI, sans-serif"
    fontSize: "20px"
    fontWeight: 600
    lineHeight: "28px"
    letterSpacing: "-0.015em"
    fontFeature: "\"cv11\", \"ss01\""
  title:
    fontFamily: "Inter, -apple-system, BlinkMacSystemFont, Segoe UI, sans-serif"
    fontSize: "15px"
    fontWeight: 600
    lineHeight: "20px"
    letterSpacing: "-0.005em"
  body:
    fontFamily: "Inter, -apple-system, BlinkMacSystemFont, Segoe UI, sans-serif"
    fontSize: "13px"
    fontWeight: 400
    lineHeight: 1.55
  label:
    fontFamily: "Inter, -apple-system, BlinkMacSystemFont, Segoe UI, sans-serif"
    fontSize: "12px"
    fontWeight: 500
    lineHeight: "16px"
  mono:
    fontFamily: "Geist Mono, ui-monospace, SFMono-Regular, Menlo, Consolas, monospace"
    fontSize: "12px"
    fontWeight: 400
    fontFeature: "\"tnum\""
rounded:
  xs: "2px"
  sm: "4px"
  md: "6px"
  lg: "8px"
  panel: "10px"
  dialog: "12px"
  pill: "11px"
spacing:
  xs: "4px"
  sm: "8px"
  md: "12px"
  lg: "16px"
  xl: "20px"
  xxl: "24px"
components:
  button:
    backgroundColor: "{colors.paper}"
    textColor: "{colors.ink}"
    rounded: "{rounded.md}"
    padding: "0 12px"
    height: "32px"
  button-hover:
    backgroundColor: "{colors.hover}"
  button-primary:
    backgroundColor: "{colors.ink}"
    textColor: "{colors.paper}"
    rounded: "{rounded.md}"
    padding: "0 12px"
    height: "32px"
  button-primary-hover:
    backgroundColor: "{colors.ink-hover}"
  button-small:
    height: "28px"
    padding: "0 10px"
  link-button:
    textColor: "{colors.accent}"
  panel:
    backgroundColor: "{colors.paper}"
    rounded: "{rounded.panel}"
  panel-header:
    padding: "0 20px"
    height: "52px"
  search-field:
    backgroundColor: "{colors.paper}"
    textColor: "{colors.ink}"
    rounded: "{rounded.md}"
    padding: "0 10px"
    height: "30px"
  filter-token:
    backgroundColor: "{colors.accent-wash}"
    textColor: "{colors.accent}"
    rounded: "{rounded.md}"
    padding: "0 6px 0 10px"
    height: "30px"
  tag:
    backgroundColor: "{colors.hover}"
    textColor: "{colors.text}"
    typography: "{typography.mono}"
    rounded: "{rounded.sm}"
    padding: "0 6px"
    height: "20px"
  tag-staletip:
    backgroundColor: "{colors.amber-wash}"
    textColor: "{colors.amber-text}"
  tag-error:
    backgroundColor: "{colors.red-wash}"
    textColor: "{colors.red}"
  badge:
    backgroundColor: "{colors.hover}"
    textColor: "{colors.muted}"
    rounded: "{rounded.pill}"
    padding: "0 8px"
    height: "22px"
  event-row-selected:
    backgroundColor: "{colors.accent-wash}"
  block-active:
    backgroundColor: "{colors.ink}"
    textColor: "{colors.paper}"
    rounded: "{rounded.sm}"
    height: "26px"
  block-staletip:
    backgroundColor: "{colors.amber}"
    textColor: "{colors.ink}"
    rounded: "{rounded.sm}"
    height: "26px"
---

# Design System: staletip

## Overview

**Creative North Star: "The Captured Record"**

staletip is a category-standard developer tool held to the Linear, Vercel dashboard and GitHub bar. It does not invent a visual world. White panels sit on a cool gray canvas beside a near-white sidebar, ink-dark type carries the hierarchy, and colour appears only where it means something: blue for what you selected or are linking, amber and gray for block states, green and red for health and failure.

The workspace is dense and meant to be read closely (Operate mode). The structure is one top bar, one sidebar, and a column of panels. Inside a panel, regions are divided by hairlines and not boxed again. Monospace is reserved for data that really is machine data. It is never used as decoration.

**Key Characteristics:**
- Flat, hairline-divided panels on a tonal canvas. No decorative shadow.
- A single blue accent. Amber and gray belong to the block trees.
- Inter for every label. Geist Mono only for hashes, heights, times and byte counts.
- Sentence case throughout. No eyebrows, kicker labels or hero-metric strips.
- One stroke icon set (16px, 1.5px stroke, round caps).

## Colors

The palette is neutral and cool, with one blue voice and a reserved state vocabulary.

### Primary
- **GitHub Blue** (accent): the only interactive accent. It marks selection (selected event row, linked knowledge row, topology link), the focus ring, link buttons, the active filter token, the ruler mark, and cross-panel linking (linked block ring, linked trace label). Accent Wash and Accent Line are its fills and borders.

### Secondary (block states)
- **Stale Amber** (amber): a stale block learned via staletip, its edge, and the packet animation on the network map. It also fills the staletip cost bars. Amber Text is the readable foreground on Amber Wash (staletip tag, offline pill, notice, job bar).
- **Neutral Gray** (gray-block, gray-line): the neutral edge between topology nodes and the fallback trace bar. Reorganized blocks have no gray state of their own.

### Neutral
- **Ink** (ink): primary text, active-chain blocks and edges, the primary button, toasts, and the selected block ring.
- **Text / Muted / Faint**: body copy, secondary labels and meta, then the quietest glyphs (separators, idle dots).
- **Canvas / Sidebar / Paper**: the page ground, the sidebar ground, and panel surfaces.
- **Line / Line Soft / Hover**: panel borders and section dividers, row dividers and grid lines, and hover fills.

### Status
- **Green** (green, green-wash): a running node, a live connection, the running miner.
- **Red** (red, red-wash): invalid blocks, error tags, destructive text buttons, error toasts and bars.

### Named Rules
**The One Accent Rule.** Blue #0969DA is only for selection, focus, links and linking. It never decorates and never encodes a block state.

**The Block-Tree Language Rule (user-set, verbatim from PRODUCT.md).** "Active chain solid ink; stale block learned via staletip is a solid orange line and solid orange block; header only is a solid orange line with an orange-striped block; a block that was reorganized away is drawn by what the node holds now (orange when it has the full block); blocks a node does not know are not drawn." The stripe is 45 degrees, #e7b556 on Amber Wash, outlined in Amber. Every swatch, legend, tag and waterfall bar that refers to a block state uses the same mapping.

**The Reserved Amber Rule.** Amber and the light grays outside the neutral ramp carry block state and staletip meaning only. They are never used as a generic highlight.

## Typography

**Body Font:** Inter (fallback -apple-system, BlinkMacSystemFont, Segoe UI, sans-serif), with cv11 and ss01 enabled
**Mono Font:** Geist Mono (fallback ui-monospace, SFMono-Regular, Menlo, Consolas, monospace), with tabular figures

**Character:** a neutral, precise grotesk for everything a person reads, and a tabular mono for everything a machine wrote.

**Known limit:** neither face is self-hosted, because the CSP and no-dependency constraints mean nothing is fetched. They render only where they are installed locally. Everywhere else the system sans and mono fallbacks render, so layouts must hold at fallback metrics.

### Hierarchy
- **Headline** (600, 20px/28px, -0.015em): the page title and the welcome title.
- **Title** (600, 15px/20px): panel headers. Sub-titles are 13px/18px at weight 600, and dialog titles are 16px.
- **Body** (400, 13px, 1.55): rows, detail text, buttons (500), and controls. The root size is 14px.
- **Label** (500 or 400, 12px): table headers, meta, captions, legends and help text. Some secondary lines are 11px.
- **Mono** (12px, sometimes 11px in SVG, tags and rulers): hashes, block heights, timestamps, durations and byte sizes only.

### Named Rules
**The Real-Data Mono Rule.** Geist Mono is only for hashes, heights, times and bytes. Labels, headings, buttons and prose are always Inter.

**The Sentence Case Rule.** Every label, heading, button and tag phrase is in sentence case. There are no uppercase eyebrows, no kicker labels above headings, and no hero-metric strips. Facts sit inline in the status line or in panel stats.

## Layout

The app shell is a sticky 48px top bar over a two-column grid: a 232px sticky sidebar and a fluid main column with 24px side padding. Panels stack in the main column with 16px gaps. The block trees and the detail panel share a row (fluid plus 344px). Inside a panel, the header row is 52px with 20px padding, and content uses the same 20px inset. The spacing rhythm is 4/8/12/16/20/24.

The status line under the title is a single row of inline facts separated by hairline left borders, with 12px padding between them.

Breakpoints:
- **1200px**: the sidebar shrinks to 208px, the detail column to 300px, and main padding to 20px. The table columns tighten, panel captions wrap to a full-width second line, and the mode-cost block stacks.
- **900px**: the trees and the detail panel stack, the search field flexes, and the session crumb hides. The welcome stacks and centres.
- **650px**: the sidebar becomes a horizontal node strip above the content and its footer hides. Header buttons, panel stats, trace byte columns and table headers hide. Event rows reflow to a 3-column grid with the description on its own line. Mobile action buttons appear. Insets drop to 16px.

## Elevation & Depth

The system is flat. Depth comes from tonal layering (canvas, sidebar, paper) and 1px hairlines, not from shadows. Only two elements sit above the page: the dialog and toasts.

### Shadow Vocabulary
- **Dialog lift** (`box-shadow: 0 16px 40px -12px #16181d40`, backdrop `#16181d40`): modal dialogs only.
- **Focus halo** (`box-shadow: 0 0 0 3px var(--accent-wash)`, with an accent border): search, select and form fields on focus.

### Named Rules
**The Hairline Rule.** Regions inside a panel are separated by 1px Line or Line Soft rules. A panel is never nested inside another panel.

## Shapes

Corners are gently rounded, and the radius steps up with container size: 2px for swatches and waterfall bars, 4px for tags, keycaps and blocks, 6px for buttons, fields, the segmented control and pre blocks, 8px for toasts and network node boxes, 10px for panels, and 12px for the dialog. Pills (badges, the live status) are fully rounded. Blocks are 26px-tall rounded rectangles, at least 52px wide and sized to the longest height label with 12px side padding, with a 34px ring (7px radius) that carries the hover, selected, linked and focus states.

## Components

### Buttons
- **Shape:** 6px radius, 32px tall (28px small), 13px/500 label, 1px Line border on Paper.
- **Primary:** an Ink fill with white text, used once per region (Create fork, Apply). Hover goes to Ink Hover. It can carry a translucent kbd hint.
- **Hover / Focus / Active:** a Hover fill on fine pointers only. Focus is a 2px accent outline with a 2px offset. Pressing scales to 0.97 over 120ms. Disabled is 45% opacity.
- **Quiet / Icon / Text / Link:** quiet buttons have a transparent border and fill. Icon buttons are 28px square. Text buttons underline on hover, in red when destructive. Link buttons are Accent.

### Chips
- **Tags:** 20px, 4px radius, mono 11px/500. They are neutral by default, Amber Wash with Amber Text for staletip, gray for reorg, and Red Wash for error.
- **Badges and live pill:** 22-24px fully rounded pills with a 6px currentColor dot, coloured green, amber or red by state.
- **Filter token:** a removable block filter in Accent Wash with an Accent Line border and Accent text (hash in mono), plus a close icon. Its border goes to full Accent on hover.

### Cards / Containers
- **Panel:** Paper, 1px Line border, 10px radius, no shadow, 20px inset. The panel header holds the title, then muted meta, then a right-aligned control, stats or caption.

### Inputs / Fields
- **Style:** 30px (toolbar) or 34px (dialog) tall, 1px Line border, 6px radius, 13px text, muted placeholder.
- **Focus:** an Accent border plus a 3px Accent Wash halo. On hover the border is #d3d6db.

### Navigation
- **Top bar:** a brand mark plus "staletip", then a chevron breadcrumb (network, then the muted session name), with the live pill and Export on the right.
- **Sidebar:** node rows (6px status dot, name, muted mode, mono height) at 13px. Hover uses the Hover fill and selection uses #eceef1. Lab links and the footer prose sit below. Danger actions are red text buttons.

### Block trees (signature)
One aligned SVG tree per node, sharing a mono height ruler with an accent mark. A sticky, opaque label column (node name and mode) stays pinned while the trees scroll horizontally. Blocks and edges follow the Block-Tree Language Rule. The legend below the trees states "Unknown blocks are not drawn".

### Detail panel
A 344px column of metric rows (muted label on the left, value on the right, mono for data), section heads, a mono hash box, a knowledge list (swatch, node, text, mono time; linked rows in Accent Wash), and a row of action buttons.

### Propagation waterfall and mode cost
Rows are 48px with node labels on the left and bytes received on the right. Each row has an 8px bar coloured by block state, and arrival is drawn in Amber Pale when the full block was fetched later. Curved 1.5px delivery paths are Amber for staletip and Gray Line otherwise. Ticks are in mono. Below a hairline, the mode cost compares header-only bytes with full-block bytes as 6px Amber and Amber Pale bars on a Line Soft track.

### Message table
Fixed columns are time (mono, muted), route, message tag, detail (mono, or Inter for prose) and size (mono, right-aligned). Rows are at least 40px with Line Soft dividers. Hover uses the Canvas fill and selection uses Accent Wash. The toolbar above holds search, the Type and Node selects, and the filter token.

## Do's and Don'ts

### Do:
- **Do** follow the Block-Tree Language Rule exactly wherever a block state appears: trees, legend, swatches, tags and waterfall bars.
- **Do** keep Blue #0969DA for selection, focus, links and cross-panel linking only.
- **Do** set hashes, heights, times and bytes in Geist Mono with tabular figures, and everything else in Inter.
- **Do** divide regions inside a panel with 1px hairlines and keep the panel inset at 20px (16px under 650px).
- **Do** restrict hover fills to `(hover:hover) and (pointer:fine)`, and honour `prefers-reduced-motion`.

### Don't:
- **Don't** use eyebrow or kicker labels, uppercase section labels, or hero-metric strips.
- **Don't** use monospace for labels, headings or prose.
- **Don't** introduce a second accent, or use amber or the block grays as general highlights.
- **Don't** nest panels or box every region as a card.
- **Don't** add shadows beyond the dialog lift and the field focus halo.
- **Don't** draw blocks a node does not know.
