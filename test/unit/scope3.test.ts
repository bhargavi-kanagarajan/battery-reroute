import { describe, expect, it } from 'vitest';
import {
  buildScope3Report,
  dispositionAsOf,
  measuredShare,
  measurementStatusAsOf,
  parseScope3Csv,
  toCsv,
  validatePeriod,
} from '../../src/core/scope3';
import type { CustodyEntry, DigitalTwin, Scope3Report, Stakeholder } from '../../src/core/types';

const MFR = 'Volt Inc';
const PERIOD = { start: '2025-01-01', end: '2025-12-31' };

function twin(id: string, over: Partial<DigitalTwin> = {}): DigitalTwin {
  return {
    passport: {
      batteryId: id,
      chemistry: 'NMC',
      capacityKwh: 60,
      packMassKg: 400,
      manufactureDate: '2022-01-01',
      manufacturer: MFR,
      embeddedCarbonKgCo2e: 5000,
      recycledContentPct: 10,
    },
    modules: [{ moduleId: 'M1', condition: 'Good' }],
    telemetry: [],
    chargingHistory: [],
    serviceHistory: [],
    custodyLog: [{ date: '2022-01-01', fromHolderId: null, toHolderId: 'OWN-001', toHolderRole: 'Owner' }],
    endOfLife: null,
    dataOwner: { id: 'OWN-001', role: 'Owner' },
    consentEvents: [],
    routedPathway: null,
    inspectionFlags: [],
    nudges: [],
    returnRecords: [],
    recyclerIntake: null,
    ...over,
  };
}

const hand = (date: string, from: string, to: string, role: CustodyEntry['toHolderRole']): CustodyEntry => ({
  date,
  fromHolderId: from,
  toHolderId: to,
  toHolderRole: role,
});
const first = (to: string, role: CustodyEntry['toHolderRole']): CustodyEntry => ({
  date: '2022-01-01',
  fromHolderId: null,
  toHolderId: to,
  toHolderRole: role,
});

const stakeholders: Stakeholder[] = [
  { id: 'OWN-001', role: 'Owner', name: 'Pat Owner', location: { city: 'Austin', state: 'TX' } },
  { id: 'SP-001', role: 'Service_Partner', name: 'Alpha Service', location: { city: 'Austin', state: 'TX' } },
  { id: 'SLP-001', role: 'Second_Life_Provider', name: 'ReUse Co', location: { city: 'Reno', state: 'NV' } },
  { id: 'REC-001', role: 'Recycler', name: 'CycleWorks', location: { city: 'Reno', state: 'NV' } },
];

describe('Disposition and Measurement_Status', () => {
  it('assigns each Disposition per rules (a)-(d)', () => {
    const recycledByEol = twin('A', {
      endOfLife: { pathway: 'Certified_Recycling', date: '2025-03-01', receivingPartyId: 'REC-001', materialsRecoveredKg: {} },
    });
    const recycledByHolder = twin('B', {
      custodyLog: [first('OWN-001', 'Owner'), hand('2025-02-01', 'OWN-001', 'REC-001', 'Recycler')],
    });
    const secondLife = twin('C', {
      custodyLog: [first('OWN-001', 'Owner'), hand('2025-02-01', 'OWN-001', 'SLP-001', 'Second_Life_Provider')],
    });
    const inUseSp = twin('D', {
      custodyLog: [first('OWN-001', 'Owner'), hand('2025-02-01', 'OWN-001', 'SP-001', 'Service_Partner')],
    });
    // SP holds custody but an EOL record exists (Second_Life): rule (b).
    const slEolAtSp = twin('E', {
      custodyLog: [first('OWN-001', 'Owner'), hand('2025-02-01', 'OWN-001', 'SP-001', 'Service_Partner')],
      endOfLife: { pathway: 'Second_Life_Review', date: '2025-02-02', receivingPartyId: 'SLP-001', materialsRecoveredKg: {} },
    });
    // No custody entry on or before the period end: Unknown.
    const unknown = twin('F', { custodyLog: [{ ...first('OWN-001', 'Owner'), date: '2026-02-01' }] });

    expect(dispositionAsOf(recycledByEol, PERIOD.end)).toBe('Recycled');
    expect(dispositionAsOf(recycledByHolder, PERIOD.end)).toBe('Recycled');
    expect(dispositionAsOf(secondLife, PERIOD.end)).toBe('Second_Life');
    expect(dispositionAsOf(inUseSp, PERIOD.end)).toBe('In_Use');
    expect(dispositionAsOf(slEolAtSp, PERIOD.end)).toBe('Second_Life');
    expect(dispositionAsOf(unknown, PERIOD.end)).toBe('Unknown');
    expect(dispositionAsOf(twin('G'), PERIOD.end)).toBe('In_Use');

    expect(measurementStatusAsOf(recycledByEol, PERIOD.end)).toBe('Measured');
    expect(measurementStatusAsOf(secondLife, PERIOD.end)).toBe('Measured');
    expect(measurementStatusAsOf(inUseSp, PERIOD.end)).toBe('Estimated');
    expect(measurementStatusAsOf(unknown, PERIOD.end)).toBe('Estimated');
  });

  it('ignores EOL records and handovers dated after the period end', () => {
    const t = twin('A', {
      custodyLog: [first('OWN-001', 'Owner'), hand('2026-01-05', 'OWN-001', 'REC-001', 'Recycler')],
      endOfLife: { pathway: 'Certified_Recycling', date: '2026-02-01', receivingPartyId: 'REC-001', materialsRecoveredKg: {} },
    });
    expect(dispositionAsOf(t, PERIOD.end)).toBe('In_Use');
    expect(measurementStatusAsOf(t, PERIOD.end)).toBe('Estimated');
    expect(dispositionAsOf(t, '2026-03-01')).toBe('Recycled');
  });
});

describe('buildScope3Report', () => {
  it('includes the manufacturer batteries made on or before period end, with counts and share', () => {
    const twins = [
      twin('BR-3', {
        custodyLog: [first('OWN-001', 'Owner'), hand('2024-05-01', 'OWN-001', 'REC-001', 'Recycler')],
        endOfLife: { pathway: 'Certified_Recycling', date: '2024-06-01', receivingPartyId: 'REC-001', materialsRecoveredKg: { Li: 5 } },
        consentEvents: [{ type: 'grant', at: '2024-01-01T00:00:00Z', byId: 'OWN-001' }],
      }),
      twin('BR-1'),
      twin('BR-2'),
      twin('BR-4', { custodyLog: [{ ...first('OWN-001', 'Owner'), date: '2026-01-01' }] }), // Unknown, Estimated
      twin('BR-X', { passport: { ...twin('BR-X').passport, manufacturer: 'Other' } }),
      twin('BR-LATE', { passport: { ...twin('BR-LATE').passport, manufactureDate: '2026-01-01' } }),
    ];
    const report = buildScope3Report(twins, stakeholders, MFR, PERIOD);

    expect(report.rows.map((r) => r.batteryId)).toEqual(['BR-1', 'BR-2', 'BR-3', 'BR-4']);
    expect(report.counts).toEqual({ In_Use: 2, Second_Life: 0, Recycled: 1, Unknown: 1 });
    expect(report.notYetEolCount).toBe(2);
    expect(report.measuredShare).toBe('50.0');

    const br3 = report.rows.find((r) => r.batteryId === 'BR-3')!;
    expect(br3).toMatchObject({
      disposition: 'Recycled',
      measurementStatus: 'Measured',
      dataConfidence: 30,
      consentStatus: 'granted',
      eolDate: '2024-06-01',
    });
    expect(br3.custodyLog).toEqual([
      { date: '2022-01-01', toRole: 'Owner' },
      { date: '2024-05-01', toRole: 'Recycler', toHolderId: 'REC-001', toHolderName: 'CycleWorks' },
    ]);
    expect(report.rows.find((r) => r.batteryId === 'BR-1')!.eolDate).toBe('');

    // No Owner identity and no emissions keys anywhere.
    const json = JSON.stringify(report);
    expect(json).not.toContain('OWN-001');
    expect(json).not.toContain('Pat Owner');
    expect(json.toLowerCase()).not.toMatch(/emission|co2/);
  });

  it('reports zeros and 0.0 for an empty report', () => {
    const report = buildScope3Report([], stakeholders, MFR, PERIOD);
    expect(report.counts).toEqual({ In_Use: 0, Second_Life: 0, Recycled: 0, Unknown: 0 });
    expect(report.notYetEolCount).toBe(0);
    expect(report.measuredShare).toBe('0.0');
    const lines = toCsv(report).split('\r\n');
    expect(lines[0]).toBe('battery_id,disposition,measurement_status,data_confidence_score,consent_status,eol_date');
    expect(lines[1]).toBe('summary_key,summary_value');
    expect(lines).toContain('not yet at end of life,0');
    expect(lines).toContain('measured_share,0.0');
  });
});

describe('measuredShare', () => {
  const row = (disposition: 'In_Use' | 'Recycled' | 'Unknown', measured: boolean) =>
    ({ disposition, measurementStatus: measured ? 'Measured' : 'Estimated' }) as const;

  it('rounds half-up to one decimal and excludes In_Use', () => {
    expect(measuredShare([row('Recycled', true), row('Unknown', false), row('Unknown', false)])).toBe('33.3');
    expect(measuredShare([row('Recycled', true), row('Recycled', true), row('Unknown', false)])).toBe('66.7');
    expect(
      measuredShare([row('In_Use', false), row('In_Use', false), row('In_Use', false), row('Recycled', true)]),
    ).toBe('100.0');
    expect(measuredShare([row('In_Use', false), row('In_Use', true)])).toBe('0.0');
    expect(measuredShare([])).toBe('0.0');
  });
});

describe('validatePeriod', () => {
  it('accepts a valid period and a single-day period', () => {
    expect(validatePeriod('2025-01-01', '2025-12-31')).toEqual({
      ok: true,
      value: { start: '2025-01-01', end: '2025-12-31' },
    });
    expect(validatePeriod('2025-06-01', '2025-06-01').ok).toBe(true);
  });

  it.each([
    [undefined, '2025-12-31', 'start'],
    ['2025-01-01', undefined, 'end'],
    ['2025-02-30', '2025-12-31', 'start'],
    ['2025-01-01', '2025/12/31', 'end'],
    ['2025-06-01', '2025-05-31', 'end'],
  ])('rejects start=%s end=%s', (start, end, field) => {
    const r = validatePeriod(start, end);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.code).toBe('VALIDATION_ERROR');
      expect(r.error.fields?.map((f) => f.field)).toContain(field);
    }
  });
});

describe('CSV export and parse', () => {
  const report: Scope3Report = {
    manufacturer: 'Volt, "Inc."\r\nEU',
    periodStart: '2025-01-01',
    periodEnd: '2025-12-31',
    rows: [
      {
        batteryId: 'BR,"1"\nx',
        disposition: 'Recycled',
        measurementStatus: 'Measured',
        dataConfidence: 85,
        consentStatus: 'granted',
        eolDate: '2025-04-02',
        custodyLog: [{ date: '2025-01-01', toRole: 'Recycler', toHolderId: 'REC-001', toHolderName: 'CycleWorks' }],
      },
      {
        batteryId: 'BR-2',
        disposition: 'In_Use',
        measurementStatus: 'Estimated',
        dataConfidence: 100,
        consentStatus: 'not_granted',
        eolDate: '',
        custodyLog: [],
      },
    ],
    counts: { In_Use: 1, Second_Life: 0, Recycled: 1, Unknown: 0 },
    notYetEolCount: 1,
    measuredShare: '100.0',
  };

  it('writes the expected layout with escaping and no custody columns', () => {
    const csv = toCsv(report);
    expect(csv).toBe(
      [
        'battery_id,disposition,measurement_status,data_confidence_score,consent_status,eol_date',
        '"BR,""1""\nx",Recycled,Measured,85,granted,2025-04-02',
        'BR-2,In_Use,Estimated,100,not_granted,',
        'summary_key,summary_value',
        'manufacturer,"Volt, ""Inc.""\r\nEU"',
        'period_start,2025-01-01',
        'period_end,2025-12-31',
        'count_In_Use,1',
        'count_Second_Life,0',
        'count_Recycled,1',
        'count_Unknown,0',
        'not yet at end of life,1',
        'measured_share,100.0',
        '',
      ].join('\r\n'),
    );
    expect(csv).not.toContain('CycleWorks');
  });

  it('round-trips to an equivalent report', () => {
    const parsed = parseScope3Csv(toCsv(report));
    const { rows, ...summary } = report;
    expect(parsed).toEqual({ ...summary, rows: rows.map(({ custodyLog: _c, ...r }) => r) });
  });

  it('throws on malformed input', () => {
    expect(() => parseScope3Csv('')).toThrow();
    expect(() => parseScope3Csv('battery_id,disposition\r\n')).toThrow();
    const bad = toCsv(report).replace('Recycled,Measured', 'Burned,Measured');
    expect(() => parseScope3Csv(bad)).toThrow();
  });
});
