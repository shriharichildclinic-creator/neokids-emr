# Vaccination Schedule (used by `vaccination.service.js`)

The `SCHEDULE` array in `src/services/vaccination.service.js` follows the
IAP (Indian Academy of Pediatrics) recommended schedule. Each entry is
expanded into a concrete due date by adding `ageDays` to the patient's
`dateOfBirth`.

| Age              | Vaccines                                               |
|------------------|--------------------------------------------------------|
| Birth            | BCG, OPV (0), Hepatitis B - 1                          |
| 6 weeks          | DTwP/DTaP-1, IPV-1, Hib-1, HepB-2, Rota-1, PCV-1       |
| 10 weeks         | DTwP/DTaP-2, IPV-2, Hib-2, Rota-2, PCV-2               |
| 14 weeks         | DTwP/DTaP-3, IPV-3, Hib-3, Rota-3, PCV-3               |
| 6 months         | Hepatitis B - 3, Influenza - 1                         |
| 7 months         | Influenza - 2                                          |
| 9 months         | MMR - 1                                                |
| 12 months        | Hepatitis A - 1                                        |
| 15 months        | PCV Booster, MMR - 2, Varicella - 1                    |
| 18 months        | DTwP/DTaP Booster 1, IPV Booster, Hib Booster, HepA-2  |
| 2 years          | Typhoid Conjugate                                      |
| 4 – 6 years      | DTwP/DTaP Booster 2, OPV Booster, Varicella-2, MMR-3   |
| 9 – 14 years     | HPV-1, HPV-2                                           |
| 10 – 12 years    | Tdap                                                   |

The service scans this table daily and dispatches WhatsApp + Email
reminders for any dose whose due date falls within `VACC_APPROACH_DAYS`
(default: 7) days from today. Each `(patient, vaccine, dueDate)`
combination is deduplicated via `NotificationLog`.

## Testing & manual trigger

- **Manual trigger (admin JWT required):**
  `POST /api/admin/jobs/vaccination-reminders/run`
  Runs the full scan immediately and returns the effective config
  (template name, portal URL, WA provider, SMTP/Meta configured flags)
  plus `{ considered, sent, skippedDedup, patients }`.
- **Local dry run:** `node scripts/test-vaccination-reminders.js`
  prints matching patients/vaccines, dispatches with dedup, and lists the
  NotificationLog rows written by the run.
- **Kill switch:** set `VACC_REMINDERS_ENABLED=false` to pause sends.
- **Delivery audit:** Admin → Notification Logs; template name is
  `neokids_vacc_reminder_v2`; every send carries
  `payload.dedupKey = "VACC:<code>:<dueDate>"`.

## Disclaimer (mandatory in every reminder)

Both the WhatsApp template body (var {{5}}) and the email (highlighted
box) include the disclaimer stating that administered-vaccine data is
not tracked, the reminder is age/schedule derived, it is not a
confirmation that a vaccine is pending, and parents should consult their
pediatrician / visit the Vaccination Portal.
