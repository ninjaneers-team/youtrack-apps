/**
 * State shared by both widgets, kept in the app's global storage.
 *
 * Why a handler at all, when the scan runs in the frontend: the Host API's own
 * storage keeps values in the visitor's browser and is not tied to a YouTrack
 * account, so a scan started on the report page would leave the dashboard tile
 * claiming no scan had ever run. The last score and the findings an administrator
 * marked as intentional are facts about the instance, so they belong in
 * AppGlobalStorage - YouTrack's mechanism for state owned by the app.
 *
 * What is stored: the numbers of the last twenty-four scans, and the findings of
 * the most recent one - headlines, the counts behind them, and the configuration
 * objects they name. No issue content and no accounts: the ones the licence check
 * names are counted here and never written down. And nothing is passed through -
 * every value is copied under a name this file knows, so a field the report gains
 * tomorrow cannot carry instance content into storage by itself.
 *
 * Extension properties hold primitives, so each structure in here is JSON in a
 * string, and what arrives is `unknown` until it has been checked: a widget of an
 * older version, a hand-edited property and a truncated write are all things this
 * handler survives rather than trusts.
 *
 * Widgets reach these endpoints through src/app-state.ts.
 */

/* The stored shapes are declared once, in the engine, and named here through
   JSDoc: a comment carries no code into the app package, so the handler stays the
   plain JavaScript YouTrack runs, and a change to a stored shape fails the type
   check instead of reaching an instance. */

/** @typedef {import('./stored-run.ts').StoredRun} StoredRun */
/** @typedef {import('./stored-run.ts').StoredCheck} StoredCheck */
/** @typedef {import('./stored-run.ts').StoredFinding} StoredFinding */
/** @typedef {import('./types.ts').FindingItem} FindingItem */
/** @typedef {import('./trend.ts').ScanAggregate} ScanAggregate */
/** @typedef {import('./stored-run.ts').IgnoredItem} IgnoredItem */

/**
 * The properties this app owns, every one of them declared in
 * src/entity-extensions.json. An undeclared write is discarded without an error,
 * so the two sides are compared by a test rather than by attention.
 *
 * @typedef {object} StoredProperties
 * @property {string} [lastScan]
 * @property {string} [lastRun]
 * @property {string} [scanHistory]
 * @property {string} [ignoredChecks]
 * @property {string} [ignoredItems]
 * @property {string | null} [scanStarted] - Cleared with null when a scan ends,
 *   which is the only property this handler ever takes back out.
 */

/**
 * What YouTrack hands a handler. Only the members this file uses are named: a
 * shape that claimed more would be a guess about the platform.
 *
 * @typedef {object} HandlerCtx
 * @property {{ extensionProperties: StoredProperties }} globalStorage
 * @property {{ json(): unknown, headers?: Array<{ name: string, value: string }> }} request
 * @property {{ code: number, json(body: unknown): void }} response
 */

/**
 * How many scan aggregates the trend keeps. An instance gets re-checked monthly at
 * most, so this is a couple of years of history in a few hundred bytes.
 */
const HISTORY_LIMIT = 24;

/**
 * How many single objects may be marked as intentional.
 *
 * Storage is shared by the instance and holds aggregates; a cap keeps a long series
 * of clicks from turning it into a list of everything the instance contains.
 */
const IGNORED_ITEMS_LIMIT = 500;

/**
 * How long the stored run may get before its objects are left out.
 *
 * A property holds 4 194 304 bytes, and YouTrack answers a longer write with an
 * error rather than a shortened value - the scan would fail to save at the moment
 * it succeeded. Measured, a run costs a few kilobytes plus some sixty bytes per
 * named object, so even an instance of a thousand projects stays two orders of
 * magnitude below this. The distance to the real limit is the room a name outside
 * ASCII needs: what is counted here are characters, and one can be three bytes.
 */
const RUN_BYTES_LIMIT = 1048576;

/**
 * Checks whose objects are people.
 *
 * An administrator sees accounts anyway; keeping a dated list of them is something
 * else, because it outlives both the account and the reason it was made. So a
 * login never becomes a stored identifier, while a project key or a board id may.
 * Enforced here rather than only in the interface, because the interface is not
 * the boundary - and `test/backend.test.ts` holds it against the catalog.
 */
const CHECKS_NAMING_PEOPLE = [
  'licensing.inactive-users',
  'governance.open-work-of-blocked-accounts',
];

/**
 * How long an identifier may be before the handler stops believing it.
 *
 * Not a defence against an attacker - only an administrator reaches these
 * endpoints - but a bound on the damage a mistake can do: a wrong value would be
 * copied into storage until the property hits its ceiling, and from then on every
 * write of it fails and the app keeps nothing at all.
 *
 * The number comes from that ceiling: five hundred marked objects of this length
 * are some 125 kilobytes, a thirtieth of what one property holds. Long enough for
 * an id built out of a project key and a field name side by side - our own check
 * IDs are under forty characters - and short enough to refuse a value nobody meant.
 */
const MAX_ID_LENGTH = 250;

/** Checks in one scan. The catalog holds twenty-two; room to grow, not a cap. */
const MAX_CHECKS = 200;

/**
 * The words this app uses for its own values.
 *
 * A list rather than a length, because a status is one of four words: something
 * else is not a longer status but a wrong one, and a wrong one would be kept run
 * after run in a property with no byte budget of its own. The free text of a run -
 * headlines, labels, the reason a check gave - is left at its natural length
 * instead, because the run itself has a budget: over it, the objects are dropped
 * whole rather than a sentence cut in half.
 *
 * `test/backend.test.ts` sends every value the app produces through the handler,
 * so a word added to one of these lists cannot be forgotten here.
 */
/** @type {readonly import('./engine.ts').CheckStatus[]} */
const STATUSES = ['finding', 'clean', 'skipped', 'failed'];
/** @type {readonly import('./types.ts').Severity[]} */
const SEVERITIES = ['critical', 'high', 'medium', 'low'];
/** @type {readonly import('./types.ts').ItemKind[]} */
const ITEM_KINDS = [
  'project',
  'board',
  'field',
  'field-group',
  'value-list',
  'group',
  'account',
];

/**
 * The fields of a value that is an object, or null when it is not one.
 *
 * Reading a field off something that is not an object gives `undefined` rather
 * than an error, and every check below would then pass on a value nobody meant.
 * One named guard instead of one per caller, and the type checker follows it.
 *
 * @param {unknown} value
 * @returns {Record<string, unknown> | null}
 */
function fieldsOf(value) {
  if (value === null || typeof value !== 'object') {
    return null;
  }
  return /** @type {Record<string, unknown>} */ (value);
}

/**
 * The value when it is one of the words we know, or null.
 *
 * @template {string} Word
 * @param {readonly Word[]} known - The values this app accepts.
 * @param {unknown} value
 * @returns {Word | null} The value when it is one of them, null otherwise.
 */
function oneOf(known, value) {
  if (typeof value !== 'string') {
    return null;
  }
  const word = /** @type {Word} */ (value);
  return known.indexOf(word) === -1 ? null : word;
}

/** A timestamp we can put on a trend: ISO 8601 in UTC, as the report sends it. */
const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/;

/**
 * An identifier as stored, or null when it is not one.
 *
 * @param {unknown} value
 * @returns {string | null}
 */
function identifier(value) {
  if (typeof value !== 'string' || value.length === 0 || value.length > MAX_ID_LENGTH) {
    return null;
  }
  return value;
}

/**
 * The request body as the object every endpoint reads fields off.
 *
 * Empty where there is none, because an exception in the sandbox is a 500 with no
 * answer at all, while an empty body fails the checks below by name.
 *
 * @param {HandlerCtx} ctx
 * @returns {Record<string, unknown>}
 */
function bodyOf(ctx) {
  try {
    const body = fieldsOf(ctx.request.json());
    return body === null ? {} : body;
  } catch (e) {
    return {};
  }
}

/**
 * What one property holds, parsed, or null where there is nothing to read.
 *
 * Storage starts out empty, and a value in it was written by some version of this
 * handler - so null covers both, and every reader below starts over on it.
 *
 * @param {HandlerCtx} ctx
 * @param {'lastScan' | 'lastRun' | 'scanHistory' | 'ignoredChecks' | 'ignoredItems'} name
 * @returns {any} Checked by the caller, which knows the fields it needs.
 */
function storedJson(ctx, name) {
  const stored = ctx.globalStorage.extensionProperties[name];
  if (!stored) {
    return null;
  }
  try {
    return JSON.parse(stored);
  } catch (e) {
    return null;
  }
}

/**
 * The checks marked as intentional.
 *
 * Filtered rather than passed on: what is read here is written back on the next
 * mark, so a value nobody meant would settle in storage for good.
 *
 * @param {HandlerCtx} ctx
 * @returns {string[]}
 */
function readIgnored(ctx) {
  const storedChecks = storedJson(ctx, 'ignoredChecks');
  if (!Array.isArray(storedChecks)) {
    return [];
  }
  return storedChecks.filter(function usable(entry) {
    return identifier(entry) !== null;
  });
}

/**
 * The marked objects, as `[{check, item}]`.
 *
 * Stored flat rather than nested, so the handler can copy field by field and a
 * malformed entry can be dropped on its own.
 *
 * @param {HandlerCtx} ctx
 * @returns {IgnoredItem[]}
 */
function readIgnoredItems(ctx) {
  const storedMarks = storedJson(ctx, 'ignoredItems');
  if (!Array.isArray(storedMarks)) {
    return [];
  }
  const rows = [];
  for (let i = 0; i < storedMarks.length; i++) {
    const mark = markOf(storedMarks[i]);
    if (mark !== null) {
      rows.push(mark);
    }
  }
  return rows;
}

/**
 * One stored mark, or null when either half of it is not an identifier.
 *
 * Both halves go through the same gate as a marked check, and for the same reason.
 *
 * @param {unknown} entry
 * @returns {IgnoredItem | null}
 */
function markOf(entry) {
  const fields = fieldsOf(entry);
  if (fields === null) {
    return null;
  }
  const check = identifier(fields.check);
  const item = identifier(fields.item);
  return check !== null && item !== null ? {check: check, item: item} : null;
}

/**
 * The aggregates of the last scan, or null.
 *
 * Dated on the way out as well as on the way in: both widgets turn the timestamp
 * into a date, and one no date can be made of throws while the view renders, which
 * leaves an empty frame that reloading does not cure.
 *
 * @param {HandlerCtx} ctx
 * @returns {ScanAggregate | null}
 */
function readLastScan(ctx) {
  const storedScan = storedJson(ctx, 'lastScan');
  return storedScan && ISO_INSTANT.test(storedScan.at) ? storedScan : null;
}

/**
 * Newest first. Entries without a timestamp cannot be placed on a trend.
 *
 * @param {HandlerCtx} ctx
 * @returns {ScanAggregate[]}
 */
function readHistory(ctx) {
  const storedHistory = storedJson(ctx, 'scanHistory');
  const dated = Array.isArray(storedHistory)
    ? storedHistory.filter(function onATrend(entry) {
      return entry && ISO_INSTANT.test(entry.at);
    })
    : [];
  if (dated.length > 0) {
    return dated;
  }
  // An instance that scanned before the trend existed still has that one scan.
  const last = readLastScan(ctx);
  return last ? [last] : [];
}

/**
 * The per-check part of a scan: our own check ID, the status, and the ratio.
 *
 * Three primitives and nothing else, because twenty-four scans of them are kept -
 * so the trend stays as small as it was before the findings were kept beside it.
 *
 * @param {unknown} sentChecks
 * @returns {ScanAggregate['checks']}
 */
function checkAggregates(sentChecks) {
  if (!Array.isArray(sentChecks)) {
    return [];
  }
  return sentChecks
    .slice(0, MAX_CHECKS)
    .filter(function usable(entry) {
      return entry && identifier(entry.id) !== null && oneOf(STATUSES, entry.status);
    })
    .map(function aggregate(entry) {
      const finding = entry.finding;
      return {
        id: String(entry.id),
        status: String(entry.status),
        ratio: finding ? Number(finding.ratio) || 0 : 0
      };
    });
}

/**
 * When a scan was last started, or null.
 *
 * The value only ever becomes a sentence about age, and a sentence about a broken
 * value would be worse than no sentence - so anything else counts as nothing.
 *
 * @param {HandlerCtx} ctx
 * @returns {string | null}
 */
function readScanStarted(ctx) {
  // The one property that is a plain value rather than JSON.
  const stored = ctx.globalStorage.extensionProperties.scanStarted;
  return typeof stored === 'string' && ISO_INSTANT.test(stored) ? stored : null;
}

/**
 * The findings of the last scan, or null when none were kept or they are broken.
 *
 * @param {HandlerCtx} ctx
 * @returns {StoredRun | null}
 */
function readLastRun(ctx) {
  const storedRun = storedJson(ctx, 'lastRun');
  // Dated like the aggregates, and for the same reason: the report renders it.
  return storedRun && Array.isArray(storedRun.checks) && ISO_INSTANT.test(storedRun.at)
    ? storedRun
    : null;
}

/**
 * Copies a number under a name this app knows, when there is one to copy.
 *
 * The numbers of a finding and of each object it names are optional in the same
 * way: absent stays absent, present becomes a number.
 *
 * @param {object} target - Cast once here rather than at each of the callers.
 * @param {string} name
 * @param {unknown} value
 * @returns {void}
 */
function copyNumber(target, name, value) {
  if (value !== undefined && value !== null) {
    /** @type {Record<string, unknown>} */ (target)[name] = Number(value);
  }
}

/**
 * The same for the texts the app writes itself: a sentence, a label, a key.
 *
 * @param {object} target - Cast once here rather than at each of the callers.
 * @param {string} name
 * @param {unknown} value
 * @returns {void}
 */
function copyText(target, name, value) {
  if (value) {
    /** @type {Record<string, unknown>} */ (target)[name] = String(value);
  }
}

/**
 * The findings of one scan, rebuilt field by field.
 *
 * @param {unknown} sentChecks
 * @param {boolean} withItems - False leaves every object list out.
 * @returns {StoredCheck[]}
 */
function runChecks(sentChecks, withItems) {
  if (!Array.isArray(sentChecks)) {
    return [];
  }
  const checks = [];
  const upTo = Math.min(sentChecks.length, MAX_CHECKS);
  for (let i = 0; i < upTo; i++) {
    const check = runCheck(sentChecks[i], withItems);
    if (check !== null) {
      checks.push(check);
    }
  }
  return checks;
}

/**
 * What a stored check is made of besides its finding, or null when it is not one.
 *
 * @param {Record<string, unknown>} entry
 * @returns {StoredCheck | null}
 */
function checkShell(entry) {
  const status = entry ? oneOf(STATUSES, entry.status) : null;
  if (status === null || identifier(entry.id) === null) {
    return null;
  }
  const check = {id: String(entry.id), status: status};
  copyText(check, 'reason', entry.reason);
  return check;
}

/**
 * One check of a run, or null when nothing about it can be shown.
 *
 * @param {unknown} entry
 * @param {boolean} withItems
 * @returns {StoredCheck | null}
 */
function runCheck(entry, withItems) {
  const fields = fieldsOf(entry);
  const check = fields === null ? null : checkShell(fields);
  if (fields === null || check === null || !fields.finding) {
    return check;
  }
  // Never the objects of a check whose subject is people, whatever was sent.
  const named = CHECKS_NAMING_PEOPLE.indexOf(check.id) === -1;
  const finding = runFinding(fields.finding, withItems && named);
  /* A finding without a severity cannot be shown the way the report shows one -
     it sorts by it and colours by it - so the check is left out rather than
     restored as a finding that says nothing. */
  if (finding === null) {
    return null;
  }
  check.finding = finding;
  return check;
}

/**
 * One finding as stored, field by field, or null when it is not one.
 *
 * @param {unknown} sentFinding
 * @param {boolean} withItems
 * @returns {NonNullable<StoredCheck['finding']> | null}
 */
function runFinding(sentFinding, withItems) {
  const fields = fieldsOf(sentFinding);
  if (fields === null) {
    return null;
  }
  const severity = oneOf(SEVERITIES, fields.severity);
  if (severity === null) {
    return null;
  }
  /** @type {NonNullable<StoredCheck['finding']>} */
  const finding = {
    severity: severity,
    headline: String(fields.headline),
    ratio: Number(fields.ratio) || 0,
    evidence: runEvidence(fields.evidence)
  };
  copyNumber(finding, 'total', fields.total);
  copyNumber(finding, 'affected', fields.affected);
  copyText(finding, 'query', fields.query);
  /* An unknown kind is dropped rather than kept: the report turns the kind into a
     link, and a name without a link is still true of the instance. */
  const kind = oneOf(ITEM_KINDS, fields.itemKind);
  if (kind !== null) {
    finding.itemKind = kind;
  }
  if (withItems && Array.isArray(fields.items)) {
    finding.items = runItems(fields.items);
  }
  return finding;
}

/**
 * The labelled numbers under a headline, as stored.
 *
 * @param {unknown} sentEvidence
 * @returns {NonNullable<StoredFinding['evidence']>}
 */
function runEvidence(sentEvidence) {
  if (!Array.isArray(sentEvidence)) {
    return [];
  }
  const rows = [];
  for (let i = 0; i < sentEvidence.length; i++) {
    const entry = sentEvidence[i];
    if (!entry || entry.label === undefined) {
      continue;
    }
    const value = typeof entry.value === 'number' ? Number(entry.value) : String(entry.value);
    rows.push({label: String(entry.label), value: value});
  }
  return rows;
}

/**
 * The objects a finding names, as stored.
 *
 * @param {readonly unknown[]} sentItems
 * @returns {FindingItem[]}
 */
function runItems(sentItems) {
  /** @type {FindingItem[]} */
  const rows = [];
  for (let i = 0; i < sentItems.length; i++) {
    const item = runItem(sentItems[i]);
    if (item !== null) {
      rows.push(item);
    }
  }
  return rows;
}

/**
 * One object a finding names, or null when it carries no id to mark it by.
 *
 * @param {unknown} entry
 * @returns {FindingItem | null}
 */
function runItem(entry) {
  const fields = fieldsOf(entry);
  // The id is what a mark is stored under later, so it goes through the same gate.
  if (fields === null || identifier(fields.id) === null) {
    return null;
  }
  /** @type {FindingItem} */
  const item = {id: String(fields.id), label: String(fields.label)};
  copyText(item, 'target', fields.target);
  copyText(item, 'detail', fields.detail);
  // A search made of project keys and a field name, never of anything a person wrote.
  copyText(item, 'query', fields.query);
  /* The score depends on these two: without them a marked board comes back
     weighing the same as any other, and the restored score would not be the one
     that was shown. */
  copyNumber(item, 'affected', fields.affected);
  copyNumber(item, 'measured', fields.measured);
  return item;
}

/**
 * Writes the findings of one scan, with their objects if they fit.
 *
 * Over budget the objects are dropped whole rather than shortened - half a list
 * that presents itself as a whole one is worse than a count saying the names were
 * not kept - and if that still does not fit, the older run stays.
 *
 * @param {HandlerCtx} ctx
 * @param {Record<string, unknown>} body
 * @returns {StoredRun | null} The run as stored, or the previous one when this did not fit.
 */
function writeRun(ctx, body) {
  /** @type {StoredRun} */
  const run = {
    at: String(body.at),
    requests: Number(body.requests) || 0,
    seconds: Number(body.seconds) || 0,
    throttled: Number(body.throttled) || 0,
    checks: runChecks(body.checks, true)
  };
  if (run.checks.length === 0) {
    // A body without checks would replace a readable report with an empty one.
    return readLastRun(ctx);
  }
  if (JSON.stringify(run).length > RUN_BYTES_LIMIT) {
    run.itemsOmitted = true;
    run.checks = runChecks(body.checks, false);
    if (JSON.stringify(run).length > RUN_BYTES_LIMIT) {
      return readLastRun(ctx);
    }
  }
  ctx.globalStorage.extensionProperties.lastRun = JSON.stringify(run);
  return run;
}

/**
 * Puts one scan on the trend.
 *
 * Marking a finding as intentional re-scores the scan that is already stored, and
 * the report saves it again under the same timestamp. That revises the newest point
 * instead of inventing a second one, so the trend counts scans, not clicks.
 *
 * @param {ScanAggregate[]} history
 * @param {ScanAggregate} aggregate
 * @returns {ScanAggregate[]}
 */
function withScan(history, aggregate) {
  const kept = history.filter(function other(entry) {
    return entry.at !== aggregate.at;
  });
  kept.push(aggregate);
  // Sorted rather than prepended: the report may also mark a finding of a run it
  // read back from storage, which is not always the newest point on the trend.
  kept.sort(function newestFirst(a, b) {
    return a.at < b.at ? 1 : -1;
  });
  return kept.slice(0, HISTORY_LIMIT);
}

/**
 * The host this instance was addressed under.
 *
 * A widget knows a host from its own base but not whether that is the instance -
 * in the development entry it is a dev server. The handler sees the request, so
 * the report can compare the two and leave its links out where they disagree.
 *
 * @param {HandlerCtx} ctx
 * @returns {string | null}
 */
function requestedHost(ctx) {
  const headers = (ctx.request && ctx.request.headers) || [];
  /* Without a prototype, because the keys come from outside: a header called
     "toString" would otherwise read back as a function that every object carries. */
  const byName = Object.create(null);
  for (let i = 0; i < headers.length; i++) {
    byName[String(headers[i].name).toLowerCase()] = headers[i].value;
  }
  // A proxy in front of the instance names the host the browser actually asked for.
  return byName['x-forwarded-host'] || byName.host || null;
}

/**
 * A number, or null where there is none to have.
 *
 * A score is null when not a single check ran, so absent is a value here. Anything
 * that is not a number becomes absent too rather than NaN, which JSON writes as
 * null and the trend would read back as a point at no height.
 *
 * @param {unknown} value
 * @returns {number | null}
 */
function numberOrNull(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

/**
 * Marks one object of one check, or takes the mark off again.
 *
 * @param {HandlerCtx} ctx
 * @param {string} checkId - Already through `identifier`, at the endpoint.
 * @param {string} item - The same.
 * @param {boolean} ignored - True adds the mark, false takes it off.
 * @returns {void} It answers on the response rather than returning the marks.
 */
function markItem(ctx, checkId, item, ignored) {
  if (CHECKS_NAMING_PEOPLE.indexOf(checkId) !== -1) {
    ctx.response.code = 400;
    ctx.response.json({
      error: 'The objects of this check are accounts, and accounts are not stored.'
    });
    return;
  }
  const kept = readIgnoredItems(ctx).filter(function keep(entry) {
    return entry.check !== checkId || entry.item !== item;
  });
  if (ignored) {
    if (kept.length >= IGNORED_ITEMS_LIMIT) {
      ctx.response.code = 400;
      ctx.response.json({
        error: 'This instance has reached the number of objects that can be marked.'
      });
      return;
    }
    kept.push({check: checkId, item: item});
  }
  ctx.globalStorage.extensionProperties.ignoredItems = JSON.stringify(kept);
  ctx.response.json({ignoredChecks: readIgnored(ctx), ignoredItems: kept});
}

exports.httpHandler = {
  endpoints: [
    {
      method: 'GET',
      path: 'state',
      /* Low-level Admin Write, which is what this key stands for and what both
         widgets ask for as well. The stored run is the reason: it was collected
         with an administrator's reach, and this endpoint hands it to whoever may
         call it. One key, not a list - YouTrack reads a list as "any of these". */
      permissions: ['ADMIN_UPDATE_APP'],
      /** @param {HandlerCtx} ctx @returns {void} */
      handle: function handle(ctx) {
        ctx.response.json({
          lastScan: readLastScan(ctx),
          lastRun: readLastRun(ctx),
          ignoredChecks: readIgnored(ctx),
          ignoredItems: readIgnoredItems(ctx),
          history: readHistory(ctx),
          scanStarted: readScanStarted(ctx),
          host: requestedHost(ctx)
        });
      }
    },
    {
      method: 'POST',
      path: 'scan',
      permissions: ['ADMIN_UPDATE_APP'],
      /** @param {HandlerCtx} ctx @returns {void} */
      handle: function handle(ctx) {
        const body = bodyOf(ctx);
        /* Every stored value hangs off this timestamp: the trend is ordered by it,
           and marking a finding revises the point that carries it. Something that
           is not a timestamp would sit in storage forever without ever matching. */
        if (typeof body.at !== 'string' || !ISO_INSTANT.test(body.at)) {
          ctx.response.code = 400;
          ctx.response.json({error: 'at must be an ISO 8601 instant in UTC.'});
          return;
        }
        const aggregate = {
          score: numberOrNull(body.score),
          // What the instance measured, before anything was marked as intentional.
          scoreAsMeasured: numberOrNull(body.scoreAsMeasured),
          // A count, and every other number of a scan is read the same way.
          findings: Number(body.findings) || 0,
          at: String(body.at),
          checks: checkAggregates(body.checks)
        };
        const history = withScan(readHistory(ctx), aggregate);
        ctx.globalStorage.extensionProperties.lastScan = JSON.stringify(aggregate);
        ctx.globalStorage.extensionProperties.scanHistory = JSON.stringify(history);
        // The findings of this scan, so that reopening the report does not mean
        // asking the instance the same few hundred questions again.
        const run = writeRun(ctx, body);
        ctx.response.json({lastScan: aggregate, history: history, lastRun: run});
      }
    },
    {
      method: 'POST',
      path: 'started',
      permissions: ['ADMIN_UPDATE_APP'],
      /* A note that a scan is under way, not a lock. Both widgets can scan, and two
         scans at once ask the instance everything twice; this is what lets the
         second one say so first. Deliberately without a lease: a scan whose browser
         went away would otherwise block the app until an invented expiry passed. */
      /** @param {HandlerCtx} ctx @returns {void} */
      handle: function handle(ctx) {
        const body = bodyOf(ctx);
        if (typeof body.at !== 'string' || !ISO_INSTANT.test(body.at)) {
          ctx.response.code = 400;
          ctx.response.json({error: 'at must be an ISO 8601 instant in UTC.'});
          return;
        }
        if (body.done) {
          // Only its own mark: with two scans running, the first to finish must not
          // report the other one as over.
          if (readScanStarted(ctx) === body.at) {
            ctx.globalStorage.extensionProperties.scanStarted = null;
          }
        } else {
          ctx.globalStorage.extensionProperties.scanStarted = String(body.at);
        }
        ctx.response.json({scanStarted: readScanStarted(ctx)});
      }
    },
    {
      method: 'POST',
      path: 'ignore',
      permissions: ['ADMIN_UPDATE_APP'],
      /** @param {HandlerCtx} ctx @returns {void} */
      handle: function handle(ctx) {
        const body = bodyOf(ctx);
        const checkId = identifier(body.checkId);
        if (checkId === null) {
          ctx.response.code = 400;
          ctx.response.json({error: 'checkId must be an identifier of this app.'});
          return;
        }
        // With an item, the request is about that one object of the check.
        if (body.item !== undefined && body.item !== null) {
          const item = identifier(body.item);
          if (item === null) {
            ctx.response.code = 400;
            ctx.response.json({error: 'item must be the id of a configuration object.'});
            return;
          }
          markItem(ctx, checkId, item, Boolean(body.ignored));
          return;
        }
        const ignored = readIgnored(ctx).filter(function keep(id) {
          return id !== checkId;
        });
        if (body.ignored) {
          /* The same bound as the number of checks in a scan: a list of marked
             checks longer than that is not a decision about this app any more, and
             an unbounded one would grow until every write of the property fails. */
          if (ignored.length >= MAX_CHECKS) {
            ctx.response.code = 400;
            ctx.response.json({
              error: 'This instance has reached the number of checks that can be marked.'
            });
            return;
          }
          ignored.push(checkId);
        }
        ctx.globalStorage.extensionProperties.ignoredChecks = JSON.stringify(ignored);
        ctx.response.json({ignoredChecks: ignored, ignoredItems: readIgnoredItems(ctx)});
      }
    }
  ]
};
