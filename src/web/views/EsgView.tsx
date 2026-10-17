/**
 * EsgView (task 15.9; Req 12.1, 12.8, 12.13, 12.14, 12.16–12.18).
 */
import { useState } from 'react';
import type { EsgListResponse } from '../apiClient';
import { StatusMessage } from '../components';
import type { Disposition, EsgCustodyEntry, Scope3Report } from '../../core/types';
import { ActionFeedback, consentLabel, todayLocal, useCommand, type RoleViewProps } from './shared';

export const NO_EMISSIONS_STATEMENT = 'This report does not quantify emissions reductions.' as const;
export const NOT_YET_EOL_LABEL = 'not yet at end of life' as const;
export const EMPTY_REPORT_TEXT = 'No batteries match the manufacturer and period.' as const;

const DISPOSITIONS: Disposition[] = ['In_Use', 'Second_Life', 'Recycled', 'Unknown'];
const ROLE_SHORT: Record<EsgCustodyEntry['toRole'], string> = {
  Owner: 'Owner',
  Fleet_Operator: 'Fleet',
  Service_Partner: 'Service partner',
  Second_Life_Provider: 'Second-life provider',
  Recycler: 'Recycler',
};

function CustodySummary({ entries }: { entries: EsgCustodyEntry[] }) {
  return (
    <ol className="br-custody">
      {entries.map((e, i) => (
        <li key={i}>
          {e.date}: {ROLE_SHORT[e.toRole]}
          {e.toHolderName ? ` (${e.toHolderName})` : ''}
        </li>
      ))}
    </ol>
  );
}

function downloadText(filename: string, text: string) {
  const blob = new Blob([text], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function ReportView({ report }: { report: Scope3Report }) {
  return (
    <section className="br-section" aria-labelledby="report-heading" data-testid="scope3-report">
      <h3 id="report-heading">
        Scope 3 Category 12 report: {report.manufacturer}, {report.periodStart} to {report.periodEnd}
      </h3>
      <p className="br-note" role="note">
        {NO_EMISSIONS_STATEMENT}
      </p>
      <ul className="br-forecast">
        {DISPOSITIONS.map((d) => (
          <li key={d}>
            <span className="br-forecast__label">{d.replace(/_/g, ' ')}</span>
            <span className="br-forecast__count">{report.counts[d]}</span>
          </li>
        ))}
      </ul>
      <p>
        <strong>Measured share:</strong> {report.measuredShare}% of batteries past first life have measured end-of-life data.
      </p>
      <p>
        <strong>{report.notYetEolCount}</strong> {NOT_YET_EOL_LABEL} (excluded from the measured share).
      </p>
      {report.rows.length === 0 ? (
        <p>{EMPTY_REPORT_TEXT}</p>
      ) : (
        <div className="br-table-wrap">
          <table className="br-table">
            <thead>
              <tr>
                <th scope="col">Battery</th>
                <th scope="col">Disposition</th>
                <th scope="col">Measurement</th>
                <th scope="col">Data confidence</th>
                <th scope="col">Consent status</th>
                <th scope="col">End-of-life date</th>
              </tr>
            </thead>
            <tbody>
              {report.rows.map((r) => (
                <tr key={r.batteryId}>
                  <th scope="row">{r.batteryId}</th>
                  <td>{r.disposition.replace(/_/g, ' ')}</td>
                  <td>{r.measurementStatus}</td>
                  <td>{r.dataConfidence}</td>
                  <td>{consentLabel(r.consentStatus)}</td>
                  <td>{r.eolDate || '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

export function EsgView(props: RoleViewProps<EsgListResponse>) {
  const { ctx, client, data } = props;
  const year = todayLocal().slice(0, 4);
  const [start, setStart] = useState(`${year}-01-01`);
  const [end, setEnd] = useState(`${year}-12-31`);
  const [report, setReport] = useState<Scope3Report | null>(null);
  const [exported, setExported] = useState<string | null>(null);
  const generate = useCommand();
  const exportCmd = useCommand();

  return (
    <div>
      <section className="br-section" aria-labelledby="report-form-heading">
        <h3 id="report-form-heading">Scope 3 Category 12 report</h3>
        <form
          className="br-form"
          onSubmit={(e) => {
            e.preventDefault();
            setExported(null);
            void generate.run(async () => {
              const res = await client.getScope3Report(ctx, { start, end });
              setReport(res.report);
            });
          }}
        >
          <label>
            Period start
            <input type="date" value={start} onChange={(e) => setStart(e.target.value)} />
          </label>
          <label>
            Period end
            <input type="date" value={end} onChange={(e) => setEnd(e.target.value)} />
          </label>
          <button type="submit" className="br-primary" disabled={generate.busy}>
            Generate report
          </button>
          <button
            type="button"
            disabled={exportCmd.busy}
            onClick={() =>
              void exportCmd.run(async () => {
                const file = await client.downloadScope3Csv(ctx, { start, end });
                downloadText(file.filename, file.csv);
                setExported(file.filename);
              })
            }
          >
            Export CSV
          </button>
        </form>
        <ActionFeedback command={generate} />
        <ActionFeedback command={exportCmd} />
        {exported ? <StatusMessage>Downloaded {exported}.</StatusMessage> : null}
      </section>

      {report ? <ReportView report={report} /> : null}

      <section className="br-section" aria-labelledby="esg-batteries-heading">
        <h3 id="esg-batteries-heading">Batteries sold under this manufacturer</h3>
        {data.batteries.length === 0 ? (
          <p>No batteries for this manufacturer.</p>
        ) : (
          <div className="br-table-wrap">
            <table className="br-table">
              <thead>
                <tr>
                  <th scope="col">Battery</th>
                  <th scope="col">Disposition</th>
                  <th scope="col">Custody (date: holder)</th>
                  <th scope="col">Measurement</th>
                  <th scope="col">Data confidence</th>
                  <th scope="col">Consent status</th>
                </tr>
              </thead>
              <tbody>
                {data.batteries.map((b) => (
                  <tr key={b.batteryId}>
                    <th scope="row">{b.batteryId}</th>
                    <td>{b.disposition.replace(/_/g, ' ')}</td>
                    <td>
                      <CustodySummary entries={b.custodyLog} />
                    </td>
                    <td>{b.measurementStatus}</td>
                    <td>{b.dataConfidence}</td>
                    <td>{consentLabel(b.consentStatus)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}
