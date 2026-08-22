# Booking Widget — Doctor Display Order

`public/assets/booking-widget.html` fetches doctors from `GET /api/public/doctors`
in whatever order the API returns them (no `ORDER BY` guarantee). Before
rendering the doctor-selection list (`#doctorsList`, populated by
`loadDoctors()`), the widget re-sorts that array for display only — the
API call, doctor data, validation, and booking flow are untouched.

## Order

1. **Dr. Vishal Parmar** — always first, regardless of specialty.
2. **Pediatricians**
3. **Gynecologists**
4. **General Physicians**
5. **Dietician / Nutritionist**
6. **Skin Specialist**
7. Any other specialty — keeps its place after the groups above, in
   whatever order the API returned it (stable sort, no doctors are hidden
   or dropped).

## How it works

`doctorDisplayRank(d)` (in `booking-widget.html`) maps a doctor to a rank:

| Rank | Match                                                        |
|------|---------------------------------------------------------------|
| -1   | Name (minus `Dr.` prefix) equals "vishal parmar", case-insensitive |
| 0    | `specialization` matches `/pediatric\|paediatric/i`            |
| 1    | `specialization` matches `/gynec\|gynaec\|obstetric/i`          |
| 2    | `specialization` matches `/general physician\|general medicine\|\bphysician\b/i` |
| 3    | `specialization` matches `/dietician\|dietitian\|nutrition/i`   |
| 4    | `specialization` matches `/skin\|dermat/i`                      |
| 5    | Anything else                                                  |

`sortDoctorsForDisplay(docs)` stable-sorts by that rank, so doctors within
the same group (or the same "everything else" bucket) keep their original
relative order.

## Adjusting the groups

Specialization is free text set by an admin per doctor (`Doctor.specialization`
in `prisma/schema.prisma`), so the regexes above are intentionally loose
(e.g. "Pediatrician", "Paediatrics", "Pediatric Specialist" all match rank 0).
If a doctor isn't landing in the expected group, check their exact
`specialization` value in the admin doctor list and, if needed, widen the
matching regex for that group in `doctorDisplayRank()` — do not add a new
per-doctor special case unless it's another always-pinned individual like
Dr. Vishal Parmar.

To pin a different doctor first instead of (or in addition to) Dr. Vishal
Parmar, edit the name check at the top of `doctorDisplayRank()`. The same
pinning pattern is also used independently in the Admin portal's doctor
list (`stripDrPrefix` + name match in `public/admin/app.js`'s
`renderDoctors()`) — the two are separate implementations for separate
UIs and must be updated independently.
