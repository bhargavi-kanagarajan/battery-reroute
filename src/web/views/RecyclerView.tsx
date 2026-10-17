/**
 * RecyclerView (task 15.8; Req 11.1–11.3, 11.5, 11.8).
 */
import { useState } from 'react';
import type { RecyclerListResponse } from '../apiClient';
import { ValidationNotice } from '../components';
import type { RecyclerBatteryView } from '../../core/projection';
import { ActionFeedback, Card, Field, FieldMessage, todayLocal, useCommand, type RoleViewProps } from './shared';

export const NO_INCOMING_TEXT = 'No incoming batteries' as const;
export const DEFAULT_MATERIALS = ['lithium', 'nickel', 'cobalt', 'manganese', 'copper', 'aluminum'] as const;

function IntakeForm({ battery, props }: { battery: RecyclerBatteryView; props: RoleViewProps<RecyclerListResponse> }) {
  const { ctx, client, refresh } = props;
  const [date, setDate] = useState(todayLocal());
  const cmd = useCommand();
  return (
    <>
      <form
        className="br-form"
        aria-label={`Log intake for ${battery.batteryId}`}
        onSubmit={(e) => {
          e.preventDefault();
          void cmd.run(() => client.logIntake(ctx, battery.batteryId, date), 'Intake logged.').then((ok) => (ok ? refresh() : undefined));
        }}
      >
        <label>
          Intake date
          <input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
          <FieldMessage error={cmd.error} field="intakeDate" />
        </label>
        <button type="submit" disabled={cmd.busy}>
          Log intake
        </button>
        <ValidationNotice />
      </form>
      <ActionFeedback command={cmd} />
    </>
  );
}

function MaterialsForm({ battery, props }: { battery: RecyclerBatteryView; props: RoleViewProps<RecyclerListResponse> }) {
  const { ctx, client, refresh } = props;
  const [values, setValues] = useState<Record<string, string>>({});
  const cmd = useCommand();
  return (
    <>
      <form
        className="br-form br-form--stack"
        aria-label={`Log materials recovered for ${battery.batteryId}`}
        onSubmit={(e) => {
          e.preventDefault();
          const materials: Record<string, number> = {};
          for (const [k, v] of Object.entries(values)) {
            if (v.trim() !== '') materials[k] = Number(v);
          }
          void cmd
            .run(() => client.logMaterials(ctx, battery.batteryId, materials), 'Materials recovered logged. End-of-life record: Certified Recycling.')
            .then((ok) => (ok ? refresh() : undefined));
        }}
      >
        <fieldset>
          <legend>Materials recovered (kg) — pack mass {battery.packMassKg} kg</legend>
          <div className="br-materials">
            {DEFAULT_MATERIALS.map((m) => (
              <label key={m}>
                {m}
                <input
                  type="number"
                  min={0}
                  step="0.1"
                  inputMode="decimal"
                  value={values[m] ?? ''}
                  onChange={(e) => setValues((prev) => ({ ...prev, [m]: e.target.value }))}
                />
              </label>
            ))}
          </div>
          <FieldMessage error={cmd.error} field="materials" />
        </fieldset>
        <button type="submit" disabled={cmd.busy}>
          Log materials recovered
        </button>
      </form>
      <ActionFeedback command={cmd} />
    </>
  );
}

export function RecyclerView(props: RoleViewProps<RecyclerListResponse>) {
  const { data } = props;
  if (data.batteries.length === 0) return <p>{NO_INCOMING_TEXT}</p>;
  return (
    <div>
      <h3>Incoming batteries (by expected arrival)</h3>
      {data.batteries.map((b) => (
        <Card key={b.batteryId} title={`Battery ${b.batteryId}`} testId={`recycler-battery-${b.batteryId}`}>
          <dl className="br-fields">
            <Field label="Chemistry" value={b.chemistry || 'unknown'} />
            <Field label="Pack mass" value={`${b.packMassKg} kg`} />
            <Field label="Coming from" value={b.location ? `${b.location.city}, ${b.location.state}` : 'unknown'} />
            <Field label="Expected arrival" value={b.expectedArrival ?? 'unknown'} />
            <Field label="Intake status" value={b.intakeStatus === 'Received' ? 'Received' : 'Awaiting intake'} />
          </dl>
          {b.intakeStatus === 'Awaiting_Intake' ? <IntakeForm battery={b} props={props} /> : null}
          {b.intakeStatus === 'Received' ? <MaterialsForm battery={b} props={props} /> : null}
        </Card>
      ))}
    </div>
  );
}
