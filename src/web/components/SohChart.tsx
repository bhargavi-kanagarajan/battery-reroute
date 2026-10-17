import { useId } from 'react';
import type { SohPoint } from '../../core/projection';

export const NO_SOH_HISTORY_TEXT = 'No SoH history available' as const;

export interface SohChartProps {
  /** One point per Telemetry reading; rendered in timestamp-ascending order (Req 8.2). */
  series: readonly SohPoint[];
  /** Used in the chart title and table caption. */
  batteryId?: string;
  width?: number;
  height?: number;
}

const PAD = { left: 40, right: 12, top: 12, bottom: 28 };

/** Stable ascending sort by timestamp; the server already sends this order. */
function ascending(series: readonly SohPoint[]): SohPoint[] {
  return series
    .map((p, i) => ({ p, i }))
    .sort((a, b) => (a.p.timestamp < b.p.timestamp ? -1 : a.p.timestamp > b.p.timestamp ? 1 : a.i - b.i))
    .map(({ p }) => p);
}

function shortDate(ts: string): string {
  return ts.slice(0, 10);
}

/**
 * Inline SVG line chart of SoH against time (Req 8.2) with an accessible title and a
 * visually hidden data table as the text alternative. With no points it shows
 * "No SoH history available" instead of the chart (Req 8.3).
 */
export function SohChart({ series, batteryId, width = 480, height = 200 }: SohChartProps) {
  const titleId = useId();
  const descId = useId();
  const subject = batteryId ? ` for ${batteryId}` : '';

  if (series.length === 0) {
    return (
      <p className="br-soh-chart" data-testid="soh-empty">
        {NO_SOH_HISTORY_TEXT}
      </p>
    );
  }

  const points = ascending(series);
  const times = points.map((p) => Date.parse(p.timestamp));
  const tMin = Math.min(...times);
  const tMax = Math.max(...times);
  const plotW = width - PAD.left - PAD.right;
  const plotH = height - PAD.top - PAD.bottom;
  const x = (t: number) => PAD.left + (tMax === tMin ? plotW / 2 : ((t - tMin) / (tMax - tMin)) * plotW);
  const y = (soh: number) => PAD.top + (1 - Math.min(100, Math.max(0, soh)) / 100) * plotH;
  const coords = points.map((p, i) => ({ cx: x(times[i]!), cy: y(p.sohPct), p }));
  const path = coords.map((c, i) => `${i === 0 ? 'M' : 'L'}${c.cx.toFixed(1)},${c.cy.toFixed(1)}`).join(' ');
  const first = points[0]!;
  const last = points[points.length - 1]!;
  const summary =
    `${points.length} reading${points.length === 1 ? '' : 's'} from ${shortDate(first.timestamp)} ` +
    `(${first.sohPct}%) to ${shortDate(last.timestamp)} (${last.sohPct}%).`;

  return (
    <figure className="br-soh-chart">
      <svg
        role="img"
        aria-labelledby={`${titleId} ${descId}`}
        viewBox={`0 0 ${width} ${height}`}
        width={width}
        height={height}
        data-testid="soh-chart"
      >
        <title id={titleId}>{`State of health over time${subject}`}</title>
        <desc id={descId}>{summary}</desc>
        {[0, 50, 80, 100].map((v) => (
          <g key={v} aria-hidden="true">
            <line x1={PAD.left} x2={width - PAD.right} y1={y(v)} y2={y(v)} stroke="#c7ccd4" strokeDasharray="3 3" />
            <text x={PAD.left - 6} y={y(v) + 4} textAnchor="end" fontSize="10" fill="#4a5360">
              {v}%
            </text>
          </g>
        ))}
        <text x={PAD.left} y={height - 8} fontSize="10" fill="#4a5360" aria-hidden="true">
          {shortDate(first.timestamp)}
        </text>
        <text x={width - PAD.right} y={height - 8} textAnchor="end" fontSize="10" fill="#4a5360" aria-hidden="true">
          {shortDate(last.timestamp)}
        </text>
        <path d={path} fill="none" stroke="#0b57d0" strokeWidth="2" aria-hidden="true" />
        {coords.map((c, i) => (
          <circle key={i} cx={c.cx} cy={c.cy} r="3" fill="#0b57d0" data-testid="soh-point" aria-hidden="true" />
        ))}
      </svg>
      <table className="visually-hidden">
        <caption>{`State of health readings${subject}`}</caption>
        <thead>
          <tr>
            <th scope="col">Timestamp</th>
            <th scope="col">SoH (%)</th>
          </tr>
        </thead>
        <tbody>
          {points.map((p, i) => (
            <tr key={i}>
              <td>{p.timestamp}</td>
              <td>{p.sohPct}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </figure>
  );
}
