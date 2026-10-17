import { useId, useState } from 'react';
import type { FiredRule, RuleName } from '../../core/pathway';
import type { ConsentStatus, EolPathway, Pathway } from '../../core/types';
import { ValidationNotice } from './ValidationNotice';

export const DECISION_SUPPORT_LABEL = 'Decision support' as const;

/** Pathways that require the Validation_Notice next to their name (Req 6.13). */
export function needsValidationNotice(pathway: Pathway | EolPathway | null | undefined): boolean {
  return pathway === 'Second_Life_Review' || pathway === 'Certified_Recycling';
}

/** Human-readable pathway name, e.g. "Second_Life_Review" → "Second Life Review". */
export function pathwayLabel(pathway: Pathway | EolPathway): string {
  return pathway.replace(/_/g, ' ');
}

const RULE_LABELS: Record<RuleName, string> = {
  CERTIFIED_RECYCLING: 'Certified recycling rule',
  MISSING_TELEMETRY: 'Missing telemetry rule',
  INSPECT_REPAIR: 'Inspect / repair rule',
  CONTINUE_USE: 'Continue use rule',
  SECOND_LIFE_REVIEW: 'Second-life review rule',
};

function describeInputs(inputs: FiredRule['inputs']): string {
  const parts: string[] = [];
  if (inputs.soh !== undefined) parts.push(`SoH ${inputs.soh}%`);
  if (inputs.thermalEvents !== undefined) parts.push(`thermal events ${inputs.thermalEvents}`);
  if (inputs.safetyCriticalFaultCode !== undefined) parts.push(`fault code ${inputs.safetyCriticalFaultCode}`);
  if (inputs.recentFaultDate !== undefined) parts.push(`recent fault on ${inputs.recentFaultDate}`);
  if (inputs.telemetryMissing) parts.push('telemetry missing');
  return parts.join(', ');
}

export interface PathwayBadgeProps {
  /** Pathway recommendation (decision support). */
  pathway: Pathway;
  /** Routed_Pathway set by a custody action, shown on its own row when present. */
  routedPathway?: EolPathway | null;
  /** End_Of_Life_Record pathway, shown on its own row when present. */
  eolPathway?: EolPathway | null;
  /** Reason text, e.g. "Telemetry is missing". */
  reason?: string;
  /** Fired rules with their inputs (Req 6.8), rendered in a disclosure. */
  firedRules?: readonly FiredRule[];
  decidingRule?: RuleName;
  /** Data_Confidence_Score shown next to the pathway (Req 7.1, 9.1, 10.1). */
  dataConfidence?: number;
  /** Consent status shown as a separate field next to the score (Req 6.9). */
  consentStatus?: ConsentStatus;
}

/**
 * Pathway name with the "Decision support" label (Req 6.14) and, for Second_Life_Review
 * or Certified_Recycling, the Validation_Notice adjacent to the name (Req 6.13). The
 * Routed_Pathway and End_Of_Life_Record pathway get the same treatment on their own rows.
 * Props are compatible with spreading a `PathwayView` from the server.
 */
export function PathwayBadge({
  pathway,
  routedPathway,
  eolPathway,
  reason,
  firedRules,
  decidingRule,
  dataConfidence,
  consentStatus,
}: PathwayBadgeProps) {
  const [showRules, setShowRules] = useState(false);
  const rulesId = useId();
  return (
    <div className="br-pathway" data-testid="pathway-badge">
      <p className="br-pathway__row">
        <span>Recommended pathway:</span>
        <span className="br-pathway__name" data-testid="pathway-name">
          {pathwayLabel(pathway)}
        </span>
        {needsValidationNotice(pathway) ? <ValidationNotice /> : null}
        <span className="br-pathway__label">{DECISION_SUPPORT_LABEL}</span>
      </p>
      {reason ? <p className="br-pathway__row">Reason: {reason}</p> : null}
      {routedPathway ? (
        <p className="br-pathway__row">
          <span>Routed pathway:</span>
          <span className="br-pathway__name" data-testid="routed-pathway-name">
            {pathwayLabel(routedPathway)}
          </span>
          {needsValidationNotice(routedPathway) ? <ValidationNotice /> : null}
        </p>
      ) : null}
      {eolPathway ? (
        <p className="br-pathway__row">
          <span>End-of-life pathway:</span>
          <span className="br-pathway__name" data-testid="eol-pathway-name">
            {pathwayLabel(eolPathway)}
          </span>
          {needsValidationNotice(eolPathway) ? <ValidationNotice /> : null}
        </p>
      ) : null}
      {dataConfidence !== undefined || consentStatus !== undefined ? (
        <p className="br-pathway__row">
          {dataConfidence !== undefined ? <span>Data confidence: {dataConfidence}/100</span> : null}
          {consentStatus !== undefined ? (
            <span>Consent: {consentStatus === 'granted' ? 'granted' : 'not granted'}</span>
          ) : null}
        </p>
      ) : null}
      {firedRules && firedRules.length > 0 ? (
        <div>
          <button type="button" aria-expanded={showRules} aria-controls={rulesId} onClick={() => setShowRules((v) => !v)}>
            Why this pathway
          </button>
          <ul id={rulesId} hidden={!showRules} aria-label="Rules that fired">
            {firedRules.map((fr) => {
              const inputs = describeInputs(fr.inputs);
              return (
                <li key={fr.rule}>
                  {RULE_LABELS[fr.rule]}
                  {inputs ? ` (${inputs})` : ''}
                  {fr.rule === decidingRule ? ' — deciding rule' : ''}
                </li>
              );
            })}
          </ul>
        </div>
      ) : null}
    </div>
  );
}
