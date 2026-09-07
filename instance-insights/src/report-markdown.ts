/**
 * Renders a scan result as Markdown. Markdown plus the print view is the whole
 * export story - no PDF library in the sandbox.
 *
 * Deliberately a pure function outside the widgets: the report text is the product,
 * so it is unit-tested rather than eyeballed in an iframe. Takes the ISO timestamp
 * from the caller for the same reason.
 *
 * Per finding it emits four elements: what was found including the number, why it
 * is worth attention, when it is legitimate, and what the work involves. The footer carries
 * the attribution, because the report gets forwarded internally and lands with
 * people who never saw the app, and the app never phones home.
 */

import { effectiveRatio } from './engine.ts';
import type { CategoryScore, IgnoredItems, ScanResult } from './engine.ts';
import type { CheckChange, Comparison } from './trend.ts';
import type { CheckDefinition, Finding } from './types.ts';
import { CATEGORY_LABEL, plural } from './types.ts';
import {
  categoryPoints,
  checkPoints,
  itemNoun,
  decisionEffect,
  decisionSentence,
  issueSearchUrl,
  itemUrl,
  ITEMS_SHOWN,
  METHOD_NOTE,
  WEIGHT_REASON,
  MOVEMENT_LABEL,
  andList,
  byImpact,
  MARKED_SECTION_NOTE,
  NO_FINDINGS_NOTE,
  nothingMovedNote,
  noMeasurementGroups,
  shareText,
  NO_MEASUREMENT_HEADING,
  NO_MEASUREMENT_NOTE,
  scoreText,
  movementDetail,
  percent,
  RATIO_DECIMALS,
  SEVERITY_LABEL,
  SEVERITY_NOTE,
  STOPPED_NOTE,
  timestampText,
  VENDOR,
  withoutMeasurement,
} from './report-shared.ts';
import type { HundredPoints } from './report-shared.ts';

/**
 * The score and what it is out of, in words.
 *
 * A file has no ring to put the figure inside, and a slash beside it says the same
 * thing in a second form - which reads as a second scale on a page that carries the
 * app's own sentences too ("Measured, this scan is 67.8 out of 100").
 */
function scoreLine(score: number | null): string {
  return score === null ? 'n/a' : `${scoreText(score)} out of 100`;
}

/** Shared empty set for findings with nothing marked. */
const NO_MARKS: ReadonlySet<string> = new Set();

export interface MarkdownInput {
  result: ScanResult;
  checks: readonly CheckDefinition[];
  /** Whether the scan was stopped before it had read everything. */
  stopped?: boolean;
  /**
   * The instance the report is about, so a reader can click through to a board or a
   * project. Without it the same names are there as plain text.
   */
  instanceUrl?: string;
  /**
   * Objects marked as intentional, per check.
   *
   * The file names them like the others - they are still true of the instance - and
   * says which ones no longer count, so the score stays recomputable from it.
   */
  markedItems?: IgnoredItems;
  /** Injected, never read from the clock, so the output is reproducible. */
  at: Date;
  /**
   * One sentence about where the score moved, when earlier scans exist.
   *
   * The page and the printed document both carry it. The file was listing which
   * checks moved and never saying that the score had - which is the line somebody
   * quotes when this file is pasted into the issue that tracks the clean-up.
   */
  trendLine?: string;
  /** The comparison against the previous scan, when there is one. */
  comparison?: Comparison;
}

export function reportToMarkdown({
  result,
  checks,
  at,
  trendLine,
  comparison,
  stopped = false,
  instanceUrl,
  markedItems = new Map(),
}: MarkdownInput): string {
  const origin = instanceUrl ?? null;
  const byId = new Map(checks.map((c) => [c.id, c]));
  const idToTitle = (id: string): string => byId.get(id)?.title ?? id;
  const lines: string[] = [];

  lines.push('# Instance Insights');
  lines.push('');
  lines.push(`Where this instance's configuration and process have drifted over time. Collected on ${timestampText(at)}.`);
  lines.push('');
  if (stopped) {
    lines.push(STOPPED_NOTE);
    lines.push('');
  }
  lines.push(`**Overall score:** ${scoreLine(result.overallScore)}`);
  lines.push('');
  lines.push(`**Findings:** ${result.findings.length}`);
  lines.push('');
  /* The file travels further than the app, so a score that stands on decisions says
     so where the number is, not in a footnote. */
  const decision = decisionEffect(result, markedItems);
  if (decision) {
    // Both scores live in the sentence: a figure cannot say what it is.
    lines.push(decisionSentence(decision));
    lines.push('');
  }
  lines.push(METHOD_NOTE);
  lines.push('', WEIGHT_REASON);

  if (trendLine !== undefined || comparison?.compared) {
    lines.push('', '## Since the previous scan', '');
    /* Where the score went, then which checks took it there. The sentence comes
       first because it is the one a reader quotes. */
    if (trendLine !== undefined) {
      lines.push(trendLine);
    }
  }
  if (comparison?.compared) {
    if (trendLine !== undefined) {
      lines.push('');
    }
    if (comparison.moved.length === 0) {
      // Saying nothing here would read as a missing section rather than a result.
      lines.push(
        nothingMovedNote(comparison.unchanged.length),
      );
    }
    for (const change of comparison.moved) {
      const title = byId.get(change.id)?.title ?? change.id;
      lines.push(`- **${MOVEMENT_LABEL[change.kind]}** - ${title}: ${movementDetail(change)}`);
    }
    if (comparison.moved.length > 0 && comparison.unchanged.length > 0) {
      // Named rather than counted: a file has no expanding section, and "nine
      // checks unchanged" leaves the reader asking which nine.
      const titles = comparison.unchanged
        .map((c) => byId.get(c.id)?.title ?? c.id)
        .join(', ');
      lines.push('', `Unchanged (${comparison.unchanged.length}): ${titles}.`);
    }
  }

  // Plain columns rather than sigma notation: the same two numbers, readable
  // without the formula in mind.
  lines.push(
    '',
    '## Where the points went',
    '',
    '| Area | Points kept | Points lost |',
    '| --- | ---: | --- |',
  );
  for (const category of result.categories) {
    lines.push(
      `| ${CATEGORY_LABEL[category.category]} | ${categoryCell(result, category)} | ` +
        `${categoryLoss(result, category)} |`,
    );
  }

  lines.push('', '## Findings');
  if (result.findings.length === 0) {
    lines.push('', NO_FINDINGS_NOTE);
  } else {
    lines.push('', SEVERITY_NOTE);
  }
  // Grouped by category, in the order of the table above: the table says where the
  // points went, and these sections say why, under the same names.
  for (const category of result.categories) {
    if (category.findings.length === 0) {
      continue;
    }
    lines.push('', `### ${CATEGORY_LABEL[category.category]}`);
    // Strongest first, as the severity note above promises and as the page and the
    // printed document both show them.
    for (const finding of byImpact(category.findings)) {
      lines.push(
        '',
        ...findingSection(
          result,
          finding,
          byId.get(finding.checkId),
          origin,
          markedItems.get(finding.checkId) ?? NO_MARKS,
        ),
      );
    }
  }

  if (result.ignoredFindings.length > 0) {
    lines.push('', '## Marked as intentional', '');
    lines.push(MARKED_SECTION_NOTE);
    for (const finding of byImpact(result.ignoredFindings)) {
      lines.push(
        '',
        ...findingSection(
          result,
          finding,
          byId.get(finding.checkId),
          origin,
          markedItems.get(finding.checkId) ?? NO_MARKS,
          true,
          3,
        ),
      );
    }
  }

  const notRun = withoutMeasurement(result.outcomes);
  if (notRun.length > 0) {
    lines.push('', `## ${NO_MEASUREMENT_HEADING}`, '');
    lines.push(NO_MEASUREMENT_NOTE);
    lines.push('');
    // The reason is what makes a moved score explainable to a reader who only has
    // the file, and checks that share one reason share one line.
    for (const group of noMeasurementGroups(result.outcomes, idToTitle)) {
      lines.push(`- ${andList(group.titles)} - ${group.phrase}`);
    }
  }

  lines.push('', '---', '');
  lines.push(
    `Report by [${VENDOR.name}](${VENDOR.url}). ${VENDOR.invitation} - ` +
      `[${VENDOR.email}](mailto:${VENDOR.email}).`,
  );
  lines.push('');

  return lines.join('\n');
}

/**
 * A category as a slice of the hundred, the way the bar and the app state it.
 *
 * Out of its own hundred, a category read as a fourth scale on a page that already
 * had three; out of the same hundred as the score, the figures can be added up.
 */
function categoryCell(result: ScanResult, category: CategoryScore): string {
  const points = categoryPoints(result, category.category);
  return points === null
    ? '-'
    : `${scoreText(points.worth - points.lost)} / ${scoreText(points.worth)}`;
}

function categoryLoss(result: ScanResult, category: CategoryScore): string {
  const points = categoryPoints(result, category.category);
  if (points === null) {
    return 'nothing measured here';
  }
  // The column header says "Points lost", so the cell is the figure alone.
  return points.lost === 0 ? 'nothing' : scoreText(points.lost);
}

/** What a check is worth of the hundred, and what its finding took of that. */
function worthPhrase(points: HundredPoints | null): string {
  return points === null ? 'nothing' : scoreText(points.worth);
}

function takenPhrase(points: HundredPoints | null): string {
  return points === null ? 'nothing' : scoreText(points.lost);
}

function findingSection(
  /** The whole result: what a check is worth depends on which others ran. */
  result: ScanResult,
  finding: Finding,
  def: CheckDefinition | undefined,
  /** The instance to link to, or null for a report that stands on its own. */
  origin: string | null,
  /** Objects of this finding that are marked as intentional. */
  marked: ReadonlySet<string>,
  /** Whether the whole finding is marked as intentional, and so deducts nothing. */
  ignored = false,
  /** Heading depth, so a finding sits under its category heading. */
  depth = 4,
): string[] {
  const lines: string[] = [];
  const title = def?.title ?? finding.checkId;
  lines.push(`${'#'.repeat(depth)} ${title} (${SEVERITY_LABEL[finding.severity]})`);
  lines.push('');
  lines.push(finding.headline);

  if (finding.evidence.length > 0) {
    lines.push('');
    for (const e of finding.evidence) {
      lines.push(`- ${e.label}: ${e.value}`);
    }
  }

  if (def) {
    lines.push('', def.why);
    lines.push('', `*May be intentional:* ${def.legitimateWhen}`);
    lines.push('', `*What this involves:* ${def.whatItInvolves}`);
    // The terms behind the deduction, so a reader of the file can recompute the
    // score instead of trusting it - in words, since a formula in a forwarded file
    // gets skipped.
    /* The share that is counted, which is the measured one minus what is marked:
       the file has to be recomputable, and a reader who adds up the measured shares
       would not arrive at the score above. */
    const counted = effectiveRatio(finding, marked);
    const markedHere = (finding.items ?? []).filter((i) => marked.has(i.id)).length;
    const points = checkPoints(result, def.category, def.weight, counted);
    lines.push(
      '',
      `*Points:* worth ${worthPhrase(points)} of the hundred, ` +
        `${shareText(finding.ratio)} affected ` +
        `(ratio ${finding.ratio.toFixed(RATIO_DECIMALS)})` +
        (markedHere > 0
          /* Named, not "of them": the share is measured in what the check counted,
             which for some checks is not the thing that was marked - a board is
             marked, cards are counted, and "1 of them" would read as one card. */
          ? `, ${markedHere} ${itemNoun(finding.itemKind, markedHere)} marked as ` +
            `intentional so ` +
            `${percent(counted)} % counted`
          : '') +
        /* A finding marked as intentional deducts nothing, and printing its
           arithmetic as though it counted would contradict the score above. */
        (ignored
          ? ', takes away nothing while marked as intentional'
          : `, takes away ${takenPhrase(points)}`),
    );
  }

  const items = finding.items ?? [];
  if (items.length > 0) {
    if (def?.itemsNamePeople) {
      // This file gets forwarded, so the accounts stay in the app.
      lines.push(
        '',
        `Affected accounts: ${items.length}. The individual accounts are listed ` +
          'in the app and left out here, since this file is meant to be shared.',
      );
    } else {
      /* The kind of thing, not the word from the code: a reader of the file has no
         way to guess what an "object" is here. */
      lines.push(
        '',
        `Affected ${itemNoun(finding.itemKind, items.length)} (${items.length}):`,
      );
      lines.push('');
      for (const item of items.slice(0, ITEMS_SHOWN)) {
        const text = item.detail ? `${item.label} - ${item.detail}` : item.label;
        const href = itemUrl(origin, finding.itemKind, item, finding.checkId);
        const named = href === null ? text : `[${text}](${href})`;
        /* Named like the others, because it is still true of the instance, and
           marked, because the score above does not count it. */
        lines.push(
          marked.has(item.id) ? `- ${named} - marked as intentional` : `- ${named}`,
        );
      }
      // The count above is the real one, so a cut list has to say it is cut.
      if (items.length > ITEMS_SHOWN) {
        lines.push(`- ... and ${items.length - ITEMS_SHOWN} more`);
      }
    }
  }

  if (finding.query !== undefined) {
    /* The number stays checkable, even for someone who only has the file. */
    const href = issueSearchUrl(origin, finding.query);
    /* Named, not just shown: a reader who does not know the syntax could not tell
       that this line was a filter at all. */
    const query = `\`${finding.query}\``;
    lines.push(
      '',
      href === null
        ? `The search behind this number: ${query}`
        : `The search behind this number: [${query}](${href})`,
    );
  }

  return lines;
}
