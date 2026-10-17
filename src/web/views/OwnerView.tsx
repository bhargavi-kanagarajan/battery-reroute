/**
 * OwnerView (task 15.4; Req 7.1, 7.2, 7.6–7.9, 7.11, 7.12, 7.14, 7.18, 7.22–7.24).
 */
import { useState } from 'react';
import type { OwnerListResponse } from '../apiClient';
import { GatedValue, PathwayBadge, StatusMessage } from '../components';
import type { ContributingFactor } from '../../core/health';
import type { OwnerBatteryView } from '../../core/projection';
import type { ImpactComponents, OwnerReturnedBatteryView, ReturnConfirmation } from '../../core/types';
import { ActionFeedback, Card, Field, consentLabel, formatRemainingLife, useCommand, type RoleViewProps } from './shared';

export const NO_BATTERIES_HELD_TEXT = 'No batteries are held' as const;
export const IMPACT_DISCLAIMER = 'Reflects owner behaviors; not an emissions-reduction figure' as const;

const COMPONENT_LABELS: Record<keyof ImpactComponents, string> = {
  charging: 'Charging practice',
  servicing: 'Timely servicing',
  consent: 'Data-sharing consent',
  return: 'Responsible return',
};

const FACTOR_LABELS: Record<ContributingFactor['name'], string> = {
  SoH: 'State of health',
  CycleCount: 'Cycle count',
  FastChargeShare: 'Fast-charge share',
  ThermalEvents: 'Thermal events',
};

export function ImpactComponentList({ components }: { components: ImpactComponents }) {
  return (
    <ul className="br-components" aria-label="Impact score components">
      {(Object.keys(COMPONENT_LABELS) as (keyof ImpactComponents)[]).map((k) => (
        <li key={k}>
          {COMPONENT_LABELS[k]}: <strong>{components[k] ? '+25' : '0'}</strong>
          <span className="visually-hidden">{components[k] ? ' (earned)' : ' (not earned)'}</span>
        </li>
      ))}
    </ul>
  );
}

function OwnerBatteryCard({ battery, props }: { battery: OwnerBatteryView; props: OwnerViewProps }) {
  const { ctx, client, refresh } = props;
  const consent = useCommand();
  const accept = useCommand();
  const granted = battery.consentStatus === 'granted';

  return (
    <Card title={`Battery ${battery.batteryId}`} testId={`owner-battery-${battery.batteryId}`}>
      <dl className="br-fields">
        <Field
          label="Health score"
          value={<GatedValue label="Health score" value={battery.healthScore} render={(v) => (v === null ? 'unknown' : `${v}/100`)} />}
        />
        <Field
          label="Remaining life"
          value={<GatedValue label="Remaining life" value={battery.remainingLife} render={formatRemainingLife} />}
        />
        <Field label="Consent" value={consentLabel(battery.consentStatus)} />
      </dl>

      <GatedValue
        label="Contributing factors"
        value={battery.factors}
        render={(factors) => (
          <details>
            <summary>What affects the health score</summary>
            <ul>
              {factors.map((f) => (
                <li key={f.name}>
                  {FACTOR_LABELS[f.name]}: {f.value} (effect {f.effect > 0 ? '+' : ''}
                  {f.effect})
                </li>
              ))}
            </ul>
          </details>
        )}
      />

      <div className="br-impact">
        <p>
          <strong>Impact score: </strong>
          <GatedValue label="Impact score" value={battery.impactScore} render={(v) => `${v}/100`} />
        </p>
        <p className="br-muted">{IMPACT_DISCLAIMER}</p>
        <GatedValue
          label="Impact score components"
          value={battery.impactComponents}
          render={(c) => <ImpactComponentList components={c} />}
        />
      </div>

      <PathwayBadge {...battery.pathway} dataConfidence={battery.dataConfidence} consentStatus={battery.consentStatus} />

      {battery.nudges.length > 0 ? (
        <div className="br-nudges">
          <h4>Suggestions</h4>
          <ul>
            {battery.nudges.map((n) => (
              <li key={n.type}>{n.message}</li>
            ))}
          </ul>
        </div>
      ) : null}

      <div className="br-actions">
        <button
          type="button"
          disabled={consent.busy}
          onClick={() =>
            void consent
              .run(() => client.setConsent(ctx, battery.batteryId, granted ? 'withdraw' : 'grant'))
              .then((ok) => (ok ? refresh() : undefined))
          }
        >
          {granted ? 'Withdraw data-sharing consent' : 'Grant data-sharing consent'}
        </button>

        {battery.returnOffer ? (
          <button
            type="button"
            className="br-primary"
            disabled={accept.busy}
            onClick={() =>
              void accept
                .run(async () => {
                  const res = await client.acceptReturnOffer(ctx, battery.batteryId);
                  props.onReturnAccepted?.(res.confirmation);
                })
                .then((ok) => (ok ? refresh() : undefined))
            }
          >
            Accept return offer to {battery.returnOffer.servicePartnerName}
          </button>
        ) : null}
      </div>
      <ActionFeedback command={consent} />
      <ActionFeedback command={accept} />
    </Card>
  );
}

function ReturnedBatteries({ items }: { items: OwnerReturnedBatteryView[] }) {
  if (items.length === 0) return null;
  return (
    <section aria-labelledby="returned-heading" className="br-section">
      <h3 id="returned-heading">Returned batteries</h3>
      <ul className="br-returned">
        {items.map((r) => (
          <li key={r.batteryId} className="br-card" data-testid={`returned-${r.batteryId}`}>
            <dl className="br-fields">
              <Field label="Battery" value={r.batteryId} />
              <Field label="Returned on" value={r.returnDate} />
              <Field label="Service partner" value={r.servicePartnerName} />
              <Field label="Final impact score" value={`${r.finalImpactScore}/100`} />
            </dl>
            <ImpactComponentList components={r.components} />
          </li>
        ))}
      </ul>
    </section>
  );
}

export type OwnerViewProps = RoleViewProps<OwnerListResponse> & {
  onReturnAccepted?: (c: ReturnConfirmation) => void;
};

export function OwnerView(baseProps: RoleViewProps<OwnerListResponse>) {
  const [confirmation, setConfirmation] = useState<ReturnConfirmation | null>(null);
  const props: OwnerViewProps = { ...baseProps, onReturnAccepted: setConfirmation };
  const { data } = props;
  return (
    <div>
      {confirmation ? (
        <StatusMessage>
          <div className="br-confirmation" data-testid="return-confirmation">
            <strong>{confirmation.message}</strong>
            <span>
              {' '}
              Handed over to {confirmation.servicePartnerName} on {confirmation.acceptanceDate}. Final impact score:{' '}
              {confirmation.finalImpactScore}/100.
            </span>
          </div>
        </StatusMessage>
      ) : null}
      {data.batteries.length === 0 ? <p>{NO_BATTERIES_HELD_TEXT}</p> : null}
      {data.batteries.map((b) => (
        <OwnerBatteryCard key={b.batteryId} battery={b} props={props} />
      ))}
      <ReturnedBatteries items={data.returnedBatteries} />
    </div>
  );
}
