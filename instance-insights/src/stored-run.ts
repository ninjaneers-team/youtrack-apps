/**
 * The last scan, in the shape the app keeps it in.
 *
 * A scan costs the instance a few hundred requests, and until now its findings
 * lived only in the open page: reloading brought the score back and nothing else.
 * They fit comfortably - a whole run measures a few kilobytes, and one storage
 * property holds four megabytes - so the report is kept and the page renders it
 * again without asking the instance anything.
 *
 * Two rules shape what travels:
 *
 * Only what cannot be recomputed. The score, the category scores and the split
 * into counted and marked findings are all functions of the outcomes, and the
 * standing texts of a check - why it matters, when it is legitimate, what
 * resolving it involves, its weight - belong to the installed version of the app.
 * Storing them would freeze a wording that was later improved; rebuilding them
 * from the catalog keeps an old run readable in the app it is opened with. What
 * has to travel is what the instance said: the headline with its numbers, the
 * ratio, the evidence, and the objects that were found.
 *
 * And no accounts. Every other check names configuration - a project key, a board
 * id, a field or group name - which an administrator may mark as intentional and
 * which the app therefore already stores. The licence check names people, and a
 * dated list of who did not use their seat is a record rather than a reading: it
 * would outlive the account it describes and the reason it was made. Its numbers
 * are kept, its names are not, and the report says so.
 */

import type { CheckOutcome, CheckStatus } from './engine.ts';
import type {
  CheckDefinition,
  Evidence,
  Finding,
  FindingItem,
  ItemKind,
  Severity,
} from './types.ts';

const STATUSES: readonly CheckStatus[] = ['finding', 'clean', 'skipped', 'failed'];

/** One check of a stored run: its own id, what came of it, and what it measured. */
export interface StoredCheck {
  id: string;
  status: CheckStatus;
  reason?: string;
  finding?: StoredFinding;
}

export interface StoredFinding {
  severity: Severity;
  headline: string;
  ratio: number;
  total?: number;
  affected?: number;
  itemKind?: ItemKind;
  query?: string;
  evidence: Evidence[];
  items?: FindingItem[];
}

/**
 * What a widget posts when a scan finishes, or when a mark changes its score.
 *
 * One body, two things kept from it: the numbers go on the trend, the findings
 * become the stored run. The handler makes both projections itself rather than
 * trusting this shape.
 */
export interface ScanUpload {
  score: number | null;
  scoreAsMeasured: number | null;
  findings: number;
  at: string;
  requests: number;
  seconds: number;
  throttled: number;
  checks: StoredCheck[];
}

/** A whole run as stored: when it ran, what it cost, and what it found. */
export interface StoredRun {
  at: string;
  requests: number;
  seconds: number;
  throttled: number;
  /**
   * True when the run was too large to keep object by object.
   *
   * A guard rather than a truncation: a half list that presents itself as a whole
   * one is worse than a number and a sentence saying the names were not kept.
   */
  itemsOmitted?: boolean;
  checks: StoredCheck[];
}

/**
 * What the report sends to be kept.
 *
 * The accounts of the licence check are left here rather than only refused by the
 * handler: the report knows the catalog, so there is no reason to put a login on
 * the wire at all. The handler drops them again, because the interface is not the
 * boundary.
 */
export function checksForStorage(
  outcomes: readonly CheckOutcome[],
  definitions: readonly CheckDefinition[],
): StoredCheck[] {
  const namesPeople = new Set(
    definitions.filter(d => d.itemsNamePeople).map(d => d.id),
  );
  return outcomes.map(outcome => {
    const stored: StoredCheck = { id: outcome.checkId, status: outcome.status };
    if (outcome.reason !== undefined) {
      stored.reason = outcome.reason;
    }
    if (outcome.finding !== null) {
      stored.finding = storedFinding(outcome.finding, namesPeople.has(outcome.checkId));
    }
    return stored;
  });
}

function storedFinding(finding: Finding, namesPeople: boolean): StoredFinding {
  const stored: StoredFinding = {
    severity: finding.severity,
    headline: finding.headline,
    ratio: finding.ratio,
    evidence: finding.evidence.map(e => ({ label: e.label, value: e.value })),
  };
  if (finding.total !== undefined) {
    stored.total = finding.total;
  }
  if (finding.affected !== undefined) {
    stored.affected = finding.affected;
  }
  if (finding.itemKind !== undefined) {
    stored.itemKind = finding.itemKind;
  }
  if (finding.query !== undefined) {
    stored.query = finding.query;
  }
  if (!namesPeople && finding.items !== undefined) {
    stored.items = finding.items.map(item => ({
      id: item.id,
      label: item.label,
      ...(item.target === undefined ? {} : { target: item.target }),
      ...(item.detail === undefined ? {} : { detail: item.detail }),
      /* The weight a marked object carries. Left out, the restored run would score
         a marked board as one board out of a list instead of the cards on it. */
      ...(item.affected === undefined ? {} : { affected: item.affected }),
      ...(item.measured === undefined ? {} : { measured: item.measured }),
    }));
  }
  return stored;
}

/**
 * A stored run, back as the outcomes the report renders.
 *
 * Category and weight come from the catalog, so a check the installed app no
 * longer has is left out: it has no weight to score with, and the score of a run
 * is recomputed here, not remembered. A check whose stored status makes no sense
 * is left out for the same reason - the alternative is a score built on a guess.
 */
export function outcomesFromRun(
  run: StoredRun,
  definitions: readonly CheckDefinition[],
): CheckOutcome[] {
  const byId = new Map(definitions.map(d => [d.id, d]));
  const outcomes: CheckOutcome[] = [];
  for (const stored of run.checks) {
    const definition = byId.get(stored.id);
    if (definition === undefined || !STATUSES.includes(stored.status)) {
      continue;
    }
    const finding = stored.status === 'finding' ? restoredFinding(stored) : null;
    if (stored.status === 'finding' && finding === null) {
      continue;
    }
    outcomes.push({
      checkId: stored.id,
      category: definition.category,
      weight: definition.weight,
      status: stored.status,
      finding,
      ...(stored.reason === undefined ? {} : { reason: stored.reason }),
    });
  }
  return outcomes;
}

function restoredFinding(stored: StoredCheck): Finding | null {
  const from = stored.finding;
  if (from === undefined || typeof from.ratio !== 'number') {
    return null;
  }
  return {
    checkId: stored.id,
    severity: from.severity,
    headline: from.headline,
    ratio: from.ratio,
    evidence: from.evidence ?? [],
    ...(from.total === undefined ? {} : { total: from.total }),
    ...(from.affected === undefined ? {} : { affected: from.affected }),
    ...(from.itemKind === undefined ? {} : { itemKind: from.itemKind }),
    ...(from.query === undefined ? {} : { query: from.query }),
    ...(from.items === undefined ? {} : { items: from.items }),
  };
}
