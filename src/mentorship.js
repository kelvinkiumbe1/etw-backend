// ── ETW University: 1-on-1 mentorship, server-enforced ─────────────────────
// Booking and cancelling run HERE, not in the client, so none of it can be
// bypassed with dev tools:
//   • Pro plan verified with access.assertAccess (fresh claims, same source
//     of truth as /api/subscribe/me)
//   • one-session-per-calendar-month + one-upcoming-at-a-time enforced inside
//     a Firestore transaction
//   • mentors are notified by Web Push (FCM) AND email the moment a booking
//     lands, even with the portal closed
//   • a sweep runs every minute and sends a ~1-hour reminder (push + email)
//     to both mentor and student
//
// Wire-up (server.js):  require('./src/mentorship').mount(app, requireAuth, db);
const { admin } = require('./firebaseAdmin');
const access = require('./access');
const email = require('./email');

let db = null;
const SITE = (process.env.ETW_SITE_URL || 'https://etwiz.space').replace(/\/$/, '');
const DAY_NAMES = { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' };

const monthKey = (ms) => { const d = new Date(ms); return d.getUTCFullYear() + '-' + d.getUTCMonth(); };
const fmtWhen = (ms) => new Date(ms).toLocaleString('en-GB', DAY_NAMES) + ' UTC';

// ── Web Push (FCM). Tokens are saved by the pages into pushTokens/{uid}. ──
async function pushTo(uid, title, body, path) {
  if (!uid) return;
  try {
    const snap = await db.collection('pushTokens').doc(uid).get();
    const token = snap.exists && snap.data().token;
    if (!token) return;
    await admin.messaging().send({
      token,
      notification: { title, body },
      webpush: {
        fcmOptions: { link: SITE + (path || '/etw-university.html') },
        notification: { icon: SITE + '/etw-logo-192.png' },
      },
    });
  } catch (e) {
    // Uninstalled/rotated token — forget it so we stop hitting it.
    if (e && (e.code === 'messaging/registration-token-not-registered'
           || e.code === 'messaging/invalid-argument')) {
      db.collection('pushTokens').doc(uid).delete().catch(() => {});
    } else console.warn('[mentorship] push:', e.message);
  }
}

// ── Email (Brevo — no-ops gracefully if not configured) ──────────────────
function mailHtml(lines) {
  return '<div style="font-family:sans-serif;line-height:1.6;color:#222">'
    + lines.map((l) => '<p>' + l + '</p>').join('')
    + '<p style="color:#888;font-size:12px">ETW University · 1-on-1 mentorship</p></div>';
}
async function emailTo(addr, name, subject, lines) {
  if (!addr) return;
  email.sendEmail({ to: addr, toName: name || '', subject, html: mailHtml(lines) }).catch(() => {});
}

async function mentorContact(mentorUid) {
  try {
    const m = await db.collection('mentors').doc(mentorUid).get();
    return m.exists ? { email: m.data().email || '', name: m.data().name || 'Mentor' } : { email: '', name: 'Mentor' };
  } catch (e) { return { email: '', name: 'Mentor' }; }
}

// ── WHO IS A MENTOR ────────────────────────────────────────────────
// Managed entirely from Render: set the MENTOR_EMAILS env var to a
// comma-separated list (e.g. "a@x.com, b@y.com"). Editing it restarts
// the service — no frontend re-upload needed.
function mentorEmails() {
  return String(process.env.MENTOR_EMAILS || '')
    .split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
}

function mount(app, requireAuth, database) {
  db = database;

  // Mirror the mentor list into Firestore so the security rules can also
  // enforce it (clients can't read or write this doc; rules use get()).
  db.collection('etwConfig').doc('mentors')
    .set({ emails: mentorEmails(), updatedAt: Date.now() })
    .then(() => console.log('[mentorship] mentor list synced (' + mentorEmails().length + ' mentors)'))
    .catch((e) => console.warn('[mentorship] mentor list sync failed:', e.message));

  // ── Is the signed-in user a mentor? (drives which UI the page shows) ──
  app.get('/api/mentorship/is-mentor', requireAuth, (req, res) => {
    const em = String(req.token.email || '').toLowerCase();
    res.json({ mentor: mentorEmails().includes(em) });
  });

  // ── BOOK — Pro only, one per calendar month, one upcoming at a time ──
  app.post('/api/mentorship/book', requireAuth, async (req, res) => {
    const uid = req.uid;
    const slotId = String((req.body && req.body.slotId) || '');
    if (!slotId) return res.status(400).json({ error: 'slotId required' });

    try {
      await access.assertAccess(uid, { pro: true });   // throws 402 pro_required
    } catch (e) {
      return res.status(e.status || 402).json({ error: '1-on-1 mentorship is on the Pro plan. Upgrade to book a session.' });
    }

    try {
      const slotRef = db.collection('mentorSlots').doc(slotId);
      const booked = await db.runTransaction(async (tx) => {
        const snap = await tx.get(slotRef);
        if (!snap.exists) throw { status: 404, msg: 'That slot no longer exists.' };
        const slot = snap.data();
        if (slot.status !== 'open') throw { status: 409, msg: 'Sorry — that time was just taken. Pick another.' };
        if (!(slot.startMs > Date.now())) throw { status: 409, msg: 'That time is already in the past.' };
        if (slot.mentorUid === uid) throw { status: 400, msg: 'You cannot book your own slot.' };

        const mine = await tx.get(db.collection('mentorSlots').where('studentUid', '==', uid));
        for (const d of mine.docs) {
          const s = d.data();
          if (s.status === 'booked' && s.startMs + ((s.durationMin || 45) + 15) * 60000 > Date.now())
            throw { status: 409, msg: 'You already have an upcoming session booked — one at a time.' };
          if ((s.status === 'booked' || s.status === 'done') && monthKey(s.startMs) === monthKey(slot.startMs))
            throw { status: 409, msg: 'Your Pro plan includes one session per month, and this month\'s is used. You can book again next month.' };
        }

        tx.update(slotRef, {
          status: 'booked',
          studentUid: uid,
          studentName: req.token.name || req.token.email || 'Student',
          studentEmail: req.token.email || '',
          bookedAt: Date.now(),
          reminderSent: false,
        });
        return slot;
      });

      // Notify the mentor right away — push + email, works with the portal closed.
      const student = req.token.name || req.token.email || 'A student';
      const when = fmtWhen(booked.startMs);
      pushTo(booked.mentorUid, 'New mentorship booking', student + ' booked your ' + when + ' slot.', '/mentor-portal.html');
      mentorContact(booked.mentorUid).then(({ email: addr, name }) => emailTo(addr, name,
        'New ETW University booking — ' + when,
        ['<b>' + student + '</b> just booked your <b>' + when + '</b> slot ('
          + (booked.durationMin || 45) + ' min).',
         'Open your <a href="' + SITE + '/mentor-portal.html">mentor portal</a> to see the details. The session runs on the built-in video call and ends automatically when the time is up.']));

      res.json({ ok: true });
    } catch (e) {
      if (e && e.status) return res.status(e.status).json({ error: e.msg });
      console.error('[mentorship] book:', e.message || e);
      res.status(500).json({ error: 'Booking failed — please try again.' });
    }
  });

  // ── CANCEL — the booking student only, ≥60 min before start ──
  app.post('/api/mentorship/cancel', requireAuth, async (req, res) => {
    const uid = req.uid;
    const slotId = String((req.body && req.body.slotId) || '');
    if (!slotId) return res.status(400).json({ error: 'slotId required' });
    try {
      const slotRef = db.collection('mentorSlots').doc(slotId);
      const info = await db.runTransaction(async (tx) => {
        const snap = await tx.get(slotRef);
        if (!snap.exists) throw { status: 404, msg: 'Booking not found.' };
        const s = snap.data();
        if (s.studentUid !== uid || s.status !== 'booked') throw { status: 403, msg: 'This is not your booking.' };
        if (s.startMs - Date.now() < 60 * 60000) throw { status: 409, msg: 'Sessions can\'t be cancelled less than 1 hour before the start.' };
        tx.update(slotRef, { status: 'open', studentUid: null, studentName: null, studentEmail: null, bookedAt: null, reminderSent: null });
        return s;
      });
      const when = fmtWhen(info.startMs);
      pushTo(info.mentorUid, 'Booking cancelled', (info.studentName || 'Your student') + ' cancelled the ' + when + ' session. The slot is open again.', '/mentor-portal.html');
      mentorContact(info.mentorUid).then(({ email: addr, name }) => emailTo(addr, name,
        'Booking cancelled — ' + when,
        [(info.studentName || 'Your student') + ' cancelled the <b>' + when + '</b> session.',
         'The slot is open for other students again.']));
      res.json({ ok: true });
    } catch (e) {
      if (e && e.status) return res.status(e.status).json({ error: e.msg });
      console.error('[mentorship] cancel:', e.message || e);
      res.status(500).json({ error: 'Cancel failed — please try again.' });
    }
  });

  // ── 1-HOUR REMINDER SWEEP (push + email, both participants) ──
  // Range query on startMs only — no composite index needed.
  async function reminderSweep() {
    try {
      const now = Date.now();
      const qs = await db.collection('mentorSlots')
        .where('startMs', '>=', now + 54 * 60000)
        .where('startMs', '<=', now + 70 * 60000)
        .get();
      for (const d of qs.docs) {
        const s = d.data();
        if (s.status !== 'booked' || s.reminderSent) continue;
        await d.ref.update({ reminderSent: true });
        const mins = Math.round((s.startMs - now) / 60000);
        const when = fmtWhen(s.startMs);

        pushTo(s.mentorUid, 'Session in ' + mins + ' minutes',
          'Your session with ' + (s.studentName || 'a student') + ' starts soon (' + when + ').', '/mentor-portal.html');
        mentorContact(s.mentorUid).then(({ email: addr, name }) => emailTo(addr, name,
          'Reminder: mentorship session in ' + mins + ' minutes',
          ['Your session with <b>' + (s.studentName || 'a student') + '</b> starts at <b>' + when + '</b>.',
           'Join from your <a href="' + SITE + '/mentor-portal.html">mentor portal</a> — the Join button unlocks 10 minutes before.']));

        pushTo(s.studentUid, 'Session in ' + mins + ' minutes',
          'Your session with ' + (s.mentorName || 'your mentor') + ' starts soon (' + when + ').', '/etw-university.html');
        if (s.studentEmail) emailTo(s.studentEmail, s.studentName,
          'Reminder: your mentorship session is in ' + mins + ' minutes',
          ['Your session with <b>' + (s.mentorName || 'your mentor') + '</b> starts at <b>' + when + '</b>.',
           'Join from <a href="' + SITE + '/etw-university.html">ETW University</a> — the Join button unlocks 10 minutes before.']);
      }
    } catch (e) { console.warn('[mentorship] sweep:', e.message); }
  }
  setInterval(reminderSweep, 60 * 1000);
  reminderSweep();

  console.log('[mentorship] ETW University endpoints mounted (+ 1h reminder sweep)');
}

module.exports = { mount };
