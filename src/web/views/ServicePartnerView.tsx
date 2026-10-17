/**
 * ServicePartnerView (task 15.6; Req 9.1, 9.2, 9.6–9.9).
 */
import { useState, type ReactNode } from 'react';
import type { ServicePartnerListResponse } from '../apiClient';
import { PathwayBadge, StatusMessage, ValidationNotice } from '../components';
import { CUSTODY_MOVED_REASON, type ServicePartnerBatteryView } from '../../core/projection';
import {
  ActionFeedback,
  Card,
  FieldMessage,
  addDaysLocal,
  todayLocal,
  useCommand,
  type RoleViewProps,
} from './shared';

function RepairForm({ battery, props }: { battery: ServicePartnerBatteryView; props: RoleViewProps<ServicePartnerListResponse> }) {
  const { ctx, client, refresh } = props;
  const [date, setDate] = useState(todayLocal());
  const [faultCode, setFaultCode] = useState('');
  const [actionTaken, setActionTaken] = useState('');
  const [modules, setModules] = useState<string[]>([]);
  const cmd = useCommand();
  const disabled = !battery.actionsEnabled || cmd.busy;

  return (
    <form
      className="br-form br-form--stack"
      aria-label={`Log repair for ${battery.batteryId}`}
      onSubmit={(e) => {
        e.preventDefault();
        void cmd
          .run(
            () => client.logRepair(ctx, battery.batteryId, { date, faultCode, actionTaken, modulesReplaced: modules }),
            'Repair logged.',
          )
          .then((ok) => {
            if (!ok) return undefined;
            setActionTaken('');
            setFaultCode('');
            setModules([]);
            return refresh();
          });
      }}
    >
      <h4>Log a repair</h4>
      <label>
        Date
        <input type="date" value={date} onChange={(e) => setDate(e.target.value)} disabled={!battery.actionsEnabled} />
        <FieldMessage error={cmd.error} field="date" />
      </label>
      <label>
        Fault code (optional)
        <input value={faultCode} maxLength={32} onChange={(e) => setFaultCode(e.target.value)} disabled={!battery.actionsEnabled} />
      </label>
      <label>
        Action taken
        <textarea value={actionTaken} maxLength={500} onChange={(e) => setActionTaken(e.target.value)} disabled={!battery.actionsEnabled} />
        <FieldMessage error={cmd.error} field="actionTaken" />
      </label>
      <fieldset disabled={!battery.actionsEnabled}>
        <legend>Modules replaced</legend>
        {battery.modules.map((m) => (
          <label key={m.moduleId} className="br-inline">
            <input
              type="checkbox"
              checked={modules.includes(m.moduleId)}
              onChange={(e) =>
                setModules((prev) => (e.target.checked ? [...prev, m.moduleId] : prev.filter((x) => x !== m.moduleId)))
              }
            />
            {m.moduleId}
          </label>
        ))}
        <FieldMessage error={cmd.error} field="modulesReplaced" />
      </fieldset>
      <button type="submit" disabled={disabled}>
        Log repair
      </button>
      <ActionFeedback command={cmd} />
    </form>
  );
}

function RoutingForms({
  battery,
  props,
  onNotice,
}: {
  battery: ServicePartnerBatteryView;
  props: RoleViewProps<ServicePartnerListResponse>;
  onNotice: (n: ReactNode) => void;
}) {
  const { ctx, client, refresh, stakeholders } = props;
  const slps = stakeholders.Second_Life_Provider;
  const recyclers = stakeholders.Recycler;
  const [slpId, setSlpId] = useState(slps[0]?.id ?? '');
  const [recyclerId, setRecyclerId] = useState(recyclers[0]?.id ?? '');
  const [arrival, setArrival] = useState(addDaysLocal(todayLocal(), 7));
  const referral = useCommand();
  const dispatch = useCommand();
  const off = !battery.actionsEnabled;
  const nameOf = (list: { id: string; name: string }[], id: string) => list.find((s) => s.id === id)?.name ?? id;

  return (
    <div className="br-routing">
      <form
        className="br-form"
        aria-label={`Refer ${battery.batteryId} to a second-life provider`}
        onSubmit={(e) => {
          e.preventDefault();
          void referral
            .run(() => client.referToSecondLife(ctx, battery.batteryId, slpId))
            .then((ok) => {
              if (!ok) return undefined;
              onNotice(
                <>
                  Battery {battery.batteryId} referred to {nameOf(slps, slpId)} for second-life review. <ValidationNotice />
                </>,
              );
              return refresh();
            });
        }}
      >
        <label>
          Second-life provider
          <select value={slpId} onChange={(e) => setSlpId(e.target.value)} disabled={off}>
            {slps.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
        </label>
        <button type="submit" disabled={off || referral.busy}>
          Refer to second life
        </button>
        <ValidationNotice />
      </form>
      <ActionFeedback command={referral} />

      <form
        className="br-form"
        aria-label={`Dispatch ${battery.batteryId} to a recycler`}
        onSubmit={(e) => {
          e.preventDefault();
          void dispatch
            .run(() => client.dispatchToRecycler(ctx, battery.batteryId, { recyclerId, expectedArrivalDate: arrival }))
            .then((ok) => {
              if (!ok) return undefined;
              onNotice(
                <>
                  Battery {battery.batteryId} dispatched to {nameOf(recyclers, recyclerId)}, arriving {arrival}. <ValidationNotice />
                </>,
              );
              return refresh();
            });
        }}
      >
        <label>
          Recycler
          <select value={recyclerId} onChange={(e) => setRecyclerId(e.target.value)} disabled={off}>
            {recyclers.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
        </label>
        <label>
          Expected arrival
          <input type="date" value={arrival} onChange={(e) => setArrival(e.target.value)} disabled={off} />
          <FieldMessage error={dispatch.error} field="expectedArrivalDate" />
        </label>
        <button type="submit" disabled={off || dispatch.busy}>
          Dispatch to recycler
        </button>
        <ValidationNotice />
      </form>
      <ActionFeedback command={dispatch} />
    </div>
  );
}

function ServiceBatteryCard({
  battery,
  props,
  onNotice,
}: {
  battery: ServicePartnerBatteryView;
  props: RoleViewProps<ServicePartnerListResponse>;
  onNotice: (n: ReactNode) => void;
}) {
  return (
    <Card
      title={
        <>
          Battery {battery.batteryId}{' '}
          <span className="br-tag">{battery.assignment === 'Assigned' ? 'Assigned' : 'Referred for inspection'}</span>
        </>
      }
      testId={`sp-battery-${battery.batteryId}`}
    >
      {!battery.actionsEnabled && battery.actionsDisabledReason ? (
        <p className="br-note" role="note">
          {battery.actionsDisabledReason}
        </p>
      ) : null}

      <PathwayBadge {...battery.pathway} dataConfidence={battery.dataConfidence} consentStatus={battery.consentStatus} />

      <h4>Modules</h4>
      <ul className="br-modules">
        {battery.modules.map((m) => (
          <li key={m.moduleId}>
            {m.moduleId}: <strong>{m.condition}</strong>
          </li>
        ))}
      </ul>

      <h4>Service history (newest first)</h4>
      {battery.serviceHistory.length === 0 ? (
        <p>No service records.</p>
      ) : (
        <div className="br-table-wrap">
          <table className="br-table">
            <thead>
              <tr>
                <th scope="col">Date</th>
                <th scope="col">Fault code</th>
                <th scope="col">Action taken</th>
                <th scope="col">Modules replaced</th>
              </tr>
            </thead>
            <tbody>
              {battery.serviceHistory.map((r, i) => (
                <tr key={`${r.date}-${i}`}>
                  <td>{r.date}</td>
                  <td>{r.faultCode || '—'}</td>
                  <td>{r.actionTaken || '—'}</td>
                  <td>{r.modulesReplaced.length ? r.modulesReplaced.join(', ') : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {battery.actionsDisabledReason === CUSTODY_MOVED_REASON ? null : (
        <>
          <RepairForm battery={battery} props={props} />
          <RoutingForms battery={battery} props={props} onNotice={onNotice} />
        </>
      )}
    </Card>
  );
}

export function ServicePartnerView(props: RoleViewProps<ServicePartnerListResponse>) {
  const [notice, setNotice] = useState<ReactNode>(null);
  // Batteries this partner can act on first; past ones (custody moved on) last. Stable otherwise.
  const ordered = [...props.data.batteries].sort(
    (a, b) => Number(a.actionsDisabledReason === CUSTODY_MOVED_REASON) - Number(b.actionsDisabledReason === CUSTODY_MOVED_REASON),
  );
  return (
    <div>
      {notice ? <StatusMessage>{notice}</StatusMessage> : null}
      {props.data.batteries.length === 0 ? <p>No batteries are assigned or referred to this service partner.</p> : null}
      {ordered.map((b) => (
        <ServiceBatteryCard key={b.batteryId} battery={b} props={props} onNotice={setNotice} />
      ))}
    </div>
  );
}
