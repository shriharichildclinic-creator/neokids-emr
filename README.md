# 🏥 NeoKidsPro EMR + Booking System

A production-ready **Pediatric Clinic EMR** and **Booking System** built on Node.js, Express, Prisma & MySQL — designed for `neokidspro.in`.

> Implements the full spec from the **NeoKidsPro PRD v1.0** (May 2026).

---

## ✨ Features

- **Guest-only booking** (no patient login) — phone is the unique identifier
- **Live Slot System** with atomic double-booking prevention (DB unique constraint)
- **Fee Snapshot** locked at booking time (`feeAtBooking`)
- **Dual consultation flows**: Online (Cashfree → Meet → PDF Invoice) + Offline (in-clinic)
- **Doctor Dashboard** — Waiting Room, Prescription Builder, Availability/Fee settings
- **Admin Panel** — Doctor management, Appointments, Analytics
- **Automation Engine** — WhatsApp + Email notifications at every lifecycle stage
- **Prescription PDF** generated with `pdfkit` and pushed via WhatsApp/Email
- **Reschedule** (doctor-only) with mandatory reason + new Meet link
- **Cashfree** webhook with HMAC signature verification
- **Google Meet** auto-creation via Calendar API
- **JWT Auth** (Admin + Doctor)
- Soft pediatric UI palette: `#4DA8FF` Blue, `#B8F2E6` Mint, `#FFF8E7` Cream

---

## 🛠 Stack

| Layer        | Tech                                       |
|--------------|--------------------------------------------|
| Runtime      | Node.js 18+ LTS                            |
| Framework    | Express.js 4                               |
| ORM          | Prisma 5                                   |
| Database     | MySQL 8                                    |
| Auth         | JWT (7-day) + bcryptjs (12 salt rounds)    |
| UI           | Tailwind CSS (CDN) — vanilla JS SPAs       |
| Payments     | Cashfree (orders + webhook)                |
| Video        | Google Calendar API → Meet                 |
| WhatsApp     | Twilio                                     |
| Email        | Nodemailer (SMTP / SendGrid)               |
| PDF          | pdfkit                                     |
| Hosting      | Hostinger VPS                              |

---

## 📁 Project Structure

```
neokidspro-emr/
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
├── .env.example
├── package.json
└── README.md
```

---

## 🚀 Quick Start

### 1. Install
```bash
git clone <repo> && cd neokidspro-emr
npm install
```

### 2. Configure
```bash
cp .env.example .env
# Edit .env — set DATABASE_URL, JWT_SECRET, Cashfree/Twilio/Google keys
```

### 3. Initialize DB
```bash
npm run prisma:generate
npm run prisma:migrate -- --name init
npm run seed
```

### 4. Run
```bash
npm run dev        # development (nodemon)
# or
npm start          # production
```

### 5. Access
- 📋 **Admin Panel**: <http://localhost:3000/admin>
- 👨‍⚕️ **Doctor Panel**: <http://localhost:3000/doctor>
- 🔌 **API Base**: <http://localhost:3000/api>
- ❤️ **Health**: <http://localhost:3000/health>

**Default credentials** (from seed):
- Admin: `admin@neokidspro.in` / `ChangeMe@123`
- Doctor: `dr.sharma@neokidspro.in` / `Doctor@123`

---

## 🔌 API Reference

### 🔐 Auth
| Method | Path                | Auth        | Description                        |
|--------|---------------------|-------------|------------------------------------|
| POST   | `/api/auth/login`   | —           | Admin or Doctor login              |
| GET    | `/api/auth/me`      | Bearer      | Current logged-in user             |

### 👤 Admin
| Method | Path                          | Description           |
|--------|-------------------------------|-----------------------|
| GET    | `/api/admin/analytics`        | Dashboard stats       |
| POST   | `/api/admin/doctors`          | Create doctor         |
| GET    | `/api/admin/doctors`          | List doctors          |
| PUT    | `/api/admin/doctors/:id`      | Update doctor         |
| DELETE | `/api/admin/doctors/:id`      | Soft delete           |
| GET    | `/api/admin/appointments`     | List all appts (filter `status,date,from,to,doctorId`) |

### 🩺 Doctor
| Method | Path                                          | Description                  |
|--------|-----------------------------------------------|------------------------------|
| GET    | `/api/doctor/me`                              | My profile                   |
| GET    | `/api/doctor/stats`                           | My stats                     |
| PUT    | `/api/doctor/availability`                    | Update working hours/days    |
| PUT    | `/api/doctor/fees`                            | Update consultation fees     |
| GET    | `/api/doctor/appointments`                    | My appointments              |
| GET    | `/api/doctor/waiting-room`                    | Today's waiting room         |
| GET    | `/api/doctor/appointments/:id`                | Detail + visit history       |
| POST   | `/api/doctor/appointments/:id/prescription`   | Create/update prescription   |
| POST   | `/api/doctor/appointments/:id/reschedule`     | Reschedule with reason       |
| POST   | `/api/doctor/appointments/:id/cancel`         | Cancel                       |
| POST   | `/api/doctor/appointments/:id/complete`       | Mark complete                |

### 🌐 Public (for WordPress frontend)
| Method | Path                              | Description                                                  |
|--------|-----------------------------------|--------------------------------------------------------------|
| GET    | `/api/public/doctors?mode=ONLINE` | List active doctors (optional mode filter)                   |
| GET    | `/api/public/doctors/:id`         | Doctor detail                                                |
| GET    | `/api/public/slots`               | Live slots — query: `doctorId`, `date` (YYYY-MM-DD), `type`  |
| POST   | `/api/public/book`                | Book appointment (returns Cashfree order if ONLINE)          |
| GET    | `/api/public/appointments/:id`    | Appointment status                                           |

### 🔔 Webhooks
| Method | Path                          | Description                              |
|--------|-------------------------------|------------------------------------------|
| POST   | `/api/webhooks/cashfree`      | Cashfree webhook (HMAC-verified)         |

---

## 📋 Booking Flow

### Physical (Offline)
1. Patient selects doctor → fills details → picks slot → confirms
2. Server creates `Appointment{ status: CONFIRMED, paymentStatus: UNPAID }`
3. Automation engine: WhatsApp + Email confirmation

### Teleconsultation (Online)
1. Patient selects doctor → fills details → picks slot
2. Server creates `Appointment{ status: PENDING, paymentStatus: UNPAID }` + Cashfree order
3. Frontend opens Cashfree Checkout
4. Cashfree webhook → `payment.captured`
5. Server verifies HMAC → updates to `CONFIRMED + PAID`
6. Automation engine: generates Meet link + Invoice PDF + WhatsApp + Email

### Fee Snapshot
At booking time, `doctor.onlineConsultFee` or `physicalConsultFee` is snapshotted into `appointment.feeAtBooking`. Subsequent fee changes do NOT affect existing bookings.

### Slot Locking
The `@@unique([doctorId, date, startTime])` constraint on `Appointment` makes booking **atomic** — concurrent requests for the same slot will fail one with `P2002 → HTTP 409`.

---

## 💳 Cashfree Webhook Setup
1. In Cashfree dashboard → Webhooks → Add Webhook
2. URL: `https://api.neokidspro.in/api/webhooks/cashfree`
3. Events: `payment.captured`, `payment.failed`, `order.paid`
4. Set webhook secret → copy to `.env` as `CASHFREE_WEBHOOK_SECRET`

---

## 🌍 Google Meet Setup
1. Create OAuth credentials in Google Cloud Console (Calendar API enabled)
2. Generate a refresh token via OAuth Playground for the clinic's calendar account
3. Set `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_REFRESH_TOKEN` in `.env`

---

## 📲 WhatsApp Setup
- Use Twilio Sandbox for testing, then upgrade to WABA-approved templates
- Set `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_WHATSAPP_FROM`

---

## 🚢 Deployment (Hostinger VPS)

```bash
# 1. SSH into VPS, install Node 18+ & MySQL 8
# 2. Clone repo, npm ci, set .env (production values)
# 3. Run migrations:
npm run prisma:deploy
npm run seed

# 4. Process manager (PM2 recommended)
npm install -g pm2
pm2 start src/server.js --name neokidspro
pm2 save && pm2 startup

# 5. Reverse proxy via Nginx (terminate SSL with Certbot)
```

Nginx snippet (`/etc/nginx/sites-available/neokidspro`):
```nginx
server {
  server_name api.neokidspro.in;
  location / {
    proxy_pass http://127.0.0.1:3000;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
  }
}
```

---

## ⏰ Cron / Reminder Job

The automation service exposes `processReminders()` for T-30min WhatsApp reminders.
Set up a cron (every 5 minutes):

```bash
*/5 * * * * cd /var/www/neokidspro-emr && node -e "require('./src/services/automation.service').processReminders()" >> /var/log/np-reminders.log 2>&1
```

---

## 🔒 Security Notes

- Passwords: `bcryptjs` @ 12 salt rounds
- JWT: HS256, 7-day expiry (use `JWT_SECRET` ≥ 32 chars)
- Cashfree webhook: HMAC SHA-256 verified against raw body
- Helmet + CORS + rate-limit (300 req / 15 min per IP)
- Patient phone validation: Indian 10-digit (`/^[6-9]\d{9}$/`)
- Storage path served via Express static (consider CDN/S3 in production)

---

## 📝 License

UNLICENSED — Proprietary to NeoKidsPro / neokidspro.in

---

**Built with ❤️ for pediatric clinics.**
