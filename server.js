/**
 * Zaemu Cafe — Express Backend
 *  - Serves index.html
 *  - REST API for persistent data (data.json)
 *  - SSE endpoint → pushes real-time events to browser
 *  - Retell webhook handlers (call events + function calling)
 *  - Proxy to Retell API (avoids CORS + keeps API key server-side)
 */

const express    = require('express');
const cors       = require('cors');
const fs         = require('fs');
const path       = require('path');
const crypto     = require('crypto');
const nodemailer = require('nodemailer');

const app  = express();
const PORT = process.env.PORT || 3000;
const DATA_FILE = path.join(__dirname, 'data.json');

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname)));  // serve index.html

// ─────────────────────────────────────────────────
//  DATA HELPERS
// ─────────────────────────────────────────────────
function readData() {
  try {
    return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
  } catch {
    return { orders: [], bookings: [], profiles: [], feedback: [], settings: {} };
  }
}

function writeData(data) {
  fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
}

// ─────────────────────────────────────────────────
//  SERVER-SENT EVENTS  (real-time push to browser)
// ─────────────────────────────────────────────────
let sseClients = [];

app.get('/api/events', (req, res) => {
  res.setHeader('Content-Type',  'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection',    'keep-alive');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.flushHeaders();

  // heartbeat every 25 s to keep connection alive through proxies
  const hb = setInterval(() => res.write(': heartbeat\n\n'), 25000);

  sseClients.push(res);
  req.on('close', () => {
    clearInterval(hb);
    sseClients = sseClients.filter(c => c !== res);
  });
});

function broadcast(eventName, payload) {
  const msg = `event: ${eventName}\ndata: ${JSON.stringify(payload)}\n\n`;
  sseClients.forEach(c => c.write(msg));
  console.log(`[SSE] broadcast "${eventName}" → ${sseClients.length} client(s)`);
}

// ─────────────────────────────────────────────────
//  DATA API
// ─────────────────────────────────────────────────
app.get('/api/data', (_req, res) => res.json(readData()));

app.post('/api/data', (req, res) => {
  const current = readData();
  const updated = { ...current, ...req.body };
  writeData(updated);
  res.json({ success: true });
});

// Save / load settings (Retell + Gmail)
app.post('/api/settings', (req, res) => {
  const data = readData();
  data.settings = { ...data.settings, ...req.body };
  writeData(data);
  // Rebuild mailer if Gmail creds changed
  if (req.body.gmailUser || req.body.gmailAppPass) buildMailer(data.settings);
  res.json({ success: true });
});

app.get('/api/settings', (_req, res) => {
  const s = readData().settings || {};
  // Never expose the app password to the browser
  const safe = { ...s };
  if (safe.gmailAppPass) safe.gmailAppPass = '••••••••';
  res.json(safe);
});

// ─────────────────────────────────────────────────
//  GMAIL — nodemailer
// ─────────────────────────────────────────────────
let mailer = null;

function buildMailer(settings) {
  // Prefer environment variables (for cloud deployment), fall back to data.json settings
  const user = process.env.GMAIL_USER || settings?.gmailUser;
  const pass = process.env.GMAIL_PASS || settings?.gmailAppPass;
  if (!user || !pass || pass === '••••••••') return;
  mailer = nodemailer.createTransport({
    service: 'gmail',
    auth: { user, pass },
  });
  console.log(`[Gmail] mailer configured for ${user}`);
}

// Build on startup with saved settings (env vars take priority)
buildMailer(readData().settings || {});

async function sendBookingEmails(booking, settings) {
  if (!mailer) return;
  const owner = settings?.gmailUser;
  if (!owner) return;

  const subject = `🐉 New Booking ${booking.id} — ${booking.customer}`;
  const htmlBody = `
    <div style="font-family:sans-serif;max-width:520px;margin:0 auto">
      <div style="background:#8B1A1A;padding:20px;border-radius:10px 10px 0 0;text-align:center">
        <h1 style="color:#C9A84C;margin:0;font-size:24px">🍽️ Zaemu Cafe</h1>
        <p style="color:rgba(255,255,255,0.8);margin:4px 0 0;font-size:13px">Authentic Bhutanese Cuisine · Thimphu</p>
      </div>
      <div style="background:#fff;padding:24px;border:1px solid #e0d0b0;border-top:none">
        <h2 style="color:#8B1A1A;margin-top:0">
          ${booking.source?.includes('AI') ? '🤖 AI Receptionist Booking' : '📅 New Table Reservation'}
        </h2>
        <table style="width:100%;border-collapse:collapse;font-size:14px">
          <tr style="background:#FFF8EE"><td style="padding:8px;font-weight:700;border:1px solid #e8d9b8;width:40%">Booking ID</td><td style="padding:8px;border:1px solid #e8d9b8"><strong style="color:#C9A84C">${booking.id}</strong></td></tr>
          <tr><td style="padding:8px;font-weight:700;border:1px solid #e8d9b8">Customer</td><td style="padding:8px;border:1px solid #e8d9b8">${booking.customer}</td></tr>
          <tr style="background:#FFF8EE"><td style="padding:8px;font-weight:700;border:1px solid #e8d9b8">Phone</td><td style="padding:8px;border:1px solid #e8d9b8">${booking.phone || '—'}</td></tr>
          <tr><td style="padding:8px;font-weight:700;border:1px solid #e8d9b8">Date</td><td style="padding:8px;border:1px solid #e8d9b8">${booking.reservedDate}</td></tr>
          <tr style="background:#FFF8EE"><td style="padding:8px;font-weight:700;border:1px solid #e8d9b8">Time</td><td style="padding:8px;border:1px solid #e8d9b8">${booking.timeSlot}</td></tr>
          <tr><td style="padding:8px;font-weight:700;border:1px solid #e8d9b8">Guests</td><td style="padding:8px;border:1px solid #e8d9b8">${booking.guests}</td></tr>
          <tr style="background:#FFF8EE"><td style="padding:8px;font-weight:700;border:1px solid #e8d9b8">Table</td><td style="padding:8px;border:1px solid #e8d9b8">${booking.table}</td></tr>
          ${booking.note ? `<tr><td style="padding:8px;font-weight:700;border:1px solid #e8d9b8">Notes</td><td style="padding:8px;border:1px solid #e8d9b8">${booking.note}</td></tr>` : ''}
          <tr style="background:#FFF8EE"><td style="padding:8px;font-weight:700;border:1px solid #e8d9b8">Source</td><td style="padding:8px;border:1px solid #e8d9b8">${booking.source || 'Manual'}</td></tr>
        </table>
      </div>
      <div style="background:#2C1810;padding:14px;border-radius:0 0 10px 10px;text-align:center">
        <p style="color:rgba(255,255,255,0.6);margin:0;font-size:12px">Zaemu Cafe · Thimphu, Bhutan · +975-2-123456</p>
      </div>
    </div>`;

  try {
    // Notify cafe owner
    await mailer.sendMail({
      from:    `"🍽️ Zaemu Cafe" <${owner}>`,
      to:      owner,
      subject,
      html:    htmlBody,
    });
    console.log(`[Gmail] Owner notification sent → ${owner}`);

    // Confirmation to customer (if they have an email-like phone — skip if phone only)
    const custEmail = booking.customerEmail;
    if (custEmail && custEmail.includes('@')) {
      await mailer.sendMail({
        from:    `"🍽️ Zaemu Cafe" <${owner}>`,
        to:      custEmail,
        subject: `✅ Booking Confirmed — ${booking.id} | Zaemu Cafe`,
        html:    htmlBody.replace('New Table Reservation', 'Your Booking is Confirmed!'),
      });
      console.log(`[Gmail] Customer confirmation sent → ${custEmail}`);
    }
  } catch (err) {
    console.error('[Gmail] Send error:', err.message);
  }
}

// Email notification for manually-created bookings
app.post('/api/notify-booking', (req, res) => {
  const { bookingId } = req.body;
  const data = readData();
  const booking = data.bookings.find(b => b.id === bookingId);
  if (!booking) return res.status(404).json({ error: 'Booking not found' });
  sendBookingEmails(booking, data.settings)
    .then(() => res.json({ success: true }))
    .catch(e  => res.status(500).json({ error: e.message }));
});

// Test Gmail
app.post('/api/test-gmail', async (req, res) => {
  const data = readData();
  if (!mailer) {
    // Try building with request body creds first
    if (req.body.gmailUser && req.body.gmailAppPass) {
      buildMailer(req.body);
    } else {
      return res.status(400).json({ error: 'Gmail not configured. Save your App Password first.' });
    }
  }
  try {
    const owner = data.settings?.gmailUser || req.body.gmailUser;
    await mailer.sendMail({
      from:    `"🍽️ Zaemu Cafe" <${owner}>`,
      to:      owner,
      subject: '✅ Zaemu Cafe — Gmail test successful!',
      html:    '<h2 style="color:#8B1A1A">🍽️ Zaemu Cafe Gmail is connected!</h2><p>Email notifications are working correctly. Kadrinchhe!</p>',
    });
    res.json({ success: true, message: `Test email sent to ${owner}` });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─────────────────────────────────────────────────
//  GENERIC EMAIL SEND  (invoice, gift card, etc.)
//  POST /api/send-email { to, subject, html, cc? }
// ─────────────────────────────────────────────────
app.post('/api/send-email', async (req, res) => {
  const { to, subject, html, cc } = req.body;
  if (!to || !subject || !html) {
    return res.status(400).json({ error: 'Missing required fields: to, subject, html' });
  }
  if (!mailer) {
    return res.status(503).json({ error: 'Gmail not configured. Save your Gmail App Password in Cafe Settings first.' });
  }
  const data  = readData();
  const owner = data.settings?.gmailUser || '';
  try {
    const mailOpts = {
      from:    `"🍽️ Zaemu Cafe" <${owner}>`,
      to,
      subject,
      html,
    };
    if (cc) mailOpts.cc = cc;
    await mailer.sendMail(mailOpts);
    console.log(`[Email] Sent "${subject}" → ${to}`);
    res.json({ success: true, message: `Email sent to ${to}` });
  } catch (err) {
    console.error('[Email] Send error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────────
//  PROXY → RETELL "CREATE WEB CALL"
//  Keeps the API key on the server side.
// ─────────────────────────────────────────────────
app.post('/api/create-web-call', async (req, res) => {
  const data    = readData();
  const apiKey  = req.body.apiKey  || data.settings?.retellApiKey;
  const agentId = req.body.agentId || data.settings?.retellAgentId;

  if (!apiKey || !agentId) {
    return res.status(400).json({ error: 'Retell API Key and Agent ID are required.' });
  }

  try {
    const r = await fetch('https://api.retellai.com/v2/create-web-call', {
      method:  'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type':  'application/json',
      },
      body: JSON.stringify({ agent_id: agentId }),
    });
    const json = await r.json();
    if (!r.ok) throw new Error(json.message || JSON.stringify(json));
    console.log(`[Retell] web-call created: ${json.call_id}`);
    res.json(json);
  } catch (err) {
    console.error('[Retell] create-web-call error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────────
//  RETELL FUNCTION-CALL WEBHOOK
//  Retell hits this URL when the AI calls a function
//  during the live call (real-time booking creation).
//
//  In your Retell agent → LLM settings, set
//  "Custom LLM webhook URL" or add these as
//  "Custom Tools" pointing to this endpoint.
// ─────────────────────────────────────────────────
app.post('/retell-function', (req, res) => {
  const { function_name, arguments: args = {}, call } = req.body;
  console.log(`[Retell Function] ${function_name}`, args);

  if (function_name === 'create_booking') {
    const id = 'AI-' + crypto.randomBytes(3).toString('hex').toUpperCase();
    const booking = {
      id,
      date:         new Date().toISOString(),
      customer:     args.customer_name   || 'Guest',
      phone:        args.phone_number    || '',
      reservedDate: args.date            || new Date().toISOString().split('T')[0],
      timeSlot:     args.time_slot       || '12:00',
      guests:       args.number_of_guests|| '2 Persons',
      table:        args.table_preference|| 'No Preference',
      note:         args.special_requests|| '',
      status:       'Confirmed',
      source:       '🤖 AI Receptionist',
      callId:       call?.call_id        || '',
    };

    const data = readData();
    data.bookings.push(booking);
    writeData(data);
    broadcast('new_booking', booking);
    console.log(`[Booking] Created ${id} via AI for ${booking.customer}`);
    sendBookingEmails(booking, data.settings).catch(() => {});

    return res.json({
      result: `Booking confirmed! Your reservation ID is ${id}. ` +
              `Table reserved for ${booking.customer} on ${booking.reservedDate} ` +
              `at ${booking.timeSlot} for ${booking.guests}. ` +
              `We look forward to welcoming you at Zaemu Cafe. Kadrinchhe!`,
    });
  }

  if (function_name === 'check_availability') {
    // In a real system you'd check actual slot occupancy
    const date = args.date || 'requested date';
    const time = args.time_slot || 'requested time';
    return res.json({
      result: `Yes, we have tables available on ${date} at ${time}. Shall I reserve one for you?`,
    });
  }

  if (function_name === 'get_menu_highlights') {
    return res.json({
      result:
        'Our signature dishes include: Ema Datshi (chilli cheese curry, Nu.150) — the national dish of Bhutan; ' +
        'Phaksha Paa (pork with red chillies, Nu.200); Jasha Maroo (spiced minced chicken, Nu.180); ' +
        'Beef Momos (dumplings, Nu.90); Hoentoe (Haa Valley half-moon dumplings, Nu.110); ' +
        'Juma sausage (Nu.160); Bathup thick noodle stew (Nu.110); ' +
        'and Suja butter tea (Nu.40). All dishes are authentic Bhutanese recipes.',
    });
  }

  if (function_name === 'get_cafe_info') {
    return res.json({
      result:
        'Zaemu Cafe is located in Thimphu, Bhutan. We are open daily from 7:00 AM to 10:00 PM. ' +
        'Phone: +975-2-123456. We offer dine-in, takeaway, and delivery. ' +
        'We specialize in 100% authentic Bhutanese cuisine.',
    });
  }

  // Fallback for unknown functions
  res.json({ result: 'I have noted that request. Is there anything else I can help you with?' });
});

// ─────────────────────────────────────────────────
//  RETELL POST-CALL WEBHOOK  (call_ended / analyzed)
//  Optional — Retell calls this after the call ends.
//  Configure in Retell Dashboard → Agent → Webhook URL
// ─────────────────────────────────────────────────
app.post('/retell-webhook', (req, res) => {
  const { event, data: callData } = req.body;
  console.log(`[Retell Webhook] event="${event}"`, callData?.call_id || '');

  if (event === 'call_ended') {
    broadcast('call_ended', {
      callId:   callData?.call_id,
      duration: callData?.duration_ms,
      summary:  callData?.call_analysis?.call_summary || '',
    });
  }

  if (event === 'call_started') {
    broadcast('call_started', { callId: callData?.call_id });
  }

  res.json({ received: true });
});

// ─────────────────────────────────────────────────
//  START
// ─────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log('');
  console.log('  🐉  Zaemu Cafe server running');
  console.log(`  👉  http://localhost:${PORT}`);
  console.log('');
  console.log('  Retell endpoints:');
  console.log(`  • Function webhook : http://localhost:${PORT}/retell-function`);
  console.log(`  • Post-call webhook: http://localhost:${PORT}/retell-webhook`);
  console.log(`  • SSE events       : http://localhost:${PORT}/api/events`);
  console.log('');
});
