---
name: data-visualization
description: Build charts and dashboards in web frontends — pick the chart that answers the question, then implement it with the project's existing library (Recharts, Chart.js, ECharts, Observable Plot, Vega-Lite, D3) or dependency-free React + SVG — with honest scales, colorblind-safe palettes, Intl number/date formatting, accessible markup, responsive sizing and edge-case handling. Use when the user asks to add, choose, fix or review a chart, graph, plot, sparkline, KPI card, metrics panel, analytics view or dashboard, or says "visualize this data", "which chart should I use", "make this chart accessible" or "the chart breaks with empty/negative/long data".
license: MIT
---

# Data visualization

Every chart answers one question for one audience. Deliverables:

| Piece | Role |
| --- | --- |
| Question + takeaway | One sentence each; the takeaway becomes the chart description |
| Chart component | Rendered with the project's library, or hand-built SVG |
| Formatters | One shared module for numbers, units and dates (`format.ts`) |
| Data table alternative | Same data, readable without the chart |
| Edge-case fixtures | Empty, single point, negatives, nulls, outliers, long labels, many series |

## Workflow

1. **Question.** Write the question the chart answers ("Which regions missed target in Q3?") and the expected takeaway. No question → no chart; a single number is a KPI card, exact lookups are a table.
2. **Data.** Inspect shape and cardinality: row count, number of categories and series, value range and sign, nulls, time grain and time zone, units. Aggregate before charting, not in the render.
3. **Encoding.** Choose the chart from the table below; detail and thresholds in [references/chart-selection.md](references/chart-selection.md). Position beats length beats angle/area beats color.
4. **Library.** Use what `package.json` already has (`recharts`, `chart.js`/`react-chartjs-2`, `echarts`, `@observablehq/plot`, `vega-lite`/`vega-embed`, `d3`, …). Recipes per library in [references/library-recipes.md](references/library-recipes.md). None installed and 1–3 simple charts → the SVG template below; zoom/brush, many chart types or >2k marks → propose adding one (canvas-capable for large data).
5. **Design.** Palette, labels, contrast and screen-reader output per [references/color-and-accessibility.md](references/color-and-accessibility.md). Sort bars by value unless categories have a natural order.
6. **Implement** with the templates below; all formatting through `format.ts`.
7. **Dashboards.** Layout, KPI cards, loading/empty/error states and performance in [references/dashboard-layout.md](references/dashboard-layout.md).
8. **Verify** with real data and every fixture in the edge-case checklist, at 320 px and desktop width, light and dark, keyboard only, with reduced motion on.

## Chart choice

| Question | Default | Alternatives | Avoid |
| --- | --- | --- | --- |
| Comparison across categories | Sorted bar (horizontal if labels are long or > 8 bars) | Dot plot, lollipop, grouped bar (≤ 3 groups) | Pie, radar, 3D bars |
| Trend over time | Line (≥ 8 points) | Column for few discrete periods, area for one cumulative series | Stacked lines, > 5 colored lines |
| Distribution | Histogram | Box/violin for group comparison, strip/dot plot for n < 50 | Bar of means without spread |
| Part-to-whole | 100 % stacked bar or single stacked bar | Pie/donut for 2–5 parts summing to 100 %, treemap for hierarchy, waterfall for change breakdown | Pie with > 5 slices, stacked area with many layers |
| Relationship | Scatter | Bubble (3rd variable), hexbin/density for > 5k points, connected scatter for paths | Dual-axis line pair |
| Geography | Choropleth of a rate (per capita, %) | Symbol map for counts, tile grid map for equal-weight regions | Choropleth of raw counts |
| Ranking / change between two points | Sorted bar | Slope chart, dumbbell, bump chart | Two separate pies |
| Deviation from a baseline | Diverging bar | Line with target band | Colors-only encoding |

## Hard rules

- Bars and areas start at zero; never truncate their value axis. Lines and dots may use a zoomed domain if it is labelled.
- No 3D, no dual y-axes, no pie with > 5 slices. Dual axes only when both series share a unit that is mapped honestly; otherwise use two aligned charts.
- Label directly (end of line, end of bar) instead of a legend when there are ≤ 5 series; a legend, when needed, follows the visual order of the marks.
- Categorical palette ≤ 7 colors, colorblind-safe; sequential or diverging ramps for magnitudes, diverging only around a meaningful midpoint. Never encode by color alone: add labels, dash patterns, markers or order. Same category = same color everywhere in the product.
- All numbers go through `Intl.NumberFormat` / `Intl.DateTimeFormat` with units in the axis title or the value (`12.3 %`, `$4.1M`, `120 ms`); `font-variant-numeric: tabular-nums` for aligned figures. Missing values display as `—`, never `0`.
- Every chart has a visible title, a one-sentence description stating the takeaway, and either `role="img"` + `aria-labelledby`/`aria-label` on the SVG/canvas or an interactive pattern with keyboard focus; plus a data table alternative.
- Tooltips never hold the only copy of information, open on focus as well as hover, and close on Escape. Interactive marks are keyboard reachable.
- Responsive: size from the container with `ResizeObserver` (text stays legible); `viewBox` scaling only for label-free graphics such as sparklines. Test at 320 px.
- Chart transitions ≤ 300 ms and disabled under `prefers-reduced-motion: reduce`. No entrance animation on every data refresh.
- Nulls render as gaps, never as zeros; the current, incomplete period is marked as partial.
- Synthetic or sample data is labelled as such on screen.

## Template: responsive SVG bar chart (no dependencies)

```jsx
// BarChart.jsx — horizontal bars, hand-computed scale, handles empty/negative/null/long labels.
import { useEffect, useId, useRef, useState } from 'react';
import { formatCompact, formatNumber } from './format';

function useWidth() {
  const ref = useRef(null);
  const [width, setWidth] = useState(0);
  useEffect(() => {
    const el = ref.current;
    if (!el) return undefined;
    const ro = new ResizeObserver(([entry]) => setWidth(Math.floor(entry.contentRect.width)));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, width];
}

// Ticks at 1/2/5 × 10^n; the domain always contains 0 and never collapses.
function niceTicks(values, count) {
  const lo = Math.min(0, ...values);
  const hi = Math.max(0, ...values);
  const raw = (hi - lo || 1) / count;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 5, 10].map((k) => k * mag).find((s) => s >= raw);
  const start = Math.floor(lo / step) * step;
  const end = hi === lo ? start + step * count : Math.ceil(hi / step) * step; // all-zero data → 0…1
  const n = Math.round((end - start) / step);
  return Array.from({ length: n + 1 }, (_, i) => Number((start + i * step).toPrecision(12)));
}

const truncate = (s, max) => (s.length > max ? `${s.slice(0, max - 1)}…` : s);

// data: [{ label: 'North', value: 1240 }, …], unique labels, sorted by the caller.
export function BarChart({ data, title, description, format = formatCompact, labelWidth = 144, barHeight = 28 }) {
  const [ref, width] = useWidth();
  const titleId = useId();
  const descId = useId();
  const values = data.map((d) => d.value).filter(Number.isFinite);
  const ticks = niceTicks(values, Math.max(2, Math.floor((width - labelWidth - 128) / 80)));
  const lo = ticks[0];
  const hi = ticks[ticks.length - 1];
  const m = { top: 24, right: 64, bottom: 8, left: labelWidth + (lo < 0 ? 64 : 0) };
  const plotW = Math.max(width - m.left - m.right, 1);
  const height = m.top + m.bottom + data.length * barHeight;
  const x = (v) => m.left + ((v - lo) / (hi - lo)) * plotW;
  const x0 = x(0);

  return (
    <figure ref={ref} className="chart">
      <figcaption id={titleId} className="chart-title">{title}</figcaption>
      <p id={descId} className="chart-desc">{description}</p>
      {data.length === 0 && <p className="chart-empty">No data for this selection.</p>}
      {data.length > 0 && width > 0 && (
        <svg width={width} height={height} role="img" aria-labelledby={`${titleId} ${descId}`}>
          {ticks.map((t) => (
            <g key={t}>
              <line x1={x(t)} x2={x(t)} y1={m.top} y2={height - m.bottom} className={t === 0 ? 'chart-zero' : 'chart-grid'} />
              <text x={x(t)} y={m.top - 8} textAnchor="middle" className="chart-tick">{format(t)}</text>
            </g>
          ))}
          {data.map((d, i) => {
            const y = m.top + i * barHeight;
            const ok = Number.isFinite(d.value);
            const end = ok ? x(d.value) : x0;
            const neg = ok && d.value < 0;
            return (
              <g key={d.label}>
                <text x={labelWidth - 8} y={y + barHeight / 2} dy="0.35em" textAnchor="end" className="chart-label">
                  <title>{d.label}</title>
                  {truncate(d.label, Math.floor(labelWidth / 7))}
                </text>
                {ok && <rect x={Math.min(x0, end)} y={y + 4} width={Math.max(Math.abs(end - x0), 1)} height={barHeight - 8} className="chart-bar" />}
                <text x={end + (neg ? -4 : 4)} y={y + barHeight / 2} dy="0.35em" textAnchor={neg ? 'end' : 'start'} className="chart-value">
                  {ok ? format(d.value) : 'No data'}
                </text>
              </g>
            );
          })}
        </svg>
      )}
      {data.length > 0 && (
        <details className="chart-data">
          <summary>Show data</summary>
          <table>
            <thead><tr><th scope="col">Category</th><th scope="col">Value</th></tr></thead>
            <tbody>
              {data.map((d) => (
                <tr key={d.label}><th scope="row">{d.label}</th><td>{formatNumber(d.value)}</td></tr>
              ))}
            </tbody>
          </table>
        </details>
      )}
    </figure>
  );
}
```

```css
.chart-bar { fill: var(--chart-1, #0072b2); }
.chart-grid { stroke: var(--chart-grid, #e5e7eb); }
.chart-zero { stroke: var(--chart-axis, #6b7280); }
.chart-label, .chart-value, .chart-tick { font: 12px system-ui, sans-serif; fill: var(--chart-text, #374151); font-variant-numeric: tabular-nums; }
```

## Library templates

[references/library-recipes.md](references/library-recipes.md) has a complete Recharts line chart (direct end labels, dashed comparison series, reduced motion, keyboard tooltips) and equivalent recipes for Chart.js, ECharts, Observable Plot, Vega-Lite and D3. The KPI card and dashboard grid are in [references/dashboard-layout.md](references/dashboard-layout.md).

## Template: formatters

```ts
// format.ts — every number and date in charts goes through here.
const LOCALE: string | undefined = undefined; // user's locale; pin (e.g. 'en-GB') only if the product requires it
const numberCache = new Map<string, Intl.NumberFormat>();
const dateCache = new Map<string, Intl.DateTimeFormat>();

function nf(options: Intl.NumberFormatOptions): Intl.NumberFormat {
  const key = JSON.stringify(options);
  let f = numberCache.get(key);
  if (!f) numberCache.set(key, (f = new Intl.NumberFormat(LOCALE, options)));
  return f;
}
function df(options: Intl.DateTimeFormatOptions): Intl.DateTimeFormat {
  const key = JSON.stringify(options);
  let f = dateCache.get(key);
  if (!f) dateCache.set(key, (f = new Intl.DateTimeFormat(LOCALE, options)));
  return f;
}
const safe = (fn: (v: number) => string) => (v: number | null | undefined): string =>
  v == null || !Number.isFinite(v) ? '—' : fn(v);

export const formatNumber = safe((v) => nf({ maximumFractionDigits: 2 }).format(v)); // 1,234.57
export const formatCompact = safe((v) => nf({ notation: 'compact', maximumFractionDigits: 1 }).format(v)); // 1.2K, 3.4M
export const formatPercent = safe((ratio) => nf({ style: 'percent', maximumFractionDigits: 1 }).format(ratio)); // 0.123 → 12.3%
export const formatDelta = safe((ratio) =>
  nf({ style: 'percent', maximumFractionDigits: 1, signDisplay: 'exceptZero' }).format(ratio)); // +4.2%, -1.5%, 0%
export const formatCurrency = (currency: string, compact = false) => safe((v) =>
  nf({ style: 'currency', currency, notation: compact ? 'compact' : 'standard', minimumFractionDigits: 0, maximumFractionDigits: compact ? 1 : 0 }).format(v));
export const formatUnit = (unit: string) => safe((v) =>
  nf({ style: 'unit', unit, unitDisplay: 'short', maximumFractionDigits: 1 }).format(v)); // formatUnit('millisecond')(120) → 120 ms

// Date-only strings ('2026-03', '2026-03-15') parse as UTC midnight: format them in UTC or they shift a day.
type DateInput = string | number | Date;
const toDate = (v: DateInput) => (v instanceof Date ? v : new Date(v));
export const formatMonth = (v: DateInput) => df({ month: 'short', year: 'numeric', timeZone: 'UTC' }).format(toDate(v)); // Mar 2026
export const formatDay = (v: DateInput) => df({ dateStyle: 'medium', timeZone: 'UTC' }).format(toDate(v)); // Mar 15, 2026
export const formatDateTime = (v: DateInput) => df({ dateStyle: 'medium', timeStyle: 'short' }).format(toDate(v)); // local time
```

Formatters take exactly one argument so they can be passed straight to library callbacks (`tickFormatter`, `valueFormatter`) that append extra arguments.

## Edge-case checklist

Build a fixture for each and look at the result:

- [ ] **Empty** (`[]`): explicit empty message, no bare axes, no `NaN`/`Infinity`.
- [ ] **Single point / single category**: visible mark (dot on a one-point line), sensible domain.
- [ ] **All zeros / all equal**: domain does not collapse; axis still readable.
- [ ] **Negatives**: bars grow from zero both ways, labels on the correct side, diverging color only if meaningful.
- [ ] **Nulls / gaps in time**: gaps shown, `—` in tooltips and tables, missing dates not silently skipped on a category axis.
- [ ] **Outliers**: one huge value does not flatten the rest — annotate, clip with a marker, or use a labelled log scale (positive data only).
- [ ] **Long labels and localized text**: truncated with the full text available; horizontal bars; no overlap at 320 px.
- [ ] **Many series / categories**: > 7 → top N + "Other", highlight one and gray the rest, or small multiples.
- [ ] **Extreme magnitudes**: 0.0004 and 12,000,000,000 both format readably; percentages of ratio vs. already-percent values not confused.
- [ ] **Partial current period, time zones, DST**: last bucket marked partial; day boundaries in the intended zone.
- [ ] **Large data**: > 2k SVG marks → aggregate, downsample or switch to canvas.

## Review checklist

- [ ] The title/description states the takeaway; a reader gets it in 5 seconds.
- [ ] Chart type matches the question per the chart-choice table.
- [ ] Bars start at zero; no 3D; no unjustified dual axis; axes and units labelled.
- [ ] Colors pass the colorblind check and 3:1 contrast; meaning never relies on color alone.
- [ ] Numbers and dates use `format.ts`; tabular figures; nulls shown as `—`.
- [ ] Screen reader gets title + description + table; tooltips work by keyboard and Escape closes them.
- [ ] Works at 320 px, in dark mode, and with reduced motion (no transitions).
- [ ] Every item of the edge-case checklist exercised.
