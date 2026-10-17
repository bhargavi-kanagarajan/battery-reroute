/**
 * Impact_Score and Final_Impact_Score (Req 7.13, 7.15, 7.19, 7.20).
 *
 * Pure: takes the twin and evalDate explicitly, never reads the clock, never
 * mutates its inputs. The four components are the only scoring inputs.
 *
 * Components read the twin's *stored* active nudge set (`twin.nudges`). Callers
 * should reconcile nudges for evalDate first (`reconcileNudges`) so the set is
 * current; the API read path and `acceptReturnOffer` both do this.
 *
 * The score is meant for batteries whose Current_Holder role is Owner (Req 7.13);
 * enforcing that is the caller's job (projection), so these functions stay total.
 */
import { addDays } from './dates';
import { consentStatus, fastChargeShare, returnRecordFor } from './telemetry';
import type { DigitalTwin, FinalImpactScore, ISODate, ImpactComponents, ImpactScore } from './types';

/** Charging_Component is earned when Fast_Charge_Share is at or below this percentage. */
export const CHARGING_COMPONENT_MAX_FCS = 40;
/** Servicing_Component is lost when an active Service_Prompt is older than this many days. */
export const SERVICE_PROMPT_GRACE_DAYS = 30;
/** Points per earned component. */
export const IMPACT_POINTS_PER_COMPONENT = 25;

type ImpactInputs = Pick<DigitalTwin, 'chargingHistory' | 'nudges' | 'consentEvents' | 'returnRecords'>;

/** The four Impact_Score components for `ownerId` on `evalDate`. */
export function impactComponents(twin: ImpactInputs, evalDate: ISODate, ownerId: string): ImpactComponents {
  // Charging: empty (or zero-energy) history counts as 0% (fastChargeShare returns 0).
  const charging = fastChargeShare(twin.chargingHistory, evalDate) <= CHARGING_COMPONENT_MAX_FCS;

  // Servicing: lost only when a Service_Prompt was created strictly more than 30 days before evalDate.
  const cutoff = addDays(evalDate, -SERVICE_PROMPT_GRACE_DAYS);
  const servicing = !twin.nudges.some((n) => n.type === 'Service_Prompt' && n.createdOn < cutoff);

  const consent = consentStatus(twin) === 'granted';

  // Return: offer accepted (ReturnRecord for this Owner) or no Return_Offer issued (no active Return_Incentive).
  const ret =
    returnRecordFor(twin, ownerId) !== undefined || !twin.nudges.some((n) => n.type === 'Return_Incentive');

  return { charging, servicing, consent, return: ret };
}

/** 25 × number of earned components. */
export function impactScore(components: ImpactComponents): ImpactScore {
  const earned =
    Number(components.charging) + Number(components.servicing) + Number(components.consent) + Number(components.return);
  return (earned * IMPACT_POINTS_PER_COMPONENT) as ImpactScore;
}

/**
 * Final_Impact_Score at Return_Offer acceptance (Req 7.19, 7.20): components of the
 * twin as it stands immediately before the handover (nudges already reconciled for
 * `acceptanceDate`), with the Return_Component forced to earned. Always 25..100.
 */
export function finalImpact(
  twinBeforeHandover: ImpactInputs,
  acceptanceDate: ISODate,
  ownerId: string,
): { finalImpactScore: FinalImpactScore; components: ImpactComponents } {
  const components: ImpactComponents = {
    ...impactComponents(twinBeforeHandover, acceptanceDate, ownerId),
    return: true,
  };
  return { finalImpactScore: impactScore(components) as FinalImpactScore, components };
}
