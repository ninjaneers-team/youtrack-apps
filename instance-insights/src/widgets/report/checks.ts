/**
 * The catalog by id, for the parts of the report that only have an id to go on.
 *
 * A stored run carries check ids and the numbers behind them, not the sentences: a
 * trend, a list of movements and a restored report all have to look the title and
 * the reasoning up again in the app that is installed now.
 */

import {CHECKS} from '../../checks/catalog.ts';
import type {CheckDefinition} from '../../types.ts';

export const CHECK_BY_ID = new Map<string, CheckDefinition>(
  CHECKS.map(check => [check.id, check])
);
