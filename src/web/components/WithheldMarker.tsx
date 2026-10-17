import type { ReactNode } from 'react';
import { WITHHELD_REASON, isWithheld, type Gated } from '../../core/projection';

export interface WithheldMarkerProps {
  /** Name of the withheld field group (e.g. "Health_Score"), announced before the reason. */
  label?: string;
}

/** Shown in place of an Owner_Data field group the server withheld pending consent (Req 4.6). */
export function WithheldMarker({ label }: WithheldMarkerProps) {
  return (
    <span className="br-withheld" role="note" data-testid="withheld-marker">
      {label ? <span className="visually-hidden">{label}: </span> : null}
      {WITHHELD_REASON}
    </span>
  );
}

export interface GatedValueProps<T> {
  value: Gated<T>;
  /** Renders the value when it was not withheld. */
  render: (value: T) => ReactNode;
  /** Passed to WithheldMarker when the value is withheld. */
  label?: string;
}

/** Renders `render(value)`, or a WithheldMarker when the server returned the withheld marker. */
export function GatedValue<T>({ value, render, label }: GatedValueProps<T>) {
  if (isWithheld(value)) return <WithheldMarker label={label} />;
  return <>{render(value as T)}</>;
}
