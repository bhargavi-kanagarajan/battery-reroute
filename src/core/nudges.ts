/**
 * Nudge_Engine (Req 7.3–7.5, 7.10, 7.16, 7.17).
 *
 * Pure: every function takes the twin, evalDate, and stakeholders explicitly,
 * never reads the clock, and never mutates its inputs. Uses full internal data
 * regardless of Consent (Req 4.11).
 *
 * Nudges are only generated for batteries whose Current_Holder role is Owner;
 * for any other battery the active set is empty.
 */
import { recommendPathway } from './pathway';
import { currentHolder, fallingSohTrend, fastChargeShare, returnRecordFor } from './telemetry';
import type { DigitalTwin, ISODate, Nudge, NudgeType, ReturnOffer, Stakeholder } from './types';

/** Fast_Charge_Share above this (percent) triggers Charging_Guidance (Req 7.3). */
export const CHARGING_GUIDANCE_FCS_THRESHOLD = 40;

/** Output order of the active nudge set. */
export const NUDGE_ORDER: readonly NudgeType[] = ['Charging_Guidance', 'Service_Prompt', 'Return_Incentive'];

/** A nudge whose condition currently holds, before a `createdOn` is attached. */
export type NudgeCondition =
  | { type: 'Charging_Guidance'; message: string }
  | { type: 'Service_Prompt'; message: string }
  | { type: 'Return_Incentive'; message: string; returnOffer: ReturnOffer };

export function returnOfferId(batteryId: string, ownerId: string): string {
  return `${batteryId}:${ownerId}:return`;
}

function returnIncentiveMessage(servicePartnerName: string): string {
  return `Return this battery to ${servicePartnerName} for responsible second-life review or recycling.`;
}

function compareByName(a: Stakeholder, b: Stakeholder): number {
  const byName = a.name.localeCompare(b.name, 'en', { sensitivity: 'base' });
  if (byName !== 0) return byName;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/**
 * Designated Service_Partner for a Return_Offer (Req 7.17): the first by name among
 * Service_Partners in the Owner's state, otherwise the first by name overall.
 * Independent of input order. Throws when there is no Service_Partner at all.
 */
export function designateServicePartner(owner: Stakeholder, servicePartners: readonly Stakeholder[]): Stakeholder {
  const sps = servicePartners.filter((s) => s.role === 'Service_Partner');
  if (sps.length === 0) throw new Error('No Service_Partner available to designate');
  const sameState = sps.filter((s) => s.location.state === owner.location.state);
  const pool = sameState.length > 0 ? sameState : sps;
  return [...pool].sort(compareByName)[0]!;
}

/**
 * Nudge conditions that hold for `twin` on evalDate, in NUDGE_ORDER.
 * Empty unless the Current_Holder role is Owner and `owner` is that holder.
 */
export function nudgeConditions(
  twin: DigitalTwin,
  evalDate: ISODate,
  owner: Stakeholder,
  servicePartners: readonly Stakeholder[],
): NudgeCondition[] {
  const holder = currentHolder(twin.custodyLog);
  if (!holder || holder.toHolderRole !== 'Owner' || holder.toHolderId !== owner.id) return [];

  const out: NudgeCondition[] = [];

  // Charging_Guidance (Req 7.3).
  const sessions = twin.chargingHistory.filter((s) => s.date <= evalDate);
  if (sessions.length >= 1) {
    const fcs = fastChargeShare(twin.chargingHistory, evalDate);
    if (fcs > CHARGING_GUIDANCE_FCS_THRESHOLD) {
      out.push({
        type: 'Charging_Guidance',
        message:
          `Fast charging makes up ${Math.round(fcs)}% of your charging energy. ` +
          'Using AC charging more often can slow battery wear.',
      });
    }
  }

  // Service_Prompt (Req 7.4).
  const trend = fallingSohTrend(twin, evalDate);
  if (trend) {
    out.push({
      type: 'Service_Prompt',
      message:
        `State of health fell ${trend.decline.toFixed(1)} percentage points in the last 180 days. ` +
        'Book a battery check with a service partner.',
    });
  }

  // Return_Incentive (Req 7.5, 7.17).
  if (!returnRecordFor(twin, owner.id) && servicePartners.some((s) => s.role === 'Service_Partner')) {
    const { pathway } = recommendPathway(twin, evalDate);
    if (pathway === 'Second_Life_Review' || pathway === 'Certified_Recycling') {
      const sp = designateServicePartner(owner, servicePartners);
      out.push({
        type: 'Return_Incentive',
        message: returnIncentiveMessage(sp.name),
        returnOffer: {
          offerId: returnOfferId(twin.passport.batteryId, owner.id),
          servicePartnerId: sp.id,
          servicePartnerName: sp.name,
        },
      });
    }
  }

  return out;
}

/**
 * New active nudge set (Req 7.10, 7.16). For each type whose condition holds, an
 * existing active nudge keeps its `createdOn` (and, for Return_Incentive, its
 * Return_Offer) with only the message refreshed; otherwise a nudge is created with
 * `createdOn = evalDate`. Types whose condition no longer holds are dropped.
 * At most one nudge per type, in NUDGE_ORDER. Idempotent for a fixed evalDate.
 */
export function reconcileNudges(
  twin: DigitalTwin,
  evalDate: ISODate,
  owner: Stakeholder,
  servicePartners: readonly Stakeholder[],
): Nudge[] {
  const conditions = nudgeConditions(twin, evalDate, owner, servicePartners);
  const result: Nudge[] = [];
  for (const type of NUDGE_ORDER) {
    const cond = conditions.find((c) => c.type === type);
    if (!cond) continue;
    const existing = twin.nudges.find((n) => n.type === type);
    const createdOn = existing?.createdOn ?? evalDate;
    if (cond.type === 'Return_Incentive') {
      // Keep the original offer only if it was issued to this Owner (same offerId).
      const keep = existing?.type === 'Return_Incentive' && existing.returnOffer.offerId === cond.returnOffer.offerId;
      const returnOffer = keep ? { ...existing.returnOffer } : { ...cond.returnOffer };
      result.push({
        type: 'Return_Incentive',
        createdOn: keep ? existing.createdOn : evalDate,
        message: returnIncentiveMessage(returnOffer.servicePartnerName),
        returnOffer,
      });
    } else {
      result.push({ type: cond.type, createdOn, message: cond.message });
    }
  }
  return result;
}
