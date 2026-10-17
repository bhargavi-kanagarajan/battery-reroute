/**
 * SecondLifeView (task 15.7; Req 10.1, 10.3–10.6, 10.8).
 */
import { useState, type ReactNode } from 'react';
import type { SecondLifeListResponse } from '../apiClient';
import { GatedValue, PathwayBadge, StatusMessage, ValidationNotice } from '../components';
import type { SecondLifeBatteryView } from '../../core/projection';
import type { ApplicationFit } from '../../core/secondLife';
import {
  ActionFeedback,
  Card,
  Field,
  FieldMessage,
  addDaysLocal,
  todayLocal,
  useCommand,
  type RoleViewProps,
} from './shared';

function fitLabel(fit: ApplicationFit): string {
  if (fit === 'None') return 'None';
  return fit.map((f) => f.replace(/_/g, ' ')).join(' + ');
}

function SecondLifeCard({
  battery,
  props,
  onNotice,
}: {
  battery: SecondLifeBatteryView;
  props: RoleViewProps<SecondLifeListResponse>;
  onNotice: (n: ReactNode) => void;
}) {
  const { ctx, client, refresh, stakeholders } = props;
  const recyclers = stakeholders.Recycler;
  const [recyclerId, setRecyclerId] = useState(recyclers[0]?.id ?? '');
  const [arrival, setArrival] = useState(addDaysLocal(todayLocal(), 7));
  const accept = useCommand();
  const dispatch = useCommand();
  const flagged = battery.safetyHistory.safetyFlag;

  return (
    <Card title={`Battery ${battery.batteryId}`} testId={`slp-battery-${battery.batteryId}`}>
      <dl className="br-fields">
        <Field label="Capacity" value={`${battery.capacityKwh} kWh`} />
        <Field label="SoH" value={<GatedValue label="SoH" value={battery.soh} render={(v) => (v === null ? 'unknown' : `${v}%`)} />} />
        <Field
          label="Usable capacity"
          value={
            <GatedValue
              label="Usable capacity"
              value={battery.usableCapacity}
              render={(v) => (v === null ? 'unknown' : `${v.toFixed(1)} kWh`)}
            />
          }
        />
        <Field
          label="Application fit"
          value={<GatedValue label="Application fit" value={battery.applicationFit} render={fitLabel} />}
        />
        <Field label="Status" value={battery.acceptance} />
      </dl>

      <h4>Safety history</h4>
      <ul>
        <li>Safety flag: {flagged ? 'yes' : 'no'}</li>
        <li>
          Thermal events:{' '}
          <GatedValue
            label="Thermal events"
            value={battery.safetyHistory.thermalEventCount}
            render={(v) => (v === null ? 'unknown' : v)}
          />
        </li>
        {battery.safetyHistory.safetyCriticalFaults.map((f) => (
          <li key={`${f.date}-${f.faultCode}`}>
            Safety-critical fault {f.faultCode} on {f.date}
          </li>
        ))}
      </ul>

      <PathwayBadge {...battery.pathway} dataConfidence={battery.dataConfidence} consentStatus={battery.consentStatus} />

      <div className="br-actions">
        <button
          type="button"
          className="br-primary"
          disabled={flagged || battery.acceptance === 'Accepted' || accept.busy}
          onClick={() =>
            void accept
              .run(() => client.acceptSecondLife(ctx, battery.batteryId), 'Battery accepted for second life.')
              .then((ok) => (ok ? refresh() : undefined))
          }
        >
          Accept for second life
        </button>
        <ValidationNotice />
        {flagged ? <span className="br-note">Safety-flagged batteries cannot be accepted.</span> : null}
      </div>
      <ActionFeedback command={accept} />

      <form
        className="br-form"
        aria-label={`Dispatch ${battery.batteryId} to a recycler`}
        onSubmit={(e) => {
          e.preventDefault();
          void dispatch
            .run(() => client.dispatchToRecycler(ctx, battery.batteryId, { recyclerId, expectedArrivalDate: arrival }))
            .then((ok) => {
              if (!ok) return undefined;
              const name = recyclers.find((r) => r.id === recyclerId)?.name ?? recyclerId;
              onNotice(
                <>
                  Battery {battery.batteryId} dispatched to {name}, arriving {arrival}. <ValidationNotice />
                </>,
              );
              return refresh();
            });
        }}
      >
        <label>
          Recycler
          <select value={recyclerId} onChange={(e) => setRecyclerId(e.target.value)}>
            {recyclers.map((r) => (
              <option key={r.id} value={r.id}>
                {r.name}
              </option>
            ))}
          </select>
        </label>
        <label>
          Expected arrival
          <input type="date" value={arrival} onChange={(e) => setArrival(e.target.value)} />
          <FieldMessage error={dispatch.error} field="expectedArrivalDate" />
        </label>
        <button type="submit" disabled={dispatch.busy}>
          Dispatch to recycler
        </button>
        <ValidationNotice />
      </form>
      <ActionFeedback command={dispatch} />
    </Card>
  );
}

export function SecondLifeView(props: RoleViewProps<SecondLifeListResponse>) {
  const [notice, setNotice] = useState<ReactNode>(null);
  return (
    <div>
      {notice ? <StatusMessage>{notice}</StatusMessage> : null}
      {props.data.batteries.length === 0 ? <p>No batteries are awaiting second-life review.</p> : null}
      {props.data.batteries.map((b) => (
        <SecondLifeCard key={b.batteryId} battery={b} props={props} onNotice={setNotice} />
      ))}
    </div>
  );
}
