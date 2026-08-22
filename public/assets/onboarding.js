/* =====================================================================
   onboarding.js — "Getting Started" tab shared by all 4 portals.
   Each portal calls NPOnboarding.mount(containerEl, role, meUser) once,
   after its own /me fetch resolves, so content can be filtered by what
   that specific account can actually do (a doctor available ONLINE-only
   never sees offline-hours instructions; a receptionist without pharmacy
   rights never sees the pharmacy-billing step).

   The "beautiful animation" is one small reusable component (a fake
   mini card that types sample text into a field, then presses a button)
   rather than a bespoke pixel-clone per feature — that keeps every step
   visually consistent and is what actually ships, instead of an
   unbounded per-screen animation build.
   ===================================================================== */
(function (global) {
  'use strict';
  if (global.NPOnboarding) return;

  const CSS = `
  .np-onb{max-width:760px}
  .np-onb__intro{color:var(--nk-muted,#64748b);font-size:.92rem;margin:0 0 1.25rem;max-width:56ch}
  .np-onb__step{display:grid;grid-template-columns:minmax(0,1fr) 260px;gap:1.5rem;align-items:center;
    padding:1.25rem;border:1px solid var(--nk-border,#D9E6E6);border-radius:14px;background:var(--nk-card,#fff);
    margin-bottom:1rem;}
  @media (max-width:760px){ .np-onb__step{grid-template-columns:1fr} }
  .np-onb__num{display:inline-grid;place-items:center;width:26px;height:26px;border-radius:50%;
    background:var(--nk-teal-50,#F1F7F7);color:var(--nk-teal-700,#467878);font-weight:700;font-size:.8rem;
    margin-bottom:.5rem;}
  .np-onb__title{font-family:'Poppins',sans-serif;font-weight:700;font-size:1.02rem;color:var(--nk-ink,#0F2E3A);margin:0 0 .35rem}
  .np-onb__desc{font-size:.86rem;color:var(--nk-muted,#64748b);line-height:1.55;margin:0}
  .np-onb__where{display:inline-flex;align-items:center;gap:5px;margin-top:.6rem;font-size:.74rem;font-weight:600;
    color:var(--nk-teal-700,#467878);background:var(--nk-teal-50,#F1F7F7);border-radius:999px;padding:3px 10px;}

  .np-onb-demo{border-radius:12px;overflow:hidden;border:1px solid var(--nk-border,#D9E6E6);
    background:var(--nk-surface,#F8FAFB);box-shadow:0 8px 20px -12px rgba(15,46,58,.25);}
  .np-onb-demo__bar{display:flex;gap:5px;padding:8px 10px;background:var(--nk-card,#fff);border-bottom:1px solid var(--nk-border,#D9E6E6);}
  .np-onb-demo__bar span{width:7px;height:7px;border-radius:50%;background:#D9E6E6;}
  .np-onb-demo__bar span:nth-child(1){background:#F28B82}
  .np-onb-demo__bar span:nth-child(2){background:#FBBC77}
  .np-onb-demo__bar span:nth-child(3){background:#89BCBD}
  .np-onb-demo__body{padding:16px 16px 18px;position:relative;min-height:118px}
  .np-onb-demo__label{display:block;font-size:.68rem;font-weight:700;text-transform:uppercase;letter-spacing:.04em;
    color:var(--nk-muted,#64748b);margin-bottom:6px;}
  .np-onb-demo__field{background:var(--nk-card,#fff);border:1px solid var(--nk-border,#D9E6E6);border-radius:8px;
    padding:8px 10px;font-size:.82rem;color:var(--nk-ink,#0F2E3A);min-height:1.3em;margin-bottom:14px;
    white-space:nowrap;overflow:hidden;}
  .np-onb-demo__cursor{display:inline-block;width:1px;background:var(--nk-teal-600,#5A9495);margin-left:1px;
    animation:np-onb-blink 1s step-end infinite;}
  .np-onb-demo__cursor{height:1em;vertical-align:-2px;}
  @keyframes np-onb-blink{50%{opacity:0}}
  .np-onb-demo__btn{display:inline-block;background:var(--nk-teal-600,#5A9495);color:#fff;font-size:.78rem;font-weight:600;
    border-radius:8px;padding:7px 14px;transition:transform .12s ease,box-shadow .12s ease;}
  .np-onb-demo__btn.is-pressed{transform:scale(.94);box-shadow:0 0 0 4px rgba(90,148,149,.22) inset;}
  .np-onb-demo__check{position:absolute;inset:0;display:grid;place-items:center;background:rgba(241,247,247,.92);
    opacity:0;transition:opacity .18s ease;pointer-events:none;}
  .np-onb-demo__check.is-visible{opacity:1}
  .np-onb-demo__check-icon{width:38px;height:38px;border-radius:50%;background:#22C55E;color:#fff;display:grid;
    place-items:center;font-size:20px;box-shadow:0 6px 16px -4px rgba(34,197,94,.55);}
  html[data-theme="dark"] .np-onb__step{background:#11202A;border-color:#234551}
  html[data-theme="dark"] .np-onb__title{color:#F4F9FA}
  html[data-theme="dark"] .np-onb-demo{background:#0E1A22;border-color:#234551}
  html[data-theme="dark"] .np-onb-demo__bar{background:#11202A;border-color:#234551}
  html[data-theme="dark"] .np-onb-demo__field{background:#11202A;border-color:#234551;color:#E6EEF1}
  html[data-theme="dark"] .np-onb-demo__check{background:rgba(14,26,34,.92)}
  `;

  function injectStyles() {
    if (document.getElementById('np-onb-styles')) return;
    const s = document.createElement('style');
    s.id = 'np-onb-styles';
    s.textContent = CSS;
    document.head.appendChild(s);
  }

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[c]));
  }

  // Drives one demo card's type -> pause -> click -> checkmark -> reset loop.
  // Runs independently per card so staggered start times don't sync up into
  // a distracting "everything blinks at once" wall of cards.
  function animateDemo(root, demo, delay) {
    const field = root.querySelector('.np-onb-demo__field');
    const btn = root.querySelector('.np-onb-demo__btn');
    const check = root.querySelector('.np-onb-demo__check');
    const text = demo.sampleText || '';
    let i = 0, timer = null;

    function typeStep() {
      i++;
      field.innerHTML = esc(text.slice(0, i)) + '<span class="np-onb-demo__cursor"></span>';
      if (i < text.length) { timer = setTimeout(typeStep, 55 + Math.random() * 45); return; }
      timer = setTimeout(pressButton, 550);
    }
    function pressButton() {
      btn.classList.add('is-pressed');
      timer = setTimeout(() => {
        btn.classList.remove('is-pressed');
        check.classList.add('is-visible');
        timer = setTimeout(resetLoop, 900);
      }, 160);
    }
    function resetLoop() {
      check.classList.remove('is-visible');
      i = 0;
      field.innerHTML = '<span class="np-onb-demo__cursor"></span>';
      timer = setTimeout(typeStep, 700);
    }
    timer = setTimeout(typeStep, delay);
    return () => clearTimeout(timer);
  }

  function demoHtml(demo) {
    return `
      <div class="np-onb-demo">
        <div class="np-onb-demo__bar"><span></span><span></span><span></span></div>
        <div class="np-onb-demo__body">
          <span class="np-onb-demo__label">${esc(demo.label)}</span>
          <div class="np-onb-demo__field"><span class="np-onb-demo__cursor"></span></div>
          <span class="np-onb-demo__btn">${esc(demo.buttonText)}</span>
          <div class="np-onb-demo__check"><span class="np-onb-demo__check-icon">&#10003;</span></div>
        </div>
      </div>`;
  }

  // ── Per-role content ──────────────────────────────────────────────
  // `show(me)` gates a step on the account's actual permissions/mode —
  // undefined means "always show".
  const CONTENT = {
    ADMIN: {
      intro: "A quick tour of what you can do as an admin — nothing here is required reading, come back to it any time from this tab.",
      steps: [
        { title: 'Add your first doctor', where: 'Doctors → + Add doctor',
          desc: "Create the account, set consultation modes (online/offline/both) and fees. You control onboarding — the doctor doesn't need to do anything until you send their invite.",
          demo: { label: 'Doctor name', sampleText: 'Dr. Ananya Rao', buttonText: 'Add doctor' } },
        { title: 'Send the onboarding invite', where: 'Doctors → Send invite',
          desc: "A one-time link lets the doctor set their own password. You'll be asked to confirm before it sends, so an accidental click can't email the wrong person." },
        { title: 'Review KYC before verifying', where: "Doctor's profile → KYC Documents",
          desc: "Upload Aadhaar, PAN, cancelled cheque and registration certificate on the doctor's behalf, then Verify or Reject once all four are in." },
        { title: 'Watch revenue and settlements', where: 'Revenue Reports · Doctor Settlements',
          desc: "Collected vs. pending is always kept separate — a billed-but-uncollected cash appointment never inflates the headline revenue figure." },
        { title: 'Everything is logged', where: 'Staff Audit Trail',
          desc: "Every appointment created, patient registered, invoice generated, doctor added/edited, refund issued — who did it and when." },
        { title: 'Data Management is for permanent deletion only', where: 'Danger Zone → Data Management',
          desc: "This is not a place to browse records — it exists to permanently wipe test/mock data or fulfil a parent's deletion request. It asks for your password before anything is deleted." }
      ]
    },
    DOCTOR: {
      intro: "Here's how the doctor portal fits together, tailored to how you actually see your own patients.",
      steps: [
        { title: 'Set your availability', where: 'Settings → Availability',
          desc: (me) => me && me.consultationModes === 'ONLINE'
            ? "You're set up for online consultations only — set your video-consult hours here."
            : me && me.consultationModes === 'OFFLINE'
            ? "You're set up for in-clinic visits only — set your clinic hours here."
            : "Set separate hours for online and in-clinic visits — patients can only book inside whichever window applies to their consultation type.",
          demo: { label: 'Available from', sampleText: '09:00', buttonText: 'Save availability' } },
        { title: "Today's Waiting Room", where: 'Dashboard → Waiting Room',
          desc: "Confirmed patients for today, in slot order — this is where a consultation actually starts." },
        { title: 'Write a prescription', where: 'Open a consultation → Prescription',
          desc: "Diagnosis, medications and vitals — if the visit was booked in-clinic, height/weight the parent entered at booking are pre-filled for you.",
          demo: { label: 'Diagnosis', sampleText: 'Common cold', buttonText: 'Generate PDF' } },
        { title: 'Mark complete only when it happens', where: 'Appointment → Mark Complete',
          desc: "Completing a consultation no longer assumes cash was collected — that's a separate Mark as Paid action, done by whoever actually took the payment." },
        { title: 'Track your earnings', where: 'Earnings',
          desc: "Your share after the clinic's cut and TDS, broken down by period." }
      ]
    },
    RECEPTIONIST: {
      intro: "What you can do here depends on the permissions your admin has enabled for your account.",
      steps: [
        { title: 'Register a walk-in patient', where: 'Patients → Register',
          show: (me) => !me || me.canManageConsultations !== false,
          desc: "Search by phone first — siblings share a parent's number but are separate patient records, matched by name too.",
          demo: { label: 'Patient name', sampleText: 'Aarav Shah', buttonText: 'Register' } },
        { title: 'Book an appointment', where: 'Appointments → New',
          show: (me) => !me || me.canManageConsultations !== false,
          desc: "Only doctors assigned to you at a clinic show up here — pick a slot and the source is recorded automatically as walk-in/phone." },
        { title: 'Generate an invoice, then collect payment', where: 'Appointment → Invoice → Mark as paid',
          show: (me) => !me || me.canManageConsultations !== false,
          desc: "Generating the invoice doesn't mark it paid by itself — Mark as paid is a separate, explicit action once cash is actually in hand." },
        { title: 'Create a pharmacy bill', where: 'Pharmacy → New bill',
          show: (me) => !!(me && me.canManagePharmacy),
          desc: "Real inventory items decrement stock only once the bill is marked paid — drafts never touch stock.",
          demo: { label: 'Medicine', sampleText: 'Paracetamol 250mg', buttonText: 'Add to bill' } }
      ]
    },
    PHARMACY: {
      intro: "The pharmacy portal in four steps.",
      steps: [
        { title: 'Check inventory before you promise stock', where: 'Inventory → Search',
          desc: "Low-stock items are flagged automatically — you'll also get a notification the moment a sale drops something to 10 units or fewer." },
        { title: 'Build a bill from a prescription or manually', where: 'Bills → New bill',
          desc: "Link a doctor's prescription to auto-fill medicines, or add items by hand for an OTC sale.",
          demo: { label: 'Medicine', sampleText: 'Amoxicillin 125mg', buttonText: 'Add item' } },
        { title: 'Mark paid to actually dispense', where: 'Bill → Mark as paid',
          desc: "Stock is reserved and decremented at this exact moment, atomically — two people can't sell the last unit twice." },
        { title: 'Send the bill to the patient', where: 'Bill → Send',
          desc: "WhatsApp or email, whichever the patient has on file." }
      ]
    }
  };

  const NPOnboarding = {
    _cleanups: [],
    mount(container, role, meUser) {
      if (!container) return;
      injectStyles();
      this._cleanups.forEach(fn => { try { fn(); } catch (_) {} });
      this._cleanups = [];

      const content = CONTENT[role];
      if (!content) { container.innerHTML = ''; return; }
      const steps = content.steps.filter(s => !s.show || s.show(meUser));

      container.innerHTML = `
        <div class="np-onb">
          <p class="np-onb__intro">${esc(content.intro)}</p>
          ${steps.map((s, i) => `
            <div class="np-onb__step" data-step="${i}">
              <div>
                <div class="np-onb__num">${i + 1}</div>
                <div class="np-onb__title">${esc(s.title)}</div>
                <p class="np-onb__desc">${esc(typeof s.desc === 'function' ? s.desc(meUser) : s.desc)}</p>
                ${s.where ? `<div class="np-onb__where">${esc(s.where)}</div>` : ''}
              </div>
              ${s.demo ? demoHtml(s.demo) : '<div></div>'}
            </div>`).join('')}
        </div>`;

      steps.forEach((s, i) => {
        if (!s.demo) return;
        const root = container.querySelector('.np-onb__step[data-step="' + i + '"]');
        if (root) this._cleanups.push(animateDemo(root, s.demo, i * 250));
      });
    }
  };

  global.NPOnboarding = NPOnboarding;
})(window);
