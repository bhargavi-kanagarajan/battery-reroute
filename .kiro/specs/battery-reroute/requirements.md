# Requirements Document

## Introduction

Battery ReRoute is a unified EV battery lifecycle data platform. It joins battery data held by carmakers, owners, fleets, service centers, second-life providers and recyclers into one record per battery (a Digital_Twin). Each stakeholder sees a role-based view of that record inside an embeddable Plugin.

The platform changes owner behavior through nudges, recommends each battery's next best pathway (continue use, inspect/repair, second-life review, certified recycling), and records every end-of-life outcome so carmakers can report measured GHG Protocol Scope 3 Category 12 data instead of estimates.

This prototype is a locally runnable web app using synthetic data. It includes one embeddable Plugin component, a Role_Switcher for demos, a Seed_Script generating about 50 batteries, a README, and a demo walkthrough. Real integrations, payments, production authentication and mobile apps are out of scope.

## Glossary

- **Platform**: The Battery ReRoute web application as a whole, consisting of the API_Server and the Plugin.
- **API_Server**: The server-side component that stores Digital_Twins, enforces role-based access, runs core logic and serves data to the Plugin.
- **Plugin**: The single embeddable UI component that renders a role-specific view of Digital_Twin data.
- **Role_Switcher**: A demo control that selects the Active_Role and the acting stakeholder identity; a stand-in for production authentication.
- **Active_Role**: The role currently selected in the Role_Switcher: Owner, Fleet_Operator, Service_Partner, Second_Life_Provider, Recycler, or ESG_Officer.
- **Owner**: An individual EV owner role.
- **Fleet_Operator**: A role representing an organization that operates a fleet of EVs.
- **Service_Partner**: A role representing a battery service or repair center.
- **Second_Life_Provider**: A role representing an organization that repurposes batteries for second-life applications.
- **Recycler**: A role representing a certified battery recycling facility.
- **ESG_Officer**: A carmaker ESG / compliance role.
- **Location**: The city and state/region of a stakeholder identity, never an exact street address. Each stakeholder identity has one Location.
- **Digital_Twin**: The unified record for one battery, comprising its Battery_Passport, modules, Telemetry, Charging_History, Service_History, Custody_Log and End_Of_Life_Record.
- **Battery_Passport**: Static battery data: battery ID, chemistry, capacity (kWh), Pack_Mass (kg), manufacture date, manufacturer, embedded carbon (kg CO2e), recycled content (%).
- **Pack_Mass**: The battery pack mass in kg, greater than 0; part of the Battery_Passport.
- **Module_Condition**: The per-module status of exactly one of Good, Degraded, or Failed. Each battery has a list of modules, each identified by a module ID.
- **Telemetry**: BMS readings, each with timestamp, state of health (%), cycle count, and thermal event count.
- **SoH**: State of health, a percentage (0–100) from the most recent Telemetry reading.
- **Usable_Capacity**: Capacity × SoH / 100, in kWh.
- **Charging_History**: A list of charging sessions, each with date, energy (kWh), charge type (DC_Fast or AC), and ambient temperature (°C).
- **Fast_Charge_Share**: The energy delivered by DC_Fast sessions divided by total energy delivered across all sessions in the Charging_History, expressed as a percentage.
- **Service_History**: A list of service records, each with date, fault code, action taken, and modules replaced.
- **Custody_Log**: An ordered, append-only list of handovers, each with date, from-holder, to-holder, and to-holder role. The last entry identifies the Current_Holder.
- **Current_Holder**: The stakeholder identity and role that currently holds custody of a battery.
- **Routed_Pathway**: The pathway a battery has been routed to by a custody action: set to Second_Life_Review when a Service_Partner refers the battery to a Second_Life_Provider, and set to Certified_Recycling when a Service_Partner or Second_Life_Provider dispatches the battery to a Recycler. The Routed_Pathway is distinct from the Pathway_Recommender's recommendation, which is decision support only. Batteries with no such custody action have no Routed_Pathway.
- **Intake_Status**: The Recycler intake status of a dispatched battery: Awaiting_Intake or Received.
- **End_Of_Life_Record**: The recorded outcome for a battery that has left first-life use: pathway (Second_Life_Review or Certified_Recycling), date, receiving party, and materials recovered (kg by material).
- **Data_Owner**: The stakeholder who controls Consent for a battery: the Owner for Owner-held batteries, or the Fleet_Operator for fleet batteries (batteries whose Owner_Data identifies a Fleet_Operator as owner).
- **Owner_Data**: Telemetry, Charging_History, and Data_Owner identity for a battery.
- **Consent**: The Data_Owner's recorded permission for Owner_Data to be visible to roles other than the Data_Owner's role. Consent gates Owner_Data only while the battery's Current_Holder is its Data_Owner; once custody passes to a Service_Partner, Second_Life_Provider, or Recycler, that Current_Holder receives the fields permitted for its role in Requirement 3 regardless of Consent. Consent is not granted by default. The identity of an Owner-role Data_Owner is excluded from ESG_Officer responses regardless of Consent (Requirement 3 criterion 16).
- **Inspection_Flag**: A record of flag date, flagging Fleet_Operator identity, and selected Service_Partner identity.
- **Safety_Critical_Fault_Code**: A fault code in a fixed list defined by the Platform.
- **Safety_Flag**: A condition that is true for a battery when any Telemetry reading has a thermal event count of 1 or more, or any Service_History record has a Safety_Critical_Fault_Code.
- **Recent_Fault**: A Service_History record with a non-empty fault code dated within the 90 days before the evaluation date.
- **Health_Model**: The rule-based component that computes the Health_Score and Remaining_Life estimate.
- **Health_Score**: An integer from 0 to 100 summarizing battery health, computed by the Health_Model.
- **Remaining_Life**: The Health_Model's estimate, in months and in cycles, until SoH reaches 80%.
- **Contributing_Factor**: A named input (SoH, cycle count, Fast_Charge_Share, thermal events) together with its signed effect on a Health_Model or Pathway_Recommender result.
- **Pathway_Recommender**: The rule-based component that assigns a Pathway to a battery.
- **Pathway**: One of Continue_Use, Inspect_Repair, Second_Life_Review, or Certified_Recycling. These four names are used everywhere, including End_Of_Life_Record pathway values and Routed_Pathway values.
- **Data_Confidence_Score**: An integer from 0 to 100 indicating completeness of the records used for a result; lower when records are missing. The Data_Confidence_Score is independent of Consent status and Active_Role, so it is the same for every role; Consent status is reported as a separate field wherever the Data_Confidence_Score is returned or shown.
- **Validation_Notice**: The exact text "Certified specialist validation required".
- **Application_Fit**: The second-life suitability of a battery: one or both of Stationary_Storage and Light_Mobility, or exactly None.
- **Nudge_Engine**: The rule-based component that generates Nudges for Owners.
- **Nudge**: An owner-facing message of type Charging_Guidance, Service_Prompt, or Return_Incentive. Each Service_Prompt Nudge has a creation date: the evaluation date on which the Nudge_Engine first generated the Nudge.
- **Falling_SoH_Trend**: A decline in SoH of 2 or more percentage points across Telemetry readings in the 180 days before the evaluation date.
- **Impact_Score**: An integer shown to Owners per battery that reflects owner behaviors, equal to the sum of four 25-point components and therefore exactly one of 0, 25, 50, 75, or 100: Charging_Component (+25 when Fast_Charge_Share is at or below 40%, with an empty Charging_History counting as 0%); Servicing_Component (+25 when the battery has no active Service_Prompt Nudge whose creation date is more than 30 days before the evaluation date); Consent_Component (+25 when Consent is granted); and Return_Component (+25 when the battery's Return_Offer is accepted or no Return_Offer has been issued for the battery). The Impact_Score is a behavior score and is not an emissions-reduction figure.
- **Final_Impact_Score**: The Impact_Score recorded once for a battery and Owner at the moment the Owner accepts a Return_Offer, with the Return_Component earned. It is never recalculated.
- **Return_Offer**: A Return_Incentive Nudge that names one designated Service_Partner identity and that an Owner can accept to hand custody of the battery to that Service_Partner. The designated Service_Partner is the Service_Partner identity whose Location state equals the Owner's Location state; if several match, the first by name in ascending alphabetical order; if none match, the first Service_Partner identity by name in ascending alphabetical order.
- **Returned_Battery**: A battery that an Owner handed over to a Service_Partner through an accepted Return_Offer; listed for that Owner in the "Returned batteries" section.
- **Replacement_Forecast**: For a fleet, four counts, one per calendar quarter for the 4 consecutive quarters starting with the quarter containing the evaluation date, computed per Requirement 8.
- **Scope3_Reporter**: The component that produces the Scope 3 Category 12 report.
- **Scope3_Report**: For a chosen manufacturer and reporting period, the list of that manufacturer's batteries with Disposition, Measurement_Status, Data_Confidence_Score, Consent status, and Custody_Log (filtered per Requirement 3 criteria 15 and 16) per battery, counts by Disposition, the Not_Yet_EOL_Count, and the Measured_Share.
- **Disposition**: The end-of-life status of a battery: In_Use, Second_Life, Recycled, or Unknown, assigned per Requirement 12 criterion 3.
- **Measurement_Status**: Measured or Estimated, assigned per Requirement 12 criterion 4.
- **Measured_Share**: Among the batteries in the Scope3_Report with Disposition Second_Life, Recycled, or Unknown, the number with Measurement_Status Measured divided by the number of those batteries, multiplied by 100 and rounded half-up to one decimal place; 0.0 when no battery has Disposition Second_Life, Recycled, or Unknown. Batteries with Disposition In_Use are excluded from both numerator and denominator.
- **Not_Yet_EOL_Count**: The number of batteries in a Scope3_Report with Disposition In_Use, labeled "not yet at end of life".
- **Seed_Script**: The script that generates synthetic Digital_Twins and loads them into the Platform's data store.
- **README**: The repository document explaining how to install, seed, start, and demo the Platform.

## Requirements

### Requirement 1: Digital Twin Data Model

**User Story:** As a platform stakeholder, I want each battery's scattered data joined into one record, so that every party works from the same lifecycle history.

#### Acceptance Criteria

1. THE API_Server SHALL store exactly one Digital_Twin per battery ID, where a battery ID is a non-empty string of 1 to 64 characters.
2. THE API_Server SHALL store for each Digital_Twin a Battery_Passport containing battery ID, chemistry (non-empty string of 1 to 64 characters), capacity in kWh (greater than 0 and at most 500), Pack_Mass in kg (greater than 0), manufacture date (not later than the date of the write request), manufacturer (non-empty string of 1 to 128 characters), embedded carbon in kg CO2e (0 or greater), and recycled content in percent (0 to 100 inclusive).
3. THE API_Server SHALL store for each Digital_Twin zero or more Telemetry readings, each containing timestamp, SoH (0 to 100 inclusive), cycle count (integer 0 or greater), and thermal event count (integer 0 or greater).
4. THE API_Server SHALL store for each Digital_Twin zero or more charging sessions in its Charging_History, each containing date, energy in kWh (0 or greater), charge type of exactly DC_Fast or AC, and ambient temperature in °C (-50 to 60 inclusive).
5. THE API_Server SHALL store for each Digital_Twin zero or more Service_History records, each containing date, fault code (empty or a string of 1 to 32 characters), action taken (string of 0 to 500 characters for seeded records; 1 to 500 characters for records logged through the Platform per Requirement 9), and a list of 0 or more module IDs replaced.
6. THE API_Server SHALL store for each Digital_Twin a list of one or more modules, each with a module ID and a Module_Condition.
7. THE API_Server SHALL store for each Digital_Twin a Custody_Log containing at least one handover entry, each entry containing date, from-holder, to-holder, and a to-holder role that is one of Owner, Fleet_Operator, Service_Partner, Second_Life_Provider, or Recycler.
8. THE API_Server SHALL store for each Digital_Twin zero or one End_Of_Life_Record containing pathway (Second_Life_Review or Certified_Recycling), date, receiving party, and materials recovered in kg by material (each mass 0 or greater).
9. IF a write request omits a required field or contains a field value outside its valid range as defined in criteria 1–8 (including SoH outside 0–100, non-positive capacity or Pack_Mass, negative energy, negative cycle count, negative material mass, recycled content outside 0–100, or a charge type other than DC_Fast or AC), THEN THE API_Server SHALL reject the entire request with a validation error that names each invalid field and SHALL leave the stored Digital_Twin unchanged.
10. IF a request attempts to create a second End_Of_Life_Record for a Digital_Twin that already has one, other than the replacement permitted by Requirement 11 criterion 5, THEN THE API_Server SHALL reject the request and leave the existing End_Of_Life_Record unchanged.
11. WHEN a custody handover is recorded with a date not earlier than the date of the last Custody_Log entry, THE API_Server SHALL append the handover as the last Custody_Log entry, identify its to-holder and to-holder role as the Current_Holder, and leave all earlier Custody_Log entries unchanged.
12. IF a request attempts to create a Digital_Twin with a battery ID that is already stored, THEN THE API_Server SHALL reject the request with an error indicating a duplicate battery ID and SHALL leave the existing Digital_Twin unchanged.
13. IF a request attempts to modify or delete an existing Custody_Log entry, or records a custody handover dated earlier than the last Custody_Log entry, THEN THE API_Server SHALL reject the request with an error indicating the Custody_Log is append-only and SHALL leave the Custody_Log unchanged.
14. WHEN an internal request retrieves a Digital_Twin by battery ID, THE API_Server SHALL return its Battery_Passport, modules, Telemetry, Charging_History, Service_History, Custody_Log, and End_Of_Life_Record (or an indication that none exists) before role-based filtering is applied per Requirement 3, and IF the battery ID is not stored, THEN THE API_Server SHALL return an error indicating the battery was not found.

### Requirement 2: Synthetic Data Seeding

**User Story:** As a demo presenter, I want about 50 batteries with realistic, varied histories, so that every role view and every Pathway is demonstrable.

#### Acceptance Criteria

1. WHEN the Seed_Script runs to completion, THE Seed_Script SHALL leave between 45 and 55 Digital_Twins (inclusive) in the data store, each with a unique battery ID and a Battery_Passport whose fields are all non-empty except on Digital_Twins deliberately seeded with missing records per criterion 5.
2. WHEN the Seed_Script runs to completion, THE Seed_Script SHALL create Digital_Twins from at least 3 distinct manufacturers and at least 3 distinct chemistries, with each of those manufacturers and chemistries appearing on at least 3 Digital_Twins.
3. WHEN the Seed_Script runs to completion, THE Seed_Script SHALL create, for each of the 4 Pathways (Continue_Use, Inspect_Repair, Second_Life_Review, Certified_Recycling), at least 3 Digital_Twins to which the Pathway_Recommender assigns that Pathway when evaluated on the seed run date.
4. WHEN the Seed_Script runs to completion, THE Seed_Script SHALL create at least one fleet of at least 10 Digital_Twins whose Current_Holder is the same Fleet_Operator identity, and at least one Digital_Twin whose Current_Holder is each of the roles Owner, Service_Partner, Second_Life_Provider, and Recycler.
5. WHEN the Seed_Script runs to completion, THE Seed_Script SHALL create Consent records such that between 50% and 70% (target 60%) of Owner-held Digital_Twins have Consent granted, at least one fleet has Consent granted by its Fleet_Operator, at least 5 Digital_Twins have an End_Of_Life_Record, at least 5 have no End_Of_Life_Record, and at least 5 have one or more of Telemetry, Charging_History, or Service_History containing zero entries or one or more empty Battery_Passport fields.
6. WHEN the Seed_Script runs to completion, THE Seed_Script SHALL create at least one Digital_Twin with a Routed_Pathway of Second_Life_Review held by a Second_Life_Provider and at least one Digital_Twin with a Routed_Pathway of Certified_Recycling dispatched to a Recycler, and SHALL assign every stakeholder identity a Location of city and state.
7. WHEN the Seed_Script runs to completion, THE Seed_Script SHALL create exactly one designated demo battery that satisfies Requirement 14 criterion 6, with the same battery ID on every run.
8. WHEN the Seed_Script runs twice with the same seed value on the same run date, THE Seed_Script SHALL produce Digital_Twins on the second run whose battery IDs and all field values are identical to those of the first run.
9. WHEN the Seed_Script runs to completion, THE Seed_Script SHALL remove all Digital_Twins present in the data store before the run, so that only Digital_Twins created by that run remain.
10. THE Seed_Script SHALL generate Telemetry in which every SoH value is between 0 and 100 inclusive and, for each Digital_Twin, SoH does not increase between consecutive readings in timestamp order except across a Service_History record that lists one or more modules replaced.
11. WHEN the Seed_Script runs without a seed value supplied, THE Seed_Script SHALL use a fixed default seed value, so that two runs without a seed value on the same run date produce identical Digital_Twins.
12. IF the supplied seed value is not an integer, THEN THE Seed_Script SHALL exit without modifying the data store and report an error indicating the seed value is invalid.
13. IF the Seed_Script fails before completion, THEN THE Seed_Script SHALL leave the data store containing the same Digital_Twins it contained before the run and report an error indicating that seeding failed.
14. THE Seed_Script SHALL create every Digital_Twin that has a Routed_Pathway of Second_Life_Review or a Current_Holder with role Second_Life_Provider with a Consent grant by its Data_Owner recorded on or before the date of the Custody_Log handover away from the Data_Owner and no Consent withdrawal recorded between that grant and that handover, so that no such Digital_Twin left its Data_Owner without Consent.

### Requirement 3: Role-Based Access Control

**User Story:** As a data owner, I want each role to receive only the fields it needs, so that battery data is shared on a need-to-know basis.

#### Acceptance Criteria

1. WHEN the API_Server receives a data request, THE API_Server SHALL determine the Active_Role and acting stakeholder identity from that request before reading or returning any battery data.
2. WHEN a request is made with Active_Role Owner, THE API_Server SHALL return only battery ID, Health_Score, Contributing_Factors, Impact_Score, Impact_Score components earned, Nudges, Remaining_Life, Pathway recommendation, Data_Confidence_Score, Return_Offer, and Consent status for batteries whose Current_Holder is that Owner, and SHALL additionally return, for each Returned_Battery of that Owner, only battery ID, return date, designated Service_Partner name, Final_Impact_Score, and the earned/not-earned state of each of its four components.
3. WHEN a request is made with Active_Role Fleet_Operator, THE API_Server SHALL return only battery ID, Health_Score, SoH, degradation over time (the SoH value and timestamp of each Telemetry reading), Remaining_Life, Replacement_Forecast, safety and fault indicators (Safety_Flag status and presence of a Recent_Fault), Inspection_Flag status, and Consent status for batteries whose Current_Holder is that Fleet_Operator.
4. WHEN a request is made with Active_Role Service_Partner, THE API_Server SHALL return only battery ID, Service_History, fault codes, Module_Condition per module, Pathway recommendation, Data_Confidence_Score, and Consent status for batteries whose Current_Holder is that Service_Partner, that have an accepted Return_Offer designating that Service_Partner, or that have an Inspection_Flag selecting that Service_Partner.
5. WHEN a request is made with Active_Role Second_Life_Provider, THE API_Server SHALL return only battery ID, capacity in kWh, SoH, Usable_Capacity, safety history (Safety_Flag status, thermal event count, and each Safety_Critical_Fault_Code with its date), Application_Fit, acceptance status, Pathway recommendation, Data_Confidence_Score, and Consent status for batteries whose Routed_Pathway is Second_Life_Review and whose Current_Holder is that Second_Life_Provider.
6. WHEN a request is made with Active_Role Recycler, THE API_Server SHALL return only battery ID, chemistry, Pack_Mass, Location, expected arrival date, and Intake_Status for batteries whose Routed_Pathway is Certified_Recycling and whose most recent Custody_Log entry is a handover to that Recycler.
7. WHEN a request is made with Active_Role ESG_Officer, THE API_Server SHALL return only battery ID, Disposition, Custody_Log (with entry fields limited per criteria 15 and 16), Measurement_Status, Data_Confidence_Score, and Consent status for batteries whose Battery_Passport manufacturer matches that ESG_Officer's manufacturer.
8. IF a request asks for a single battery ID that does not exist or is outside the Active_Role's permitted battery scope, or asks for a field outside the Active_Role's permitted fields, THEN THE API_Server SHALL respond with an access-denied error, return no battery data, and give the same response for nonexistent and out-of-scope battery IDs.
9. IF a request asks to perform an action not permitted for the Active_Role, THEN THE API_Server SHALL respond with an access-denied error and leave the Digital_Twin unchanged, with no new Custody_Log, Service_History, Telemetry, Consent, Inspection_Flag, or End_Of_Life_Record entry created.
10. THE API_Server SHALL apply field filtering before data leaves the API_Server, so that the Plugin receives only the fields listed for the Active_Role in criteria 2 to 7.
11. IF a request omits the Active_Role or acting stakeholder identity, names a role other than Owner, Fleet_Operator, Service_Partner, Second_Life_Provider, Recycler, or ESG_Officer, or names an identity not present in the Platform's data store for that role, THEN THE API_Server SHALL respond with an error indicating the missing or invalid role or identity and return no battery data.
12. WHEN a request for a list of batteries is made, THE API_Server SHALL return only the batteries within the Active_Role's permitted scope, and SHALL return an empty list rather than an error when no batteries are in scope.
13. WHILE a Service_Partner can see a battery only through an Inspection_Flag and the battery's Current_Holder is a Fleet_Operator, THE API_Server SHALL allow the Service_Partner to view that battery and SHALL reject repair, referral, and dispatch actions on it until the Fleet_Operator hands over custody of the battery to that Service_Partner per Requirement 8 criterion 12.
14. WHEN a Fleet_Operator hands over custody of a battery to a Service_Partner per Requirement 8 criterion 12, THE API_Server SHALL identify that Service_Partner as the Current_Holder and SHALL accept repair, referral, and dispatch actions on the battery from that Service_Partner per Requirement 9.
15. WHEN a request is made with Active_Role ESG_Officer, THE API_Server SHALL return each Custody_Log entry with only its date and to-holder role, plus its to-holder identity only when the to-holder role is Fleet_Operator, Service_Partner, Second_Life_Provider, or Recycler.
16. THE API_Server SHALL exclude the identity of every Owner-role holder, whether to-holder or from-holder of a Custody_Log entry or Data_Owner of a battery, from every response to the ESG_Officer, including battery views, Scope3_Reports, and CSV exports.
17. THE API_Server SHALL exclude from Owner responses for a Returned_Battery all data recorded after the Return_Offer handover, including new Service_History records, Custody_Log entries, Telemetry readings, Routed_Pathway, and End_Of_Life_Record.
18. IF an Owner requests any action (Consent grant or withdrawal, Return_Offer acceptance, or any other write) on a Returned_Battery, THEN THE API_Server SHALL respond with an access-denied error and leave the Digital_Twin unchanged.

### Requirement 4: Consent

**User Story:** As a battery's data owner (an EV owner, or a fleet operator for fleet batteries), I want to control whether usage data is shared, so that other parties see it only with my permission.

#### Acceptance Criteria

1. WHEN the Data_Owner of a battery grants Consent for that battery, THE API_Server SHALL record the Consent on that battery's Digital_Twin with a timestamp of the grant and the granting Data_Owner's identity, and SHALL return a response indicating the battery's Consent status is granted.
2. WHEN the Data_Owner of a battery withdraws Consent for that battery, THE API_Server SHALL record the withdrawal on that battery's Digital_Twin with a timestamp and the withdrawing Data_Owner's identity, and SHALL return a response indicating the battery's Consent status is not granted.
3. THE API_Server SHALL treat a battery as lacking Consent when no Consent grant has been recorded for it or when the most recent recorded Consent event for it is a withdrawal, so that Consent is not granted by default.
4. WHERE a battery's Owner_Data identifies a Fleet_Operator as Data_Owner, THE API_Server SHALL accept Consent grants and withdrawals for that battery from that Fleet_Operator and SHALL NOT require Consent from any individual Owner.
5. WHILE a battery lacks Consent and the battery's Current_Holder is its Data_Owner, THE API_Server SHALL exclude Owner_Data and fields derived from Owner_Data (including Telemetry readings, SoH values, Charging_History, Fast_Charge_Share, Health_Score, Remaining_Life, Contributing_Factors, and Data_Owner identity) from every response to roles other than the Data_Owner's role, starting with the first request received after the withdrawal is recorded.
6. WHILE a battery lacks Consent and the battery's Current_Holder is its Data_Owner, THE API_Server SHALL return to those other roles, in place of each excluded field group, a marker stating that owner data is withheld pending consent.
7. WHILE a battery has Consent and the battery's Current_Holder is its Data_Owner, THE API_Server SHALL include the Owner_Data fields permitted by Requirement 3 for the Active_Role, starting with the first request received after the grant is recorded.
8. WHILE a battery's Current_Holder is a Service_Partner, Second_Life_Provider, or Recycler, THE API_Server SHALL return to that Current_Holder the fields permitted for its role by Requirement 3 regardless of Consent status, starting with the first request received after the handover away from the Data_Owner is recorded.
9. THE API_Server SHALL exclude the identity of an Owner-role Data_Owner from every response to the ESG_Officer regardless of Consent status and Current_Holder, per Requirement 3 criterion 16.
10. THE API_Server SHALL include Battery_Passport, Custody_Log, and End_Of_Life_Record fields permitted by Requirement 3 in responses regardless of Consent status.
11. THE API_Server SHALL continue to use Owner_Data internally for the Health_Model, Pathway_Recommender, Nudge_Engine, and Scope3_Reporter regardless of Consent status, and SHALL apply Consent only to the fields returned in responses.
12. IF a grant or withdrawal of Consent is requested by a stakeholder who is not the battery's Data_Owner, THEN THE API_Server SHALL reject the request with an error indicating the requester is not permitted to change Consent for that battery, and SHALL leave the battery's Consent status and recorded Consent events unchanged.
13. THE API_Server SHALL retain every recorded Consent grant and withdrawal for a battery in chronological order, without modifying or deleting earlier entries.
14. IF an Owner requests a Consent grant or withdrawal for a Returned_Battery of that Owner, THEN THE API_Server SHALL reject the request with an access-denied error per Requirement 3 criterion 18, even where Owner_Data still identifies that Owner as Data_Owner, and SHALL leave the battery's Consent status and recorded Consent events unchanged.

### Requirement 5: Health and Remaining-Life Model

**User Story:** As a stakeholder, I want an explainable health and remaining-life estimate, so that I understand why a battery is rated the way it is.

#### Acceptance Criteria

1. WHEN a Digital_Twin is evaluated for a given evaluation date, THE Health_Model SHALL compute a Health_Score from SoH, cycle count, and thermal event count taken from the most recent Telemetry reading timestamped on or before the evaluation date, and from the Fast_Charge_Share computed over Charging_History sessions dated on or before the evaluation date.
2. THE Health_Model SHALL produce a Health_Score that is an integer between 0 and 100 inclusive.
3. WHEN a Digital_Twin with a SoH above 80% and at least 2 Telemetry readings is evaluated, THE Health_Model SHALL compute Remaining_Life as a non-negative integer number of months and a non-negative integer number of cycles until SoH reaches 80%.
4. IF the SoH of the evaluated Digital_Twin is at or below 80%, THEN THE Health_Model SHALL report Remaining_Life as 0 months and 0 cycles.
5. WHEN a Health_Score is computed, THE Health_Model SHALL return exactly four Contributing_Factors (SoH, cycle count, Fast_Charge_Share, and thermal events), each with a signed numeric effect on the Health_Score, where a positive value raises the score, a negative value lowers it, and zero has no effect.
6. WHEN two Digital_Twins differ only in that one has a higher SoH, THE Health_Model SHALL assign the higher-SoH Digital_Twin a Health_Score greater than or equal to the other.
7. WHEN two Digital_Twins differ only in that one has a higher Fast_Charge_Share, higher cycle count, or more thermal events, THE Health_Model SHALL assign that Digital_Twin a Health_Score less than or equal to the other.
8. WHEN the same Digital_Twin is evaluated twice with the same evaluation date, THE Health_Model SHALL produce identical Health_Score, Remaining_Life, Contributing_Factors, and Data_Confidence_Score values.
9. IF a Digital_Twin has no Telemetry readings timestamped on or before the evaluation date, THEN THE Health_Model SHALL return no Health_Score, no Remaining_Life, and a reason stating that telemetry is missing, and SHALL leave the Digital_Twin unchanged.
10. WHEN a Health_Score is computed, THE Health_Model SHALL return a Data_Confidence_Score computed by the method in Requirement 6 criterion 10.
11. IF a Digital_Twin has an empty Charging_History, THEN THE Health_Model SHALL treat Fast_Charge_Share as 0% when computing the Health_Score and SHALL report the Fast_Charge_Share Contributing_Factor with an effect of 0.
12. IF a Digital_Twin with a SoH above 80% has fewer than 2 Telemetry readings timestamped on or before the evaluation date, THEN THE Health_Model SHALL return the Health_Score, return no Remaining_Life, and return a reason stating that insufficient telemetry history exists to estimate Remaining_Life.

### Requirement 6: Pathway Recommendation

**User Story:** As a stakeholder, I want each battery's next best pathway with its reasons, so that I can make an informed decision.

#### Acceptance Criteria

1. WHEN a Digital_Twin is evaluated against an evaluation date, THE Pathway_Recommender SHALL assign exactly one Pathway, chosen from Continue_Use, Inspect_Repair, Second_Life_Review, or Certified_Recycling.
2. WHEN a Digital_Twin is evaluated, THE Pathway_Recommender SHALL apply the assignment rules in this fixed precedence order and assign the Pathway of the first rule whose condition holds: (a) Certified_Recycling rule (criterion 3), (b) missing-Telemetry rule (criterion 4), (c) Inspect_Repair rule (criterion 5), (d) Continue_Use rule (criterion 6), (e) Second_Life_Review rule (criterion 7).
3. IF a Safety_Flag is present, or the most recent Telemetry reading reports SoH below 60%, THEN THE Pathway_Recommender SHALL assign Certified_Recycling, including when the Digital_Twin has no Telemetry readings and the Safety_Flag comes only from a Safety_Critical_Fault_Code in the Service_History.
4. IF a Digital_Twin has no Telemetry readings and no Safety_Flag is present, THEN THE Pathway_Recommender SHALL assign Inspect_Repair and return a reason stating that Telemetry is missing.
5. IF no Safety_Flag is present, the most recent Telemetry reading reports SoH of 60% or above, and a Recent_Fault exists relative to the evaluation date, THEN THE Pathway_Recommender SHALL assign Inspect_Repair.
6. WHEN a Digital_Twin is evaluated and the most recent Telemetry reading reports SoH of 80% or above, no Safety_Flag is present, and no Recent_Fault exists, THE Pathway_Recommender SHALL assign Continue_Use.
7. WHEN a Digital_Twin is evaluated and the most recent Telemetry reading reports SoH of 60% or above and below 80%, no Safety_Flag is present, and no Recent_Fault exists, THE Pathway_Recommender SHALL assign Second_Life_Review.
8. WHEN a Pathway is assigned, THE Pathway_Recommender SHALL return every rule whose condition held during evaluation, each with the rule name and the input values that satisfied it (SoH, thermal event count, Safety_Critical_Fault_Code, Recent_Fault date, or Telemetry absence, as applicable), and SHALL identify which of those rules determined the assigned Pathway.
9. WHEN a Pathway is assigned, THE Pathway_Recommender SHALL return a Data_Confidence_Score as an integer from 0 to 100 and the battery's Consent status (granted or not granted) as a separate field.
10. THE Pathway_Recommender SHALL compute the Data_Confidence_Score by starting at 100 and subtracting these fixed deductions, each applied at most once: 30 when Telemetry has no readings, 20 when Charging_History has no sessions, 20 when Service_History has no records, and 15 when one or more Battery_Passport fields are empty, with a minimum result of 0.
11. WHEN a missing record category is added to an otherwise unchanged Digital_Twin and the Digital_Twin is re-evaluated with the same evaluation date, THE Pathway_Recommender SHALL produce a Data_Confidence_Score greater than or equal to the previous score.
12. WHEN the same Digital_Twin is evaluated more than once with the same evaluation date and unchanged records, THE Pathway_Recommender SHALL return the same Pathway, the same fired rules, and the same Data_Confidence_Score each time.
13. WHEN the Plugin displays a Second_Life_Review or Certified_Recycling Pathway, Routed_Pathway, or End_Of_Life_Record pathway, THE Plugin SHALL display the Validation_Notice in the same view and adjacent to the pathway name.
14. WHEN the Plugin displays any Pathway recommendation, THE Plugin SHALL display a label identifying the recommendation as decision support in the same view as the Pathway name.
15. THE Pathway_Recommender SHALL compute the same Data_Confidence_Score for a given Digital_Twin and evaluation date regardless of Consent status and Active_Role.

### Requirement 7: Owner View and Nudges

**User Story:** As an EV owner, I want clear guidance on my battery, so that I can charge well, repair early, and return the battery responsibly.

#### Acceptance Criteria

1. WHILE the Active_Role is Owner, THE Plugin SHALL display, for each battery whose Current_Holder is the Owner identity selected in the Role_Switcher, the Health_Score with its Contributing_Factors, the Impact_Score, the Remaining_Life in both months and cycles, the Pathway recommendation with its Data_Confidence_Score, all active Nudges, and the Consent status (granted or not granted).
2. WHILE the Active_Role is Owner and the selected Owner is the Current_Holder of zero batteries, THE Plugin SHALL display a message indicating that no batteries are held.
3. WHEN the Nudge_Engine evaluates a battery whose Charging_History contains 1 or more sessions and whose Fast_Charge_Share is greater than 40%, THE Nudge_Engine SHALL generate a Charging_Guidance Nudge that states the current Fast_Charge_Share as a whole-number percentage.
4. WHEN the Nudge_Engine evaluates a battery for which a Falling_SoH_Trend is detected, THE Nudge_Engine SHALL generate a Service_Prompt Nudge that states the SoH decline across the 180-day window in percentage points with one decimal place.
5. WHEN the Pathway_Recommender assigns Second_Life_Review or Certified_Recycling to a battery whose Current_Holder has the Owner role, THE Nudge_Engine SHALL generate a Return_Incentive Nudge containing a Return_Offer that names one designated Service_Partner identity selected per criterion 17.
6. WHEN an Owner who is the Current_Holder of a battery accepts an unaccepted Return_Offer for that battery, THE API_Server SHALL append one Custody_Log handover dated the acceptance date, with the Owner as from-holder, the designated Service_Partner as to-holder, and Service_Partner as to-holder role.
7. WHEN an Owner accepts a Return_Offer, THE API_Server SHALL mark the Return_Offer as accepted and remove the Return_Incentive Nudge from the Owner's active Nudges.
8. WHEN an Owner grants or withdraws Consent in the Plugin, THE API_Server SHALL persist the updated Consent and THE Plugin SHALL display the updated Consent status within 2 seconds of the action.
9. WHILE the Active_Role is Owner, THE Plugin SHALL display the Impact_Score alongside a label stating that the score reflects owner behaviors and is not an emissions-reduction figure.
10. THE Nudge_Engine SHALL keep at most one active Nudge of each Nudge type (Charging_Guidance, Service_Prompt, Return_Incentive) per battery, so that repeated evaluation under unchanged conditions creates no duplicate Nudges.
11. IF an Owner attempts to accept a Return_Offer that is already accepted, or for a battery whose Current_Holder is not that Owner, THEN THE API_Server SHALL reject the acceptance and leave the Custody_Log and Return_Offer unchanged, and THE Plugin SHALL display an error message indicating the offer cannot be accepted.
12. IF a Consent update fails to persist, THEN THE Plugin SHALL keep displaying the previous Consent status and display an error message indicating the Consent change was not saved.
13. WHEN a battery whose Current_Holder has the Owner role is evaluated for an evaluation date, THE API_Server SHALL compute the Impact_Score as the sum of 25 points for each of the four Impact_Score components (Charging_Component, Servicing_Component, Consent_Component, Return_Component) earned per the Impact_Score definition, producing exactly one of 0, 25, 50, 75, or 100.
14. WHILE the Active_Role is Owner, THE Plugin SHALL display, alongside each Impact_Score, each of the four Impact_Score components with an indication of whether the component was earned (+25) or not earned (0).
15. WHEN the same battery is evaluated more than once with the same evaluation date and unchanged Charging_History, Nudges, Consent, and Return_Offer, THE API_Server SHALL produce the same Impact_Score and the same set of earned components each time.
16. WHEN the Nudge_Engine generates a Service_Prompt Nudge, THE Nudge_Engine SHALL record the evaluation date as the Nudge's creation date and SHALL retain that creation date unchanged while the Nudge remains active.
17. WHEN the Nudge_Engine generates a Return_Offer, THE Nudge_Engine SHALL designate the Service_Partner identity whose Location state equals the Owner's Location state, choosing the first by name in ascending alphabetical order when several match, and choosing the first Service_Partner identity by name in ascending alphabetical order when none match.
18. WHEN an Owner accepts a Return_Offer, THE Plugin SHALL display, in the same view, a confirmation message with the text "Return accepted, +25 Impact points", naming the designated Service_Partner and the acceptance date.
19. WHEN an Owner accepts a Return_Offer, THE API_Server SHALL record a Final_Impact_Score for that battery and Owner, computed for the acceptance date with the Return_Component earned (+25) and with the Charging_Component, Servicing_Component, and Consent_Component evaluated as they stood immediately before the Custody_Log handover, together with the earned/not-earned state of each of the four components.
20. THE API_Server SHALL record each Final_Impact_Score as exactly one of 25, 50, 75, or 100, since the Return_Component is earned.
21. THE API_Server SHALL keep each recorded Final_Impact_Score and its component states unchanged after recording, regardless of later Service_History, Telemetry, Custody_Log, Routed_Pathway, Consent, or End_Of_Life_Record changes to the battery (immutability property).
22. WHILE the Active_Role is Owner and the selected Owner has one or more Returned_Batteries, THE Plugin SHALL display a "Returned batteries" section listing every Returned_Battery of that Owner, each entry showing battery ID, return date (the acceptance date), the designated Service_Partner's name, the Final_Impact_Score, and each of its four components marked earned or not earned.
23. WHILE the Active_Role is Owner and the selected Owner has zero Returned_Batteries, THE Plugin SHALL hide the "Returned batteries" section.
24. WHILE the Active_Role is Owner, THE Plugin SHALL display no action controls (Consent, Return_Offer acceptance, or other) for any Returned_Battery.

### Requirement 8: Fleet Operator View

**User Story:** As a fleet operator, I want fleet-wide health and a replacement forecast, so that I can plan maintenance and budget for replacements.

#### Acceptance Criteria

1. WHILE the Active_Role is Fleet_Operator, THE Plugin SHALL display a list of every battery whose Current_Holder is the acting Fleet_Operator identity, showing for each battery its battery ID, Health_Score, SoH, Remaining_Life in both months and cycles (or "unknown" when no Remaining_Life is available), and Consent status, ordered by Health_Score ascending.
2. WHILE the Active_Role is Fleet_Operator, WHEN the Fleet_Operator selects a battery from the fleet list, THE Plugin SHALL display a chart of SoH against timestamp containing one point for every Telemetry reading of the selected battery, ordered by timestamp ascending.
3. WHILE the Active_Role is Fleet_Operator, IF the selected battery has zero Telemetry readings, THEN THE Plugin SHALL display a message indicating that no SoH history is available in place of the SoH chart.
4. WHILE the Active_Role is Fleet_Operator, THE Plugin SHALL display the Replacement_Forecast for the fleet as four labeled counts, one for each of the 4 consecutive calendar quarters starting with the calendar quarter that contains the evaluation date.
5. WHILE the Active_Role is Fleet_Operator, THE Plugin SHALL provide a control to grant or withdraw Consent for each fleet battery, per Requirement 4 criterion 4.
6. WHEN a Fleet_Operator flags a battery in the fleet for inspection and selects one Service_Partner identity as the referral recipient, THE API_Server SHALL record on the Digital_Twin an Inspection_Flag containing the flag date, the flagging Fleet_Operator identity, and the selected Service_Partner identity.
7. WHEN the API_Server records an Inspection_Flag, THE API_Server SHALL make the battery visible as referred for inspection to the selected Service_Partner identity only, and to no other Service_Partner identity.
8. THE Replacement_Forecast SHALL count each fleet battery whose Remaining_Life is 12 months or less in exactly one quarter, namely the quarter containing the date obtained by adding the battery's Remaining_Life in months to the evaluation date, counting the battery in the fourth quarter when that date falls after the fourth quarter ends, so that the sum of the four quarterly counts equals the number of fleet batteries whose Remaining_Life is 12 months or less.
9. THE Replacement_Forecast SHALL exclude every fleet battery whose Remaining_Life is greater than 12 months or is not available.
10. IF a Fleet_Operator submits an Inspection_Flag for a battery whose Current_Holder is not that Fleet_Operator identity, or without selecting a Service_Partner identity, THEN THE API_Server SHALL reject the request, record no Inspection_Flag, and leave the Digital_Twin unchanged, and THE Plugin SHALL display an error message indicating the reason for rejection.
11. WHILE the Active_Role is Fleet_Operator, THE Plugin SHALL display a "hand over to Service_Partner" control for each fleet battery that has an Inspection_Flag, naming the Service_Partner identity selected in the most recent Inspection_Flag.
12. WHEN a Fleet_Operator performs the "hand over to Service_Partner" action on a battery whose Current_Holder is that Fleet_Operator identity and that has an Inspection_Flag, THE API_Server SHALL append one Custody_Log handover dated the current date with from-holder set to the Fleet_Operator, to-holder set to the Service_Partner selected in the most recent Inspection_Flag, and to-holder role Service_Partner.
13. IF a Fleet_Operator performs the "hand over to Service_Partner" action on a battery that has no Inspection_Flag or whose Current_Holder is not that Fleet_Operator identity, THEN THE API_Server SHALL reject the request with an error indicating the reason and leave the Custody_Log unchanged, and THE Plugin SHALL display an error message indicating the reason for rejection.

### Requirement 9: Service Partner View

**User Story:** As a service partner, I want a battery's fault and service history and module condition, so that I can repair it correctly and record what I did.

#### Acceptance Criteria

1. WHILE the Active_Role is Service_Partner, THE Plugin SHALL display, for each battery whose Current_Holder is the acting Service_Partner, that has an accepted Return_Offer designating the acting Service_Partner, or that has an Inspection_Flag selecting the acting Service_Partner, the battery's Service_History records in reverse chronological order (each showing date, fault code, action taken, and modules replaced), the Module_Condition of every module of the battery, the battery's current Pathway recommendation with its Data_Confidence_Score, the battery's Consent status, and whether the battery is assigned or referred for inspection.
2. WHEN a Service_Partner submits a repair log for a battery whose Current_Holder is the acting Service_Partner, containing a date no later than the current date, a fault code (which may be empty), an action taken of 1 to 500 characters, and zero or more module IDs belonging to that battery as modules replaced, THE API_Server SHALL append one Service_History record with that date, fault code, action taken, and modules replaced to the battery's Digital_Twin.
3. WHEN a Service_Partner logs a repair that lists one or more modules replaced, THE API_Server SHALL set the Module_Condition of each listed module to Good and SHALL leave the Module_Condition of all unlisted modules of that battery unchanged.
4. WHEN a Service_Partner refers a battery whose Current_Holder is the acting Service_Partner to a selected Second_Life_Provider, THE API_Server SHALL append one Custody_Log handover dated the current date with from-holder set to the acting Service_Partner, to-holder set to the selected Second_Life_Provider, and to-holder role Second_Life_Provider, and SHALL set the battery's Routed_Pathway to Second_Life_Review.
5. WHEN a Service_Partner dispatches a battery whose Current_Holder is the acting Service_Partner to a selected Recycler with an expected arrival date that is no earlier than the current date and no later than 90 days after the current date, THE API_Server SHALL append one Custody_Log handover dated the current date with from-holder set to the acting Service_Partner, to-holder set to the selected Recycler, to-holder role Recycler, and the expected arrival date, set the battery's Routed_Pathway to Certified_Recycling, and set its Intake_Status to Awaiting_Intake.
6. IF a Service_Partner submits a repair log with a missing date, a date later than the current date, a missing or empty action taken, an action taken longer than 500 characters, or a modules-replaced entry that does not identify a module of that battery, THEN THE API_Server SHALL reject the request with a validation error identifying each invalid field, SHALL NOT append any Service_History record, and SHALL leave all Module_Conditions unchanged.
7. IF a Service_Partner submits a referral or dispatch for a battery whose Current_Holder is not the acting Service_Partner, or names a target whose role is not Second_Life_Provider (for referral) or Recycler (for dispatch), or submits a dispatch with a missing expected arrival date or one outside the range of the current date to 90 days after the current date, THEN THE API_Server SHALL reject the request with a validation error indicating the reason, SHALL NOT append any Custody_Log entry, and SHALL leave the battery's Routed_Pathway unchanged.
8. WHILE the Active_Role is Service_Partner, THE Plugin SHALL display the Validation_Notice next to every referral-to-Second_Life_Provider control and every dispatch-to-Recycler control, and in the confirmation shown after each referral or dispatch succeeds.
9. WHILE the Active_Role is Service_Partner and a displayed battery is visible only through an Inspection_Flag with a Fleet_Operator as Current_Holder, THE Plugin SHALL show the repair, referral, and dispatch controls for that battery as disabled together with a message stating that custody handover from the Fleet_Operator is pending.

### Requirement 10: Second-Life Provider View

**User Story:** As a second-life provider, I want capacity, safety history and application fit for batteries in second-life review, so that I can choose suitable batteries for reuse.

#### Acceptance Criteria

1. WHILE the Active_Role is Second_Life_Provider, THE Plugin SHALL display, for each battery whose Routed_Pathway is Second_Life_Review and whose Current_Holder is the acting Second_Life_Provider, the battery ID, capacity in kWh, SoH in percent, Usable_Capacity in kWh rounded to one decimal place, safety history (Safety_Flag status, thermal event count, and each Safety_Critical_Fault_Code with its date), Application_Fit, acceptance status (Pending or Accepted), Pathway recommendation with its Data_Confidence_Score, and Consent status.
2. WHEN a battery is displayed to a Second_Life_Provider, THE Platform SHALL compute Usable_Capacity as capacity × SoH / 100 and SHALL compute Application_Fit as follows: Stationary_Storage when SoH is 60% or above and Usable_Capacity is 10.0 kWh or above; Light_Mobility when SoH is 70% or above and Usable_Capacity is 2.0 kWh or above; both when both conditions hold; and None, exclusively and never combined with another value, when neither condition holds, when a Safety_Flag is present, or when the battery has no Telemetry readings.
3. WHEN a Second_Life_Provider accepts a battery in its view that has no Safety_Flag and no existing End_Of_Life_Record, THE API_Server SHALL create an End_Of_Life_Record with pathway Second_Life_Review, the acceptance date set to the current date, and the acting Second_Life_Provider as receiving party, and THE Plugin SHALL display the battery as Accepted.
4. WHEN a Second_Life_Provider dispatches a battery in its view (Pending or Accepted) to a Recycler with an expected arrival date no earlier than the dispatch date and no later than 90 days after it, THE API_Server SHALL append a Custody_Log handover dated the dispatch date, from the acting Second_Life_Provider to that Recycler with to-holder role Recycler, recording the expected arrival date, set the battery's Routed_Pathway to Certified_Recycling, and set its Intake_Status to Awaiting_Intake.
5. WHILE the Active_Role is Second_Life_Provider, THE Plugin SHALL display the Validation_Notice adjacent to the accept action and the dispatch-to-Recycler action for every displayed battery.
6. IF a Second_Life_Provider attempts to accept a battery with a Safety_Flag present, THEN THE API_Server SHALL reject the request with an error indicating the battery is safety-flagged and SHALL NOT create an End_Of_Life_Record, and THE Plugin SHALL show the accept action as disabled for that battery while keeping the dispatch-to-Recycler action available.
7. IF a Second_Life_Provider submits an accept or dispatch request for a battery outside its view per criterion 1, or an accept request for a battery that already has an End_Of_Life_Record, THEN THE API_Server SHALL reject the request with an error indicating the battery is not available to that Second_Life_Provider and SHALL leave the Custody_Log and End_Of_Life_Record unchanged.
8. IF a Second_Life_Provider submits a dispatch request with a missing Recycler, a missing expected arrival date, or an expected arrival date outside the range of the dispatch date to 90 days after it, THEN THE API_Server SHALL reject the request with a validation error identifying the invalid field and SHALL leave the Custody_Log unchanged.

### Requirement 11: Recycler View

**User Story:** As a recycler, I want chemistry, location and expected arrival for incoming batteries, so that I can plan intake and record recovered materials.

#### Acceptance Criteria

1. WHILE the Active_Role is Recycler, THE Plugin SHALL display, for each battery whose Routed_Pathway is Certified_Recycling and whose most recent Custody_Log entry is a handover to the acting Recycler, the battery ID, chemistry, Pack_Mass, Location (the city and state of the from-holder of that handover), expected arrival date, and Intake_Status, ordered by expected arrival date ascending.
2. WHILE the Active_Role is Recycler and no battery meets criterion 1, THE Plugin SHALL display a message indicating that no incoming batteries exist.
3. WHEN a Recycler logs intake with an intake date for a battery in its view with Intake_Status Awaiting_Intake, THE API_Server SHALL record the intake date against the existing dispatch handover, set the battery's Intake_Status to Received, and append no additional Custody_Log entry.
4. IF a Recycler logs intake for a battery outside its view, or whose Intake_Status is already Received, or with an intake date that is missing, earlier than the dispatch handover date, or later than the current date, THEN THE API_Server SHALL reject the request with a validation error indicating the failed condition and leave the Custody_Log and Intake_Status unchanged.
5. WHEN a Recycler logs materials recovered for a battery with Intake_Status Received, THE API_Server SHALL create the End_Of_Life_Record, or replace any existing End_Of_Life_Record (including a prior Second_Life_Review record), with pathway Certified_Recycling, the log date as date, the Recycler as receiving party, and recovered mass in kg for each material.
6. IF a Recycler logs materials recovered for a battery whose Intake_Status is not Received, THEN THE API_Server SHALL reject the request with a validation error indicating that intake must be logged first and leave the End_Of_Life_Record unchanged.
7. IF a Recycler logs materials recovered containing zero materials, any material mass less than 0 kg, or a total mass greater than the battery's Pack_Mass, THEN THE API_Server SHALL reject the request with a validation error indicating the failed condition and leave the End_Of_Life_Record unchanged.
8. WHILE the Active_Role is Recycler, THE Plugin SHALL display the Validation_Notice adjacent to the intake action for each battery with Intake_Status Awaiting_Intake.

### Requirement 12: ESG Scope 3 Category 12 Report

**User Story:** As a carmaker ESG officer, I want the disposition of every sold battery with its data quality, so that I can report measured Scope 3 Category 12 data instead of estimates.

#### Acceptance Criteria

1. WHILE the Active_Role is ESG_Officer, THE Plugin SHALL display Disposition, Custody_Log (each entry limited per Requirement 3 criteria 15 and 16), Measurement_Status, Data_Confidence_Score, and Consent status for every battery whose Battery_Passport manufacturer equals the manufacturer of the selected ESG_Officer identity, and SHALL display no battery of any other manufacturer.
2. WHEN an ESG_Officer requests a Scope3_Report for its manufacturer and a reporting period defined by a start date and an end date (inclusive), THE Scope3_Reporter SHALL include every battery of that manufacturer with a manufacture date on or before the period end date, including batteries manufactured before the period start date and batteries whose End_Of_Life_Record is dated before the period start date; the period start date SHALL be used only for validation and shown on the Scope3_Report alongside the end date.
3. WHEN a Scope3_Report is generated, THE Scope3_Reporter SHALL assign each battery exactly one Disposition, considering only End_Of_Life_Records and Custody_Log entries dated on or before the period end date, using the first matching rule in this order: (a) Recycled, if an End_Of_Life_Record with pathway Certified_Recycling exists or the Current_Holder as of the period end date has role Recycler; (b) Second_Life, if an End_Of_Life_Record with pathway Second_Life_Review exists or the Current_Holder as of the period end date has role Second_Life_Provider; (c) In_Use, if no End_Of_Life_Record exists and the Current_Holder as of the period end date has role Owner, Fleet_Operator, or Service_Partner; (d) Unknown, in all other cases, including a battery with no Custody_Log entries dated on or before the period end date.
4. WHEN a Scope3_Report is generated, THE Scope3_Reporter SHALL assign each battery Measurement_Status Measured if an End_Of_Life_Record or a Custody_Log handover to a Second_Life_Provider or Recycler dated on or before the period end date exists for the battery, and Estimated otherwise.
5. WHEN a Scope3_Report is generated, THE Scope3_Reporter SHALL produce a count for each of the four Dispositions (In_Use, Second_Life, Recycled, Unknown), including Dispositions with a count of 0, whose sum equals the total number of batteries in the Scope3_Report.
6. WHEN a Scope3_Report containing 1 or more batteries with Disposition Second_Life, Recycled, or Unknown is generated, THE Scope3_Reporter SHALL compute Measured_Share as the number of those batteries with Measurement_Status Measured divided by the number of those batteries, multiplied by 100, rounded half-up to one decimal place (for example, 1 of 3 yields 33.3), excluding batteries with Disposition In_Use from both numerator and denominator.
7. WHEN a Scope3_Report is generated, THE Scope3_Reporter SHALL compute each battery's Data_Confidence_Score by the method in Requirement 6 criterion 10 and SHALL report each battery's Consent status (granted or not granted) as a separate field.
8. WHEN an ESG_Officer exports a Scope3_Report, THE Scope3_Reporter SHALL produce a CSV file containing a header row and one row per battery with battery ID, Disposition, Measurement_Status, Data_Confidence_Score, Consent status, and End_Of_Life_Record date, where the End_Of_Life_Record date field is empty for a battery with no End_Of_Life_Record dated on or before the period end date, and with no Custody_Log data, so that the CSV file contains no custody holder identities.
9. WHEN an ESG_Officer exports a Scope3_Report, THE Scope3_Reporter SHALL include, after the battery rows, summary rows containing the manufacturer, period start date, period end date, one count per Disposition, the Not_Yet_EOL_Count labeled "not yet at end of life", and Measured_Share.
10. THE Scope3_Reporter SHALL escape CSV field values containing commas, double quotes, or line breaks according to RFC 4180 by enclosing the field in double quotes and doubling each embedded double quote.
11. FOR ALL valid Scope3_Reports, exporting to CSV then parsing the CSV SHALL produce a report equivalent to the original, where equivalent means the same set of battery IDs, the same Disposition, Measurement_Status, Data_Confidence_Score, Consent status, and End_Of_Life_Record date per battery, the same Disposition counts, the same Not_Yet_EOL_Count, and the same Measured_Share (round-trip property).
12. THE Scope3_Report SHALL contain Dispositions, Measurement_Status, Data_Confidence_Score, Consent status, Custody_Log entries limited per Requirement 3 criteria 15 and 16, counts, Not_Yet_EOL_Count, and Measured_Share only, with no emissions or emissions-reduction quantity.
13. WHILE a Scope3_Report is displayed, THE Plugin SHALL display a statement that the report does not quantify emissions reductions.
14. IF the reporting period end date is before the period start date, or either date is missing or not a valid calendar date, THEN THE Scope3_Reporter SHALL return a validation error indicating the invalid period and SHALL generate no Scope3_Report and no CSV file, and THE Plugin SHALL display the error and retain the entered dates.
15. IF an ESG_Officer requests a Scope3_Report, export, or battery view for a manufacturer other than the manufacturer of the selected ESG_Officer identity, THEN THE API_Server SHALL reject the request with an error indicating access is not permitted and SHALL return no battery data.
16. IF a Scope3_Report contains 0 batteries with Disposition Second_Life, Recycled, or Unknown (including a Scope3_Report in which every battery has Disposition In_Use), THEN THE Scope3_Reporter SHALL report Measured_Share as 0.0.
17. IF a Scope3_Report contains 0 batteries, THEN THE Scope3_Reporter SHALL report all four Disposition counts and the Not_Yet_EOL_Count as 0 and Measured_Share as 0.0, the CSV export SHALL contain the header row and summary rows with no battery rows, and THE Plugin SHALL display a message indicating no batteries match the manufacturer and period.
18. WHILE a Scope3_Report is displayed, THE Plugin SHALL display the Not_Yet_EOL_Count labeled "not yet at end of life" as a count separate from Measured_Share.

### Requirement 13: Embeddable Plugin and Role Switcher

**User Story:** As a demo presenter, I want one embeddable component that changes view by role, so that I can show every stakeholder's perspective in one place.

#### Acceptance Criteria

1. THE Plugin SHALL be a single UI component that accepts exactly two inputs, an Active_Role (one of Owner, Fleet_Operator, Service_Partner, Second_Life_Provider, Recycler, or ESG_Officer) and a stakeholder identity, and renders only the view defined for that Active_Role using data returned by the API_Server for that stakeholder identity.
2. WHEN the Role_Switcher selection of Active_Role or stakeholder identity changes, THE Plugin SHALL replace the displayed view with the view for the newly selected Active_Role and stakeholder identity within 2 seconds, measured from the selection change to the completed render, with the Platform running locally on data loaded by the Seed_Script.
3. THE Role_Switcher SHALL list exactly the six Active_Role values and, for each role, every stakeholder identity of that role present in the data loaded by the Seed_Script, with a minimum of 1 stakeholder identity per role.
4. WHEN the Active_Role selection changes in the Role_Switcher, THE Role_Switcher SHALL restrict the stakeholder identity list to identities of the newly selected role and select the first identity in that list by default.
5. THE Platform SHALL provide a host page that embeds one instance of the Plugin and one instance of the Role_Switcher, both visible without navigating to another page.
6. THE Plugin SHALL render every interactive control so that it is reachable with the Tab key, activatable with the Enter key (and the Space key for buttons and checkboxes), shows a visible focus indicator when focused, and exposes a non-empty accessible name.
7. WHILE the Plugin is awaiting a response from the API_Server after a Role_Switcher selection change, THE Plugin SHALL display a loading indicator that has an accessible name and SHALL remove it when the view renders or an error message is displayed.
8. IF the API_Server returns an error or does not respond within 10 seconds, THEN THE Plugin SHALL display an error message indicating which operation failed, retain the previously displayed view data and the current Role_Switcher selection, and keep all controls of the previous view operable.
9. IF the Plugin receives an Active_Role that is not one of the six defined roles, or a stakeholder identity that does not exist for that Active_Role in the data loaded by the Seed_Script, THEN THE Plugin SHALL display a message indicating the invalid role or identity and SHALL render no Digital_Twin data.

### Requirement 14: Runnable Prototype, README and Demo Walkthrough

**User Story:** As an evaluator, I want to start the app locally and follow a scripted demo, so that I can see one battery's full lifecycle end to end.

#### Acceptance Criteria

1. THE Platform SHALL run locally using only synthetic data generated by the Seed_Script, making zero network calls to external battery, carmaker, or recycler systems, and SHALL complete every demo walkthrough step while the host machine has no internet connection.
2. THE README SHALL document the prerequisites and the install, seed, and start commands for the Platform, with each command given as literal text that an evaluator can run as written, in the order install, seed, start.
3. THE README SHALL contain a numbered demo walkthrough that identifies the designated demo battery by its battery ID, names the Active_Role and stakeholder identity to select in the Role_Switcher for each step, and traces the demo battery from Owner to Service_Partner to Second_Life_Provider to Recycler, ending with the ESG_Officer exporting the Scope3_Report.
4. THE README demo walkthrough SHALL include a step in which the Owner grants Consent for the demo battery before the Owner accepts the Return_Offer.
5. THE README demo walkthrough SHALL specify, for the ESG_Officer step, the demo battery's manufacturer and a reporting period whose start date is on or before the current date and whose end date is on or after the current date.
6. WHEN the Seed_Script completes, THE Platform SHALL contain the demo battery with Current_Holder role Owner, Consent not granted, no End_Of_Life_Record, no Routed_Pathway, no Custody_Log handovers to a Service_Partner, Second_Life_Provider, or Recycler, and seeded records for which the Pathway_Recommender assigns Second_Life_Review (SoH 60% or above and below 80%, no Safety_Flag, no Recent_Fault), so that a Return_Offer is shown to the Owner.
7. WHEN the Seed_Script is run again after a walkthrough has been completed, THE Platform SHALL restore the demo battery to the state defined in criterion 6.
8. THE Platform SHALL allow every demo walkthrough step to be completed using only the Plugin and the Role_Switcher, without command-line, API, or direct data-store actions after the start command.
9. WHEN the demo walkthrough steps are followed after a fresh seed, THE Plugin SHALL show the demo battery's Custody_Log containing handovers to the Service_Partner, the Second_Life_Provider, and the Recycler in that order, with the Recycler as the Current_Holder.
10. WHEN the ESG_Officer generates the Scope3_Report for the manufacturer and reporting period specified in the demo walkthrough after the walkthrough is completed, THE Scope3_Reporter SHALL list the demo battery with Disposition Recycled and Measurement_Status Measured, both in the on-screen report and in the exported Scope3_Report.
11. THE README SHALL state that the prototype uses a Role_Switcher in place of production authentication.
12. THE README demo walkthrough SHALL include, immediately after the step in which the Owner accepts the Return_Offer, a step in which the Owner sees the confirmation message "Return accepted, +25 Impact points" and sees the demo battery in the "Returned batteries" section.
13. WHEN the demo walkthrough is followed after a fresh seed and the Owner accepts the Return_Offer, THE Plugin SHALL show the demo battery in the "Returned batteries" section with a Final_Impact_Score of at least 50, with the Consent_Component earned (Consent granted earlier in the walkthrough) and the Return_Component earned.
