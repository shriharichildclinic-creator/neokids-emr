# NeoKidsPro EMR – API Reference

Base URL: `https://api.neokidspro.in/api`

## Authentication

All `/admin/*` and `/doctor/*` endpoints require a `Bearer <JWT>` header.
Obtain a token via `POST /auth/login`.

```
Authorization: Bearer eyJhbGciOiJIUzI1NiIs...
```

---

## POST `/auth/login`

```json
{
  "email": "doctor@neokidspro.in",
  "password": "secret"
}
```

**Response 200**
```json
{
  "token": "eyJ...",
  "role": "DOCTOR",
  "user": { "id": "uuid", "name": "Anjali", "email": "..." }
}
```

---

## POST `/public/book`

```json
{
  "doctorId": "uuid",
  "patientName": "Aarav Kumar",
  "phone": "9876543210",
  "email": "parent@example.com",
  "parentName": "Rahul Kumar",
  "dateOfBirth": "2020-04-15",
  "gender": "MALE",
  "primaryProblem": "High fever for 2 days",
  "date": "2026-05-25",
  "startTime": "10:30",
  "consultationType": "ONLINE"
}
```

**Response 201 — Online (requires payment)**
```json
{
  "appointment": { "id": "uuid", "status": "PENDING" },
  "requiresPayment": true,
  "cashfree": {
    "orderId": "appt_xxx",
    "paymentSessionId": "session_xxx",
    "amount": 500,
    "currency": "INR",
    "environment": "sandbox"
  }
}
```

**Response 201 — Offline (no payment)**
```json
{
  "appointment": { "id": "uuid", "status": "CONFIRMED" },
  "requiresPayment": false
}
```

**Errors**
- `409 Conflict` — slot already booked
- `400 Bad Request` — invalid input / consultation mode mismatch
- `404 Not Found` — doctor not found

---

## GET `/public/slots?doctorId=...&date=2026-05-25&type=ONLINE`

```json
{
  "doctorId": "uuid",
  "date": "2026-05-25",
  "type": "ONLINE",
  "slots": [
    { "startTime": "10:00", "endTime": "10:15", "available": true },
    { "startTime": "10:15", "endTime": "10:30", "available": false }
  ]
}
```

---

## POST `/doctor/appointments/:id/prescription`

```json
{
  "chiefComplaint": "Fever, cough",
  "diagnosis": "Acute viral fever",
  "allergies": "None known",
  "investigations": "CBC done",
  "medications": [
    {
      "name": "Paracetamol Syrup",
      "dose": "5 ml",
      "frequency": "TID",
      "duration": "3 days",
      "instructions": "After food"
    }
  ],
  "advice": "Plenty of fluids, rest",
  "followUpDate": "2026-05-30"
}
```

Triggers:
1. PDF generated → `/files/prescriptions/prescription_<id>.pdf`
2. Appointment marked `COMPLETED`
3. WhatsApp + Email sent to patient

---

## POST `/doctor/appointments/:id/reschedule`

```json
{
  "date": "2026-05-26",
  "startTime": "11:00",
  "reason": "Doctor unavailable due to emergency"
}
```

Triggers:
- Validates new slot is free
- Creates new Meet link (if ONLINE)
- WhatsApp + Email to patient

---

## Cashfree Webhook

`POST /webhooks/cashfree`

Headers:
- `x-webhook-signature`: Base64 HMAC-SHA256 of `timestamp + rawBody`
- `x-webhook-timestamp`: Cashfree webhook timestamp header

Body: raw JSON from Cashfree webhooks.

On `payment_status = SUCCESS`:
- Locate appointment by `cashfreeOrderId`
- Update: `status=CONFIRMED, paymentStatus=PAID`
- Trigger automation: Meet link + Invoice + notifications
