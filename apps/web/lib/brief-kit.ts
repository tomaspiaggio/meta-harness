/**
 * The stylesheet every daily brief renders with. It uses only the app's theme
 * tokens, so briefs match the app in light and dark mode. The writing agent is
 * told these class names (see BRIEF_KIT_GUIDE); keep the two in step.
 */
export const BRIEF_KIT_CSS = `
:host { display: block; color: var(--foreground); font-family: var(--font-sans); font-size: 15px; line-height: 1.6; }
* { box-sizing: border-box; }
.brief { max-width: 46rem; margin: 0 auto; }
h1, h2 { font-family: var(--font-serif); font-weight: 600; letter-spacing: -0.01em; color: var(--foreground); }
h1 { font-size: 2rem; line-height: 1.15; margin: 0.25rem 0 0.5rem; }
h2 { font-size: 1.35rem; line-height: 1.25; margin: 2.25rem 0 0.75rem; }
h3 { font-size: 1rem; font-weight: 600; margin: 0 0 0.35rem; }
p { margin: 0 0 0.9rem; }
ul, ol { margin: 0 0 1rem; padding-left: 1.2rem; }
li { margin: 0.2rem 0; }
a { color: var(--primary); text-decoration: underline; text-underline-offset: 2px; }
code { font-family: var(--font-mono); font-size: 0.85em; background: var(--muted); padding: 0.1rem 0.3rem; border-radius: 4px; }
hr { border: 0; border-top: 1px solid var(--border); margin: 2rem 0; }
.eyebrow { font-family: var(--font-mono); font-size: 11px; text-transform: uppercase; letter-spacing: 0.08em; color: var(--muted-foreground); }
.lede { font-family: var(--font-serif); font-size: 1.25rem; line-height: 1.5; margin: 0.5rem 0 1.5rem; }
.muted { color: var(--muted-foreground); }
.small { font-size: 0.85rem; }
.grid { display: grid; gap: 0.75rem; grid-template-columns: repeat(auto-fit, minmax(13rem, 1fr)); margin: 1rem 0 1.25rem; }
.card { background: var(--card); color: var(--card-foreground); border: 1px solid var(--border); border-radius: calc(var(--radius) + 4px); padding: 1rem 1.1rem; box-shadow: var(--shadow-xs); }
.card > :last-child { margin-bottom: 0; }
.card.accent { border-left: 3px solid var(--primary); }
.badge { display: inline-flex; align-items: center; gap: 0.3rem; border: 1px solid var(--border); border-radius: 999px; padding: 0.05rem 0.55rem; font-family: var(--font-mono); font-size: 0.72rem; color: var(--muted-foreground); background: var(--background); white-space: nowrap; }
.badge.primary { color: var(--primary); background: var(--live-soft); border-color: transparent; }
.badge.good { color: var(--success); background: var(--success-soft); border-color: transparent; }
.badge.warn { color: var(--warning); background: var(--warning-soft); border-color: transparent; }
.badge.risk { color: var(--danger); background: var(--danger-soft); border-color: transparent; }
.stats { display: flex; flex-wrap: wrap; gap: 1.25rem 2rem; margin: 1rem 0 1.5rem; }
.stat strong { display: block; font-family: var(--font-serif); font-size: 2rem; line-height: 1.1; color: var(--primary); }
.stat span { font-size: 0.8rem; color: var(--muted-foreground); }
.why { margin: 1rem 0; padding: 0.7rem 1rem; border-left: 3px solid var(--chart-4); border-radius: 0 var(--radius) var(--radius) 0; background: var(--muted); font-size: 0.95rem; }
.why .label { display: block; font-family: var(--font-mono); font-size: 11px; text-transform: uppercase; letter-spacing: 0.08em; color: var(--muted-foreground); margin-bottom: 0.2rem; }
.timeline { list-style: none; margin: 1rem 0 1.5rem 0.4rem; padding: 0; border-left: 2px solid var(--border); }
.timeline li { position: relative; margin: 0; padding: 0 0 1rem 1.25rem; }
.timeline li::before { content: ""; position: absolute; left: -7px; top: 0.45rem; width: 12px; height: 12px; border-radius: 50%; background: var(--card); border: 2px solid var(--primary); }
.flow { display: flex; flex-wrap: wrap; align-items: stretch; gap: 0.5rem; margin: 1rem 0 1.25rem; }
.flow > .card { flex: 1 1 9rem; padding: 0.7rem 0.85rem; font-size: 0.9rem; }
.flow > .arrow { align-self: center; color: var(--muted-foreground); }
@media (max-width: 560px) { .flow { flex-direction: column; } .flow > .arrow { transform: rotate(90deg); } }
.progress { height: 6px; border-radius: 999px; background: var(--muted); overflow: hidden; margin: 0.35rem 0; }
.progress > span { display: block; height: 100%; background: var(--primary); }
figure.diagram { margin: 1.5rem 0; padding: 1rem; background: var(--card); border: 1px solid var(--border); border-radius: calc(var(--radius) + 4px); }
figure.diagram svg { display: block; width: 100%; height: auto; font-family: var(--font-sans); }
figcaption { margin-top: 0.6rem; font-size: 0.8rem; color: var(--muted-foreground); }
table { width: 100%; border-collapse: collapse; font-size: 0.9rem; margin: 1rem 0; }
th, td { text-align: left; padding: 0.5rem 0.6rem; border-bottom: 1px solid var(--border); vertical-align: top; }
th { font-size: 0.75rem; font-weight: 600; text-transform: uppercase; letter-spacing: 0.04em; color: var(--muted-foreground); }
svg text { fill: var(--foreground); font-size: 12px; }
svg .c1 { fill: var(--chart-1); } svg .c2 { fill: var(--chart-2); } svg .c3 { fill: var(--chart-3); }
svg .c4 { fill: var(--chart-4); } svg .c5 { fill: var(--chart-5); }
svg .s1 { stroke: var(--chart-1); fill: none; } svg .s2 { stroke: var(--chart-2); fill: none; } svg .s3 { stroke: var(--chart-3); fill: none; }
svg .s4 { stroke: var(--chart-4); fill: none; } svg .s5 { stroke: var(--chart-5); fill: none; }
svg .ink { fill: var(--foreground); } svg .soft { fill: var(--muted); } svg .paper { fill: var(--card); }
svg .line { stroke: var(--border); fill: none; } svg .text-muted { fill: var(--muted-foreground); }
`;
export const BRIEF_KIT_GUIDE = `Write an HTML fragment (no <html>, <head>, <script>, external images, fonts or stylesheets; a <style> block is allowed but rarely needed). Wrap it in <article class="brief">. It is rendered inside the app with this kit, which follows the app's theme in light and dark mode, so do not set colors yourself:
- Text: h1 (the headline), h2 (sections), h3, p, ul/ol, code, a, hr; .eyebrow (small caps label), .lede (one large opening sentence), .muted, .small.
- Layout: .grid of .card (add .accent for the key one); .flow of .card separated by <span class="arrow">→</span> for a sequence; .stats of .stat (<div class="stat"><strong>3</strong><span>PRs merged</span></div>); ol.timeline for the day's sequence; table for comparisons.
- Status: span.badge with .primary, .good, .warn or .risk.
- Why: <div class="why"><span class="label">Why · decision-key r3</span>…</div> for the decision or reason that made the work necessary.
- Progress: <div class="progress"><span style="width:60%"></span></div>.
- Diagrams: <figure class="diagram"><svg viewBox="0 0 640 240">…</svg><figcaption>…</figcaption></figure>. In SVG use classes, not colors: c1–c5 (fills), s1–s5 (strokes, with stroke-width), ink, soft, paper, line, text-muted; <text> is already themed. Draw architecture, flows, before/after or timelines when the work has structure.
- Links to a conversation: <a href="/?workspace=WORKSPACE_ID&session=SESSION_ID">.`;
