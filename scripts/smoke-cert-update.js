// Simulates the real production failure: PUT /api/doctor/certificates/:id
// with a mocked prisma + pdf service. Verifies the v3.4.11 update handler
// never 500s across all realistic patch shapes.
process.env.JWT_SECRET = 'test-secret';

const path = require('path');
const Module = require('module');

// ── Mock prisma & pdf modules before requiring the controller ──
const prismaMock = {
  medicalCertificate: {
    findFirst: async () => ({
      id: 'cert-1',
      doctorId: 'doc-1',
      durationType: 'DATE_RANGE',
      certificateDate: null,
      fromDate: new Date(Date.UTC(2026, 7, 10)),
      toDate: new Date(Date.UTC(2026, 7, 12)),
      restDays: 3,
      reason: 'Fever',
      appointment: null,
      patient: { id: 'p1', name: 'Kid A', dateOfBirth: new Date('2020-01-01'), gender: 'M' }
    }),
    update: async (args) => {
      lastUpdateData = args.data;
      return { id: 'cert-1', doctorId: 'doc-1', appointment: null, ...args.data };
    }
  },
  doctor: { findUnique: async () => ({ id: 'doc-1', name: 'Dr. X' }) }
};
let lastUpdateData = null;

const pdfMock = {
  generateMedicalCertificate: async () => ({ url: '/storage/certificates/cert-1.pdf' })
};

// Patch module loader
const origResolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...args) {
  if (request === '../config/prisma') return 'prisma-mock';
  if (request === '../services/pdf.service') return 'pdf-mock';
  return origResolve.call(this, request, ...args);
};
require.cache['prisma-mock'] = { exports: prismaMock };
require.cache['pdf-mock'] = { exports: pdfMock };
Module._load = ((orig) => function (request, ...args) {
  if (request === '../config/prisma') return prismaMock;
  if (request === '../services/pdf.service') return pdfMock;
  return orig.call(this, request, ...args);
})(Module._load);

const cert = require(require('path').join(__dirname, '..', 'src', 'controllers', 'certificate.controller'));

function mockRes() {
  return {
    statusCode: 200,
    body: null,
    status(c) { this.statusCode = c; return this; },
    json(b) { this.body = b; return this; }
  };
}
function mockReq(body) {
  return { params: { id: 'cert-1' }, user: { id: 'doc-1', role: 'DOCTOR' }, body };
}

const cases = [
  ['reason-only patch', { reason: 'Updated diagnosis notes' }],
  ['single-day switch', { durationType: 'SINGLE_DAY', certificateDate: '2026-08-18' }],
  ['range patch w/ restDays', { fromDate: '2026-08-15', restDays: 5 }],
  ['range patch w/ explicit toDate', { fromDate: '2026-08-15', toDate: '2026-08-19' }],
  ['notes + template patch', { additionalNotes: 'Follow up in 1 week', templateKey: 'SCHOOL_LEAVE' }],
  ['diagnosis clear', { diagnosis: '' }],
  ['full form resubmit (all fields)', { templateKey: 'GENERAL', diagnosis: 'Viral fever', reason: 'Rest advised', durationType: 'DATE_RANGE', fromDate: '2026-08-18', toDate: '2026-08-20', restDays: 3, additionalNotes: '' }]
];

(async () => {
  let failures = 0;
  for (const [name, body] of cases) {
    const res = mockRes();
    try {
      await cert.update(mockReq(body), res, (err) => { throw err; });
      if (res.statusCode >= 500) {
        console.log('FAIL', name, '→ HTTP', res.statusCode, JSON.stringify(res.body));
        failures++;
      } else {
        console.log('PASS', name, '→ HTTP', res.statusCode, '| db write:', JSON.stringify(lastUpdateData));
      }
    } catch (e) {
      console.log('FAIL', name, '→ THREW', e.message);
      failures++;
    }
  }

  // Also simulate PDF failure — update must still succeed with pdfWarning
  pdfMock.generateMedicalCertificate = async () => { throw new Error('pdfkit exploded'); };
  const res = mockRes();
  await cert.update(mockReq({ reason: 'Still works when PDF fails' }), res, (err) => { throw err; });
  if (res.statusCode >= 500) { console.log('FAIL pdf-failure case → HTTP', res.statusCode); failures++; }
  else console.log('PASS pdf-failure case → HTTP', res.statusCode, '| warning:', res.body && res.body.pdfWarning);

  console.log(failures === 0 ? '\nALL UPDATE CASES PASS — no 500 paths remain' : `\n${failures} FAILURES`);
  process.exit(failures === 0 ? 0 : 1);
})();
