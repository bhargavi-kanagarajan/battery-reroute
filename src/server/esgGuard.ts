/**
 * Final leak guard for ESG_Officer responses (Req 3.16, 4.9, 12.8).
 *
 * Projection already strips Owner identities (`esgCustodyEntries`, no Data_Owner field), so
 * this guard should never trip. It checks the serialized body against every Owner-role id and
 * name and, if any appears, replaces the response with a generic INTERNAL error rather than
 * leaking. The details are logged without the identity itself.
 */
import type { DigitalTwin, Stakeholder } from '../core/types';
import { HttpError, INTERNAL_MESSAGE } from './errors';

export interface OwnerIdentities {
  ownerIds: string[];
  ownerNames: string[];
}

/** Owner-role stakeholder ids and names, plus any Owner-role Data_Owner ids on the twins. */
export function ownerIdentities(stakeholders: readonly Stakeholder[], twins: readonly DigitalTwin[] = []): OwnerIdentities {
  const ids = new Set<string>();
  const names = new Set<string>();
  for (const s of stakeholders) {
    if (s.role !== 'Owner') continue;
    ids.add(s.id);
    names.add(s.name);
  }
  for (const t of twins) {
    if (t.dataOwner.role === 'Owner') ids.add(t.dataOwner.id);
    for (const e of t.custodyLog) if (e.toHolderRole === 'Owner') ids.add(e.toHolderId);
  }
  return { ownerIds: [...ids], ownerNames: [...names] };
}

/**
 * Throws `HttpError('INTERNAL')` if any Owner id or name occurs as a substring of the
 * serialized body. `body` may be a string (CSV) or any JSON-serializable value.
 * Empty strings are ignored.
 */
export function assertNoOwnerIdentity(body: unknown, ownerIds: readonly string[], ownerNames: readonly string[]): void {
  const text = typeof body === 'string' ? body : JSON.stringify(body);
  const leaked = [...ownerIds, ...ownerNames].some((needle) => needle.length > 0 && text.includes(needle));
  if (leaked) {
    console.error('ESG guard blocked a response containing an Owner identity');
    throw new HttpError('INTERNAL', INTERNAL_MESSAGE);
  }
}
