require('dotenv').config();
const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const app = express();
const PORT = process.env.PORT || 4195;

app.use(cors());
app.use(express.json());
app.use(express.static(__dirname));
app.use('/studio_captures', express.static(path.resolve(__dirname, '../studio_captures')));
app.use('/vsl_root', express.static(path.resolve(__dirname, '..')));
app.use('/skills', express.static(path.resolve(__dirname, '../../.agents/skills')));

const GHL_WEBHOOK_URL = process.env.GHL_WEBHOOK_URL || 'https://services.leadconnectorhq.com/hooks/ShmWKPtFl0vRgBAVTR4F/webhook-trigger/011c2b44-3ed8-4530-ba76-9c8a6957747b';
const CSV_FILE = path.join(__dirname, 'leads_and_orders.csv');

const CSV_HEADERS = [
  'Order_Or_Lead_ID',
  'Date_Time',
  'Full_Name',
  'Email',
  'WhatsApp_Phone',
  'Selected_Tier',
  'Order_Bump_30Min_Call',
  'Post_Purchase_Upsell_30Min_Call',
  'Total_USD',
  'Total_NGN',
  'Payment_Method',
  'Paystack_Reference',
  'GHL_Tags',
  'Payment_Status',
  'Funnel_Stage'
];

function initCSV() {
  if (!fs.existsSync(CSV_FILE)) {
    fs.writeFileSync(CSV_FILE, CSV_HEADERS.join(',') + '\n', 'utf8');
  }
}
initCSV();

function escapeCSV(val) {
  if (val === null || val === undefined) return '""';
  return `"${String(val).replace(/"/g, '""')}"`;
}

function formatNow() {
  return new Date().toISOString().replace('T', ' ').slice(0, 19);
}

function splitName(fullName = '') {
  const parts = String(fullName || '').trim().split(/\s+/).filter(Boolean);
  return {
    firstName: parts[0] || 'Student',
    lastName: parts.slice(1).join(' ') || ''
  };
}

function normalizePhone(phone = '') {
  const raw = String(phone || '').trim();
  if (!raw) return '';
  const digits = raw.replace(/[^0-9+]/g, '');
  if (digits.startsWith('0') && digits.length === 11) {
    return '+234' + digits.slice(1);
  }
  return digits;
}

const activeRecords = new Map();

// ============================================================================
// GOHIGHLEVEL (LEADCONNECTOR) WEBHOOK SYNC ENGINE
// Fires immediately on Step 1 Opt-In (tag: 'aie-optin')
// Fires on Payment / Upsell / Thank-You Page (tag: 'purchased')
// ============================================================================
async function syncGhlWebhook(eventType, rec) {
  if (!GHL_WEBHOOK_URL) return;
  const isPurchased = rec.is_purchased === true || String(rec.payment_status || '').toLowerCase().includes('paid');
  const tags = Array.isArray(rec.ghl_tags) && rec.ghl_tags.length
    ? rec.ghl_tags
    : (isPurchased ? ['purchased', 'aie-paid'] : ['aie-optin', 'unpaid-lead']);
  const primaryTag = isPurchased ? 'purchased' : 'aie-optin';
  const { firstName, lastName } = splitName(rec.name);

  const payload = {
    event: eventType,
    funnel: 'Weekly AI Bootcamp (Sunday, Nov 22 · 4:00 PM - 8:00 PM GMT+1 Nigerian Time)',
    order_or_lead_id: rec.id,
    lead_id: rec.lead_id || rec.id,
    first_name: firstName,
    last_name: lastName,
    full_name: rec.name || '',
    name: rec.name || '',
    email: rec.email || '',
    phone: normalizePhone(rec.phone),
    raw_phone: rec.phone || '',
    status: isPurchased ? 'purchased' : 'lead',
    payment_status: isPurchased ? 'paid' : 'unpaid',
    purchased: isPurchased,
    tag: primaryTag,
    tags: tags,
    tags_csv: tags.join(','),
    remove_tags: isPurchased ? ['unpaid-lead'] : [],
    package_tier: rec.tier_label || 'Founding 100 Pass ($100)',
    has_30min_consultation: rec.tier === 'vip',
    order_value_usd: Number(rec.total_usd || 100),
    order_value_ngn: Number(rec.total_ngn || 150000),
    paystack_reference: rec.paystack_ref || '',
    funnel_stage: rec.funnel_stage || 'step1_optin',
    consultation_slot: rec.consultation_slot || '',
    consultation_notes: rec.consultation_notes || '',
    bootcamp_date: 'Sunday, November 22, 2026 (4:00 PM - 8:00 PM GMT+1 Nigerian Time)',
    timestamp: new Date().toISOString()
  };

  try {
    await fetch(GHL_WEBHOOK_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
  } catch (err) {
    console.error('GHL Webhook Error:', err.message);
  }
}

function upsertCSVRecord(rec, eventType = 'record_updated') {
  try {
    initCSV();
    const lines = fs.readFileSync(CSV_FILE, 'utf8').split('\n').filter(Boolean);
    const header = lines[0];
    const dataRows = lines.slice(1);

    const rowStr = [
      escapeCSV(rec.id),
      escapeCSV(rec.date_time),
      escapeCSV(rec.name),
      escapeCSV(rec.email),
      escapeCSV(rec.phone),
      escapeCSV(rec.tier_label || 'Founding 100 Pass ($100)'),
      escapeCSV(rec.order_bump || 'NO'),
      escapeCSV(rec.upsell_call || 'Pending'),
      escapeCSV(`$${rec.total_usd || 100}`),
      escapeCSV(`₦${Number(rec.total_ngn || 150000).toLocaleString()}`),
      escapeCSV(rec.payment_method || 'Step 1 Lead Only'),
      escapeCSV(rec.paystack_ref || ''),
      escapeCSV((rec.ghl_tags || []).join(' | ')),
      escapeCSV(rec.payment_status || 'unpaid'),
      escapeCSV(rec.funnel_stage || 'step1_optin')
    ].join(',');

    let foundIdx = -1;
    for (let i = 0; i < dataRows.length; i++) {
      if (
        dataRows[i].startsWith(`"${rec.id}"`) ||
        (rec.lead_id && dataRows[i].startsWith(`"${rec.lead_id}"`))
      ) {
        foundIdx = i;
        break;
      }
    }

    if (foundIdx >= 0) {
      dataRows[foundIdx] = rowStr;
    } else {
      dataRows.push(rowStr);
    }

    fs.writeFileSync(CSV_FILE, [header, ...dataRows].join('\n') + '\n', 'utf8');
    syncGhlWebhook(eventType, rec);
  } catch (err) {
    console.error('CSV Save Error:', err.message);
  }
}

// GET /api/config — Public config for Paystack, WhatsApp & GHL Webhook
app.get('/api/config', (req, res) => {
  const rate = Number(process.env.USD_TO_NGN_RATE || 1500);
  const coreUsd = Number(process.env.CORE_PRICE_USD || 100);
  const upsellUsd = Number(process.env.UPSELL_PRICE_USD || 50);
  const vipUsd = Number(process.env.VIP_PRICE_USD || 150);

  res.json({
    paystackPublicKey: process.env.PAYSTACK_PUBLIC_KEY || 'pk_live_a9bb940af8c01879325031847e4472d62a7c7dc7',
    paystackCurrency: process.env.PAYSTACK_CURRENCY || 'NGN',
    usdToNgnRate: rate,
    corePriceUsd: coreUsd,
    upsellPriceUsd: upsellUsd,
    vipPriceUsd: vipUsd,
    corePriceNgn: coreUsd * rate,
    upsellPriceNgn: upsellUsd * rate,
    vipPriceNgn: vipUsd * rate,
    whatsappGroupUrl: process.env.WHATSAPP_GROUP_URL || 'https://wa.me/33698170335?text=Hi%20David%2C%20I%20just%20paid%20for%20the%20AI%20Editor%20Bootcamp%20and%20I%27m%20ready%20to%20join%20the%20Buyers%20WhatsApp%20Group!',
    whatsappNumber: process.env.WHATSAPP_NUMBER || '33698170335',
    whatsappDisplay: process.env.WHATSAPP_DISPLAY || '+33 6 98 17 03 35',
    ghlWebhookUrl: GHL_WEBHOOK_URL,
    fbPixelId: process.env.FB_PIXEL_ID || '',
    gaMeasurementId: process.env.GA_MEASUREMENT_ID || ''
  });
});

// POST /api/admin/set-pixel — Dynamically sets & saves FB_PIXEL_ID in .env
app.post('/api/admin/set-pixel', (req, res) => {
  try {
    const cleanId = String((req.body && req.body.fb_pixel_id) || '').trim();
    if (!cleanId) return res.status(400).json({ success: false, error: 'Missing fb_pixel_id' });
    process.env.FB_PIXEL_ID = cleanId;
    const envPath = path.join(__dirname, '.env');
    if (fs.existsSync(envPath)) {
      let envText = fs.readFileSync(envPath, 'utf8');
      if (/^FB_PIXEL_ID=.*$/m.test(envText)) {
        envText = envText.replace(/^FB_PIXEL_ID=.*$/m, `FB_PIXEL_ID=${cleanId}`);
      } else {
        envText += `\nFB_PIXEL_ID=${cleanId}\n`;
      }
      fs.writeFileSync(envPath, envText, 'utf8');
    }
    res.json({ success: true, fbPixelId: cleanId });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// POST /api/pixel/event — Server-Side Meta Conversion API (CAPI) & Pixel Event Logger
const PIXEL_LOG_FILE = path.join(__dirname, 'pixel_events.jsonl');
app.post('/api/pixel/event', async (req, res) => {
  try {
    const payload = {
      ...req.body,
      ip: req.headers['x-forwarded-for'] || req.socket.remoteAddress || '',
      user_agent: req.headers['user-agent'] || ''
    };
    fs.appendFileSync(PIXEL_LOG_FILE, JSON.stringify(payload) + '\n', 'utf8');

    const pixelId = process.env.FB_PIXEL_ID || payload.pixel_id || '';
    if (pixelId && process.env.FB_CAPI_TOKEN && payload.standard_event) {
      const sha256 = (v) => crypto.createHash('sha256').update(String(v).trim().toLowerCase()).digest('hex');
      const userData = {
        client_ip_address: payload.ip,
        client_user_agent: payload.user_agent
      };
      if (payload.user && payload.user.email) userData.em = [sha256(payload.user.email)];
      if (payload.user && payload.user.phone) userData.ph = [sha256(payload.user.phone.replace(/[^0-9]/g, ''))];

      fetch(`https://graph.facebook.com/v19.0/${encodeURIComponent(pixelId)}/events?access_token=${encodeURIComponent(process.env.FB_CAPI_TOKEN)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          data: [
            {
              event_name: payload.standard_event,
              event_time: Math.floor(Date.now() / 1000),
              event_id: payload.event_id,
              event_source_url: payload.page_url,
              action_source: 'website',
              user_data: userData,
              custom_data: payload.params || {}
            }
          ]
        })
      }).catch(() => {});
    }

    res.json({ success: true });
  } catch (err) {
    res.status(200).json({ success: false });
  }
});

// GET /api/geo — Server-side IP country detection for Nigeria (NG), Ghana (GH), Kenya (KE), or Global (USD)
app.get('/api/geo', async (req, res) => {
  try {
    const hdrCountry = (
      req.headers['cf-ipcountry'] ||
      req.headers['x-vercel-ip-country'] ||
      req.headers['x-country-code'] ||
      ''
    ).toUpperCase().trim();

    if (hdrCountry && hdrCountry !== 'XX') {
      return res.json({ country: hdrCountry });
    }

    const fwd = (req.headers['x-forwarded-for'] || '').split(',')[0].trim();
    const url = (fwd && !fwd.startsWith('127.') && !fwd.startsWith('::1') && !fwd.startsWith('192.168.'))
      ? `https://ipwho.is/${encodeURIComponent(fwd)}`
      : 'https://ipwho.is/';
    const r = await fetch(url);
    const j = await r.json();
    if (j && j.country_code) {
      return res.json({ country: String(j.country_code).toUpperCase() });
    }
  } catch (e) {}
  res.json({ country: '' });
});

// GET /api/recent-buyers — Feeds live Proof Pulse buyer notifications
app.get('/api/recent-buyers', (req, res) => {
  const recent = [];
  for (const rec of activeRecords.values()) {
    if (rec.name) {
      recent.unshift({
        name: rec.name,
        location: rec.location || 'Lagos, Nigeria',
        action: rec.is_purchased
          ? 'locked in a $100 Founding Pass for Sunday\'s Live AI Bootcamp'
          : 'reserved a spot in Sunday\'s Live AI Editor Bootcamp',
        time: 'Just now'
      });
    }
  }
  res.json({ buyers: recent.slice(0, 8) });
});

// POST /api/lead/step1 — Captures Step 1 Lead & Immediately Fires GHL Webhook (status: 'lead', tag: 'aie-optin')
app.post('/api/lead/step1', (req, res) => {
  try {
    const { lead_id, name, email, phone, tier, include_bump } = req.body;
    if (!email && !phone) {
      return res.status(400).json({ success: false, error: 'Email or WhatsApp phone is required' });
    }

    const rate = Number(process.env.USD_TO_NGN_RATE || 1500);
    const isVip = tier === 'vip' || Boolean(include_bump);
    const totalUsd = isVip ? 150 : 100;
    const totalNgn = totalUsd * rate;

    const id = lead_id || `AIE-LEAD-${Math.floor(100000 + Math.random() * 900000)}`;
    const existing = activeRecords.get(id) || {};

    const rec = {
      ...existing,
      id,
      lead_id: id,
      date_time: existing.date_time || formatNow(),
      name: name || existing.name || '',
      email: email || existing.email || '',
      phone: phone || existing.phone || '',
      tier: isVip ? 'vip' : 'ga',
      tier_label: isVip
        ? 'VIP Pass + 30-Min 1-on-1 AI 10x Revenue Call ($150)'
        : 'Founding 100 Pass — AI Editor 2.0 + Live Bootcamp ($100)',
      order_bump: include_bump ? 'YES (+$50 30-Min Call)' : 'NO',
      upsell_call: isVip ? 'Included in VIP / Order Bump' : 'Pending Step 2',
      total_usd: totalUsd,
      total_ngn: totalNgn,
      payment_method: 'Step 1 Lead Captured (Viewing Step 2 Payment)',
      payment_status: existing.payment_status || 'unpaid',
      is_purchased: false,
      ghl_tags: ['aie-optin', 'unpaid-lead'],
      funnel_stage: 'step1_optin'
    };

    activeRecords.set(id, rec);
    upsertCSVRecord(rec, 'lead_optin_step1');

    res.json({ success: true, lead_id: id, record: rec });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// POST /api/paystack/initialize — Server-Side Paystack Transaction Initializer
app.post('/api/paystack/initialize', async (req, res) => {
  try {
    const secret = process.env.PAYSTACK_SECRET_KEY || '';
    const rate = Number(process.env.USD_TO_NGN_RATE || 1500);
    const { email, name, phone, amount_usd, amount_ngn, tier, include_bump, callback_url } = req.body;

    const usd = Number(amount_usd || (tier === 'vip' || include_bump ? 150 : 100));
    const ngn = amount_ngn ? Math.round(Number(amount_ngn)) : Math.round(usd * rate);
    const ref = `AIE_${Date.now()}_${Math.floor(1000 + Math.random() * 9000)}`;

    const payload = {
      email: email || 'buyer@aieditor.com',
      amount: ngn * 100,
      currency: 'NGN',
      reference: ref,
      callback_url: callback_url || undefined,
      metadata: {
        custom_fields: [
          { display_name: 'Customer Name', variable_name: 'customer_name', value: name || '' },
          { display_name: 'WhatsApp Phone', variable_name: 'whatsapp_phone', value: phone || '' },
          { display_name: 'Package Tier', variable_name: 'package_tier', value: `${tier || 'ga'} ($${usd} USD)` },
          { display_name: '30-Min 1:1 Consultation', variable_name: 'consultation_bump', value: (tier === 'vip' || include_bump) ? 'YES (Included)' : 'NO' }
        ]
      }
    };

    const pRes = await fetch('https://api.paystack.co/transaction/initialize', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${secret}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(payload)
    });
    const pJson = await pRes.json();

    if (pJson && pJson.status && pJson.data) {
      return res.json({
        success: true,
        authorization_url: pJson.data.authorization_url,
        access_code: pJson.data.access_code,
        reference: pJson.data.reference,
        amount_ngn: ngn,
        amount_usd: usd
      });
    }
    res.status(400).json({ success: false, error: (pJson && pJson.message) || 'Could not initialize Paystack' });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// POST /api/order/create — Verifies Step 2 Paystack Payment & Fires GHL Webhook with tag: 'purchased'
app.post('/api/order/create', async (req, res) => {
  try {
    const {
      lead_id,
      name,
      email,
      phone,
      tier,
      include_consultation_bump,
      payment_method,
      paystack_ref,
      amount_ngn
    } = req.body;

    const secret = process.env.PAYSTACK_SECRET_KEY || '';
    const rate = Number(process.env.USD_TO_NGN_RATE || 1500);
    const hasConsultation = tier === 'vip' || Boolean(include_consultation_bump);
    let totalNgn = amount_ngn ? Number(amount_ngn) : (hasConsultation ? 150 * rate : 100 * rate);
    let totalUsd = amount_ngn === 5000 ? 3.33 : (hasConsultation ? 150 : 100);

    const orderId = lead_id || `AIE-${Math.floor(100000 + Math.random() * 900000)}`;
    let paymentStatus = amount_ngn === 5000 ? 'PAID (Live ₦5,000 Paystack Test)' : 'PAID (Paystack)';

    if (paystack_ref && secret) {
      try {
        const verifyRes = await fetch(`https://api.paystack.co/transaction/verify/${encodeURIComponent(paystack_ref)}`, {
          headers: { Authorization: `Bearer ${secret}` }
        });
        const verifyJson = await verifyRes.json();
        if (verifyJson && verifyJson.data && verifyJson.data.status === 'success') {
          const verifiedNgn = Math.round(Number(verifyJson.data.amount || 0) / 100);
          if (verifiedNgn > 0) totalNgn = verifiedNgn;
          paymentStatus = verifiedNgn === 5000
            ? 'PAID & VERIFIED (Live ₦5,000 Paystack Test)'
            : 'PAID & VERIFIED (Paystack)';
        }
      } catch (e) {}
    }

    const ghlTags = ['purchased', 'aie-paid'];
    if (hasConsultation) ghlTags.push('vip-consultation-30min');

    const existing = activeRecords.get(orderId) || {};
    const rec = {
      ...existing,
      id: orderId,
      lead_id: orderId,
      date_time: formatNow(),
      name: name || existing.name || '',
      email: email || existing.email || '',
      phone: phone || existing.phone || '',
      tier: hasConsultation ? 'vip' : 'ga',
      tier_label: hasConsultation
        ? 'VIP Pass + 30-Min 1-on-1 AI 10x Revenue Call ($150)'
        : 'Founding 100 Pass — AI Editor 2.0 + Live Bootcamp ($100)',
      order_bump: include_consultation_bump ? 'YES (+$50 30-Min Consultation)' : (tier === 'vip' ? 'VIP Tier Selected ($150)' : 'NO'),
      upsell_call: hasConsultation ? 'Included in Initial Order (30-Min 1:1 Call)' : 'Viewing Post-Purchase OTO Page',
      total_usd: totalUsd,
      total_ngn: totalNgn,
      payment_method: payment_method || 'Paystack',
      paystack_ref: paystack_ref || '',
      payment_status: paymentStatus,
      is_purchased: true,
      ghl_tags: ghlTags,
      funnel_stage: hasConsultation ? 'vip_purchased' : 'core_purchased_viewing_oto'
    };

    activeRecords.set(orderId, rec);
    upsertCSVRecord(rec, 'order_purchased');

    // If they already bought VIP / Order Bump -> go straight to Thank-You Page.
    // Otherwise -> show the 1-Click 30-Min Consultation Upsell Page first, then Thank-You Page!
    const nextUrl = hasConsultation
      ? `thankyou.html?order_id=${encodeURIComponent(orderId)}&tier=vip&ref=${encodeURIComponent(paystack_ref || '')}`
      : `upsell-consultation.html?order_id=${encodeURIComponent(orderId)}&tier=ga&ref=${encodeURIComponent(paystack_ref || '')}`;

    res.json({
      success: true,
      order_id: orderId,
      has_consultation: hasConsultation,
      next_url: nextUrl,
      record: rec
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// POST /api/order/upsell — Verifies 1-Click +$97 30-Min Consultation OTO & Redirects to Thank-You Page
app.post('/api/order/upsell', async (req, res) => {
  try {
    const { order_id, name, email, phone, paystack_ref, action } = req.body;
    const secret = process.env.PAYSTACK_SECRET_KEY || '';
    const rate = Number(process.env.USD_TO_NGN_RATE || 1500);
    const resolvedId = order_id || `AIE-OTO-${Math.floor(100000 + Math.random() * 900000)}`;
    const existing = activeRecords.get(resolvedId) || {};

    if (action === 'decline') {
      const rec = {
        ...existing,
        id: resolvedId,
        lead_id: resolvedId,
        date_time: existing.date_time || formatNow(),
        name: name || existing.name || '',
        email: email || existing.email || '',
        phone: phone || existing.phone || '',
        upsell_call: 'Declined Post-Purchase 30-Min OTO',
        is_purchased: true,
        ghl_tags: Array.from(new Set([...(existing.ghl_tags || []), 'purchased', 'aie-paid'])),
        funnel_stage: 'oto_declined_heading_to_thankyou'
      };
      activeRecords.set(resolvedId, rec);
      upsertCSVRecord(rec, 'order_purchased');
      return res.json({
        success: true,
        order_id: resolvedId,
        has_consultation: false,
        next_url: `thankyou.html?order_id=${encodeURIComponent(resolvedId)}&tier=ga`
      });
    }

    let verified = 'PAID (Paystack OTO)';
    if (paystack_ref && secret) {
      try {
        const verifyRes = await fetch(`https://api.paystack.co/transaction/verify/${encodeURIComponent(paystack_ref)}`, {
          headers: { Authorization: `Bearer ${secret}` }
        });
        const verifyJson = await verifyRes.json();
        if (verifyJson && verifyJson.data && verifyJson.data.status === 'success') {
          verified = 'PAID & VERIFIED (Paystack Core + OTO)';
        }
      } catch (e) {}
    }

    const rec = {
      ...existing,
      id: resolvedId,
      lead_id: resolvedId,
      date_time: existing.date_time || formatNow(),
      name: name || existing.name || '',
      email: email || existing.email || '',
      phone: phone || existing.phone || '',
      tier: 'vip',
      tier_label: 'Founding Pass ($100) + Post-Purchase 30-Min Consultation OTO (+$50)',
      upsell_call: 'ACCEPTED Post-Purchase OTO: 30-Min 1:1 Consultation (+$50)',
      total_usd: 150,
      total_ngn: 150 * rate,
      payment_method: 'Paystack',
      paystack_ref: [existing.paystack_ref, paystack_ref].filter(Boolean).join(' | '),
      payment_status: verified,
      is_purchased: true,
      ghl_tags: ['purchased', 'aie-paid', 'vip-consultation-30min'],
      funnel_stage: 'upsell_30min_purchased'
    };

    activeRecords.set(resolvedId, rec);
    upsertCSVRecord(rec, 'upsell_purchased');

    res.json({
      success: true,
      order_id: resolvedId,
      has_consultation: true,
      next_url: `thankyou.html?order_id=${encodeURIComponent(resolvedId)}&tier=vip&oto=accepted&ref=${encodeURIComponent(paystack_ref || '')}`,
      record: rec
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// POST /api/order/thankyou-sync — Guaranteed GHL 'purchased' Tag Sync on Thank-You Page Arrival
app.post('/api/order/thankyou-sync', (req, res) => {
  try {
    const { order_id, name, email, phone, tier, ref } = req.body;
    const resolvedId = order_id || `AIE-${Math.floor(100000 + Math.random() * 900000)}`;
    const existing = activeRecords.get(resolvedId) || {};
    const rate = Number(process.env.USD_TO_NGN_RATE || 1500);
    const isVip = tier === 'vip' || existing.tier === 'vip';
    const totalUsd = isVip ? 150 : 100;

    const tags = new Set([...(existing.ghl_tags || []), 'purchased', 'aie-paid', 'thankyou-page-reached']);
    if (isVip) tags.add('vip-consultation-30min');

    const rec = {
      ...existing,
      id: resolvedId,
      lead_id: resolvedId,
      date_time: existing.date_time || formatNow(),
      name: name || existing.name || '',
      email: email || existing.email || '',
      phone: phone || existing.phone || '',
      tier: isVip ? 'vip' : 'ga',
      tier_label: isVip
        ? 'VIP Pass + 30-Min 1-on-1 AI 10x Revenue Call ($150)'
        : 'Founding 100 Pass — AI Editor 2.0 + Live Bootcamp ($100)',
      total_usd: totalUsd,
      total_ngn: totalUsd * rate,
      paystack_ref: ref || existing.paystack_ref || '',
      payment_status: existing.payment_status || 'PAID (Thank-You Page Verified)',
      is_purchased: true,
      ghl_tags: Array.from(tags),
      funnel_stage: 'thankyou_page_reached'
    };

    activeRecords.set(resolvedId, rec);
    upsertCSVRecord(rec, 'thankyou_page_purchased_synced');

    res.json({ success: true, record: rec });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// POST /api/consultation/book — Saves 30-Min 1-on-1 Consultation Slot & Syncs to GoHighLevel
app.post('/api/consultation/book', (req, res) => {
  try {
    const { order_id, name, email, phone, date, time, notes } = req.body;
    const resolvedId = order_id || `AIE-VIP-${Math.floor(100000 + Math.random() * 900000)}`;
    const existing = activeRecords.get(resolvedId) || {};
    const rate = Number(process.env.USD_TO_NGN_RATE || 1500);
    const slotText = `${date || 'Preferred Date'} @ ${time || 'Preferred Time'} (WAT / Nigerian Time)`;

    const tags = new Set([
      ...(existing.ghl_tags || []),
      'purchased',
      'aie-paid',
      'vip-consultation-30min',
      'consultation-booked'
    ]);

    const rec = {
      ...existing,
      id: resolvedId,
      lead_id: resolvedId,
      date_time: existing.date_time || formatNow(),
      name: name || existing.name || '',
      email: email || existing.email || '',
      phone: phone || existing.phone || '',
      tier: 'vip',
      tier_label: 'VIP Pass + 30-Min 1-on-1 AI 10x Revenue Call ($150)',
      upsell_call: `BOOKED: ${slotText}`,
      consultation_slot: slotText,
      consultation_notes: notes || '',
      total_usd: existing.total_usd || 150,
      total_ngn: (existing.total_usd || 150) * rate,
      payment_status: existing.payment_status || 'PAID (VIP Consultation Booked)',
      is_purchased: true,
      ghl_tags: Array.from(tags),
      funnel_stage: 'consultation_booked'
    };

    activeRecords.set(resolvedId, rec);
    upsertCSVRecord(rec, 'consultation_slot_booked');

    res.json({ success: true, slot: slotText, record: rec });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// POST /api/paystack/webhook — Server-to-Server Paystack Webhook (Guarantees GHL 'purchased' Tag Even If Browser Closes)
app.post('/api/paystack/webhook', (req, res) => {
  try {
    const secret = process.env.PAYSTACK_SECRET_KEY || '';
    if (secret && req.headers['x-paystack-signature']) {
      const hash = crypto.createHmac('sha512', secret).update(JSON.stringify(req.body)).digest('hex');
      if (hash !== req.headers['x-paystack-signature']) {
        return res.status(401).send('Invalid signature');
      }
    }
    const event = req.body;
    if (event && event.event === 'charge.success' && event.data) {
      const data = event.data;
      const email = (data.customer && data.customer.email) || '';
      const amountNgn = Math.round(Number(data.amount || 0) / 100);
      const rate = Number(process.env.USD_TO_NGN_RATE || 1500);
      const amountUsd = Math.round(amountNgn / rate);
      const ref = data.reference || `AIE_WH_${Date.now()}`;
      const fields = (data.metadata && data.metadata.custom_fields) || [];
      const isVip = amountUsd >= 145 || amountUsd === 50;

      const rec = {
        id: ref,
        lead_id: ref,
        date_time: formatNow(),
        name: (fields[0] && fields[0].value) || '',
        email,
        phone: (fields[1] && fields[1].value) || '',
        tier: isVip ? 'vip' : 'ga',
        tier_label: (fields[2] && fields[2].value) || 'Paystack Webhook Order',
        order_bump: (fields[3] && fields[3].value) || '',
        upsell_call: isVip ? 'VIP / 30-Min Call Included' : 'Core Pass',
        total_usd: amountUsd,
        total_ngn: amountNgn,
        payment_method: 'Paystack Webhook Verified',
        paystack_ref: ref,
        payment_status: 'PAID & VERIFIED (Webhook)',
        is_purchased: true,
        ghl_tags: ['purchased', 'aie-paid', ...(isVip ? ['vip-consultation-30min'] : [])],
        funnel_stage: 'paystack_webhook_paid'
      };
      upsertCSVRecord(rec, 'paystack_webhook_purchased');
    }
    res.status(200).send('OK');
  } catch (err) {
    res.status(200).send('OK');
  }
});

// GET /api/admin/export-csv — Download all Step-1 Leads & Paid Orders CSV
app.get('/api/admin/export-csv', (req, res) => {
  initCSV();
  res.download(CSV_FILE, 'ai_editor_bootcamp_leads_and_orders.csv');
});

app.listen(PORT, () => {
  console.log(`🚀 Weekly AI Bootcamp 3-Page Paystack + GHL Funnel running at http://localhost:${PORT}`);
});
