# Implementation Plan: Battery ReRoute

## Overview

Battery ReRoute is built bottom-up in TypeScript (strict, Node.js 20+), following the design's layout. Work starts with the pure `src/core/` modules: types, schemas, helpers, Data_Confidence, Health_Model, Pathway_Recommender, Nudge_Engine, Impact_Score, Application_Fit, Replacement_Forecast, access rules, Scope3/CSV, projection, and commands. The repository and Express API_Server come next, then the deterministic Seed_Script (`scripts/`), then the React Plugin and host page (`src/web/`). The plan ends with the README and the required integration tests: the demo walkthrough and the fleet handover scenario.

Each step plugs into the steps before it. Property tests (fast-check, `numRuns >= 100`) sit right after the code they check. The environment is Windows/PowerShell, so every test command runs once and exits (`npm test` → `vitest --run`). Nothing runs in watch mode.

## Tasks

- [ ] 1. Project scaffolding, domain types, and schemas
  - [x] 1.1 Create the Node/TypeScript project skeleton
    - Create `package.json` with exactly pinned versions of TypeScript, tsx, Express 4, Zod, React 18, React DOM, Vite, @vitejs/plugin-react, Vitest, fast-check, supertest, @testing-library/react, @testing-library/user-event, @testing-library/jest-dom, jsdom, and the matching `@types/*`
    - Add npm scripts with no POSIX shell syntax, so they work in PowerShell: `seed` (`tsx scripts/seed.ts`), `build:web` (`vite build`), `start` (`vite build && tsx src/server/main.ts`), `test` (`vitest --run`), `typecheck` (`tsc --noEmit`)
    - Create a strict `tsconfig.json`, a `vite.config.ts` (root `src/web`, output `dist/web`), and a `vitest.config.ts` (jsdom for `test/web/**`, node for everything else)
    - Create the directories `src/core`, `src/server`, `src/server/repo`, `src/web`, `scripts`, `test/unit`, `test/properties`, `test/web`, `test/integration`, and `data` (with `data/.gitkeep`). Add a `.gitignore` that ignores `node_modules`, `dist`, and `data/store.json*`
    - _Requirements: 14.1, 14.2_

  - [x] 1.2 Define core types in `src/core/types.ts`
    - Add every type from the design Data Models section: Role, HolderRole, Pathway, EolPathway, ModuleCondition, ConsentStatus, IntakeStatus, Location, Stakeholder (with `manufacturer` for ESG_Officer), BatteryPassport, Module, TelemetryReading, ChargingSession, ServiceRecord, CustodyEntry (`fromHolderId` nullable, optional `expectedArrivalDate`), ConsentEvent, InspectionFlag, Nudge (a discriminated union, each variant with `createdOn`; Return_Incentive carries `returnOffer { offerId, servicePartnerId, servicePartnerName }`), ImpactComponents, ReturnRecord (immutable, append-only, `finalImpactScore: 25|50|75|100`), RecyclerIntake, EndOfLifeRecord, DigitalTwin (`nudges`, `returnRecords`, `inspectionFlags`, `consentEvents`, `routedPathway`, `recyclerIntake`, `dataOwner`), and Store (`version: 2`)
    - Add the report and view models: EsgCustodyEntry, Scope3Row (with `consentStatus` and `eolDate`), Scope3Report (`counts`, `notYetEolCount`, `measuredShare` as a string), Scope3CsvReport, OwnerReturnedBatteryView, and ReturnConfirmation (`message: 'Return accepted, +25 Impact points'`)
    - Add ViewerContext, Action, the `Result<T, E>` type, and the ErrorCode union from the design Error Handling table (including NOT_CURRENT_HOLDER, NO_INSPECTION_FLAG, OFFER_NOT_ACCEPTABLE, ACTION_NOT_PERMITTED)
    - _Requirements: 1.1–1.8, 7.16, 7.19, 7.21, 8.6, 12.5, 12.9_

  - [x] 1.3 Implement Zod schemas and the immutability guard in `src/core/schemas.ts`
    - Write Zod schemas that enforce every range in Req 1.1–1.8:
      - battery ID 1–64 chars; chemistry 1–64; capacity (0, 500]; Pack_Mass > 0; manufacture date not later than the write date (passed in as a parameter); manufacturer 1–128; embedded carbon ≥ 0; recycled content 0–100
      - SoH 0–100; integer cycle and thermal counts ≥ 0
      - energy ≥ 0; charge type DC_Fast|AC; ambient temperature -50 to 60
      - fault code empty or 1–32 chars; action taken 0–500 (seeded) or 1–500 (logged)
      - modules ≥ 1; Custody_Log ≥ 1 entry with valid holder roles; EOL material masses ≥ 0
    - Add a seeded-twin schema variant that allows empty Battery_Passport fields
    - Add `formatZodErrors(err)` → `{ field, message }[]` with a dotted path for every failing field
    - Add `assertAppendOnlyChanges(oldTwin, newTwin)`. It rejects any modification or removal of existing Custody_Log entries, ConsentEvents, Inspection_Flags, or ReturnRecords; only appends are allowed
    - Export `SAFETY_CRITICAL_FAULT_CODES` (`THERMAL_RUNAWAY`, `CELL_VENTING`, `INTERNAL_SHORT`, `ISOLATION_FAULT`, `BMS_OVERTEMP`)
    - _Requirements: 1.1–1.9, 1.13, 4.13, 7.21_

  - [ ] 1.4 Create shared fast-check arbitraries in `test/arbitraries.ts`
    - `arbTwin`: optional empty categories; readings before and after an `evalDate`; safety-critical fault codes; recent and old faults; module replacements; prior nudges with varied `createdOn`; optional ReturnRecords and Inspection_Flags
    - `arbEvalDate`
    - `arbStakeholders`: Service_Partners with shared and distinct states and names
    - `arbDataset`: fleet, returned, inspection-flagged, routed, and EOL twins
    - `arbViewer`, `arbCommandSequence`, `arbInvalidFieldSet`
    - `arbScope3Report`: strings with commas, quotes, CR/LF, and Unicode; empty and all-In_Use reports
    - _Requirements: 1.1–1.8_

- [x] 2. Core helpers and Data_Confidence
  - [x] 2.1 Implement date and telemetry helpers
    - `src/core/dates.ts`: ISO date parse/validate, `addDays`, `addMonths`, the calendar quarter of a date, and the quarter offset between two dates
    - `src/core/telemetry.ts` functions:
      - `latestReading`, `readingsUpTo`
      - `fastChargeShare`: 0 when there are no sessions or total energy is 0
      - `safetyFlag`: any thermal event ≥ 1 or any Safety_Critical_Fault_Code on or before evalDate
      - `recentFault`: non-empty fault code within [evalDate−90d, evalDate]
      - `fallingSohTrend`: 180-day window, ≥ 2 readings, decline ≥ 2
      - `currentHolder(custodyLog, asOf?)`, `consentStatus(twin)`, `latestInspectionFlag(twin)`, `returnRecordFor(twin, ownerId)`, `isReturnedFor(twin, ownerId)`
    - _Requirements: 1.11, 4.3, 5.1, 5.11, 6.3, 6.5, 7.4_

  - [ ]* 2.2 Write unit tests for the core helpers
    - Create `test/unit/telemetry.test.ts` covering:
      - Fast_Charge_Share with no sessions and with zero energy
      - Recent_Fault at the 90-day boundary
      - Falling_SoH_Trend at the 180-day boundary and with exactly 2.0 points of decline
      - `currentHolder` with `asOf`
      - `consentStatus` with an empty history and with a withdrawal last
      - `isReturnedFor`
    - _Requirements: 4.3, 5.11, 6.5, 7.4_

  - [x] 2.3 Implement Data_Confidence in `src/core/confidence.ts`
    - `dataConfidence(twin)` takes no viewer, role, or Consent parameter and has no consent deduction. Start at 100 and subtract, each at most once: 30 (no Telemetry), 20 (no Charging_History), 20 (no Service_History), 15 (any empty Battery_Passport field). Floor at 0
    - Note in a doc comment: every caller that returns `dataConfidence` must also return `consentStatus(twin)` as a separate field (pathway result, Owner/SP/SLP/ESG projections, Scope3 rows, CSV)
    - _Requirements: 5.10, 6.9, 6.10, 6.15_

  - [ ]* 2.4 Write property test for adding records
    - **Property 22: Adding records never lowers confidence**
    - **Validates: Requirements 6.11**
    - File: `test/properties/p22-confidence-monotonic.test.ts`

- [x] 3. Health_Model
  - [x] 3.1 Implement `evaluateHealth(twin, evalDate)` in `src/core/health.ts`
    - Factor effects follow the design table:
      - SoH: `-(100-SoH)`
      - Cycles: `-min(15, cycles/100)`
      - FCS: `-min(15, FCS×0.2)`, exactly 0 when there is no Charging_History
      - Thermal: `-min(20, events×10)`
    - Score = clamp(round(100 + Σ effect), 0, 100), computed from unrounded effects. Effects are reported rounded to 1 decimal
    - Remaining_Life:
      - 0/0 when SoH ≤ 80
      - null with `INSUFFICIENT_TELEMETRY_HISTORY` when there are fewer than 2 readings
      - otherwise rate-based from the first and last readings, capped at MAX_MONTHS = 180 and MAX_CYCLES = 5000, clamped to [0, cap]
    - Return `TELEMETRY_MISSING` when no reading is on or before evalDate. Include `dataConfidence(twin)`. Never mutate the input. Use Owner_Data regardless of Consent
    - _Requirements: 4.11, 5.1, 5.2, 5.3, 5.4, 5.5, 5.6, 5.7, 5.9, 5.10, 5.11, 5.12_

  - [ ]* 3.2 Write property test for health result shape and range
    - **Property 15: Health result shape and range**
    - **Validates: Requirements 5.2, 5.5, 5.9, 5.11**
    - File: `test/properties/p15-health-shape.test.ts`

  - [ ]* 3.3 Write property test for Health_Score monotonicity
    - **Property 16: Health_Score monotonicity**
    - **Validates: Requirements 5.6, 5.7**
    - File: `test/properties/p16-health-monotonic.test.ts`

  - [ ]* 3.4 Write property test for the evaluation-date cutoff
    - **Property 17: Evaluation-date cutoff**
    - **Validates: Requirements 5.1**
    - File: `test/properties/p17-evaldate-cutoff.test.ts`

  - [ ]* 3.5 Write property test for Remaining_Life rules
    - **Property 18: Remaining_Life rules**
    - **Validates: Requirements 5.3, 5.4, 5.12**
    - File: `test/properties/p18-remaining-life.test.ts`

  - [ ]* 3.6 Write unit tests for Health_Model numeric examples
    - Create `test/unit/health.test.ts` with hand-checked Health_Score and Remaining_Life values, including a zero-rate case that hits the caps
    - _Requirements: 5.3, 5.5_

- [x] 4. Pathway_Recommender
  - [x] 4.1 Implement `recommendPathway(twin, evalDate)` in `src/core/pathway.ts`
    - Evaluate all five rule conditions independently (CERTIFIED_RECYCLING, MISSING_TELEMETRY, INSPECT_REPAIR, CONTINUE_USE, SECOND_LIFE_REVIEW) and record the satisfying inputs for each fired rule
    - Pick the first fired rule in precedence (a)–(e) as `decidingRule`. MISSING_TELEMETRY sets the reason "Telemetry is missing"
    - Return `dataConfidence(twin)` and a separate `consentStatus(twin)` field. Use full internal data regardless of Consent
    - _Requirements: 4.11, 6.1, 6.2, 6.3, 6.4, 6.5, 6.6, 6.7, 6.8, 6.9, 6.12_

  - [ ]* 4.2 Write property test for the pathway decision table
    - **Property 20: Pathway matches the reference decision table**
    - **Validates: Requirements 6.1, 6.2, 6.3, 6.4, 6.5, 6.6, 6.7, 6.8**
    - Compare against a separately written reference function in the test file
    - File: `test/properties/p20-pathway-table.test.ts`

  - [ ]* 4.3 Write property test for evaluation determinism
    - **Property 19: Evaluation determinism**
    - **Validates: Requirements 5.8, 6.12**
    - File: `test/properties/p19-determinism.test.ts`

- [x] 5. Nudge_Engine, Impact_Score, and Final_Impact_Score
  - [x] 5.1 Implement the Nudge_Engine in `src/core/nudges.ts`
    - `nudgeConditions(twin, evalDate, owner, servicePartners)` returns conditions only when the Current_Holder role is Owner:
      - Charging_Guidance: sessions ≥ 1 and FCS > 40; message uses `Math.round(FCS)%`
      - Service_Prompt: Falling_SoH_Trend; message uses `decline.toFixed(1)` percentage points
      - Return_Incentive: pathway Second_Life_Review or Certified_Recycling and no ReturnRecord for that Owner; Return_Offer `{ offerId: '<batteryId>:<ownerId>:return', servicePartnerId, servicePartnerName }`
    - `reconcileNudges(twin, evalDate, owner, servicePartners)` is pure and idempotent:
      - keeps an existing active nudge of a type whose condition still holds, with its original `createdOn` and Return_Offer, and refreshes only the message
      - creates new nudges with `createdOn = evalDate`
      - drops nudges whose condition no longer holds
      - keeps at most one nudge per type, ordered Charging_Guidance, Service_Prompt, Return_Incentive
    - `designateServicePartner(owner, servicePartners)`: Service_Partners whose `location.state` equals the Owner's state, first by `name` ascending (`localeCompare('en', { sensitivity: 'base' })`, ties by `id`); if none match, the first of all Service_Partners by the same ordering
    - _Requirements: 7.3, 7.4, 7.5, 7.10, 7.16, 7.17_

  - [ ]* 5.2 Write property test for nudge reconciliation
    - **Property 23: Nudge reconciliation**
    - **Validates: Requirements 7.3, 7.4, 7.5, 7.10, 7.16**
    - File: `test/properties/p23-nudges.test.ts`

  - [ ]* 5.3 Write property test for Service_Partner designation
    - **Property 40: Service_Partner designation**
    - **Validates: Requirements 7.5, 7.17**
    - Compare against a reference function and check that the result does not depend on input list order
    - File: `test/properties/p40-sp-designation.test.ts`

  - [x] 5.4 Implement Impact_Score and Final_Impact_Score in `src/core/impact.ts`
    - `impactComponents(twin, evalDate, ownerId)` computes four booleans only:
      - charging: FCS ≤ 40, with an empty history counting as 0
      - servicing: no active Service_Prompt whose `createdOn` is more than 30 days before evalDate
      - consent: `consentStatus` is granted
      - return: a ReturnRecord exists for the Owner, or there is no active Return_Incentive
    - `impactScore(components)` = 25 × number of true components (0|25|50|75|100). There are no other scoring inputs
    - `finalImpact(twinBeforeHandover, acceptanceDate, ownerId)` computes the components on the pre-handover twin with `return` forced to `true` and returns `{ finalImpactScore: 25|50|75|100, components }`
    - _Requirements: 7.13, 7.15, 7.19, 7.20_

  - [ ]* 5.5 Write property test for Impact_Score components
    - **Property 39: Impact_Score is the sum of four 25-point components**
    - **Validates: Requirements 7.13, 7.15**
    - File: `test/properties/p39-impact-score.test.ts`

  - [ ]* 5.6 Write unit tests for Impact_Score and designation examples
    - Create `test/unit/impact.test.ts` covering:
      - FCS 41% → Charging not earned
      - Service_Prompt created 31 days earlier → Servicing not earned; 30 days → earned
      - two same-state SPs → the alphabetically first is designated
      - no same-state SP → the alphabetically first overall is designated
    - _Requirements: 7.13, 7.17_

- [x] 6. Second-life fit and Replacement_Forecast
  - [x] 6.1 Implement Usable_Capacity and Application_Fit in `src/core/secondLife.ts`
    - `usableCapacity` = capacity × SoH / 100. Threshold comparisons use the unrounded value
    - Application_Fit:
      - Stationary_Storage when SoH ≥ 60 and UC ≥ 10.0
      - Light_Mobility when SoH ≥ 70 and UC ≥ 2.0
      - both when both conditions hold
      - exactly `None` when there is no Telemetry, a Safety_Flag is present, or neither condition holds
    - _Requirements: 10.2_

  - [ ]* 6.2 Write property test for Usable_Capacity and Application_Fit
    - **Property 30: Usable_Capacity and Application_Fit**
    - **Validates: Requirements 10.2**
    - File: `test/properties/p30-application-fit.test.ts`

  - [x] 6.3 Implement `replacementForecast(fleetTwins, evalDate)` in `src/core/forecast.ts`
    - Returns four quarters starting with the quarter that contains evalDate
    - Each battery with Remaining_Life ≤ 12 months goes in the quarter of `addMonths(evalDate, months)`, capped at the fourth quarter
    - Batteries with unknown or > 12-month Remaining_Life are excluded
    - _Requirements: 8.4, 8.8, 8.9_

  - [ ]* 6.4 Write property test for Replacement_Forecast placement
    - **Property 26: Replacement_Forecast placement**
    - **Validates: Requirements 8.4, 8.8, 8.9**
    - File: `test/properties/p26-forecast.test.ts`

- [x] 7. Checkpoint - Ensure all tests pass
  - Run `npm test` (single run, `vitest --run`) and `npm run typecheck`. Ensure all tests pass, ask the user if questions arise.

- [x] 8. Access rules, CSV, and Scope3_Reporter
  - [x] 8.1 Implement access rules in `src/core/access.ts`
    - `inScope(twin, viewer)` follows the design scope table:
      - Owner: Current_Holder
      - Fleet_Operator: Current_Holder
      - Service_Partner: Current_Holder, a ReturnRecord designating the SP, or the most recent Inspection_Flag selecting the SP
      - SLP: Routed_Pathway Second_Life_Review and Current_Holder
      - Recycler: Routed_Pathway Certified_Recycling and the latest handover is to that Recycler
      - ESG: matching manufacturer
    - `ownerReturnedScope(twins, ownerId)`: twins with a ReturnRecord for that Owner whose Current_Holder is not that Owner
    - Role/action permission matrix and `allowedActions(twin, viewer)`:
      - Owner guard: `isReturnedFor` → no Owner actions at all
      - repair, referral, and dispatch only for an SP that is the Current_Holder (an inspection-only SP gets none while a Fleet_Operator holds custody)
      - handover only for the Fleet_Operator holder with an Inspection_Flag
    - `ownerDataVisible(twin, viewer)`:
      - true if the viewer is the Data_Owner
      - true if the viewer is the Current_Holder with role SP/SLP/Recycler, regardless of Consent
      - otherwise true only if the Data_Owner is the Current_Holder and Consent is granted
      - false otherwise
    - `esgCustodyEntries(custodyLog, stakeholders)` projects each entry to `{ date, toRole }`, adding `toHolderId`/`toHolderName` only when `toRole` is Fleet_Operator, Service_Partner, Second_Life_Provider, or Recycler. It has no from-holder field
    - Export the per-role permitted field sets for use in tests
    - _Requirements: 3.2–3.7, 3.9, 3.13, 3.14, 3.15, 3.16, 3.18, 4.4, 4.5, 4.7, 4.8, 4.9, 4.14, 8.7_

  - [x] 8.2 Implement the RFC 4180 CSV utilities in `src/core/csv.ts`
    - `csvEscape` quotes a field that contains a comma, a double quote, CR, or LF, and doubles embedded quotes
    - `parseCsv` is a state-machine parser for quoted and unquoted fields, doubled quotes, and CRLF or LF record ends
    - _Requirements: 12.10_

  - [ ]* 8.3 Write property test for CSV field escaping
    - **Property 36: CSV field escaping round trip**
    - **Validates: Requirements 12.10**
    - File: `test/properties/p36-csv-escape.test.ts`

  - [x] 8.4 Implement the Scope3_Reporter in `src/core/scope3.ts`
    - `validatePeriod(start?, end?)` rejects a missing or invalid calendar date, or an end date before the start date
    - `buildScope3Report(twins, stakeholders, manufacturer, period)`:
      - inclusion: manufacturer match and manufacture date ≤ period end
      - Disposition: rules (a)–(d), using only EOL records and custody entries dated ≤ end, with `currentHolder(log, end)`
      - Measurement_Status: Measured or Estimated
      - each row has `dataConfidence(twin)`, a separate `consentStatus`, `eolDate` ('' when none ≤ end), and `custodyLog` from `esgCustodyEntries`
      - all four counts are always present; `notYetEolCount` = In_Use count
      - Measured_Share counts Second_Life/Recycled/Unknown only (In_Use excluded from both numerator and denominator); `"0.0"` when d = 0; `tenths = floor((2000m + d) / (2d))`, formatted with `toFixed(1)`
      - no emissions fields
    - `toCsv(report)`:
      - header `battery_id,disposition,measurement_status,data_confidence_score,consent_status,eol_date`, then battery rows
      - then `summary_key,summary_value` followed by manufacturer, period_start, period_end, the four `count_*` rows, `not yet at end of life`, and `measured_share`
      - CRLF line endings, every field escaped, no custody columns
    - `parseScope3Csv(csv)` throws on malformed input
    - _Requirements: 12.2, 12.3, 12.4, 12.5, 12.6, 12.7, 12.8, 12.9, 12.10, 12.12, 12.14, 12.16, 12.17_

  - [ ]* 8.5 Write property test for Scope3 inclusion, Disposition, and Measurement_Status
    - **Property 34: Scope3 inclusion, Disposition, and Measurement_Status**
    - **Validates: Requirements 12.2, 12.3, 12.4**
    - File: `test/properties/p34-scope3-disposition.test.ts`

  - [ ]* 8.6 Write property test for Scope3 counts, Not_Yet_EOL_Count, and Measured_Share
    - **Property 35: Scope3 counts, Not_Yet_EOL_Count, and Measured_Share**
    - **Validates: Requirements 12.5, 12.6, 12.16, 12.17**
    - File: `test/properties/p35-scope3-counts.test.ts`

  - [ ]* 8.7 Write property test for the Scope3_Report CSV round trip
    - **Property 37: Scope3_Report CSV round trip**
    - **Validates: Requirements 12.8, 12.9, 12.11, 12.17**
    - File: `test/properties/p37-scope3-csv-roundtrip.test.ts`

  - [ ]* 8.8 Write property test for invalid reporting periods
    - **Property 38: Invalid reporting periods are rejected**
    - **Validates: Requirements 12.14**
    - File: `test/properties/p38-invalid-period.test.ts`

  - [ ]* 8.9 Write unit tests for Scope3
    - Create `test/unit/scope3.test.ts` covering:
      - 1 of 3 → 33.3; 2 of 3 → 66.7; 3 In_Use + 1 Measured Recycled → 100.0
      - all In_Use → 0.0
      - an empty report → 0.0, with a CSV that has only the header and summary rows
      - a hand-checked CSV export with the `consent_status` column and the "not yet at end of life" row
      - a report object with no emissions keys
    - _Requirements: 12.6, 12.8, 12.9, 12.12, 12.16, 12.17_

- [x] 9. Role projection and consent gating
  - [x] 9.1 Implement `src/core/projection.ts`
    - `evaluateDerived(twin, evalDate, viewer, stakeholders)` combines health, pathway, nudges, impact components and score, fit, intake status, acceptance status, Disposition, and Measurement_Status
    - `project(twin, derived, viewer, stakeholders)` builds each role DTO from an explicit field list, never by spreading the twin. Wherever `dataConfidence` appears (Owner, SP, SLP, ESG), a separate `consentStatus` field is added next to it
    - Consent gating: when `!ownerDataVisible` and the Current_Holder is the Data_Owner, the `health`, `soh`, `telemetry`, `charging`, and `dataOwner` groups are replaced with `{ withheld: true, reason: 'Owner data withheld pending consent' }`. Passport, custody, EOL, Service_History, modules, pathway, Data_Confidence, consentStatus, and the Safety_Flag/Recent_Fault booleans are never gated
    - Service_Partner `assignment`/`actionsEnabled`/`actionsDisabledReason`:
      - the SP is Current_Holder → `Assigned`, true
      - visible only through an Inspection_Flag while a Fleet_Operator holds custody → `ReferredForInspection`, false, `'Custody handover from the Fleet_Operator is pending'`
      - visible only through a past ReturnRecord → `Assigned`, false
    - Fleet `inspectionFlag` summary comes from the most recent flag (`flagged`, `flagDate`, `servicePartnerId`, `servicePartnerName`)
    - ESG DTO: batteryId, disposition, custodyLog (from `esgCustodyEntries`), measurementStatus, dataConfidence, consentStatus. No Data_Owner identity
    - `projectReturned(record)` reads only the ReturnRecord and returns exactly batteryId, returnDate, servicePartnerName, finalImpactScore, components
    - List helpers:
      - Fleet list sorted by Health_Score ascending
      - SoH series by timestamp ascending
      - Service_History in reverse chronological order
      - Recycler list by expected arrival ascending, with Location from the from-holder of the latest handover
    - _Requirements: 3.2–3.7, 3.10, 3.15, 3.16, 3.17, 4.5, 4.6, 4.7, 4.8, 4.10, 6.9, 7.22, 8.1, 8.2, 8.11, 9.1, 9.9, 10.1, 11.1, 12.1_

  - [ ]* 9.2 Write property test for consent gating
    - **Property 13: Consent gates Owner_Data per ownerDataVisible**
    - **Validates: Requirements 4.4, 4.5, 4.6, 4.7, 4.8**
    - File: `test/properties/p13-consent-gating.test.ts`

  - [ ]* 9.3 Write property test for consent independence
    - **Property 14: Consent does not affect non-owner data, internal results, or Data_Confidence_Score**
    - **Validates: Requirements 4.10, 4.11, 6.15**
    - File: `test/properties/p14-consent-independence.test.ts`

  - [ ]* 9.4 Write property test for view ordering and series
    - **Property 25: View ordering and series**
    - **Validates: Requirements 8.1, 8.2, 9.1, 11.1**
    - File: `test/properties/p25-view-ordering.test.ts`

  - [ ]* 9.5 Write property test for the Data_Confidence_Score formula
    - **Property 21: Data_Confidence_Score formula, independent of viewer and Consent**
    - **Validates: Requirements 5.10, 6.9, 6.10, 6.15, 12.7**
    - Check that Health_Model, Pathway_Recommender, every projection that shows the score, and Scope3 rows return the same value, each with a separate `consentStatus` equal to `consentStatus(twin)`
    - File: `test/properties/p21-confidence-formula.test.ts`

  - [ ]* 9.6 Write unit tests for projection
    - Create `test/unit/projection.test.ts` covering:
      - the shape of each SP assignment case, including the exact disabled-reason text
      - an ESG custody entry for an Owner holder with only `{ date, toRole }`
      - a withheld marker in place of the Fleet `health` group when Consent is not granted
    - _Requirements: 3.15, 4.6, 9.9_

- [x] 10. Command functions
  - [x] 10.1 Implement custody, consent, return-offer, inspection, and handover commands in `src/core/commands.ts`
    - Every function is pure and returns `Result<CommandOutput, DomainError>` without mutating the input
    - Owner guard: every Owner command first checks `isReturnedFor` → `ACTION_NOT_PERMITTED`. This runs before the Data_Owner check
    - `appendCustody`: append-only; a backdated handover → `CUSTODY_APPEND_ONLY`
    - `recordConsent`: Data_Owner only (Owner or fleet Fleet_Operator), otherwise `NOT_DATA_OWNER`; appends a ConsentEvent with timestamp and identity
    - `acceptReturnOffer` (a single pure function, so the result lands in one atomic write):
      - reject with `OFFER_NOT_ACCEPTABLE` if the requester is not the holder, no Return_Incentive is active, or a ReturnRecord already exists
      - `reconcileNudges` for today, then `finalImpact` on the pre-handover twin
      - append the handover Owner → designated SP (role Service_Partner)
      - remove the Return_Incentive
      - append the ReturnRecord
      - return the confirmation `{ message: 'Return accepted, +25 Impact points', servicePartnerName, acceptanceDate, finalImpactScore, components }`
    - `flagInspection`: Fleet_Operator holder only (`NOT_CURRENT_HOLDER`); requires a Service_Partner (`VALIDATION_ERROR`); appends an Inspection_Flag
    - `handOverToServicePartner(twin, fleetOperatorId, today)`:
      - errors: `NOT_CURRENT_HOLDER` when the actor is not the holder; `NO_INSPECTION_FLAG` when the twin has no flag
      - appends one handover dated today to the SP of the most recent Inspection_Flag, with role Service_Partner
    - _Requirements: 1.11, 1.13, 3.14, 3.18, 4.1, 4.2, 4.4, 4.12, 4.13, 4.14, 7.6, 7.7, 7.11, 7.18, 7.19, 7.20, 8.6, 8.10, 8.12, 8.13_

  - [x] 10.2 Implement repair, routing, second-life, and recycler commands in `src/core/commands.ts`
    - `logRepair`: SP holder only; validates date ≤ today, action 1–500, and module IDs; names each invalid field; appends one record; sets listed modules to Good
    - `referToSecondLife`: SP holder only; target must be an SLP; appends a handover; sets Routed_Pathway to Second_Life_Review
    - `dispatchToRecycler`: SP holder, or SLP holder with Second_Life_Review; target must be a Recycler; arrival within [today, today+90]; appends a handover with `expectedArrivalDate`; sets Certified_Recycling and Awaiting_Intake
    - `acceptSecondLife`: Safety_Flag → `SAFETY_FLAGGED`; out of view or an existing EOL → `NOT_AVAILABLE`; otherwise creates the Second_Life_Review EOL record
    - `logIntake`: in view and Awaiting_Intake; intake date within [dispatch date, today]; records `recyclerIntake` without a custody entry
    - `logMaterials`: requires Received (`INTAKE_REQUIRED`); requires a non-empty map with masses ≥ 0 and total ≤ Pack_Mass; replaces any EOL with Certified_Recycling. Any other second EOL → `EOL_EXISTS`
    - _Requirements: 1.10, 9.2, 9.3, 9.4, 9.5, 9.6, 9.7, 10.3, 10.4, 10.6, 10.7, 10.8, 11.3, 11.4, 11.5, 11.6, 11.7_

  - [ ]* 10.3 Write property test for the append-only Custody_Log
    - **Property 3: Custody_Log is append-only**
    - **Validates: Requirements 1.11, 1.13**
    - File: `test/properties/p03-custody-append-only.test.ts`

  - [ ]* 10.4 Write property test for consent event history
    - **Property 11: Consent is the last event, history is append-only**
    - **Validates: Requirements 4.1, 4.2, 4.3, 4.13**
    - File: `test/properties/p11-consent-history.test.ts`

  - [ ]* 10.5 Write property test for Data_Owner-only consent changes
    - **Property 12: Only the Data_Owner can change Consent**
    - **Validates: Requirements 4.4, 4.12**
    - File: `test/properties/p12-consent-owner-only.test.ts`

  - [ ]* 10.6 Write property test for Return_Offer acceptance
    - **Property 24: Return_Offer acceptance**
    - **Validates: Requirements 7.6, 7.7, 7.11, 7.18**
    - File: `test/properties/p24-return-offer.test.ts`

  - [ ]* 10.7 Write property test for the Final_Impact_Score value
    - **Property 41: Final_Impact_Score value**
    - **Validates: Requirements 7.19, 7.20**
    - File: `test/properties/p41-final-impact-value.test.ts`

  - [ ]* 10.8 Write property test for Final_Impact_Score immutability
    - **Property 42: Final_Impact_Score immutability**
    - **Validates: Requirements 7.21**
    - Use `arbCommandSequence` and check `assertAppendOnlyChanges` after each step
    - File: `test/properties/p42-final-impact-immutable.test.ts`

  - [ ]* 10.9 Write property test for Owner actions on a Returned_Battery
    - **Property 44: Owner actions on a Returned_Battery are rejected**
    - **Validates: Requirements 3.18, 4.14**
    - File: `test/properties/p44-returned-owner-actions.test.ts`

  - [ ]* 10.10 Write property test for Inspection_Flag recording and visibility
    - **Property 27: Inspection_Flag recording and visibility**
    - **Validates: Requirements 8.6, 8.7, 8.10**
    - File: `test/properties/p27-inspection-flag.test.ts`

  - [ ]* 10.11 Write property test for the fleet handover
    - **Property 45: Fleet handover to the flagged Service_Partner**
    - **Validates: Requirements 3.13, 3.14, 8.12, 8.13**
    - File: `test/properties/p45-fleet-handover.test.ts`

  - [ ]* 10.12 Write property test for repair logging
    - **Property 28: Repair logging**
    - **Validates: Requirements 9.2, 9.3, 9.6**
    - File: `test/properties/p28-repair-logging.test.ts`

  - [ ]* 10.13 Write property test for referral and dispatch routing
    - **Property 29: Referral and dispatch routing**
    - **Validates: Requirements 9.4, 9.5, 9.7, 10.4, 10.8**
    - File: `test/properties/p29-routing.test.ts`

  - [ ]* 10.14 Write property test for second-life acceptance
    - **Property 31: Second-life acceptance**
    - **Validates: Requirements 1.10, 10.3, 10.6, 10.7**
    - File: `test/properties/p31-second-life-accept.test.ts`

  - [ ]* 10.15 Write property test for Recycler intake
    - **Property 32: Recycler intake**
    - **Validates: Requirements 11.3, 11.4**
    - File: `test/properties/p32-recycler-intake.test.ts`

  - [ ]* 10.16 Write property test for materials recovered
    - **Property 33: Materials recovered**
    - **Validates: Requirements 1.10, 11.5, 11.6, 11.7**
    - File: `test/properties/p33-materials.test.ts`

  - [ ]* 10.17 Write property test for disallowed actions
    - **Property 10: Disallowed actions are no-ops**
    - **Validates: Requirements 3.9, 3.13**
    - File: `test/properties/p10-disallowed-actions.test.ts`

- [x] 11. Checkpoint - Ensure all tests pass
  - Run `npm test` and `npm run typecheck`. Ensure all tests pass, ask the user if questions arise.

- [x] 12. Repository and API_Server
  - [x] 12.1 Implement the repositories in `src/server/repo/`
    - `Repository` interface: load stakeholders and twins, get twin, create twin, replace twin, replace the whole store
    - `MemoryRepository` for tests
    - `FileRepository` over `data/store.json`:
      - writes `store.json.tmp`, then `fs.rename`
      - serializes mutations through a single in-process queue
      - leaves the in-memory cache unchanged when a write fails
    - _Requirements: 1.1, 1.9, 2.9, 2.13_

  - [x] 12.2 Implement the Express app factory, role middleware, ESG guard, and read routes
    - `src/server/app.ts`: `createApp({ repo, clock, internal })`
      - the clock uses `BR_TODAY` or today
      - JSON error middleware uses the design error shape and codes; unexpected errors return a generic `INTERNAL`
    - `src/server/roleContext.ts`: validates `X-Role`/`X-Identity` before any battery read → `400 INVALID_ROLE_CONTEXT`
    - `src/server/esgGuard.ts`: `assertNoOwnerIdentity(body, ownerIds, ownerNames)` checks the serialized body and returns `INTERNAL` instead of leaking. It is applied to every ESG route: battery list, battery detail, Scope3 report, and CSV export
    - Read routes:
      - `GET /api/stakeholders`
      - `GET /api/batteries`: scoped and projected; an empty list when nothing is in scope. The Owner response shape is `{ batteries, returnedBatteries }`, with `returnedBatteries` built by `projectReturned`
      - `GET /api/batteries/:id`: an identical `ACCESS_DENIED` body for missing and out-of-scope IDs; an Owner's Returned_Battery returns only the returned view
      - `GET /api/fleet/forecast`
      - `GET /api/scope3` and `GET /api/scope3.csv`: the manufacturer must match the ESG_Officer's, otherwise `ACCESS_DENIED`; an invalid period → `VALIDATION_ERROR`
    - Reads reconcile nudges for Owner-held twins and persist only when the set changed
    - Internal `POST /api/internal/twins` and `GET /api/internal/twins/:id` are mounted only when `internal: true`
    - _Requirements: 1.12, 1.14, 3.1, 3.2, 3.8, 3.10, 3.11, 3.12, 3.16, 3.17, 4.9, 7.10, 7.16, 8.4, 12.1, 12.8, 12.14, 12.15_

  - [x] 12.3 Implement the command routes in `src/server/commandRoutes.ts` and mount them in `app.ts`
    - Routes:
      - `POST /api/batteries/:id/consent`
      - `POST /api/batteries/:id/return-offer/accept`: returns the confirmation payload
      - `POST /api/batteries/:id/inspection-flag`
      - `POST /api/batteries/:id/handover`: Fleet_Operator only; `NOT_CURRENT_HOLDER` / `NO_INSPECTION_FLAG`
      - `POST /api/batteries/:id/repairs`, `POST /api/batteries/:id/referral`, `POST /api/batteries/:id/dispatch`
      - `POST /api/batteries/:id/second-life/accept`, `POST /api/batteries/:id/intake`, `POST /api/batteries/:id/materials`
    - Every route follows the same flow, and any failure writes nothing:
      1. resolve context
      2. load the twin
      3. check scope, the Owner Returned_Battery guard, and `allowedActions`
      4. validate the payload with Zod
      5. run the pure command
      6. validate the full new twin and run `assertAppendOnlyChanges`
      7. persist in one atomic write
      8. return the updated projected view (plus the confirmation for return acceptance)
    - _Requirements: 3.9, 3.13, 3.14, 3.18, 4.1, 4.2, 4.12, 4.14, 7.6, 7.7, 7.8, 7.11, 7.18, 7.21, 8.6, 8.10, 8.12, 8.13, 9.2, 9.4, 9.5, 10.3, 10.4, 11.3, 11.5_

  - [x] 12.4 Implement the server entry point in `src/server/main.ts`
    - Load and validate `data/store.json` through FileRepository. If the store is missing or invalid (including an old `version`), print a message telling the user to run `npm run seed` and exit non-zero
    - Serve the `dist/web` static assets and the host page. Bind to `127.0.0.1` only, with no outbound network calls
    - _Requirements: 13.5, 14.1, 14.8_

  - [ ]* 12.5 Write property test for validation
    - **Property 1: Validation rejects exactly the invalid fields, atomically**
    - **Validates: Requirements 1.1, 1.2, 1.3, 1.4, 1.5, 1.6, 1.7, 1.8, 1.9**
    - Run it through supertest against the internal create route with MemoryRepository
    - File: `test/properties/p01-validation.test.ts`

  - [ ]* 12.6 Write property test for the create/retrieve round trip
    - **Property 2: Create/retrieve round trip and uniqueness**
    - **Validates: Requirements 1.1, 1.12, 1.14**
    - File: `test/properties/p02-create-retrieve.test.ts`

  - [ ]* 12.7 Write property test for role scope and the field whitelist
    - **Property 7: Role scope and field whitelist**
    - **Validates: Requirements 3.2, 3.3, 3.4, 3.5, 3.6, 3.7, 3.10, 3.12, 12.1**
    - File: `test/properties/p07-role-scope.test.ts`

  - [ ]* 12.8 Write property test for uniform access denial
    - **Property 8: Uniform access denial**
    - **Validates: Requirements 3.8, 12.15**
    - File: `test/properties/p08-access-denial.test.ts`

  - [ ]* 12.9 Write property test for invalid role context
    - **Property 9: Invalid role context returns no data**
    - **Validates: Requirements 3.1, 3.11**
    - File: `test/properties/p09-invalid-role.test.ts`

  - [ ]* 12.10 Write property test for Returned_Battery redaction
    - **Property 43: Owner sees no post-handover data for a Returned_Battery**
    - **Validates: Requirements 3.2, 3.17, 7.22**
    - File: `test/properties/p43-returned-redaction.test.ts`

  - [ ]* 12.11 Write property test for Owner identity exclusion in ESG responses
    - **Property 46: No Owner identity in ESG responses**
    - **Validates: Requirements 3.15, 3.16, 4.9, 12.8**
    - Cover the ESG battery list and detail, the Scope3 JSON, and the CSV export
    - File: `test/properties/p46-esg-no-owner-identity.test.ts`

  - [ ]* 12.12 Write unit tests for the server
    - Create `test/unit/server.test.ts` covering:
      - the middleware runs before any repository read (repository spy)
      - FileRepository keeps the old store when rename throws
      - INTERNAL errors hide details
      - `assertNoOwnerIdentity` returns INTERNAL on a planted leak
      - internal routes are absent when `internal: false`
      - startup fails clearly on a missing store
    - _Requirements: 1.14, 2.13, 3.1, 3.16_

- [x] 13. Seed_Script
  - [x] 13.1 Implement the deterministic dataset generator in `scripts/seedGenerator.ts`
    - mulberry32 PRNG, `DEFAULT_SEED = 20250101`, `parseSeed(arg)` (non-integer → invalid-seed error), and a pure `generateDataset(seed, runDate)` where every date is an offset from runDate
    - Stakeholders:
      - ≥ 1 per role, each with a city/state Location
      - at least two Service_Partners in different states
      - ESG_Officers, each with a manufacturer
    - About 50 twins built from archetypes:
      - ≥ 3 manufacturers and ≥ 3 chemistries, each on ≥ 3 twins
      - ≥ 3 twins per Pathway on runDate
      - a fleet of ≥ 10 twins under one Fleet_Operator
      - holders of every role
      - 50–70% of Owner-held twins with Consent; at least one fleet with Consent
      - ≥ 5 twins with EOL and ≥ 5 without; ≥ 5 twins with missing records
      - a Routed_Pathway Second_Life_Review twin held by an SLP, and a Certified_Recycling dispatch
    - Telemetry SoH stays within 0–100 and never increases except across a module-replacement service record
    - Req 2.14 rule: every twin with Routed_Pathway Second_Life_Review or an SLP holder gets a Data_Owner Consent grant dated on or before its first handover away from the Data_Owner, with no withdrawal in between
    - Run `reconcileNudges(twin, runDate, …)` for Owner-held twins. Give selected archetypes a backdated Service_Prompt `createdOn` (e.g. 45 days before runDate)
    - Demo battery `BR-DEMO-0001` (Req 14.6): Owner-held, Consent not granted, no EOL, no Routed_Pathway, no handover to an SP/SLP/Recycler, no ReturnRecord, SoH 60–79, no Safety_Flag, no Recent_Fault → Second_Life_Review
    - _Requirements: 2.1, 2.2, 2.3, 2.4, 2.5, 2.6, 2.7, 2.8, 2.10, 2.11, 2.12, 2.14, 7.16, 7.17, 13.3, 14.6_

  - [x] 13.2 Implement `checkSeedInvariants(dataset, runDate)` in `scripts/seedInvariants.ts`
    - Recompute pathways on runDate and check the counts and ratios of Req 2.1–2.6
    - Check the Req 2.14 consent-before-handover rule for every applicable twin
    - Run the full demo battery check of Req 14.6: exactly one `BR-DEMO-0001`, Owner holder, Consent not granted, no EOL, no Routed_Pathway, no SP/SLP/Recycler handover, no ReturnRecord, and `recommendPathway(...).pathway === 'Second_Life_Review'`
    - Throw a descriptive error on any failure
    - _Requirements: 2.1–2.7, 2.14, 14.6_

  - [x] 13.3 Implement the seed CLI in `scripts/seed.ts`
    - Parse `--seed`. On an invalid seed, print "Invalid seed value: …", exit 1, and leave the store untouched
    - `runDate = BR_TODAY ?? today`. Validate every twin with the Zod schemas, then run `checkSeedInvariants`
    - Write atomically through FileRepository (tmp file, then rename), replacing all prior twins. On any failure, print "Seeding failed: …", exit 1, and leave the store untouched
    - _Requirements: 2.9, 2.11, 2.12, 2.13, 14.7_

  - [ ]* 13.4 Write property test for seed determinism
    - **Property 4: Seed determinism**
    - **Validates: Requirements 2.8, 2.11**
    - File: `test/properties/p04-seed-determinism.test.ts`

  - [ ]* 13.5 Write property test for seeded Telemetry
    - **Property 5: Seeded Telemetry is in range and non-increasing except across module replacement**
    - **Validates: Requirements 2.10**
    - File: `test/properties/p05-seed-telemetry.test.ts`

  - [ ]* 13.6 Write property test for non-integer seeds
    - **Property 6: Non-integer seeds are rejected**
    - **Validates: Requirements 2.12**
    - File: `test/properties/p06-invalid-seed.test.ts`

  - [ ]* 13.7 Write property test for seeded Consent and the demo battery state
    - **Property 47: Seeded Consent-before-handover and demo battery state**
    - **Validates: Requirements 2.7, 2.14, 14.6**
    - File: `test/properties/p47-seed-consent-demo.test.ts`

  - [ ]* 13.8 Write unit tests for seed coverage and failure handling
    - Create `test/unit/seed.test.ts` covering:
      - the default-seed coverage counts and ratios (Req 2.1–2.7)
      - SPs in at least two states
      - backdated Service_Prompt nudges present
      - re-seeding after mutations restores the demo battery and removes earlier twins (2.9, 14.7)
      - failure injection (rename throws; invariants fail) leaves the previous store intact (2.13)
    - _Requirements: 2.1–2.7, 2.9, 2.13, 14.6, 14.7_

- [x] 14. Checkpoint - Ensure all tests pass
  - Run `npm test` and `npm run typecheck`, then run `npm run seed` once to confirm `data/store.json` is produced. Ensure all tests pass, ask the user if questions arise.

- [x] 15. Plugin, Role_Switcher, and host page
  - [x] 15.1 Implement the API client and data hook
    - `src/web/apiClient.ts`: a fetch wrapper that sends `X-Role`/`X-Identity`, uses a 10-second `AbortController` timeout, and returns typed errors naming the operation
    - `src/web/useRoleData.ts`: discards stale responses and keeps the last good data on error
    - _Requirements: 13.2, 13.7, 13.8_

  - [x] 15.2 Implement shared UI components in `src/web/components/`
    - `ValidationNotice`: exact text "Certified specialist validation required"
    - `PathwayBadge`: pathway name with a "Decision support" label, and the notice adjacent for Second_Life_Review/Certified_Recycling (pathway, Routed_Pathway, or EOL pathway)
    - `WithheldMarker`
    - `ErrorBanner` (`role="alert"`)
    - `LoadingIndicator` (`role="status"`, aria-label "Loading battery data")
    - `SohChart`: inline SVG with `<title>` and a visually hidden data table
    - Global `:focus-visible` styles
    - _Requirements: 4.6, 6.13, 6.14, 8.2, 13.6, 13.7, 13.8_

  - [x] 15.3 Implement HostPage, RoleSwitcher, and the Plugin shell
    - `src/web/index.html`, `src/web/main.tsx`, `src/web/HostPage.tsx`: one RoleSwitcher and one Plugin on a single page
    - `src/web/RoleSwitcher.tsx`: six roles, identities filtered by role, the first identity selected by default, native labeled `<select>` elements
    - `src/web/Plugin.tsx`:
      - takes exactly two inputs (`role`, `identityId`)
      - validates them against `/api/stakeholders` and, if invalid, shows an invalid role/identity message with no twin data
      - shows the loading indicator and error banner
      - renders a role-to-view registry
    - _Requirements: 13.1, 13.3, 13.4, 13.5, 13.7, 13.8, 13.9_

  - [x] 15.4 Implement OwnerView in `src/web/views/OwnerView.tsx`
    - For each held battery show:
      - Health_Score with its factors
      - Impact_Score with the four components marked "+25"/"0" and the label "Reflects owner behaviors; not an emissions-reduction figure"
      - Remaining_Life in months and cycles
      - PathwayBadge with Data_Confidence_Score and Consent status
      - Nudges
    - Consent toggle: updates only after the server confirms; on failure keeps the previous status and shows an error
    - Accept Return_Offer button: shows an error on rejection. On success it shows "Return accepted, +25 Impact points" with the Service_Partner name and acceptance date in the same view
    - "Returned batteries" section: lists battery ID, return date, SP name, Final_Impact_Score, and the four components. The section is not rendered when empty, and returned entries have no buttons or inputs
    - Shows "No batteries are held" when the list is empty
    - _Requirements: 7.1, 7.2, 7.6, 7.7, 7.8, 7.9, 7.11, 7.12, 7.14, 7.18, 7.22, 7.23, 7.24_

  - [x] 15.5 Implement FleetView in `src/web/views/FleetView.tsx`
    - Fleet list ordered by Health_Score, showing "unknown" when there is no Remaining_Life, plus Consent status
    - SohChart for the selected battery, or "No SoH history available"
    - Four labeled forecast quarters and consent controls per battery
    - Inspection-flag form with SP selection and rejection errors
    - For each flagged battery, a "Hand over to {servicePartnerName}" button naming the SP from the most recent Inspection_Flag. It calls `POST /api/batteries/:id/handover` and shows an error on rejection
    - _Requirements: 8.1, 8.2, 8.3, 8.4, 8.5, 8.6, 8.10, 8.11, 8.12, 8.13_

  - [x] 15.6 Implement ServicePartnerView in `src/web/views/ServicePartnerView.tsx`
    - Service_History newest first, module conditions, PathwayBadge with Data_Confidence_Score and Consent status, and an Assigned or Referred-for-inspection label
    - Repair log form with inline field errors. Referral and dispatch forms with ValidationNotice next to each control and in the success confirmations
    - When `actionsEnabled` is false, repair, referral, and dispatch controls are rendered `disabled` and the `actionsDisabledReason` message ("Custody handover from the Fleet_Operator is pending") is shown
    - _Requirements: 9.1, 9.2, 9.6, 9.7, 9.8, 9.9_

  - [x] 15.7 Implement SecondLifeView in `src/web/views/SecondLifeView.tsx`
    - Capacity, SoH, Usable_Capacity to 1 decimal, safety history, Application_Fit, Pending/Accepted, PathwayBadge with Data_Confidence_Score, and Consent status
    - The accept action is disabled for a safety-flagged battery; the dispatch-to-Recycler form stays available; ValidationNotice sits next to both actions
    - _Requirements: 10.1, 10.3, 10.4, 10.5, 10.6, 10.8_

  - [x] 15.8 Implement RecyclerView in `src/web/views/RecyclerView.tsx`
    - Incoming list ordered by expected arrival, and an empty-state message
    - Intake form with ValidationNotice for Awaiting_Intake batteries; materials-recovered form for Received batteries
    - _Requirements: 11.1, 11.2, 11.3, 11.5, 11.8_

  - [x] 15.9 Implement EsgView in `src/web/views/EsgView.tsx`
    - Battery table: Disposition, ESG-filtered Custody_Log, Measurement_Status, Data_Confidence_Score, Consent status
    - Period form that keeps the entered dates on error
    - Scope3 report:
      - the four counts, and the "not yet at end of life" count shown separately from Measured_Share
      - a `consent_status` column
      - the "does not quantify emissions reductions" statement
      - an empty-report message
    - CSV export button that downloads `/api/scope3.csv`
    - _Requirements: 12.1, 12.8, 12.13, 12.14, 12.16, 12.17, 12.18_

  - [x] 15.10 Wire all role views into the Plugin registry
    - Register OwnerView, FleetView, ServicePartnerView, SecondLifeView, RecyclerView, and EsgView in `src/web/Plugin.tsx`, so a Role_Switcher change replaces the view
    - _Requirements: 13.1, 13.2_

  - [ ]* 15.11 Write Plugin shell and RoleSwitcher tests
    - Create `test/web/shell.test.tsx` covering:
      - six roles
      - identity filtering with the first identity selected by default
      - the loading indicator's accessible name
      - an error or 10 s timeout (fake timers) keeping previous data and the selection
      - the invalid role/identity message
    - _Requirements: 13.3, 13.4, 13.7, 13.8, 13.9_

  - [ ]* 15.12 Write role view tests
    - Create `test/web/views.test.tsx` with fixture responses for each view. Check:
      - required fields and empty states
      - Validation_Notice placement and the "Decision support" label
      - the Impact_Score disclaimer and components
      - the Owner confirmation message
      - the "Returned batteries" section: shown with entries, absent when empty, no controls in entries
      - the Fleet "Hand over to {name}" button and rejection error
      - SP disabled controls with the pending-handover message
      - consent failure keeping the previous status
      - disabled accept for safety-flagged batteries
      - the Scope 3 no-emissions statement and the separate "not yet at end of life" count
    - _Requirements: 6.13, 6.14, 7.1, 7.2, 7.9, 7.12, 7.14, 7.18, 7.22, 7.23, 7.24, 8.1–8.5, 8.11, 8.13, 9.1, 9.8, 9.9, 10.1, 10.5, 10.6, 11.1, 11.2, 11.8, 12.1, 12.13, 12.17, 12.18_

  - [ ]* 15.13 Write keyboard accessibility tests
    - Create `test/web/a11y.test.tsx`: every control is reachable with `userEvent.tab()`, activates with Enter (and Space for buttons and checkboxes), and has a non-empty accessible name
    - _Requirements: 13.6_

- [x] 16. README and integration tests
  - [x] 16.1 Write `README.md`
    - Prerequisites (Node.js 20+). Literal commands in order: `npm install`, `npm run seed`, `npm start`. Test command `npm test` (single run). Optional PowerShell override `$env:BR_TODAY="YYYY-MM-DD"`
    - A statement that the prototype uses a Role_Switcher in place of production authentication, and that the server binds to 127.0.0.1 with no authentication
    - Numbered walkthrough for `BR-DEMO-0001`, naming the role and identity for each step:
      1. Owner grants Consent
      2. Owner accepts the Return_Offer
      3. Owner sees "Return accepted, +25 Impact points" and the battery in "Returned batteries" with a Final_Impact_Score ≥ 50 (Consent and Return components earned)
      4. Service_Partner refers the battery to the Second_Life_Provider
      5. Second_Life_Provider accepts the battery, then dispatches it to the Recycler
      6. Recycler logs intake, then materials
      7. ESG_Officer generates and exports the Scope 3 CSV, using the demo battery's manufacturer and a period that covers the current date
    - _Requirements: 14.2, 14.3, 14.4, 14.5, 14.8, 14.11, 14.12, 14.13_

  - [x] 16.2 Write the demo walkthrough integration test
    - Create `test/integration/walkthrough.test.ts`. Seed into a temporary store, then drive the API in README order with the README's IDs and period:
      1. Consent grant
      2. Return acceptance: assert the confirmation payload (message, SP name, acceptance date) and that `returnedBatteries` contains the demo battery with `finalImpactScore ≥ 50` and the Consent and Return components earned; snapshot that entry
      3. SP refers to the SLP
      4. SLP accepts, then dispatches to the Recycler
      5. Intake, then materials
      6. ESG report and CSV
    - Assert:
      - custody handovers go SP → SLP → Recycler in that order, with the Recycler as Current_Holder
      - Disposition Recycled and Measurement_Status Measured in both JSON and CSV
      - no Owner identity in any ESG output
      - the Owner's `returnedBatteries` entry deeply equals the snapshot
    - Install a guard that fails on any non-loopback outbound request
    - _Requirements: 3.16, 3.17, 7.18, 7.21, 14.1, 14.6, 14.8, 14.9, 14.10, 14.12, 14.13_

  - [x] 16.3 Write the fleet handover integration scenario
    - Create `test/integration/fleetHandover.test.ts` and run these steps:
      1. The Fleet_Operator flags a fleet battery for a Service_Partner
      2. That SP's view lists it as ReferredForInspection with `actionsEnabled: false`
      3. Repair, referral, and dispatch return `ACTION_NOT_PERMITTED` with no change
      4. A handover on an unflagged battery returns `NO_INSPECTION_FLAG`; a handover by a non-holder Fleet_Operator returns `NOT_CURRENT_HOLDER`
      5. `POST /api/batteries/:id/handover` makes the SP the Current_Holder
      6. The SP logs a repair successfully
    - _Requirements: 3.13, 3.14, 8.6, 8.7, 8.11, 8.12, 8.13, 9.2, 9.9_

  - [ ]* 16.4 Write responsiveness and startup smoke tests
    - Create `test/integration/smoke.test.ts`: `createApp` serves the host page with one Role_Switcher and one Plugin; a role switch and a consent update render within 2 s on seeded data
    - _Requirements: 7.8, 13.2, 13.5_

- [x] 17. Final checkpoint - Ensure all tests pass
  - Run `npm test`, `npm run typecheck`, and `npm run build:web`. Ensure all tests pass, ask the user if questions arise.

## Notes

- Sub-tasks marked with `*` are optional (property, unit, Plugin, and smoke tests) and can be skipped for a faster MVP. The demo walkthrough (16.2) and fleet handover scenario (16.3) integration tests are required.
- Each property test is a single fast-check property with `{ numRuns: 100 }` or more, kept in its own file and tagged with a comment such as `// Feature: battery-reroute, Property 20: Pathway matches the reference decision table`. Properties 4, 5, and 47 may lower `numRuns` only if runtime exceeds a few seconds; the test notes the reason.
- Model-based properties (20, 26, 30, 34, 35, 39, 40) compare against a separately written reference function in the test file. Properties 1, 2, 7, 8, 9, 43, and 46 run through the HTTP layer (supertest + MemoryRepository).
- Core functions take `evalDate` explicitly and never read the clock. Tests inject a fixed clock.
- All test runs are single-shot (`npm test` → `vitest --run`) for Windows/PowerShell. `npm start` is long-running and should be run manually by the user.
- Visible focus and full WCAG conformance need manual testing with assistive technologies. Automated tests cover keyboard reachability and accessible names only.

## Task Dependency Graph

```json
{
  "waves": [
    { "id": 0, "tasks": ["1.1"] },
    { "id": 1, "tasks": ["1.2", "8.2"] },
    { "id": 2, "tasks": ["1.3", "2.1", "8.3"] },
    { "id": 3, "tasks": ["1.4", "2.2", "2.3", "8.1"] },
    { "id": 4, "tasks": ["2.4", "3.1", "4.1", "6.1"] },
    { "id": 5, "tasks": ["3.2", "3.3", "3.4", "3.5", "3.6", "4.2", "4.3", "5.1", "6.2", "6.3", "8.4"] },
    { "id": 6, "tasks": ["5.2", "5.3", "5.4", "6.4", "8.5", "8.6", "8.7", "8.8", "8.9"] },
    { "id": 7, "tasks": ["5.5", "5.6", "9.1", "10.1", "12.1"] },
    { "id": 8, "tasks": ["9.2", "9.3", "9.4", "9.5", "9.6", "10.2", "13.1"] },
    { "id": 9, "tasks": ["10.3", "10.4", "10.5", "10.6", "10.7", "10.8", "10.9", "10.10", "10.11", "10.12", "10.13", "10.14", "10.15", "10.16", "10.17", "12.2", "13.2"] },
    { "id": 10, "tasks": ["12.3", "13.3", "13.4", "13.5", "13.6", "13.7", "15.1", "15.2"] },
    { "id": 11, "tasks": ["12.4", "13.8", "15.3", "16.1"] },
    { "id": 12, "tasks": ["12.5", "12.6", "12.7", "12.8", "12.9", "12.10", "12.11", "12.12", "15.4", "15.5", "15.6", "15.7", "15.8", "15.9"] },
    { "id": 13, "tasks": ["15.10", "16.2", "16.3"] },
    { "id": 14, "tasks": ["15.11", "15.12", "15.13", "16.4"] }
  ]
}
```
