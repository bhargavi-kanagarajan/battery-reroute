/**
 * Persists nudge reconciliation caused by reads (Req 7.10, 7.16).
 *
 * Reconciliation is the only write a read can cause. It is re-run inside the repository's
 * write queue on the *current* stored twin, so a read that raced with a command (for example
 * a Return_Offer acceptance that removed the Return_Incentive) never writes stale nudges back.
 * Nothing is written when the reconciled set equals the stored set, so repeated reads on the
 * same evaluation date write at most once.
 */
import { evaluateDerived } from '../core/projection';
import type { DigitalTwin, DomainError, ISODate, Stakeholder, ViewerContext } from '../core/types';
import type { Repository } from './repo';

/** Sentinel returned by the mutator to abort the write when nothing changed. */
const UNCHANGED: DomainError = { code: 'INTERNAL', message: 'nudges unchanged' };

export async function persistReconciledNudges(
  repo: Repository,
  batteryIds: readonly string[],
  evalDate: ISODate,
  viewer: ViewerContext,
  stakeholders: readonly Stakeholder[],
): Promise<void> {
  for (const id of batteryIds) {
    const result = await repo.updateTwin(id, (current: DigitalTwin) => {
      const d = evaluateDerived(current, evalDate, viewer, stakeholders);
      if (!d.nudgesChanged) return { ok: false, error: UNCHANGED };
      return { ok: true, value: { ...current, nudges: d.nudges } };
    });
    // UNCHANGED and NOT_FOUND (twin removed concurrently) are both fine to ignore.
    if (!result.ok && result.error !== UNCHANGED && result.error.code !== 'NOT_FOUND') {
      throw new Error(`Failed to persist reconciled nudges for ${id}: ${result.error.code}`);
    }
  }
}
