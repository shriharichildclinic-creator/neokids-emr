# 🏥 NeoKids EMR & Booking System

> **🚧 Active Development** — I'm actively building this. Not production-ready. Things will break and change.

Backend API for [neokidspro.in](https://neokidspro.in) — a Pediatric Clinic platform I'm building end-to-end.

This repo handles the **EMR (Electronic Medical Records)** and **appointment booking** system. It's designed to plug into the WordPress + Elementor frontend I've also built for the same clinic (documented below).

**Stack:** Node.js · Express · Prisma · MySQL · Hostinger VPS

---

## 🌐 Part of a Bigger Project

This backend is one piece of NeoKidsPro. Here's the full picture:

| Layer | What | Status |
|---|---|---|
| Frontend | WordPress + Elementor — [neokidspro.in](https://neokidspro.in) | ✅ Live |
| Backend API | This repo — EMR + Booking | 🚧 In Development |

### WordPress Frontend — What I Built

The live site at [neokidspro.in](https://neokidspro.in) was fully designed and developed by me using **WordPress + Elementor Pro**.

**Pages built:**
- Home Page
- Doctor Listing Page
- Individual Doctor Profile Pages
- Blog / Articles Section
- Legal & Compliance Pages (Privacy Policy, Data Protection, Telemedicine Guidelines, Refund & Cancellation Policy — Mumbai jurisdiction)

**Doctor system (ACF-based):**
- Custom doctor database built with Advanced Custom Fields
- Dynamic doctor cards — name, specialisation, experience, etc.
- Individual profile pages per doctor
- Structured for easy scaling as more doctors are added

**Blog section:**
- Preview cards on homepage with title, short description, and Read More CTA
- Full blog pages with SEO-friendly layout

**Navigation & layout:**
- Responsive header/footer
- Active-state nav styling
- Organised footer with key links

**Tools used:** WordPress CMS · Elementor Pro · Advanced Custom Fields (ACF) · Hostinger

> The WordPress frontend currently has static doctor/slot info. This backend API will eventually replace that with live data — real-time slots, bookings, prescriptions, and automations.

---

## ✨ Features (Being Built)

- **Guest-only booking** — no patient account needed, phone is the unique ID
- **Live slot system** — atomic double-booking prevention via DB unique constraint
- **Fee snapshot** — fee is locked at booking time (`feeAtBooking`), unaffected by future changes
- **Dual consultation flows:**
  - Offline (in-clinic) → WhatsApp + Email confirmation
  - Online (Cashfree payment → Google Meet link → PDF Invoice)
- **Doctor Dashboard** — Waiting Room, Prescription Builder, Availability & Fee management
- **Admin Panel** — Doctor management, Appointments view, Analytics
- **Automation Engine** — WhatsApp (Meta Cloud API) + Email at every lifecycle stage
- **Prescription PDF** — generated with `pdfkit`, sent via WhatsApp & Email
- **Reschedule** (doctor-only) with mandatory reason + new Meet link
- **Cashfree webhook** — HMAC SHA-256 verified
- **Google Meet** — auto-created via Calendar API
- **JWT Auth** — separate roles for Admin and Doctor

---

## 🛠 Stack

| Layer | Tech |
|---|---|
| Runtime | Node.js 18+ LTS |
| Framework | Express.js 4 |
| ORM | Prisma 5 |
| Database | MySQL 8 |
| Auth | JWT (7-day) + bcryptjs (12 salt rounds) |
| UI | Tailwind CSS (CDN) — vanilla JS SPAs |
| Payments | Cashfree (orders + webhook) |
| Video | Google Calendar API → Meet |
| WhatsApp | **Meta Cloud API** |
| Email | Nodemailer (SMTP / SendGrid) |
| PDF | pdfkit |
| Hosting | Hostinger VPS |

---

## 📁 Project Structure

```
neokids-emr/
├── prisma/
│   ├── schema.prisma        # MySQL schema (Doctor, Patient, Appointment, Prescription...)
│   └── seed.js              # Default admin + sample doctor
├── public/
│   ├── admin/               # Admin Panel SPA
│   └── doctor/              # Doctor Dashboard SPA
├── src/
│   ├── config/prisma.js
│   ├── controllers/         # auth, admin, doctor, public, webhook
│   ├── middleware/          # auth, errorHandler
│   ├── routes/
│   ├── services/            # slot, booking, automation, pdf, cashfree, googleMeet, whatsapp, email
│   ├── utils/               # logger, validators (zod)
│   └── server.js
├── storage/
│   ├── invoices/            # Generated invoice PDFs
│   └── prescriptions/       # Generated prescription PDFs
├── docs/                    # Project docs / PRD
├── .env.example
├── package.json
└── README.md
```

---

## 🚀 Local Setup

```bash
# 1. Clone & install
git clone https://github.com/Juhainah/neokids-emr.git
cd neokids-emr
npm install

# 2. Configure environment
cp .env.example .env
# Fill in DATABASE_URL, JWT_SECRET, Cashfree, Meta Cloud API, Google keys

# 3. Set up DB
npm run prisma:generate
npm run prisma:migrate -- --name init
npm run seed

# 4. Start dev server
npm run dev
```

**Once running:**
- Admin Panel → `http://localhost:3000/admin`
- Doctor Panel → `http://localhost:3000/doctor`
- API → `http://localhost:3000/api`
- Health check → `http://localhost:3000/health`

**Default seed credentials:**
- Admin: `admin@neokidspro.in` / `ChangeMe@123`
- Doctor: `dr.sharma@neokidspro.in` / `Doctor@123`

---

## 🔌 API Overview

### Auth
| Method | Path | Description |
|---|---|---|
| POST | `/api/auth/login` | Admin or Doctor login |
| GET | `/api/auth/me` | Current user (Bearer token) |

### Admin
| Method | Path | Description |
|---|---|---|
| GET | `/api/admin/analytics` | Dashboard stats |
| POST/GET/PUT/DELETE | `/api/admin/doctors` | Doctor CRUD |
| GET | `/api/admin/appointments` | All appointments (filter by status, date, doctorId) |

### Doctor
| Method | Path | Description |
|---|---|---|
| GET | `/api/doctor/waiting-room` | Today's waiting room |
| GET | `/api/doctor/appointments/:id` | Appointment detail + visit history |
| POST | `/api/doctor/appointments/:id/prescription` | Create / update prescription |
| POST | `/api/doctor/appointments/:id/reschedule` | Reschedule with reason |
| POST | `/api/doctor/appointments/:id/complete` | Mark as complete |

### Public (WordPress frontend integration)
| Method | Path | Description |
|---|---|---|
| GET | `/api/public/doctors` | List active doctors (optional `?mode=ONLINE`) |
| GET | `/api/public/slots` | Live slots — `?doctorId=&date=YYYY-MM-DD&type=` |
| POST | `/api/public/book` | Book an appointment |
| GET | `/api/public/appointments/:id` | Check appointment status |

### Webhooks
| Method | Path | Description |
|---|---|---|
| POST | `/api/webhooks/cashfree` | Payment webhook (HMAC-verified) |

---

## 📋 Booking Flow

**Offline (In-clinic)**
1. Patient picks doctor → fills details → selects slot → confirms
2. `Appointment { status: CONFIRMED, paymentStatus: UNPAID }` created
3. WhatsApp + Email confirmation sent

**Online (Teleconsultation)**
1. Patient picks doctor → fills details → selects slot
2. `Appointment { status: PENDING }` + Cashfree order created
3. Frontend opens Cashfree Checkout
4. Cashfree webhook fires on `payment.captured` → HMAC verified
5. Status updated to `CONFIRMED + PAID`
6. Google Meet link generated + Invoice PDF sent via WhatsApp & Email

**Fee snapshot** — fee is copied to `feeAtBooking` at booking time. Doctor changing fees later never affects existing bookings.

**Slot locking** — `@@unique([doctorId, date, startTime])` on `Appointment`. Concurrent duplicate requests get `P2002` → HTTP 409.

---

## 📲 WhatsApp — Meta Cloud API

This project uses **Meta Cloud API** (not Twilio).

Add to `.env`:
```
META_WHATSAPP_TOKEN=
META_PHONE_NUMBER_ID=
META_WHATSAPP_VERIFY_TOKEN=
```

Requires approved message templates for production use.

---

## 💳 Cashfree Setup

1. Cashfree Dashboard → Webhooks → URL: `https://api.neokidspro.in/api/webhooks/cashfree`
2. Events to subscribe: `payment.captured`, `payment.failed`, `order.paid`
3. Copy the webhook secret → `.env` as `CASHFREE_WEBHOOK_SECRET`

---

## 🌍 Google Meet Setup

1. Google Cloud Console → create OAuth credentials (Calendar API enabled)
2. Generate a refresh token via OAuth Playground for the clinic's Google account
3. Set `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_REFRESH_TOKEN` in `.env`

---

## 🔒 Security

- Passwords: bcryptjs @ 12 salt rounds
- JWT: HS256, 7-day expiry — use `JWT_SECRET` ≥ 32 chars
- Cashfree webhook: HMAC SHA-256 verified on raw request body
- Helmet + CORS + rate-limit (300 req / 15 min per IP)
- Patient phone: Indian 10-digit validation (`/^[6-9]\d{9}$/`)

---

## ⏰ Reminder Cron

```bash
# Fires T-30min WhatsApp reminders — run every 5 mins
*/5 * * * * cd /var/www/neokids-emr && node -e "require('./src/services/automation.service').processReminders()" >> /var/log/np-reminders.log 2>&1
```

---

## 🚧 Status

Actively in development. The WordPress frontend is live; this API is being built to power the dynamic features behind it. Not accepting contributions right now.

---

*Built by [Juhainah Nasir](https://github.com/Juhainah) · UX/UI + Frontend Dev*
*Part of the NeoKidsPro.in project — pediatric clinic platform*
