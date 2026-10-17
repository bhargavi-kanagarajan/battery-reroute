/**
 * FleetView (task 15.5; Req 8.1–8.6, 8.10–8.13).
 */
import { useEffect, useRef, useState } from 'react';
import type { FleetListResponse } from '../apiClient';
import { GatedValue, SohChart, StatusMessage, WithheldMarker } from '../components';
import { isWithheld, type FleetBatteryView } from '../../core/projection';
import { ActionFeedback, Card, consentLabel, formatRemainingLife, useCommand, type RoleViewProps } from './shared';

function FleetBatteryDetail({
  battery,
  props,
  onNotice,
}: {
  battery: FleetBatteryView;
  props: RoleViewProps<FleetListResponse>;
  onNotice: (msg: string) => void;
}) {
  const { ctx, client, refresh, stakeholders } = props;
  const sps = stakeholders.Service_Partner;
  const [spId, setSpId] = useState(sps[0]?.id ?? '');
  const flag = useCommand();
  const handover = useCommand();
  const consent = useCommand();
  const granted = battery.consentStatus === 'granted';
  const flagged = battery.inspectionFlag.flagged ? battery.inspectionFlag : null;
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    ref.current?.scrollIntoView?.({ behavior: 'smooth', block: 'start' });
  }, []);

  return (
    <div ref={ref}>
    <Card title={`Battery ${battery.batteryId}`} testId="fleet-detail">
      <h4>State of health over time</h4>
      {isWithheld(battery.sohSeries) ? (
        <WithheldMarker label="SoH history" />
      ) : (
        <SohChart series={battery.sohSeries} batteryId={battery.batteryId} />
      )}

      <p>
        Safety flag: <strong>{battery.safetyFlag ? 'yes' : 'no'}</strong> · Recent fault:{' '}
        <strong>{battery.recentFault ? 'yes' : 'no'}</strong>
      </p>

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
      </div>
      <ActionFeedback command={consent} />

      <form
        className="br-form"
        onSubmit={(e) => {
          e.preventDefault();
          void flag
            .run(() => client.flagInspection(ctx, battery.batteryId, spId), 'Flagged for inspection.')
            .then((ok) => (ok ? refresh() : undefined));
        }}
      >
        <label>
          Service partner for inspection
          <select value={spId} onChange={(e) => setSpId(e.target.value)}>
            {sps.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
        </label>
        <button type="submit" disabled={flag.busy}>
          Flag for inspection
        </button>
      </form>
      <ActionFeedback command={flag} />

      {flagged ? (
        <div className="br-actions">
          <p>
            Flagged on {flagged.flagDate} for {flagged.servicePartnerName}.
          </p>
          <button
            type="button"
            className="br-primary"
            disabled={handover.busy}
            onClick={() =>
              void handover
                .run(() => client.handOver(ctx, battery.batteryId))
                .then((ok) => {
                  if (!ok) return undefined;
                  onNotice(`Battery ${battery.batteryId} handed over to ${flagged.servicePartnerName}.`);
                  return refresh();
                })
            }
          >
            Hand over to {flagged.servicePartnerName}
          </button>
        </div>
      ) : null}
      <ActionFeedback command={handover} />
    </Card>
    </div>
  );
}

export function FleetView(props: RoleViewProps<FleetListResponse>) {
  const { data } = props;
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const selected = data.batteries.find((b) => b.batteryId === selectedId) ?? null;

  return (
    <div>
      {notice ? <StatusMessage>{notice}</StatusMessage> : null}
      <section className="br-section" aria-labelledby="forecast-heading">
        <h3 id="forecast-heading">Replacement forecast (batteries reaching 80% SoH)</h3>
        <ul className="br-forecast">
          {data.replacementForecast.map((q) => (
            <li key={q.quarter}>
              <span className="br-forecast__label">{q.quarter}</span>
              <span className="br-forecast__count">{q.count}</span>
            </li>
          ))}
        </ul>
      </section>

      <section className="br-section" aria-labelledby="fleet-heading">
        <h3 id="fleet-heading">Fleet batteries (lowest health first)</h3>
        {data.batteries.length === 0 ? (
          <p>No batteries are held by this fleet.</p>
        ) : (
          <div className="br-table-wrap">
            <table className="br-table">
              <thead>
                <tr>
                  <th scope="col">Battery</th>
                  <th scope="col">Health score</th>
                  <th scope="col">SoH</th>
                  <th scope="col">Remaining life</th>
                  <th scope="col">Consent</th>
                  <th scope="col">Inspection</th>
                  <th scope="col">
                    <span className="visually-hidden">Details</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {data.batteries.map((b) => (
                  <tr key={b.batteryId} aria-selected={b.batteryId === selectedId}>
                    <th scope="row">{b.batteryId}</th>
                    <td>
                      <GatedValue label="Health score" value={b.healthScore} render={(v) => (v === null ? 'unknown' : v)} />
                    </td>
                    <td>
                      <GatedValue label="SoH" value={b.soh} render={(v) => (v === null ? 'unknown' : `${v}%`)} />
                    </td>
                    <td>
                      <GatedValue label="Remaining life" value={b.remainingLife} render={formatRemainingLife} />
                    </td>
                    <td>{consentLabel(b.consentStatus)}</td>
                    <td>{b.inspectionFlag.flagged ? `Flagged (${b.inspectionFlag.servicePartnerName})` : '—'}</td>
                    <td>
                      <button type="button" onClick={() => setSelectedId(b.batteryId)} aria-label={`Show details for ${b.batteryId}`}>
                        Details
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {selected ? <FleetBatteryDetail key={selected.batteryId} battery={selected} props={props} onNotice={setNotice} /> : null}
    </div>
  );
}
