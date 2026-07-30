// Brevo (Sendinblue) transactional email sender.
// Configure via env: BREVO_API_KEY, BREVO_SENDER (verified sender address),
// optional BREVO_SENDER_NAME. Until those are set, sendEmail() is a safe no-op
// so the rest of the app keeps working.
const API_URL = 'https://api.brevo.com/v3/smtp/email';

function configured() {
  return !!(process.env.BREVO_API_KEY && process.env.BREVO_SENDER);
}

// Returns { ok, reason, status, body, messageId } so callers can report *why* a
// send failed. sendEmail() below keeps the plain boolean contract.
async function sendEmailVerbose({ to, toName, subject, html }) {
  if (!configured()) {
    console.log('[email] BREVO not configured — skipping send:', subject);
    return { ok: false, reason: 'not_configured' };
  }
  if (!to) return { ok: false, reason: 'no_recipient' };
  try {
    const r = await fetch(API_URL, {
      method: 'POST',
      headers: {
        'api-key': process.env.BREVO_API_KEY,
        'Content-Type': 'application/json',
        'Accept': 'application/json',
      },
      body: JSON.stringify({
        sender: { email: process.env.BREVO_SENDER, name: process.env.BREVO_SENDER_NAME || 'ETW Journal' },
        to: [{ email: to, name: toName || to }],
        subject,
        htmlContent: html,
      }),
    });
    const body = await r.text().catch(() => '');
    if (!r.ok) {
      console.error('[email] Brevo error', r.status, body.slice(0, 300));
      return { ok: false, reason: 'brevo_rejected', status: r.status, body: body.slice(0, 300) };
    }
    // Brevo hands back a messageId on success — worth logging so a send can be
    // traced in their dashboard when the recipient still reports nothing.
    let messageId = null;
    try { messageId = (JSON.parse(body) || {}).messageId || null; } catch (e) {}
    console.log('[email] sent to', to, '| subject:', subject, '| messageId:', messageId || '(none)');
    return { ok: true, status: r.status, messageId };
  } catch (e) {
    console.error('[email] send failed:', e.message);
    return { ok: false, reason: 'network', body: e.message };
  }
}

async function sendEmail(opts) {
  const r = await sendEmailVerbose(opts);
  return !!r.ok;
}

// ── Contacts (for campaigns / segments) ────────────────────────────────
// Transactional sends above don't need a contact to exist. This is only so the
// Brevo audience mirrors the app: with PLAN / EXPIRES_AT on each contact you can
// build segments like "Essential, expiring within 7 days" and send a campaign
// from the dashboard without exporting anything by hand.
//
// BREVO_LIST_ID may be a single id or a comma-separated list. Without it the
// contact is still created, just not added to any list.
const CONTACTS_URL = 'https://api.brevo.com/v3/contacts';

function listIdsFromEnv() {
  return String(process.env.BREVO_LIST_ID || '')
    .split(',').map((s) => parseInt(s.trim(), 10)).filter((n) => !isNaN(n) && n > 0);
}

async function upsertContact({ email: addr, attributes, listIds }) {
  if (!configured() || !addr) return false;
  const lists = (listIds && listIds.length) ? listIds : listIdsFromEnv();
  try {
    const r = await fetch(CONTACTS_URL, {
      method: 'POST',
      headers: {
        'api-key': process.env.BREVO_API_KEY,
        'Content-Type': 'application/json',
        'Accept': 'application/json',
      },
      // updateEnabled makes this an upsert — Brevo 400s on a duplicate without it.
      body: JSON.stringify({
        email: addr,
        attributes: attributes || {},
        updateEnabled: true,
        ...(lists.length ? { listIds: lists } : {}),
      }),
    });
    if (!r.ok) {                       // 201 = created, 204 = updated
      const t = await r.text().catch(() => '');
      console.error('[email] Brevo contact error', r.status, t.slice(0, 200));
      return false;
    }
    return true;
  } catch (e) {
    console.error('[email] contact upsert failed:', e.message);
    return false;
  }
}

module.exports = { sendEmail, sendEmailVerbose, configured, upsertContact, listIdsFromEnv };
