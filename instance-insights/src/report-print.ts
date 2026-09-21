/**
 * Renders a scan result as a self-contained HTML document for printing.
 *
 * Built from the result rather than cloned from the page, for three reasons: the
 * print window resolves no relative stylesheet, so the styles have to travel with
 * the document; the controls of an interactive report have no meaning on paper and
 * simply do not exist here; and a pure function can be unit-tested instead of
 * eyeballed through a print dialog.
 *
 * Everything the instance supplies - project, board and field names - is escaped.
 * A project named after an HTML tag must not become markup.
 */

import { effectiveRatio } from './engine.ts';
import type { CategoryScore, CheckOutcome, IgnoredItems, ScanResult } from './engine.ts';
import type { CheckChange, Comparison } from './trend.ts';
import type { CheckDefinition, Finding } from './types.ts';
import { CATEGORY_LABEL, plural } from './types.ts';
import {
  byImpact,
  categoryTableLabel,
  itemKindPage,
  ONE_PAGE_LINK,
  ONE_PAGE_NOTE,
  MARKED_SECTION_NOTE,
  NO_FINDINGS_NOTE,
  nothingMovedNote,
  categoryPoints,
  checkPoints,
  dateText,
  decisionEffect,
  decisionSentence,
  issueSearchUrl,
  itemUrl,
  itemNoun,
  ITEMS_SHOWN,
  METHOD_NOTE,
  WEIGHT_REASON,
  MOVEMENT_LABEL,
  andList,
  noMeasurementByCategory,
  shareText,
  NO_MEASUREMENT_HEADING,
  NO_MEASUREMENT_NOTE,
  oneDecimal,
  scoreText,
  movementDetail,
  percent,
  RATIO_DECIMALS,
  SEVERITY_LABEL,
  SEVERITY_NOTE,
  STOPPED_NOTE,
  timeText,
  VENDOR,
  withoutMeasurement,
} from './report-shared.ts';

/** Escapes text for HTML content and attribute values alike. */
function esc(value: string | number): string {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Print styles.
 *
 * Paper is white and has no theme, so the colours are explicit rather than taken
 * from ring-ui variables that do not exist in this document. Severity shows as a
 * word and a grey rule, not as a colour: a report is read on a monochrome office
 * printer as often as on screen.
 */
const STYLES = `
  @page { size: A4; margin: 18mm 16mm 20mm; }
  * { box-sizing: border-box; }
  html { -webkit-print-color-adjust: exact; print-color-adjust: exact; background: #f2f4f6; }
  body {
    /* The window shows this document before it is printed, so on screen it looks
       like a sheet of paper. @page owns the margins once it goes to the printer. */
    max-width: 178mm;
    margin: 0 auto;
    padding: 16mm 12mm;
    background: #fff;
    color: #1a1a1a;
    font: 10.5pt/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", Inter, Helvetica, Arial, sans-serif;
    /* Figures line up in a column, on paper as on screen. */
    font-variant-numeric: tabular-nums;
  }
  @media print {
    html { background: #fff; }
    body { max-width: none; margin: 0; padding: 0; }
  }
  h1, h2, h3 { margin: 0; font-weight: 600; }
  p { margin: 0; }

  .head {
    display: flex;
    justify-content: space-between;
    align-items: flex-end;
    gap: 12pt;
    border-bottom: 1.5pt solid #1a1a1a;
    padding-bottom: 8pt;
  }
  .head__title { font-size: 20pt; letter-spacing: -0.01em; }
  .head__subtitle { margin-top: 2pt; color: #5c5f61; font-size: 9.5pt; }
  .head__meta { text-align: right; font-size: 8.5pt; color: #5c5f61; }

  .summary {
    display: flex;
    align-items: baseline;
    gap: 16pt;
    margin-top: 14pt;
    padding: 12pt 14pt;
    border: 0.75pt solid #d6d9dc;
    border-radius: 4pt;
    background: #fafbfc;
    break-inside: avoid;
  }
  .summary__figure { flex: none; }
  .summary__sub { margin-top: 2pt; font-size: 8.5pt; color: #5c5f61; }
  .bar-cell { width: 30%; }
  .bar {
    height: 5pt;
    border-radius: 3pt;
    background: #e6e9ec;
    overflow: hidden;
  }
  .bar__fill { height: 100%; background: #55595c; }
  .terms { color: #5c5f61; font-size: 9pt; }
  .moved { margin-top: 8pt; break-inside: avoid; }
  .moved li { margin-top: 1pt; }
  .moved__kind {
    display: inline-block;
    min-width: 52pt;
    font-size: 7.5pt;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    color: #5c5f61;
  }
  .summary__label {
    font-size: 7.5pt;
    text-transform: uppercase;
    letter-spacing: 0.08em;
    color: #5c5f61;
  }
  /* The second figure of the card, a step below the score in the ring beside it. */
  .summary__score { font-size: 26pt; font-weight: 700; line-height: 1; letter-spacing: -0.02em; }
  .finding__item--marked { color: #5c5f61; }
  .score-ring { position: relative; width: 78pt; height: 78pt; margin-top: 3pt; }
  .score-ring__dial { display: block; width: 100%; height: 100%; }
  /* Centred in the ring, both lines together, so the figure and what it is out of
     read as one thing. */
  .score-ring__figures { position: absolute; inset: 0; display: flex;
    flex-direction: column; align-items: center; justify-content: center; line-height: 1; }
  .score-ring__value { font-size: 22pt; font-weight: 700; letter-spacing: -0.02em; }
  .score-ring__max { margin-top: 2pt; font-size: 7.5pt; white-space: nowrap; color: #5c5f61; }
  .decisions { margin: 8pt 0 0; padding-left: 7pt; font-size: 9pt;
    border-left: 2pt solid #d6d9dc; color: #5c5f61; }
  .summary__facts { flex: 1; min-width: 40%; }
  .summary__note { margin-top: 4pt; font-size: 8.5pt; color: #5c5f61; }

  h2 {
    margin-top: 18pt;
    break-after: avoid;
    padding-bottom: 3pt;
    border-bottom: 0.75pt solid #d6d9dc;
    font-size: 12pt;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    color: #3c3f41;
  }

  table { width: 100%; border-collapse: collapse; margin-top: 8pt; font-size: 9.5pt; }
  th, td { padding: 4pt 8pt; border-bottom: 0.5pt solid #e6e9ec; text-align: left; }
  th {
    border-bottom: 0.75pt solid #b8bcbf;
    font-weight: 600;
    font-size: 8.5pt;
    color: #5c5f61;
  }
  th + th, td + td { border-left: 0.5pt solid #e6e9ec; }
  th:first-child, td:first-child { padding-left: 0; }
  .num { text-align: right; font-variant-numeric: tabular-nums; width: 22%; }
  .num--score { font-weight: 600; }

  .finding {
    margin-top: 10pt;
    padding: 9pt 0 9pt 10pt;
    border-left: 2.5pt solid #8c9196;
    break-inside: avoid;
  }
  .finding--critical { border-left-color: #1a1a1a; }
  .finding--high { border-left-color: #55595c; }
  .finding__severity {
    font-size: 7.5pt;
    text-transform: uppercase;
    letter-spacing: 0.08em;
    color: #5c5f61;
  }
  .finding__title { font-size: 12pt; margin-top: 1pt; }
  .finding__headline { margin-top: 4pt; font-weight: 600; }
  .finding__why { margin-top: 4pt; }
  .finding__evidence {
    margin: 5pt 0 0;
    padding: 0;
    list-style: none;
    font-size: 9.5pt;
    color: #3c3f41;
  }
  .finding__evidence li + li { margin-top: 1pt; }
  .finding__aside { margin-top: 5pt; font-size: 9pt; color: #5c5f61; }
  .finding__aside b { color: #3c3f41; font-weight: 600; }
  .finding__items-label { margin: 6pt 0 0; font-size: 9pt; font-weight: 600; color: #3c3f41; }
  .finding__items { margin: 2pt 0 0; padding-left: 12pt; font-size: 9pt; color: #3c3f41; }

  .note { margin-top: 6pt; font-size: 9pt; color: #5c5f61; }
  .list { margin: 6pt 0 0; padding-left: 12pt; font-size: 9.5pt; }

  .method {
    margin-top: 18pt;
    padding-top: 6pt;
    border-top: 0.5pt solid #e6e9ec;
    font-size: 8.5pt;
    color: #5c5f61;
    break-inside: avoid;
  }

  .foot {
    margin-top: 8pt;
    padding-top: 6pt;
    border-top: 0.75pt solid #d6d9dc;
    font-size: 8.5pt;
    color: #5c5f61;
  }
  .foot a { color: inherit; text-decoration: none; }
`;

/** Shared empty set for findings with nothing marked. */
const NO_MARKS: ReadonlySet<string> = new Set();


export interface PrintInput {
  result: ScanResult;
  checks: readonly CheckDefinition[];
  /** Whether the scan was stopped before it had read everything. */
  stopped?: boolean;
  /**
   * The instance the report is about. A printed document keeps the names either
   * way; a PDF that is read on screen becomes navigable with it.
   */
  instanceUrl?: string;
  /**
   * Objects marked as intentional, per check.
   *
   * The document names them like the others - they are still true of the instance -
   * and says which ones no longer count, so the score stays recomputable from it.
   */
  markedItems?: IgnoredItems;
  /** Injected, never read from the clock, so the output is reproducible. */
  at: Date;
  /** One sentence about the trend, when earlier scans exist. */
  trendLine?: string;
  /** The comparison against the previous scan, when there is one. */
  comparison?: Comparison;
}

export function reportToPrintHtml({
  result,
  checks,
  at,
  trendLine,
  comparison,
  stopped = false,
  instanceUrl,
  markedItems = new Map(),
}: PrintInput): string {
  const origin = instanceUrl ?? null;
  const byId = new Map(checks.map((c) => [c.id, c]));
  const parts: string[] = [];

  parts.push(
    '<header class="head"><div>',
    '<h1 class="head__title">Instance Insights</h1>',
    `<p class="head__subtitle">Where this instance's configuration and process have drifted over time</p>`,
    '</div><div class="head__meta">',
    `<div>${esc(dateText(at))}</div>`,
    `<div>${esc(timeText(at))}</div>`,
    '</div></header>',
  );

  /* A document that gets forwarded has to carry this: a score over part of an
     instance reads exactly like a score over all of it. */
  if (stopped) {
    parts.push(`<p class="note">${STOPPED_NOTE}</p>`);
  }

  /* A forwarded document is read by people who were not there when the decisions
     were taken, so the score says what part of it is one. */
  const decision = decisionEffect(result, markedItems);

  parts.push(
    '<section class="summary">',
    // The score opens the conversation and the number of findings says how much
    // is behind it, so both are figures of the same size.
    '<div class="summary__figure"><div class="summary__label">Overall score</div>',
    /* No second figure beside the score: what the difference between the two means
       takes a sentence, and the sentence is directly below. */
    scoreRing(result),
    '</div>',
    '<div class="summary__figure"><div class="summary__label">Findings</div>',
    `<div class="summary__score">${result.findings.length}</div></div>`,
    // Only the trend belongs beside the figures. How the number is made is a
    // footnote - needed for defensibility, not for the first ten seconds.
    trendLine
      ? `<div class="summary__facts"><p class="summary__note">${esc(trendLine)}</p></div>`
      : '',
    '</section>',
  );

  if (decision) {
    parts.push(`<p class="decisions">${esc(decisionSentence(decision))}</p>`);
  }

  /* What changed comes before the current state: this is the part of a printed
     report that answers "did the work pay off". */
  if (comparison?.compared) {
    parts.push(
      '<h2>Since the previous scan</h2>',
      comparison.moved.length === 0
        ? `<p class="note">${nothingMovedNote(comparison.unchanged.length)}</p>`
        : movedList(comparison.moved, byId) + unchangedLine(comparison.unchanged, byId),
    );
  }

  parts.push(
    '<h2>Where the points went</h2>',
    categoriesTable(result),
  );

  parts.push('<h2>Findings</h2>');
  if (result.findings.length > 0) {
    parts.push(`<p class="note">${SEVERITY_NOTE}</p>`);
  }
  if (result.findings.length === 0) {
    parts.push(`<p class="note">${NO_FINDINGS_NOTE}</p>`);
  }
  /* Grouped by category, in the order of the table above, and strongest first
     inside a category: the table says where the points went, and this is where the
     reader looks for why. On screen the same grouping carries the jump from the
     table; on paper it is what makes the two sections one document. */
  for (const category of result.categories) {
    if (category.findings.length === 0) continue;
    parts.push(`<h3>${esc(CATEGORY_LABEL[category.category])}</h3>`);
    for (const finding of byImpact(category.findings)) {
      parts.push(
        findingBlock(
          result,
          finding,
          byId.get(finding.checkId),
          false,
          origin,
          markedItems.get(finding.checkId) ?? NO_MARKS,
        ),
      );
    }
  }

  if (result.ignoredFindings.length > 0) {
    parts.push(
      '<h2>Marked as intentional</h2>',
      `<p class="note">${MARKED_SECTION_NOTE}</p>`,
    );
    for (const finding of byImpact(result.ignoredFindings)) {
      parts.push(
        findingBlock(
          result,
          finding,
          byId.get(finding.checkId),
          true,
          origin,
          markedItems.get(finding.checkId) ?? NO_MARKS,
        ),
      );
    }
  }

  const notRun = withoutMeasurement(result.outcomes);
  if (notRun.length > 0) {
    parts.push(
      `<h2>${NO_MEASUREMENT_HEADING}</h2>`,
      `<p class="note">${NO_MEASUREMENT_NOTE}</p>`,
      notRunList(result, byId),
    );
  }

  parts.push(`<p class="method">${METHOD_NOTE}</p>`);
  parts.push(`<p class="method">${WEIGHT_REASON}</p>`);

  parts.push(
    '<footer class="foot">Report by ',
    `<a href="${VENDOR.url}">${VENDOR.name}</a>, ${VENDOR.url}. `,
    `${VENDOR.invitation} - ${VENDOR.email}.</footer>`,
  );

  return [
    '<!doctype html>',
    '<html lang="en"><head><meta charset="utf-8">',
    `<title>Instance Insights - ${esc(dateText(at))}</title>`,
    `<style>${STYLES}</style>`,
    '</head><body>',
    parts.join(''),
    '</body></html>',
  ].join('');
}

/** A full category score, and therefore a full bar. */
const FULL_SCORE = 100;


/**
 * Geometry of the dial, in its own coordinates.
 *
 * Half the box, and the radius that leaves the stroke room inside it rather than
 * half outside: (108 - 10) / 2 = 49. The arc is one stroked circle whose dash is
 * the score's share of the circumference, turned back a quarter so it starts at the
 * top where a dial starts.
 */
const RING_SIZE = 108;
const RING_STROKE = 10;
const RING_CENTRE = 54;
const RING_RADIUS = 49;
const RING_LENGTH = Math.PI * (RING_SIZE - RING_STROKE);
const QUARTER_TURN = -90;

/** Paper has no theme to follow, so the dial carries fixed colours. */
const RING_TRACK = '#e6e9ec';
const RING_ARC = '#3574f0';

/**
 * The score inside the hundred it is out of.
 *
 * The same picture as in the app, and for the same reasons: a full circle is a
 * hundred, so the maximum is the shape rather than a scale to read, and the app's
 * own mark is a dial. What is missing is not broken down here - the table below
 * names every area with what it was worth and what it lost, and two pictures of
 * one thing read as two things.
 */
function scoreRing(result: ScanResult): string {
  const { overallScore } = result;
  const arc =
    overallScore === null
      ? ''
      : `<circle cx="${RING_CENTRE}" cy="${RING_CENTRE}" r="${RING_RADIUS}" ` +
        `fill="none" stroke="${RING_ARC}" stroke-width="${RING_STROKE}" ` +
        `stroke-linecap="round" stroke-dasharray="` +
        `${round((Math.max(overallScore, 0) / FULL_SCORE) * RING_LENGTH)} ${round(RING_LENGTH)}" ` +
        `transform="rotate(${QUARTER_TURN} ${RING_CENTRE} ${RING_CENTRE})"/>`;
  return (
    '<div class="score-ring">' +
    `<svg class="score-ring__dial" viewBox="0 0 ${RING_SIZE} ${RING_SIZE}">` +
    `<circle cx="${RING_CENTRE}" cy="${RING_CENTRE}" r="${RING_RADIUS}" fill="none" ` +
    `stroke="${RING_TRACK}" stroke-width="${RING_STROKE}"/>` +
    arc +
    '</svg>' +
    '<div class="score-ring__figures">' +
    `<div class="score-ring__value">${overallScore === null ? 'n/a' : esc(scoreText(overallScore))}</div>` +
    // In words, because that is the sentence a reader needs and no arc can say it.
    '<div class="score-ring__max">out of 100</div>' +
    '</div></div>'
  );
}

const BAR_DECIMALS = 100;

function round(n: number): number {
  return Math.round(n * BAR_DECIMALS) / BAR_DECIMALS;
}

/**
 * Every category as a slice of the same hundred as the score above it.
 *
 * Out of its own hundred it read as another scale on a page that already had
 * several; out of the hundred, the column adds up to what the score says.
 */
function categoriesTable(result: ScanResult): string {
  const rows = result.categories
    .map((c) => {
      const points = categoryPoints(result, c.category);
      const figures =
        points === null
          ? '-'
          : `${esc(scoreText(points.worth - points.lost))} / ${esc(scoreText(points.worth))}`;
      /* A dash where nothing was measured, like the figure beside it: the name of
         the row says how many of its checks came back without a number, and saying
         it again here made one statement read as two. */
      const terms =
        points === null
          ? '-'
          : points.lost === 0
            ? 'nothing'
            : esc(scoreText(points.lost));
      return (
        `<tr><th scope="row">${esc(categoryTableLabel(result, c.category))}</th>` +
        `<td class="bar-cell">${bar(c.score)}</td>` +
        `<td class="num num--score">${figures}</td>` +
        `<td class="terms">${terms}</td></tr>`
      );
    })
    .join('');
  /* Named columns: two figures side by side are two guesses without them. */
  const head =
    '<thead><tr><th scope="col">Area</th><th scope="col"></th>' +
    '<th scope="col" class="num">Points kept</th>' +
    '<th scope="col">Points lost</th></tr></thead>';
  return `<table>${head}<tbody>${rows}</tbody></table>`;
}

/**
 * The checks that did not move, by name.
 *
 * On paper there is nothing to expand, so the names are written out: a count alone
 * leaves the reader asking which checks were compared at all.
 */
function unchangedLine(
  unchanged: readonly CheckChange[],
  byId: Map<string, CheckDefinition>,
): string {
  if (unchanged.length === 0) {
    return '';
  }
  const titles = unchanged
    .map((c) => esc(byId.get(c.id)?.title ?? c.id))
    .join(', ');
  return `<p class="note">Unchanged (${unchanged.length}): ${titles}.</p>`;
}

function movedList(
  moved: readonly CheckChange[],
  byId: Map<string, CheckDefinition>,
): string {
  const items = moved
    .map((change) => {
      const title = esc(byId.get(change.id)?.title ?? change.id);
      const kind = MOVEMENT_LABEL[change.kind];
      return (
        `<li><span class="moved__kind">${kind}</span>${title} - ` +
        `${esc(movementDetail(change))}</li>`
      );
    })
    .join('');
  return `<ul class="list moved">${items}</ul>`;
}

/** A filled proportion of the points a category kept. */
function bar(score: number | null): string {
  const filled = score === null ? 0 : Math.max(Math.min(score, FULL_SCORE), 0);
  return `<div class="bar"><div class="bar__fill" style="width:${filled}%"></div></div>`;
}

function notRunList(result: ScanResult, byId: Map<string, CheckDefinition>): string {
  /* By category, like the findings: the table of points names the categories that
     could not be scored, and this is where they are. Checks that came back for the
     same reason share one line - three of them under three bullets read as three
     failures rather than as one part not applying. */
  return noMeasurementByCategory(result.outcomes, (id) => byId.get(id)?.title ?? id)
    .map(({ category, groups }) => {
      const items = groups
        .map((group) => `<li>${esc(andList(group.titles))} - ${esc(group.phrase)}</li>`)
        .join('');
      return `<h3>${esc(CATEGORY_LABEL[category])}</h3><ul class="list">${items}</ul>`;
    })
    .join('');
}

function findingBlock(
  /** The whole result: what a check is worth depends on which others ran. */
  result: ScanResult,
  finding: Finding,
  def: CheckDefinition | undefined,
  ignored: boolean,
  /** The instance to link to, or null for a document that stands on its own. */
  origin: string | null,
  /** Objects of this finding that are marked as intentional. */
  marked: ReadonlySet<string>,
): string {
  const listed = finding.items ?? [];
  const parts = [
    `<article class="finding finding--${esc(finding.severity)}">`,
    `<div class="finding__severity">${esc(SEVERITY_LABEL[finding.severity])}</div>`,
    `<h4 class="finding__title">${esc(def?.title ?? finding.checkId)}</h4>`,
    `<p class="finding__headline">${esc(finding.headline)}</p>`,
  ];

  if (finding.evidence.length > 0) {
    parts.push(
      '<ul class="finding__evidence">',
      finding.evidence
        .map((e) => `<li>${esc(e.label)}: <b>${esc(e.value)}</b></li>`)
        .join(''),
      '</ul>',
    );
  }

  if (def) {
    parts.push(`<p class="finding__why">${esc(def.why)}</p>`);
    parts.push(
      `<p class="finding__aside"><b>May be intentional:</b> ${esc(def.legitimateWhen)}</p>`,
    );
    // An intentional finding takes nothing away. Printing its arithmetic as though
    // it counted would contradict the score on the same page.
    /* The share that is counted, which is the measured one minus what is marked:
       a printed score has to be recomputable from the page it is printed on. */
    const counted = effectiveRatio(finding, marked);
    const points = checkPoints(result, def.category, def.weight, counted);
    const worth = points === null ? 'nothing' : esc(scoreText(points.worth));
    const taken = points === null ? 'nothing' : esc(scoreText(points.lost));
    const markedHere = listed.filter((i) => marked.has(i.id)).length;
    /* Named, not "of them": a board is marked and cards are counted, so "1 of them"
       would read as one card. */
    const share =
      `${shareText(finding.ratio)} affected ` +
      `(ratio ${finding.ratio.toFixed(RATIO_DECIMALS)})` +
      (markedHere > 0
        ? `, ${markedHere} ${itemNoun(finding.itemKind, markedHere)} marked as ` +
          `intentional so ` +
          `${percent(counted)} % counted`
        : '');
    parts.push(
      `<p class="finding__aside"><b>What this involves:</b> ${esc(def.whatItInvolves)}</p>`,
    );
    parts.push(
      ignored
        ? `<p class="finding__aside"><b>Points:</b> worth ${worth} of the hundred, ` +
            `${share}, takes away nothing while marked as intentional</p>`
        : `<p class="finding__aside"><b>Points:</b> worth ${worth} of the hundred, ` +
            `${share}, takes away ${taken}</p>`,
    );
  }

  if (listed.length > 0) {
    if (def?.itemsNamePeople) {
      // Printed reports get passed around, so the accounts stay in the app.
      parts.push(
        `<p class="finding__aside">Affected accounts: ${listed.length}. The individual`,
        ' accounts are listed in the app and left out here, since this document is',
        ' meant to be shared.</p>',
      );
    } else {
      const rest = listed.length - ITEMS_SHOWN;
      /* The list says what it is a list of, and how long it is. Unlabelled, a
         column of names under a finding leaves the reader to work out both what
         kind of thing they are looking at and whether they are looking at all of
         them - which the page and the Markdown file both spell out. */
      parts.push(
        `<p class="finding__items-label">Affected ${itemNoun(
          finding.itemKind,
          listed.length,
        )} (${listed.length})</p>`,
        '<ul class="finding__items">',
        listed
          .slice(0, ITEMS_SHOWN)
          .map((i) => {
            /* The number is the link where the row counts issues: a field has no
               address of its own, and what a reader wants from "1 of 12494 issues"
               is those issues. */
            const search = i.query === undefined ? null : issueSearchUrl(origin, i.query);
            const shown = i.detail === undefined ? '' : esc(i.detail);
            const detail =
              i.detail === undefined
                ? ''
                : ` - ${search === null ? shown : `<a href="${esc(search)}">${shown}</a>`}`;
            const href = itemUrl(origin, finding.itemKind, i, finding.checkId);
            const label = esc(i.label);
            const named =
              href === null ? `${label}${detail}` : `<a href="${esc(href)}">${label}</a>${detail}`;
            /* Named like the others, because it is still true of the instance, and
               marked, because the score above does not count it. */
            return marked.has(i.id)
              ? `<li class="finding__item--marked">${named} - marked as intentional</li>`
              : `<li>${named}</li>`;
          })
          .join(''),
        // A document has an end: the list is cut, and says by how much.
        rest > 0 ? `<li>... and ${rest} more</li>` : '',
        '</ul>',
      );
      /* One link where the rows have no address of their own, with the reason: a
         list of names each linking to the same page promises places it has not. */
      const page = itemKindPage(origin, finding.itemKind);
      if (page !== null) {
        parts.push(
          `<p class="finding__aside"><a href="${esc(page)}">${ONE_PAGE_LINK}</a>. ` +
            `${ONE_PAGE_NOTE}</p>`,
        );
      }
    }
  }

  if (finding.query !== undefined) {
    /* The number stays checkable, even for someone who only has the document. */
    const href = issueSearchUrl(origin, finding.query);
    const query = `<code>${esc(finding.query)}</code>`;
    parts.push(
      `<p class="finding__query">The search behind this number: ${
        href === null ? query : `<a href="${esc(href)}">${query}</a>`
      }</p>`,
    );
  }

  parts.push('</article>');
  return parts.join('');
}
