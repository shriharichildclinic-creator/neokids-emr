/* ==========================================================================
   Shared billing UI (v4.1) — used by BOTH the pharmacy and receptionist
   portals so the "New bill" / "Edit draft" / "Mark paid" experience is a
   single source of truth.

   Responsibilities:
   - patient linking (optional, searchable, quick-create walk-in)
   - doctor linking (optional, searchable)
   - bill type (PHARMACY | CONSULT | SERVICE)
   - line items: per-line Inventory / Manual mode (never both at once)
     * inventory mode auto-fills price+stock from the medicine
     * manual mode is a plain name/price line
   - DRAFT (editable) vs PAID (locked) lifecycle
   ========================================================================== */
(function (global) {
  'use strict';
  if (global.NPBilling) return;

  var BILL_TYPES = { PHARMACY: 'Pharmacy', CONSULT: 'Consultation', SERVICE: 'Service' };

  function inr(n) { return '₹' + Number(n || 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 }); }

  function mk(el, cls, html) {
    var d = document.createElement(el);
    if (cls) d.className = cls;
    if (html !== undefined) d.innerHTML = html;
    return d;
  }
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function qs(s, r) { return (r || document).querySelector(s); }
  function qsa(s, r) { return Array.prototype.slice.call((r || document).querySelectorAll(s)); }

  // ── debounced async patient search ──────────────────────────────────────
  function attachSearch(input, menu, renderFn, fetchFn, onPick) {
    var timer = null;
    input.addEventListener('input', function () {
      clearTimeout(timer);
      var q = input.value.trim();
      if (q.length < 2) { menu.classList.remove('is-open'); menu.innerHTML = ''; return; }
      timer = setTimeout(function () {
        fetchFn(q).then(function (rows) {
          renderFn(rows, q);
          menu.classList.add('is-open');
        }).catch(function () { menu.innerHTML = '<div class="np-combo__empty">Search failed</div>'; menu.classList.add('is-open'); });
      }, 220);
    });
    input.addEventListener('focus', function () {
      if (menu.children.length) menu.classList.add('is-open');
    });
    document.addEventListener('click', function (e) {
      if (!input.contains(e.target) && !menu.contains(e.target)) menu.classList.remove('is-open');
    });
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') menu.classList.remove('is-open');
    });
  }

  function pickPatient(menu, input, hidden, p) {
    hidden.value = p.id;
    input.value = p.name;
    menu.classList.remove('is-open');
  }

  var NPBilling = {
    inr: inr,
    // config: { api, esc, fmt, toast, inventory, doctors, patientSearch,
    //           billsBase, role, defaultBillType, canSwitchType, onSaved, rxId }
    open: function (cfg, existing) {
      if (!window.NPToast) window.NPToast = { success: function (m) { alert(m); }, error: function (m) { alert(m); }, warn: function (m) { alert(m); } };
      var api = cfg.api;
      var esc_ = cfg.esc || esc;
      // Note: esc from the portal is preferred for consistency.
      var fmt = cfg.fmt || function (d) { return new Date(d).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' }); };
      var toast = cfg.toast || window.NPToast;
      var inventory = cfg.inventory || [];
      var doctors = cfg.doctors || [];
      var patientSearch = cfg.patientSearch || function () { return Promise.resolve([]); };
      var billsBase = cfg.billsBase;
      var role = cfg.role || 'PHARMACY';
      var editing = !!existing;
      var bill = existing || { items: [], total: 0, discount: 0, tax: 0, paymentMethod: 'CASH', billNumber: '', status: 'DRAFT', billType: cfg.defaultBillType || 'PHARMACY' };
      var canSwitchType = !!cfg.canSwitchType;

      if (editing && bill.status !== 'DRAFT') {
        toast('This bill is already paid and locked', 'warn');
        return;
      }

      var typeOptions = ['PHARMACY', 'CONSULT', 'SERVICE'].map(function (t) {
        return '<option value="' + t + '"' + (bill.billType === t ? ' selected' : '') + '>' + BILL_TYPES[t] + '</option>';
      }).join('');
      var doctorOpts = doctors.map(function (d) {
        return '<option value="' + d.id + '"' + (bill.doctorId === d.id ? ' selected' : '') + '>Dr. ' + esc_(d.name) + (d.specialization ? ' — ' + esc_(d.specialization) : '') + '</option>';
      }).join('');

      var lineModeHint = bill.billType === 'PHARMACY' ? 'Inventory' : 'Manual';

      global.__billing = {
        cfg: cfg, bill: bill, editing: editing,
        inventory: inventory, doctors: doctors, patientSearch: patientSearch, billsBase: billsBase, role: role,
      };

      var title = editing ? 'Edit bill ' + esc_(bill.billNumber) : 'New bill';
      var subtitle = editing ? 'Draft / unpaid — editable until paid' : 'Save as draft (unpaid) or save & mark paid';

      var host = document.querySelector(cfg.host || '#modalHost');
      host.innerHTML = '<div class="np-modal"><div class="np-modal__panel"><header class="np-modal__head">' +
        '<div class="np-modal__title">' + title + '</div><div class="np-modal__subtitle" style="font-size:.78rem;color:var(--np-muted)">' + subtitle + '</div>' +
        '<button class="np-modal__close" type="button" onclick="NPBilling.close()">×</button></header>' +
        '<div class="np-modal__body"><form id="billForm">' +

        // Patient (optional) + doctor (optional)
        '<div class="np-grid-2">' +
          '<div class="np-field"><label class="np-field__label">Patient <span class="np-mut" style="font-weight:400">(optional)</span></label>' +
            '<div class="np-combo" id="patCombo"><input id="billPatient" class="np-input" placeholder="Search name or phone" autocomplete="off" value="' + esc_(bill.customerName && bill.patientId ? '' : (bill.patient ? bill.patient.name : (bill.customerName || ''))) + '"/>' +
            '<input type="hidden" id="billPatientId" value="' + (bill.patientId || '') + '"/>' +
            '<div class="np-combo__menu" id="patMenu"></div></div>' +
            '<div class="np-mut" style="font-size:.72rem;margin-top:.25rem">Walk-in: leave unselected — a patient record is optional.</div></div>' +
          '<div class="np-field"><label class="np-field__label">Phone <span class="np-mut" style="font-weight:400">(optional)</span></label>' +
            '<input id="billPhone" class="np-input" maxlength="10" value="' + esc_(bill.customerPhone || (bill.patient && bill.patient.phone) || '') + '" placeholder="10 digits"/></div>' +
        '</div>' +
        '<div class="np-field"><label class="np-field__label">Doctor <span class="np-mut" style="font-weight:400">(optional)</span></label>' +
          '<select id="billDoctor" class="np-select"><option value="">— No doctor —</option>' + doctorOpts + '</select></div>' +

        // Bill type (segmented for receptionists; hidden/single for pharmacy)
        (canSwitchType
          ? '<div class="np-field"><label class="np-field__label">Bill type</label><select id="billType" class="np-select">' + typeOptions + '</select></div>'
          : '<input type="hidden" id="billType" value="' + esc_(bill.billType) + '"/>') +

        // Line items
        '<div class="np-row" style="justify-content:space-between;align-items:center;margin:.25rem 0 .5rem"><label class="np-field__label" style="margin:0">Items</label><button type="button" class="np-btn np-btn--sm np-btn--ghost" id="addLineBtn">+ Add item</button></div>' +
        '<div id="billLines"></div>' +

        '<div class="np-grid-2" style="margin-top:.75rem">' +
          '<div class="np-field"><label class="np-field__label">Discount (₹)</label><input id="billDiscount" type="number" step="0.01" min="0" class="np-input" value="' + (Number(bill.discount) || 0) + '"/></div>' +
          '<div class="np-field"><label class="np-field__label">Tax (₹)</label><input id="billTax" type="number" step="0.01" min="0" class="np-input" value="' + (Number(bill.tax) || 0) + '"/></div>' +
        '</div>' +
        '<div class="np-field"><label class="np-field__label">Payment method</label><select id="billPayMethod" class="np-select">' +
          ['CASH', 'UPI', 'CARD', 'ONLINE', 'OTHER'].map(function (m) { return '<option value="' + m + '"' + (bill.paymentMethod === m ? ' selected' : '') + '>' + m + '</option>'; }).join('') +
        '</select></div>' +
        (bill.notes !== undefined ? '<div class="np-field"><label class="np-field__label">Notes</label><textarea id="billNotes" class="np-textarea">' + esc_(bill.notes || '') + '</textarea></div>' : '<div class="np-field"><label class="np-field__label">Notes</label><textarea id="billNotes" class="np-textarea"></textarea></div>') +

        '<div class="np-bill-total"><span>Total</span><span id="billGrandTotal">' + inr(Number(bill.total) || 0) + '</span></div>' +
        '</form></div>' +
        '<div class="np-modal__foot">' +
          '<button type="button" class="np-btn" onclick="NPBilling.close()">Cancel</button>' +
          (editing ? '<button class="np-btn np-btn--primary" type="submit" form="billForm">Save changes</button>'
                   : '<button class="np-btn np-btn--ghost" type="button" id="savePaidBtn">Save & mark paid</button><button class="np-btn np-btn--primary" type="submit" form="billForm">Save as draft</button>') +
        '</div></div></div>';

      // Wire patient search
      var pInput = qs('#billPatient');
      var pMenu = qs('#patMenu');
      var pId = qs('#billPatientId');
      attachSearch(pInput, pMenu, function (rows, q) {
        pMenu.innerHTML = rows.length ? rows.map(function (p) {
          return '<button type="button" class="np-combo__opt" data-id="' + p.id + '" data-name="' + esc_(p.name) + '" data-phone="' + esc_(p.phone || '') + '">' +
            '<span class="np-combo__opt__name"><span>' + esc_(p.name) + '</span></span>' +
            '<span class="np-combo__opt__meta">' + (p.phone ? '+91 ' + esc_(p.phone) : '') + (p.id ? ' · ' + String(p.id).slice(0, 8) : '') + '</span></button>';
        }).join('') : '<div class="np-combo__empty">No matches — leave unselected for a walk-in bill</div>';
        qsa('.np-combo__opt', pMenu).forEach(function (b) {
          b.addEventListener('click', function () {
            pickPatient(pMenu, pInput, pId, { id: b.getAttribute('data-id'), name: b.getAttribute('data-name') });
            qs('#billPhone').value = b.getAttribute('data-phone');
          });
        });
      }, patientSearch);

      qs('#billPhone').addEventListener('input', function () {
        if (!pId.value && pInput.value) { /* keep walk-in name; phone is separate */ }
      });

      // Render existing lines or start with a single default line
      var linesHost = qs('#billLines');
      var lines = (editing && bill.items && bill.items.length) ? bill.items : [];
      var renderLine = function (item) {
        var mode = item && item.itemId ? 'inv' : (item && item.mode === 'manual' ? 'manual' : lineModeHint === 'Manual' ? 'manual' : 'inv');
        var div = mk('div', 'np-bill-line');
        var itemId = item && item.itemId ? item.itemId : '';
        var name = item && item.name ? item.name : '';
        var qty = item && item.quantity ? item.quantity : 1;
        var price = item && (item.unitPrice !== undefined && item.unitPrice !== null) ? String(item.unitPrice) : (item && item.itemId ? '' : '0');
        // Precompute price display when a catalog line is present
        if (itemId) {
          var it = inventory.filter(function (x) { return x.id === itemId; })[0];
          if (it) price = String(it.sellingPrice);
        }
        div.innerHTML =
          '<div class="np-bill-line__head">' +
            '<span class="np-bill-line__kind" data-kind="' + mode + '">' + (mode === 'inv' ? 'Inventory' : 'Manual item') + '</span>' +
            '<button type="button" class="np-btn np-btn--sm np-btn--ghost np-btn--danger" onclick="NPBilling.removeLine(this)">Remove</button>' +
          '</div>' +
          '<div class="np-seg np-seg--fit" style="margin-bottom:.5rem">' +
            '<button type="button" class="np-seg__btn' + (mode === 'inv' ? ' is-active' : '') + '" data-mode="inv">Inventory</button>' +
            '<button type="button" class="np-seg__btn' + (mode === 'manual' ? ' is-active' : '') + '" data-mode="manual">Manual item</button>' +
          '</div>' +
          (mode === 'inv'
            ? '<div class="np-combo" style="margin-bottom:.5rem"><input class="np-input np-line-search" placeholder="Search medicine…" autocomplete="off" value="' + esc_(name) + '"/>' +
              '<input type="hidden" class="np-line-item" value="' + itemId + '"/>' +
              '<div class="np-combo__menu np-line-menu"></div>' +
              '<div class="np-bill-stock np-line-stock"></div></div>'
            : '<div class="np-field" style="margin-bottom:.5rem"><input class="np-input np-line-name" placeholder="Item name (e.g. Consultation, Vaccination)" value="' + esc_(name) + '"/></div>') +
          '<div class="bill-line" style="margin-bottom:0">' +
            '<div class="bill-line__qty"><label class="np-field__label">Qty</label><input type="number" class="np-input np-line-qty" min="1" value="' + qty + '"/></div>' +
            '<div class="bill-line__price"><label class="np-field__label">Price (₹)</label><input type="number" step="0.01" min="0" class="np-input np-line-price" value="' + esc_(price) + '"/></div>' +
            '<div class="bill-line__price"><label class="np-field__label">Line total</label><div class="np-input np-line-total" style="display:flex;align-items:center;font-weight:700">' + inr(Number(price || 0) * qty) + '</div></div>' +
          '</div>';
        linesHost.appendChild(div);
        NPBilling.wireLine(div);
      };
      if (lines.length) {
        lines.forEach(function (item) { renderLine({ mode: item.itemId ? 'inv' : 'manual', itemId: item.itemId || '', name: item.name, quantity: item.quantity, unitPrice: item.unitPrice }); });
      } else {
        renderLine({ mode: lineModeHint === 'Manual' ? 'manual' : 'inv' });
      }

      qs('#addLineBtn').addEventListener('click', function () { renderLine({ mode: lineModeHint === 'Manual' ? 'manual' : 'inv' }); });
      qs('#billForm').addEventListener('submit', function (e) { e.preventDefault(); NPBilling.submit(false); });
      var paidBtn = qs('#savePaidBtn');
      if (paidBtn) paidBtn.addEventListener('click', function () { NPBilling.submit(true); });

      ['billDiscount', 'billTax'].forEach(function (id) {
        qs('#' + id).addEventListener('input', NPBilling.recompute);
      });
      // Sync the footer + every line total with whatever was rendered into the
      // form (edit-draft values, pre-seeded price) instead of waiting for input.
      NPBilling.recompute();
      if (canSwitchType) {
        qs('#billType').addEventListener('change', function () {
          bill.billType = qs('#billType').value;
          var hint = bill.billType === 'PHARMACY' ? 'Inventory' : 'Manual';
          qsa('.np-bill-line').forEach(function (l) { NPBilling.setLineMode(l, hint === 'Manual' ? 'manual' : 'inv'); });
        });
      }
    },

    wireSearch: function (search, menu, itemHidden, stockHint, price, qty) {
      var inventory = global.__billing.inventory;
      var renderDrop = function (rows) {
        menu.innerHTML = rows.length ? rows.map(function (it) {
          return '<button type="button" class="np-combo__opt" data-id="' + it.id + '" data-name="' + esc(it.name) + '" data-price="' + it.sellingPrice + '" data-stock="' + it.stock + '">' +
            '<span class="np-combo__opt__name"><span>' + esc(it.name) + '</span><span>' + inr(it.sellingPrice) + '</span></span>' +
            '<span class="np-combo__opt__meta">' + 'stock ' + it.stock + (it.unit ? ' · ' + esc(it.unit) : '') + (it.manufacturer ? ' · ' + esc(it.manufacturer) : '') + '</span></button>';
        }).join('') : '<div class="np-combo__empty">No medicines match</div>';
        qsa('.np-combo__opt', menu).forEach(function (b) {
          b.addEventListener('click', function () {
            itemHidden.value = b.getAttribute('data-id');
            search.value = b.getAttribute('data-name');
            price.value = b.getAttribute('data-price');
            qty.value = Math.max(1, Math.min(Number(qty.value) || 1, Number(b.getAttribute('data-stock'))));
            NPBilling.setStockHint(stockHint, Number(b.getAttribute('data-stock')));
            menu.classList.remove('is-open');
            NPBilling.recompute(); // price/qty were set programmatically — no 'input' event fires
          });
        });
      };
      attachSearch(search, menu, renderDrop, function (q) {
        var term = q.toLowerCase();
        return Promise.resolve(inventory.filter(function (it) { return it.name.toLowerCase().indexOf(term) >= 0; }));
      });
      if (itemHidden.value) {
        var it = inventory.filter(function (x) { return x.id === itemHidden.value; })[0];
        if (it) NPBilling.setStockHint(stockHint, Number(it.stock));
      }
    },

    wireLine: function (lineEl) {
      var segBtns = qsa('.np-seg__btn', lineEl);
      segBtns.forEach(function (b) {
        if (b.__wired) return; b.__wired = true;
        b.addEventListener('click', function () { NPBilling.setLineMode(lineEl, b.getAttribute('data-mode')); });
      });
      var search = qs('.np-line-search', lineEl);
      var menu = qs('.np-line-menu', lineEl);
      var itemHidden = qs('.np-line-item', lineEl);
      var stockHint = qs('.np-line-stock', lineEl);
      var price = qs('.np-line-price', lineEl);
      var qty = qs('.np-line-qty', lineEl);

      if (search && menu && !search.__billingWired) {
        search.__billingWired = true;
        NPBilling.wireSearch(search, menu, itemHidden, stockHint, price, qty);
      }
      [qty, price].forEach(function (el) {
        if (el && !el.__billingWired) { el.__billingWired = true; el.addEventListener('input', NPBilling.recompute); }
      });
    },

    setStockHint: function (hint, stock) {
      hint.textContent = 'In stock: ' + stock;
      hint.className = 'np-bill-stock ' + (stock <= 0 ? 'is-out' : stock <= 10 ? 'is-low' : '');
    },

    setLineMode: function (lineEl, mode) {
      qsa('.np-seg__btn', lineEl).forEach(function (b) { b.classList.toggle('is-active', b.getAttribute('data-mode') === mode); });
      qs('.np-bill-line__kind', lineEl).textContent = mode === 'inv' ? 'Inventory' : 'Manual item';
      qs('.np-bill-line__kind', lineEl).setAttribute('data-kind', mode);
      var invCombo = qs('.np-combo', lineEl);
      var manualName = qs('.np-line-name', lineEl);
      var price = qs('.np-line-price', lineEl);
      var itemHidden = qs('.np-line-item', lineEl);

      if (mode === 'inv') {
        if (manualName) {
          var manualVal = manualName.value;
          manualName.remove();
          var newCombo = mk('div', 'np-combo');
          newCombo.style.cssText = 'margin-bottom:.5rem';
          newCombo.innerHTML = '<input class="np-input np-line-search" placeholder="Search medicine…" autocomplete="off"/>' +
            '<input type="hidden" class="np-line-item" value=""/>' +
            '<div class="np-combo__menu np-line-menu"></div>' +
            '<div class="np-bill-stock np-line-stock"></div>';
          lineEl.insertBefore(newCombo, qs('.bill-line', lineEl));
          price.value = price.value || '';
          NPBilling.wireLine(lineEl);
        }
      } else {
        if (invCombo) {
          invCombo.remove();
          var field = mk('div', 'np-field');
          field.style.cssText = 'margin-bottom:.5rem';
          var inp = mk('input');
          inp.className = 'np-input np-line-name';
          inp.placeholder = 'Item name (e.g. Consultation, Vaccination)';
          lineEl.insertBefore(field, qs('.bill-line', lineEl));
          field.appendChild(inp);
        }
      }
      NPBilling.recompute();
    },

    removeLine: function (btn) {
      var host = global.__billing && document.querySelector(global.__billing.cfg && global.__billing.cfg.host || '#modalHost');
      var lines = document.querySelectorAll('#billLines .np-bill-line');
      if (lines.length <= 1) { (global.__billing.cfg.toast || window.NPToast)('Keep at least one item', 'warn'); return; }
      btn.closest('.np-bill-line').remove();
      NPBilling.recompute();
    },

    collectLines: function () {
      return qsa('#billLines .np-bill-line').map(function (lineEl) {
        // data-kind stores the raw mode ('inv' | 'manual'), set by setLineMode.
        // Fall back to the live DOM (hidden item id vs. free-text name) so a
        // stale attribute can never silently flip a line to the wrong mode.
        var kindEl = qs('.np-bill-line__kind', lineEl);
        var kind = kindEl ? kindEl.getAttribute('data-kind') : '';
        var itemId = qs('.np-line-item', lineEl);
        var nameEl = qs('.np-line-name', lineEl);
        var name = qs('.np-line-search', lineEl);
        var qty = qs('.np-line-qty', lineEl);
        var price = qs('.np-line-price', lineEl);
        var mode = (kind === 'inv' || kind === 'manual') ? kind
                 : (itemId && itemId.value) ? 'inv' : 'manual';
        // An inventory line's display name lives in the search input; a manual
        // line's name lives in its own input. Never cross them over.
        var lineName = mode === 'inv' ? (name ? name.value : '') : (nameEl ? nameEl.value : '');
        return {
          mode: mode,
          itemId: (itemId && itemId.value) || '',
          name: lineName,
          quantity: Number(qty ? qty.value : 1),
          unitPrice: Number(price ? price.value : 0)
        };
      }).filter(function (l) {
        if (l.mode === 'inv') return !!(l.itemId || (l.name && l.name.trim()));
        return !!(l.name && l.name.trim());
      });
    },

    recompute: function () {
      var lines = NPBilling.collectLines();
      var subtotal = lines.reduce(function (s, l) { return s + (Number(l.unitPrice) || 0) * (Number(l.quantity) || 0); }, 0);
      var discount = Number((qs('#billDiscount') && qs('#billDiscount').value) || 0);
      var tax = Number((qs('#billTax') && qs('#billTax').value) || 0);
      var total = Math.max(0, subtotal - discount + tax);
      var grand = qs('#billGrandTotal');
      if (grand) grand.textContent = inr(total);
      // update per-line totals too
      qsa('#billLines .np-bill-line').forEach(function (lineEl) {
        var qty = qs('.np-line-qty', lineEl);
        var price = qs('.np-line-price', lineEl);
        var total = qs('.np-line-total', lineEl);
        if (total) total.textContent = inr((Number(price && price.value) || 0) * (Number(qty && qty.value) || 0));
      });
      return total;
    },

    submit: function (markPaidNow) {
      var g = global.__billing;
      var cfg = g.cfg;
      var toast = cfg.toast || window.NPToast;
      var lines = NPBilling.collectLines();
      if (!lines.length) { toast('Add at least one item', 'error'); return; }
      if (lines.some(function (l) { return l.mode === 'inv' && !l.itemId; })) {
        toast('Pick a medicine from the search results in every Inventory line', 'error');
        return;
      }
      var payload = {
        customerName: (qs('#billPatient') ? qs('#billPatient').value.trim() : '') || null,
        customerPhone: (qs('#billPhone') ? qs('#billPhone').value.trim() : '') || null,
        patientId: (qs('#billPatientId') ? qs('#billPatientId').value.trim() : '') || undefined,
        doctorId: qs('#billDoctor') ? (qs('#billDoctor').value || undefined) : undefined,
        billType: qs('#billType') ? qs('#billType').value : (cfg.defaultBillType || 'PHARMACY'),
        prescriptionId: cfg.rxId || undefined,
        discount: Number((qs('#billDiscount') && qs('#billDiscount').value) || 0),
        tax: Number((qs('#billTax') && qs('#billTax').value) || 0),
        paymentMethod: qs('#billPayMethod') ? qs('#billPayMethod').value : 'CASH',
        notes: (qs('#billNotes') && qs('#billNotes').value) || '',
        items: lines.map(function (l) {
          return { itemId: l.itemId || undefined, name: l.name, quantity: l.quantity, unitPrice: l.unitPrice };
        })
      };
      if (!markPaidNow && payload.billType === 'PHARMACY' && payload.items.some(function (i) { return i.itemId; })) {
        // inventory lines validated on server for stock
      }

      var url, method;
      if (g.editing) {
        url = g.billsBase + '/' + g.bill.id;
        method = 'PUT';
      } else {
        url = g.billsBase;
        method = 'POST';
      }
      cfg.api(url, { method: method, body: JSON.stringify(payload) }).then(function (r) {
        var doMarkPaid = markPaidNow && !g.editing && r.bill && r.bill.id;
        if (doMarkPaid) {
          // IMPORTANT: the bill above was already created as a DRAFT and
          // persisted server-side by the time we get here. If this
          // mark-paid call fails (e.g. someone else just bought the last
          // unit of a medicine in this line between form-fill and submit),
          // that draft still exists — it is NOT rolled back. We must not
          // let this rejection fall through to the generic "Failed to
          // save bill" handler below, because that would tell the user
          // nothing was saved when in fact a draft now sits in their bill
          // list. Tag the error so the outer .catch can handle it
          // differently (see savedAsDraft below).
          return cfg.api(g.billsBase + '/' + r.bill.id + '/mark-paid', { method: 'POST', body: JSON.stringify({ paymentMethod: payload.paymentMethod }) })
            .then(function (p) { return p; })
            .catch(function (payErr) {
              var err = new Error('Bill saved as draft, but marking it paid failed: ' + (payErr && payErr.message ? payErr.message : 'unknown error') + '. Fix the issue (e.g. restock or adjust quantity) and mark the draft paid from the bill list.');
              err.savedAsDraft = true;
              err.draftBill = r.bill;
              throw err;
            });
        }
        return r;
      }).then(function (r) {
        toast(markPaidNow ? 'Bill saved and marked paid' : (g.editing ? 'Bill updated' : 'Bill saved as draft'));
        if (r && r.pdfUrl) {
          if (cfg.onPdf) cfg.onPdf(r.pdfUrl); else window.open(r.pdfUrl, '_blank');
        }
        NPBilling.close();
        if (cfg.onSaved) cfg.onSaved(r && r.bill);
      }).catch(function (e) {
        if (e && e.savedAsDraft) {
          // The draft is real and already saved — closing the modal here
          // is correct (there is nothing left to fix in this form; the
          // fix happens on the saved draft itself), and we refresh the
          // caller's list so the draft is visible instead of appearing
          // to have vanished.
          toast(e.message, 'warn');
          NPBilling.close();
          if (cfg.onSaved) cfg.onSaved(e.draftBill);
          return;
        }
        toast(e.message || 'Failed to save bill', 'error');
      });
    },

    close: function () {
      var host = document.querySelector(global.__billing && global.__billing.cfg && global.__billing.cfg.host || '#modalHost');
      if (host) host.innerHTML = '';
      delete global.__billing;
    },

    markPaid: function (cfg, billId, onDone) {
      var toast = cfg.toast || window.NPToast;
      cfg.api(cfg.billsBase + '/' + billId + '/mark-paid', { method: 'POST', body: JSON.stringify({}) }).then(function (r) {
        toast('Bill marked paid');
        if (r && r.pdfUrl && cfg.onPdf) cfg.onPdf(r.pdfUrl);
        if (onDone) onDone();
      }).catch(function (e) { toast(e.message || 'Failed to mark paid', 'error'); });
    }

  };

  global.NPBilling = NPBilling;
})(window);
