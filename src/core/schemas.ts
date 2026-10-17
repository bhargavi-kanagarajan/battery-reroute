/**
 * Zod schemas for Battery ReRoute (Req 1.1–1.9) and the append-only guard (Req 1.13, 4.13, 7.21).
 *
 * Pure module: no Node, Express, or React imports. The schemas mirror `types.ts`; the
 * compile-time checks at the bottom of the file fail the typecheck if they drift apart.
 */
import { z } from 'zod';
import type {
  BatteryPassport,
  ChargingSession,
  CustodyEntry,
  DigitalTwin,
  DomainError,
  FieldError,
  Module,
  Result,
  ServiceRecord,
  Stakeholder,
  Store,
  TelemetryReading,
} from './types';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Fixed list of Safety_Critical_Fault_Codes defined by the Platform. */
export const SAFETY_CRITICAL_FAULT_CODES = [
  'THERMAL_RUNAWAY',
  'CELL_VENTING',
  'INTERNAL_SHORT',
  'ISOLATION_FAULT',
  'BMS_OVERTEMP',
] as const;

export type SafetyCriticalFaultCode = (typeof SAFETY_CRITICAL_FAULT_CODES)[number];

export const ROLES = [
  'Owner',
  'Fleet_Operator',
  'Service_Partner',
  'Second_Life_Provider',
  'Recycler',
  'ESG_Officer',
] as const;

export const HOLDER_ROLES = [
  'Owner',
  'Fleet_Operator',
  'Service_Partner',
  'Second_Life_Provider',
  'Recycler',
] as const;

// ---------------------------------------------------------------------------
// Primitive schemas
// ---------------------------------------------------------------------------

/** True when `s` is a real calendar date in `YYYY-MM-DD` form. */
export function isValidIsoDate(s: string): boolean {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!m) return false;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  if (mo < 1 || mo > 12 || d < 1) return false;
  const leap = (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][mo - 1] ?? 0;
  return d <= days;
}

export const isoDateSchema = z
  .string({ required_error: 'Required' })
  .refine(isValidIsoDate, { message: 'Must be a valid calendar date (YYYY-MM-DD)' });

export const isoDateTimeSchema = z
  .string({ required_error: 'Required' })
  .datetime({ offset: true, message: 'Must be a valid ISO timestamp' });

const nonNegInt = z.number({ required_error: 'Required' }).int('Must be an integer').min(0, 'Must be 0 or greater');

export const batteryIdSchema = z
  .string({ required_error: 'Required' })
  .min(1, 'Must be 1 to 64 characters')
  .max(64, 'Must be 1 to 64 characters');

export const roleSchema = z.enum(ROLES);
export const holderRoleSchema = z.enum(HOLDER_ROLES);
export const eolPathwaySchema = z.enum(['Second_Life_Review', 'Certified_Recycling']);
export const chargeTypeSchema = z.enum(['DC_Fast', 'AC']);
export const moduleConditionSchema = z.enum(['Good', 'Degraded', 'Failed']);

// ---------------------------------------------------------------------------
// Battery_Passport (Req 1.1, 1.2)
// ---------------------------------------------------------------------------

export interface SchemaOptions {
  /** Date of the write request; the manufacture date must not be later. */
  writeDate: string;
  /**
   * Seeded twins may have empty Battery_Passport string fields (Req 2.5) and
   * Service_History action text of 0 characters (Req 1.5).
   */
  seeded?: boolean;
}

export function passportSchema(opts: SchemaOptions) {
  const { writeDate, seeded = false } = opts;
  const chemistry = seeded
    ? z.string({ required_error: 'Required' }).max(64, 'Must be at most 64 characters')
    : z.string({ required_error: 'Required' }).min(1, 'Must be 1 to 64 characters').max(64, 'Must be 1 to 64 characters');
  const manufacturer = seeded
    ? z.string({ required_error: 'Required' }).max(128, 'Must be at most 128 characters')
    : z
        .string({ required_error: 'Required' })
        .min(1, 'Must be 1 to 128 characters')
        .max(128, 'Must be 1 to 128 characters');
  const datedOk = isoDateSchema.refine((d) => d <= writeDate, {
    message: 'Must not be later than the write date',
  });
  const manufactureDate = seeded ? z.union([z.literal(''), datedOk]) : datedOk;

  return z.object({
    batteryId: batteryIdSchema,
    chemistry,
    capacityKwh: z
      .number({ required_error: 'Required' })
      .gt(0, 'Must be greater than 0')
      .max(500, 'Must be at most 500'),
    packMassKg: z.number({ required_error: 'Required' }).gt(0, 'Must be greater than 0'),
    manufactureDate,
    manufacturer,
    embeddedCarbonKgCo2e: z.number({ required_error: 'Required' }).min(0, 'Must be 0 or greater'),
    recycledContentPct: z
      .number({ required_error: 'Required' })
      .min(0, 'Must be between 0 and 100')
      .max(100, 'Must be between 0 and 100'),
  });
}

// ---------------------------------------------------------------------------
// Records (Req 1.3–1.8)
// ---------------------------------------------------------------------------

export const moduleSchema = z.object({
  moduleId: z.string({ required_error: 'Required' }).min(1, 'Must not be empty'),
  condition: moduleConditionSchema,
});

export const telemetryReadingSchema = z.object({
  timestamp: isoDateTimeSchema,
  sohPct: z
    .number({ required_error: 'Required' })
    .min(0, 'Must be between 0 and 100')
    .max(100, 'Must be between 0 and 100'),
  cycleCount: nonNegInt,
  thermalEventCount: nonNegInt,
});

export const chargingSessionSchema = z.object({
  date: isoDateSchema,
  energyKwh: z.number({ required_error: 'Required' }).min(0, 'Must be 0 or greater'),
  chargeType: chargeTypeSchema,
  ambientTempC: z
    .number({ required_error: 'Required' })
    .min(-50, 'Must be between -50 and 60')
    .max(60, 'Must be between -50 and 60'),
});

export const faultCodeSchema = z
  .string({ required_error: 'Required' })
  .max(32, 'Must be empty or 1 to 32 characters');

/** Service record; `seeded` allows 0-character action text, otherwise 1–500 (Req 1.5, 9.2). */
export function serviceRecordSchema(opts: { seeded?: boolean } = {}) {
  const actionTaken = opts.seeded
    ? z.string({ required_error: 'Required' }).max(500, 'Must be at most 500 characters')
    : z
        .string({ required_error: 'Required' })
        .min(1, 'Must be 1 to 500 characters')
        .max(500, 'Must be 1 to 500 characters');
  return z.object({
    date: isoDateSchema,
    faultCode: faultCodeSchema,
    actionTaken,
    modulesReplaced: z.array(z.string().min(1, 'Must not be empty')),
  });
}

export const custodyEntrySchema = z.object({
  date: isoDateSchema,
  fromHolderId: z.string().min(1, 'Must not be empty').nullable(),
  toHolderId: z.string({ required_error: 'Required' }).min(1, 'Must not be empty'),
  toHolderRole: holderRoleSchema,
  expectedArrivalDate: isoDateSchema.optional(),
});

export const custodyLogSchema = z
  .array(custodyEntrySchema)
  .min(1, 'Must contain at least one handover entry')
  .superRefine((log, ctx) => {
    for (let i = 1; i < log.length; i++) {
      const prev = log[i - 1];
      const cur = log[i];
      if (prev && cur && cur.date < prev.date) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [i, 'date'],
          message: 'Custody_Log dates must be non-decreasing',
        });
      }
    }
  });

export const endOfLifeRecordSchema = z.object({
  pathway: eolPathwaySchema,
  date: isoDateSchema,
  receivingPartyId: z.string({ required_error: 'Required' }).min(1, 'Must not be empty'),
  materialsRecoveredKg: z.record(
    z.string().min(1, 'Must not be empty'),
    z.number({ required_error: 'Required' }).min(0, 'Must be 0 or greater'),
  ),
});

export const dataOwnerSchema = z.object({
  id: z.string({ required_error: 'Required' }).min(1, 'Must not be empty'),
  role: z.enum(['Owner', 'Fleet_Operator']),
});

export const consentEventSchema = z.object({
  type: z.enum(['grant', 'withdraw']),
  at: isoDateTimeSchema,
  byId: z.string({ required_error: 'Required' }).min(1, 'Must not be empty'),
});

export const inspectionFlagSchema = z.object({
  flagDate: isoDateSchema,
  fleetOperatorId: z.string({ required_error: 'Required' }).min(1, 'Must not be empty'),
  servicePartnerId: z.string({ required_error: 'Required' }).min(1, 'Must not be empty'),
});

export const returnOfferSchema = z.object({
  offerId: z.string().min(1, 'Must not be empty'),
  servicePartnerId: z.string().min(1, 'Must not be empty'),
  servicePartnerName: z.string().min(1, 'Must not be empty'),
});

export const nudgeSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('Charging_Guidance'), createdOn: isoDateSchema, message: z.string() }),
  z.object({ type: z.literal('Service_Prompt'), createdOn: isoDateSchema, message: z.string() }),
  z.object({
    type: z.literal('Return_Incentive'),
    createdOn: isoDateSchema,
    message: z.string(),
    returnOffer: returnOfferSchema,
  }),
]);

export const impactComponentsSchema = z.object({
  charging: z.boolean(),
  servicing: z.boolean(),
  consent: z.boolean(),
  return: z.boolean(),
});

export const returnRecordSchema = z.object({
  batteryId: batteryIdSchema,
  ownerId: z.string().min(1, 'Must not be empty'),
  offerId: z.string().min(1, 'Must not be empty'),
  returnDate: isoDateSchema,
  servicePartnerId: z.string().min(1, 'Must not be empty'),
  servicePartnerName: z.string().min(1, 'Must not be empty'),
  finalImpactScore: z.union([z.literal(25), z.literal(50), z.literal(75), z.literal(100)]),
  components: impactComponentsSchema.refine((c) => c.return, {
    message: 'Return component must be earned',
  }),
});

export const recyclerIntakeSchema = z.object({
  handoverIndex: nonNegInt,
  intakeDate: isoDateSchema,
});

// ---------------------------------------------------------------------------
// Digital_Twin (Req 1.1–1.8)
// ---------------------------------------------------------------------------

/** Full Digital_Twin schema. Use `{ seeded: true }` for Seed_Script output (empty passport fields allowed). */
export function digitalTwinSchema(opts: SchemaOptions) {
  return z.object({
    passport: passportSchema(opts),
    modules: z.array(moduleSchema).min(1, 'Must contain at least one module'),
    telemetry: z.array(telemetryReadingSchema),
    chargingHistory: z.array(chargingSessionSchema),
    serviceHistory: z.array(serviceRecordSchema({ seeded: opts.seeded ?? false })),
    custodyLog: custodyLogSchema,
    endOfLife: endOfLifeRecordSchema.nullable(),
    dataOwner: dataOwnerSchema,
    consentEvents: z.array(consentEventSchema),
    routedPathway: eolPathwaySchema.nullable(),
    inspectionFlags: z.array(inspectionFlagSchema),
    nudges: z.array(nudgeSchema),
    returnRecords: z.array(returnRecordSchema),
    recyclerIntake: recyclerIntakeSchema.nullable(),
  });
}

/** Seeded-twin variant: allows empty Battery_Passport string fields (Req 2.1, 2.5). */
export function seededDigitalTwinSchema(writeDate: string) {
  return digitalTwinSchema({ writeDate, seeded: true });
}

export const locationSchema = z.object({
  city: z.string().min(1, 'Must not be empty'),
  state: z.string().min(1, 'Must not be empty'),
});

export const stakeholderSchema = z.object({
  id: z.string().min(1, 'Must not be empty'),
  role: roleSchema,
  name: z.string().min(1, 'Must not be empty'),
  location: locationSchema,
  manufacturer: z.string().min(1, 'Must not be empty').optional(),
});

/** Whole-store schema (seeded twins allowed); twin keys must equal their battery IDs. */
export function storeSchema(writeDate: string) {
  return z
    .object({
      version: z.literal(2),
      seed: z.number().int('Must be an integer'),
      runDate: isoDateSchema,
      stakeholders: z.array(stakeholderSchema),
      twins: z.record(z.string(), seededDigitalTwinSchema(writeDate)),
    })
    .superRefine((store, ctx) => {
      for (const [key, twin] of Object.entries(store.twins)) {
        if (twin.passport.batteryId !== key) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['twins', key, 'passport', 'batteryId'],
            message: 'Must equal the twin key',
          });
        }
      }
    });
}

// ---------------------------------------------------------------------------
// Error formatting
// ---------------------------------------------------------------------------

/** Converts a ZodError into `{ field, message }[]` with dotted paths (e.g. `telemetry.0.sohPct`). */
export function formatZodErrors(err: z.ZodError): FieldError[] {
  const out: FieldError[] = [];
  const seen = new Set<string>();
  for (const issue of err.issues) {
    const field = issue.path.length > 0 ? issue.path.map(String).join('.') : '(root)';
    const key = `${field}\u0000${issue.message}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ field, message: issue.message });
  }
  return out;
}

/** Parses `value` with `schema`, returning a VALIDATION_ERROR naming every invalid field. */
export function validate<S extends z.ZodTypeAny>(
  schema: S,
  value: unknown,
): Result<z.infer<S>, DomainError> {
  const parsed = schema.safeParse(value);
  if (parsed.success) return { ok: true, value: parsed.data };
  return {
    ok: false,
    error: { code: 'VALIDATION_ERROR', message: 'Validation failed', fields: formatZodErrors(parsed.error) },
  };
}

// ---------------------------------------------------------------------------
// Append-only guard (Req 1.13, 4.13, 7.21)
// ---------------------------------------------------------------------------

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) {
    return Number.isNaN(a) && Number.isNaN(b);
  }
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false;
    return a.every((v, i) => deepEqual(v, b[i]));
  }
  const ao = a as Record<string, unknown>;
  const bo = b as Record<string, unknown>;
  const ak = Object.keys(ao).filter((k) => ao[k] !== undefined);
  const bk = Object.keys(bo).filter((k) => bo[k] !== undefined);
  if (ak.length !== bk.length) return false;
  return ak.every((k) => Object.prototype.hasOwnProperty.call(bo, k) && deepEqual(ao[k], bo[k]));
}

type AppendOnlyKey = 'custodyLog' | 'consentEvents' | 'inspectionFlags' | 'returnRecords';
const APPEND_ONLY_KEYS: readonly AppendOnlyKey[] = ['custodyLog', 'consentEvents', 'inspectionFlags', 'returnRecords'];

/**
 * Checks that `newTwin` changes the append-only lists of `oldTwin` only by appending.
 * Any modified or removed existing Custody_Log entry, ConsentEvent, Inspection_Flag, or
 * ReturnRecord is rejected. Custody_Log violations use `CUSTODY_APPEND_ONLY`; others use
 * `VALIDATION_ERROR`. Each offending element is named as `<list>.<index>`.
 */
export function assertAppendOnlyChanges(
  oldTwin: DigitalTwin,
  newTwin: DigitalTwin,
): Result<true, DomainError> {
  const fields: FieldError[] = [];
  let custodyViolated = false;
  for (const key of APPEND_ONLY_KEYS) {
    const before = oldTwin[key] as readonly unknown[];
    const after = newTwin[key] as readonly unknown[];
    if (after.length < before.length) {
      fields.push({ field: key, message: 'Existing entries must not be removed' });
      if (key === 'custodyLog') custodyViolated = true;
    }
    const n = Math.min(before.length, after.length);
    for (let i = 0; i < n; i++) {
      if (!deepEqual(before[i], after[i])) {
        fields.push({ field: `${key}.${i}`, message: 'Existing entries must not be modified' });
        if (key === 'custodyLog') custodyViolated = true;
      }
    }
  }
  if (fields.length === 0) return { ok: true, value: true };
  return {
    ok: false,
    error: custodyViolated
      ? { code: 'CUSTODY_APPEND_ONLY', message: 'The Custody_Log is append-only', fields }
      : { code: 'VALIDATION_ERROR', message: 'Append-only history must not be modified or removed', fields },
  };
}

// ---------------------------------------------------------------------------
// Compile-time consistency checks with types.ts
// ---------------------------------------------------------------------------

type Mutual<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
type Expect<T extends true> = T;

type TwinOut = z.infer<ReturnType<typeof digitalTwinSchema>>;
type StoreOut = z.infer<ReturnType<typeof storeSchema>>;

// eslint-disable-next-line @typescript-eslint/no-unused-vars
type _SchemaChecks = [
  Expect<Mutual<z.infer<ReturnType<typeof passportSchema>>, BatteryPassport>>,
  Expect<Mutual<z.infer<typeof moduleSchema>, Module>>,
  Expect<Mutual<z.infer<typeof telemetryReadingSchema>, TelemetryReading>>,
  Expect<Mutual<z.infer<typeof chargingSessionSchema>, ChargingSession>>,
  Expect<Mutual<z.infer<ReturnType<typeof serviceRecordSchema>>, ServiceRecord>>,
  Expect<Mutual<z.infer<typeof custodyEntrySchema>, CustodyEntry>>,
  Expect<Mutual<z.infer<typeof stakeholderSchema>, Stakeholder>>,
  Expect<Mutual<TwinOut, DigitalTwin>>,
  Expect<Mutual<StoreOut, Store>>,
];
