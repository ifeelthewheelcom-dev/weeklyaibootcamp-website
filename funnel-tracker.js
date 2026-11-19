/**
 * Weekly AI Bootcamp — Unified Meta Pixel (Facebook Pixel), Server CAPI & Live Event Inspector
 * Tracks every piece of the 3-page funnel with strict eventID deduplication:
 *  1. Landing Page Visit (index.html) -> PageView + ViewContent
 *  2. Step 1 Two-Step Checkout Modal (Name/Email/WhatsApp) -> Lead + InitiateCheckout (with Advanced Matching)
 *  3. Paystack Popup Opened / Order Bump Toggled -> AddPaymentInfo
 *  4. Main Pass Purchase ($100 / ₦150,000, $150 / ₦225,000 VIP, or Live ₦5,000 Test) -> Purchase + BootcampMainPurchase
 *  5. Post-Purchase Upsell Page (upsell-consultation.html) -> PageView + ViewContent + Purchase (if accepted)
 *  6. Thank-You Page Arrival (thankyou.html) -> PageView + Fallback Purchase Check + CompleteRegistration
 */
(function () {
  const STORAGE_KEYS = {
    LEAD: 'aie_lead_data',
    LEAD_ID: 'aie_lead_id',
    ORDER_ID: 'aie_order_id',
    PIXEL_ID: 'aie_fb_pixel_id',
    FIRED_EVENTS: 'aie_fired_pixel_events_v1',
    EVENT_HISTORY: 'aie_pixel_event_history_v1'
  };

  const urlParams = new URLSearchParams(window.location.search);
  const urlPixel = urlParams.get('pixel') || urlParams.get('fb_pixel_id') || '';
  if (urlPixel && /^\d{10,20}$/.test(urlPixel.trim())) {
    try { localStorage.setItem(STORAGE_KEYS.PIXEL_ID, urlPixel.trim()); } catch (e) {}
  }

  let trackerConfig = {
    fbPixelId: (urlPixel && /^\d{10,20}$/.test(urlPixel.trim()))
      ? urlPixel.trim()
      : (localStorage.getItem(STORAGE_KEYS.PIXEL_ID) || ''),
    gaMeasurementId: '',
    initialized: false
  };

  function isTestOrLocal() {
    const h = window.location.hostname;
    return (
      h === 'localhost' ||
      h === '127.0.0.1' ||
      urlParams.has('test') ||
      urlParams.has('test5k') ||
      urlParams.has('debug_pixel')
    );
  }

  function getFiredEvents() {
    try {
      return JSON.parse(sessionStorage.getItem(STORAGE_KEYS.FIRED_EVENTS) || '{}');
    } catch (e) {
      return {};
    }
  }

  function markEventFired(eventId) {
    try {
      const fired = getFiredEvents();
      fired[eventId] = Date.now();
      sessionStorage.setItem(STORAGE_KEYS.FIRED_EVENTS, JSON.stringify(fired));
    } catch (e) {}
  }

  function hasEventFired(eventId) {
    if (!eventId) return false;
    const fired = getFiredEvents();
    return Boolean(fired[eventId]);
  }

  function getStoredLead() {
    try {
      const raw = localStorage.getItem(STORAGE_KEYS.LEAD);
      if (raw) return JSON.parse(raw);
    } catch (e) {}
    return {
      name: localStorage.getItem('aie_name') || '',
      email: localStorage.getItem('aie_email') || '',
      phone: localStorage.getItem('aie_phone') || ''
    };
  }

  function injectMetaPixel(pixelId, userData) {
    const cleanId = String(pixelId || '').trim();
    if (!cleanId || cleanId === 'YOUR_PIXEL_ID') return;

    if (!window.fbq) {
      !(function (f, b, e, v, n, t, s) {
        if (f.fbq) return;
        n = f.fbq = function () {
          n.callMethod ? n.callMethod.apply(n, arguments) : n.queue.push(arguments);
        };
        if (!f._fbq) f._fbq = n;
        n.push = n;
        n.loaded = !0;
        n.version = '2.0';
        n.queue = [];
        t = b.createElement(e);
        t.async = !0;
        t.src = v;
        s = b.getElementsByTagName(e)[0];
        s.parentNode.insertBefore(t, s);
      })(window, document, 'script', 'https://connect.facebook.net/en_US/fbevents.js');
    }

    const advancedMatch = {};
    if (userData && userData.email) advancedMatch.em = userData.email.trim().toLowerCase();
    if (userData && userData.phone) advancedMatch.ph = userData.phone.replace(/[^0-9]/g, '');
    if (userData && userData.name) {
      const parts = userData.name.trim().split(/\s+/);
      if (parts[0]) advancedMatch.fn = parts[0].toLowerCase();
      if (parts.length > 1) advancedMatch.ln = parts.slice(1).join(' ').toLowerCase();
    }

    try {
      window.fbq('init', cleanId, advancedMatch);
    } catch (e) {}
  }

  async function initTracker() {
    if (trackerConfig.initialized) return trackerConfig;
    try {
      const res = await fetch('/api/config');
      const cfg = await res.json();
      const serverPixel = (cfg.fbPixelId && cfg.fbPixelId !== 'YOUR_PIXEL_ID') ? cfg.fbPixelId : '';
      const activePixel = trackerConfig.fbPixelId || serverPixel;
      trackerConfig = {
        ...trackerConfig,
        fbPixelId: activePixel,
        gaMeasurementId: cfg.gaMeasurementId || '',
        initialized: true
      };
      if (activePixel) {
        try { localStorage.setItem(STORAGE_KEYS.PIXEL_ID, activePixel); } catch (e) {}
        injectMetaPixel(activePixel, getStoredLead());
      }
    } catch (e) {
      trackerConfig.initialized = true;
      if (trackerConfig.fbPixelId) {
        injectMetaPixel(trackerConfig.fbPixelId, getStoredLead());
      }
    }
    updateInspectorHeader();
    return trackerConfig;
  }

  function recordEventToInspector(entry) {
    try {
      const hist = JSON.parse(sessionStorage.getItem(STORAGE_KEYS.EVENT_HISTORY) || '[]');
      hist.unshift(entry);
      sessionStorage.setItem(STORAGE_KEYS.EVENT_HISTORY, JSON.stringify(hist.slice(0, 15)));
    } catch (e) {}
    renderInspectorEvents();
  }

  function dispatchEvent({ standardEvent, customEvent, eventId, params = {}, user = {} }) {
    if (eventId && hasEventFired(eventId)) {
      return;
    }
    if (eventId) {
      markEventFired(eventId);
    }

    const mergedUser = { ...getStoredLead(), ...user };
    const finalEventId = eventId || `EVT_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;

    if (trackerConfig.fbPixelId) {
      injectMetaPixel(trackerConfig.fbPixelId, mergedUser);
    }

    // 1. Browser Meta Pixel (fbq) with eventID for CAPI deduplication
    if (typeof window.fbq === 'function' && trackerConfig.fbPixelId) {
      if (standardEvent) {
        window.fbq('track', standardEvent, params, { eventID: finalEventId });
      }
      if (customEvent) {
        window.fbq('trackCustom', customEvent, params, { eventID: finalEventId + '_cust' });
      }
    }

    // 2. Record in Visual Inspector (for localhost / ?test=5000 verification)
    recordEventToInspector({
      standardEvent: standardEvent || 'Custom',
      customEvent: customEvent || '',
      eventId: finalEventId,
      value: params.value,
      currency: params.currency || 'NGN',
      time: new Date().toLocaleTimeString()
    });

    // 3. Server-Side Conversion API (CAPI) & Funnel Analytics Log
    try {
      fetch('/api/pixel/event', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        keepalive: true,
        body: JSON.stringify({
          pixel_id: trackerConfig.fbPixelId || '',
          standard_event: standardEvent,
          custom_event: customEvent,
          event_id: finalEventId,
          page_url: window.location.href,
          page_path: window.location.pathname,
          params,
          user: mergedUser,
          timestamp: new Date().toISOString()
        })
      }).catch(() => {});
    } catch (e) {}
  }

  const BootcampTracker = {
    init: initTracker,

    setPixelId: async function (newPixelId) {
      const clean = String(newPixelId || '').trim();
      if (!clean) return false;
      trackerConfig.fbPixelId = clean;
      try { localStorage.setItem(STORAGE_KEYS.PIXEL_ID, clean); } catch (e) {}
      injectMetaPixel(clean, getStoredLead());
      try {
        await fetch('/api/admin/set-pixel', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ fb_pixel_id: clean })
        });
      } catch (e) {}
      updateInspectorHeader();
      // Fire immediate PageView test on the newly saved Pixel ID
      if (typeof window.fbq === 'function') {
        window.fbq('track', 'PageView');
      }
      recordEventToInspector({
        standardEvent: 'PageView (Pixel Connected)',
        customEvent: `Pixel_${clean}`,
        eventId: `INIT_${Date.now()}`,
        time: new Date().toLocaleTimeString()
      });
      return true;
    },

    // 1. Page Landing (index.html, upsell-consultation.html, thankyou.html)
    trackPageLanding: async function (pageName, customProps = {}) {
      await initTracker();
      if (typeof window.fbq === 'function' && trackerConfig.fbPixelId) {
        window.fbq('track', 'PageView');
      }
      dispatchEvent({
        standardEvent: 'ViewContent',
        customEvent: `PageLanding_${pageName}`,
        eventId: `VC_${pageName}_${window.location.pathname}`,
        params: {
          content_name: pageName,
          content_category: 'Weekly AI Bootcamp Funnel',
          currency: customProps.currency || 'NGN',
          value: customProps.value || 150000,
          ...customProps
        }
      });
    },

    // 2. Step 1 Opt-In Captured (Name, Email, WhatsApp Phone)
    trackStep1OptIn: function (lead = {}) {
      const cleanKey = (lead.lead_id || lead.email || lead.phone || Date.now()).toString().replace(/[^a-zA-Z0-9]/g, '');
      const eventId = `LEAD_${cleanKey}`;
      const isVip = lead.tier === 'vip' || Boolean(lead.include_bump);
      const valNgn = lead.amount_ngn || (isVip ? 225000 : 150000);

      dispatchEvent({
        standardEvent: 'Lead',
        customEvent: 'Step1OptInCaptured',
        eventId,
        user: lead,
        params: {
          content_name: 'Weekly AI Bootcamp — Step 1 Lead Opt-In',
          content_category: 'Weekly AI Bootcamp',
          currency: 'NGN',
          value: valNgn
        }
      });

      dispatchEvent({
        standardEvent: 'InitiateCheckout',
        customEvent: 'Step2CheckoutViewed',
        eventId: `IC_${cleanKey}`,
        user: lead,
        params: {
          content_name: isVip ? 'VIP Pass + 30-Min 1:1 Call ($150)' : 'Founding 100 Pass ($100)',
          content_ids: [isVip ? 'aie-vip-150' : 'aie-core-100'],
          content_type: 'product',
          currency: 'NGN',
          value: valNgn,
          num_items: isVip ? 2 : 1
        }
      });
    },

    // 3. Paystack Popup Opened / Payment Info Initiated
    trackPaystackPopupOpened: function ({ amountNgn = 150000, isTest5k = false, hasConsultation = false, user = {} }) {
      dispatchEvent({
        standardEvent: 'AddPaymentInfo',
        customEvent: isTest5k ? 'PaystackLive5kTestOpened' : 'PaystackCheckoutOpened',
        eventId: `API_${Date.now()}`,
        user,
        params: {
          content_name: isTest5k
            ? 'Weekly AI Bootcamp (Live ₦5,000 Paystack Test)'
            : (hasConsultation ? 'VIP Pass + 30-Min 1:1 Call ($150)' : 'Founding 100 Pass ($100)'),
          currency: 'NGN',
          value: Number(amountNgn)
        }
      });
    },

    // 4. Main Pass Purchase Completed (Fires BEFORE redirecting to Upsell Page!)
    trackMainPurchase: function ({ orderId, reference, valueNgn = 150000, valueUsd = 100, hasConsultation = false, isTest5k = false, user = {} }) {
      const cleanId = (reference || orderId || `ORD_${Date.now()}`).toString().replace(/[^a-zA-Z0-9_-]/g, '');
      const eventId = `PUR_MAIN_${cleanId}`;
      try {
        localStorage.setItem('aie_last_purchase_ref', cleanId);
        localStorage.setItem('aie_last_purchase_ngn', String(valueNgn));
      } catch (e) {}

      dispatchEvent({
        standardEvent: 'Purchase',
        customEvent: isTest5k ? 'BootcampLive5kTestPurchase' : 'BootcampMainPurchase',
        eventId,
        user,
        params: {
          content_name: isTest5k
            ? 'Weekly AI Bootcamp — Live ₦5,000 Paystack Verification'
            : (hasConsultation ? 'VIP Pass + 30-Min 1-on-1 Call ($150)' : 'Founding 100 Bootcamp Pass ($100)'),
          content_ids: hasConsultation ? ['aie-core-100', 'aie-vip-call-50'] : ['aie-core-100'],
          content_type: 'product',
          currency: 'NGN',
          value: Number(valueNgn),
          value_usd: Number(valueUsd),
          order_id: orderId || cleanId,
          paystack_reference: reference || cleanId
        }
      });
    },

    // 5. Post-Purchase 1-on-1 Consultation Upsell Purchase (+$50 / +₦75,000 or ₦5,000 Test)
    trackUpsellPurchase: function ({ orderId, reference, valueNgn = 75000, valueUsd = 50, isTest5k = false, user = {} }) {
      const cleanId = (reference || orderId || `OTO_${Date.now()}`).toString().replace(/[^a-zA-Z0-9_-]/g, '');
      const eventId = `PUR_OTO_${cleanId}`;
      dispatchEvent({
        standardEvent: 'Purchase',
        customEvent: 'UpsellConsultation50Purchase',
        eventId,
        user,
        params: {
          content_name: isTest5k
            ? '30-Min 1-on-1 Consultation Upsell (Live ₦5,000 Test)'
            : '30-Min 1-on-1 AI 10x Revenue Consultation Upsell (+$50)',
          content_ids: ['aie-oto-30min-call-50'],
          content_type: 'product',
          currency: 'NGN',
          value: Number(valueNgn),
          value_usd: Number(valueUsd),
          order_id: orderId || cleanId,
          paystack_reference: reference || cleanId
        }
      });
    },

    // 6. Thank-You Page Arrival (+ Deduplicated Safety Fallback if browser skipped directly from Paystack redirect)
    trackThankYouPage: async function ({ orderId, reference, isVip = false, otoAccepted = false, valueNgn = 150000, user = {} }) {
      await initTracker();
      const cleanRef = (reference || localStorage.getItem('aie_last_purchase_ref') || orderId || `TY_${Date.now()}`).toString().replace(/[^a-zA-Z0-9_-]/g, '');
      const savedNgn = Number(localStorage.getItem('aie_last_purchase_ngn') || valueNgn || (isVip ? 225000 : 150000));

      // Safety fallback: ensure main Purchase event fired at least once for this reference
      if (!hasEventFired(`PUR_MAIN_${cleanRef}`)) {
        BootcampTracker.trackMainPurchase({
          orderId: orderId || cleanRef,
          reference: cleanRef,
          valueNgn: savedNgn,
          valueUsd: savedNgn === 5000 ? 3.33 : (isVip ? 150 : 100),
          hasConsultation: isVip && !otoAccepted,
          isTest5k: savedNgn === 5000,
          user
        });
      }

      dispatchEvent({
        standardEvent: 'CompleteRegistration',
        customEvent: 'ThankYouPageConfirmed',
        eventId: `TY_CONFIRMED_${orderId || cleanRef}`,
        user,
        params: {
          content_name: isVip
            ? 'Weekly AI Bootcamp VIP Registration Confirmed ($150)'
            : 'Weekly AI Bootcamp Founding Pass Confirmed ($100)',
          currency: 'NGN',
          value: savedNgn,
          order_id: orderId || cleanRef,
          status: 'paid_and_confirmed'
        }
      });
    }
  };

  window.BootcampTracker = BootcampTracker;

  // ===========================================================================
  // VISUAL META PIXEL & PAYSTACK LIVE TEST INSPECTOR (Shown on Localhost / ?test=5000)
  // ===========================================================================
  function updateInspectorHeader() {
    const badge = document.getElementById('aiePixelStatusBadge');
    const input = document.getElementById('aiePixelIdInput');
    if (!badge) return;
    if (trackerConfig.fbPixelId) {
      badge.textContent = `🟢 Pixel ID: ${trackerConfig.fbPixelId}`;
      badge.style.background = 'rgba(22,163,74,0.22)';
      badge.style.color = '#4ADE80';
      badge.style.borderColor = '#22C55E';
      if (input && !input.value) input.value = trackerConfig.fbPixelId;
    } else {
      badge.textContent = '🟡 CAPI Log Active (Add FB Pixel ID Below)';
      badge.style.background = 'rgba(250,204,21,0.16)';
      badge.style.color = '#FACC15';
      badge.style.borderColor = '#EAB308';
    }
  }

  function renderInspectorEvents() {
    const listEl = document.getElementById('aiePixelEventList');
    if (!listEl) return;
    let hist = [];
    try {
      hist = JSON.parse(sessionStorage.getItem(STORAGE_KEYS.EVENT_HISTORY) || '[]');
    } catch (e) {}
    if (!hist.length) {
      listEl.innerHTML = '<div style="color:#94A3B8;font-size:11px;padding:4px 0">Waiting for funnel events...</div>';
      return;
    }
    listEl.innerHTML = hist.slice(0, 6).map(ev => {
      const valStr = ev.value ? ` • <strong style="color:#4ADE80">${ev.currency === 'NGN' ? '₦' : '$'}${Number(ev.value).toLocaleString()}</strong>` : '';
      return `<div style="padding:5px 8px;background:rgba(15,23,42,0.85);border-left:3px solid #F37021;border-radius:4px;margin-bottom:4px;font-size:11px;line-height:1.35">
        <div style="display:flex;justify-content:space-between;color:#F8FAFC;font-weight:800">
          <span>✓ fbq('track', '${ev.standardEvent}')</span>
          <span style="color:#94A3B8;font-weight:600;font-size:10px">${ev.time}</span>
        </div>
        <div style="color:#CBD5E1;font-size:10.5px">${ev.customEvent || ''}${valStr} <span style="color:#64748B">[${ev.eventId}]</span></div>
      </div>`;
    }).join('');
  }

  function mountVisualInspector() {
    if (!isTestOrLocal()) return;
    if (document.getElementById('aiePixelInspector')) return;

    const wrap = document.createElement('div');
    wrap.id = 'aiePixelInspector';
    wrap.style.cssText = 'position:fixed;bottom:68px;right:16px;z-index:9999;width:330px;max-width:calc(100vw - 32px);background:#070C16;color:#F8FAFC;border:2px solid #F37021;border-radius:12px;box-shadow:0 20px 50px rgba(0,0,0,0.65);font-family:Inter,-apple-system,sans-serif;overflow:hidden;';
    wrap.innerHTML = `
      <div style="background:#0F172A;padding:9px 12px;display:flex;align-items:center;justify-content:space-between;border-bottom:1px solid rgba(255,255,255,0.1);cursor:pointer" onclick="const b=document.getElementById('aiePixelInspectorBody');b.style.display=b.style.display==='none'?'block':'none'">
        <div style="font-size:11.5px;font-weight:900;letter-spacing:0.03em;color:#F8FAFC;display:flex;align-items:center;gap:6px">
          <span>📡 META PIXEL &amp; PAYSTACK MONITOR</span>
        </div>
        <span style="font-size:11px;color:#94A3B8;font-weight:700">▾</span>
      </div>
      <div id="aiePixelInspectorBody" style="padding:10px 12px">
        <div id="aiePixelStatusBadge" style="font-size:11px;font-weight:800;padding:4px 8px;border-radius:6px;border:1px solid #EAB308;margin-bottom:8px;text-align:center">
          Checking Meta Pixel...
        </div>
        <div style="display:flex;gap:6px;margin-bottom:8px">
          <input type="text" id="aiePixelIdInput" placeholder="Paste 15-Digit FB Pixel ID" style="flex:1;background:#0F172A;border:1px solid #334155;color:#fff;font-size:11.5px;padding:6px 8px;border-radius:6px;outline:none" />
          <button type="button" onclick="window.BootcampTracker.setPixelId(document.getElementById('aiePixelIdInput').value)" style="background:#F37021;color:#fff;border:none;font-size:11px;font-weight:800;padding:6px 10px;border-radius:6px;cursor:pointer;white-space:nowrap">
            Save Pixel
          </button>
        </div>
        <div id="aiePixelEventList" style="max-height:175px;overflow-y:auto"></div>
      </div>
    `;
    document.body.appendChild(wrap);
    updateInspectorHeader();
    renderInspectorEvents();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', mountVisualInspector);
  } else {
    mountVisualInspector();
  }
})();
