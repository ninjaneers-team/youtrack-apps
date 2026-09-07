/**
 * Where the report jumps to.
 *
 * The category table and the findings below it are two screens apart, and the jump
 * between them is the only thing that connects them - so both sides read the
 * target from here rather than each spelling out an id of its own.
 */

import type {Category} from '../../types.ts';

/** Anchor of the findings section as a whole. */
export const FINDINGS_ANCHOR = 'findings';

/** Anchor of a category's findings, shared by the table and the findings section. */
export function findingsAnchor(category: Category): string {
  return `findings-${category}`;
}
