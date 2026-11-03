// Turns raw MT5 deals (from MetaApi) into the SAME Firestore "trades" document
// shape the ETW frontend already reads (matched to the app's mt5-live flow and
// CSV importer). MT5 records two+ "deals" per position (entry IN, exit OUT); we
// group them by positionId into one closed round-trip trade.

// Identical boundaries to the frontend's getSessionFromTime() in journal.html.
function getSessionFromTime(ms) {
  const h = new Date(ms).getUTCHours();
  if (h >= 22 || h < 2) return 'Asian';
  if (h >= 2 && h < 5)  return 'London';
  if (h >= 7 && h < 12) return 'New York';
  if (h >= 12 && h < 15) return 'London/NY';
  return 'Other';
}

function r2(n) { return Math.round(((+n || 0) + Number.EPSILON) * 100) / 100; }
function ms(t) { return new Date(t).getTime(); }

function buildTradesFromDeals(deals, { uid, accountId }) {
  const groups = new Map();
  for (const d of deals || []) {
    if (!d || d.positionId == null) continue;                 // skip balance/credit ops
    if (d.type !== 'DEAL_TYPE_BUY' && d.type !== 'DEAL_TYPE_SELL') continue;
    const k = String(d.positionId);
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(d);
  }

  const trades = [];
  for (const [posId, ds] of groups) {
    ds.sort((a, b) => ms(a.time) - ms(b.time));
    const ins  = ds.filter(d => d.entryType === 'DEAL_ENTRY_IN'  || d.entryType === 'DEAL_ENTRY_INOUT');
    const outs = ds.filter(d => d.entryType === 'DEAL_ENTRY_OUT' || d.entryType === 'DEAL_ENTRY_OUT_BY');
    if (!ins.length || !outs.length) continue;                // not a completed round-trip yet (still open)

    const first = ins[0];
    const last  = outs[outs.length - 1];
    const direction = first.type === 'DEAL_TYPE_BUY' ? 'LONG' : 'SHORT';
    const lot        = ins.reduce((s, d) => s + (d.volume || 0), 0);
    const swap       = ds.reduce((s, d) => s + (d.swap || 0), 0);
    const commission = ds.reduce((s, d) => s + (d.commission || 0), 0);
    const pnl        = ds.reduce((s, d) => s + (d.profit || 0) + (d.swap || 0) + (d.commission || 0), 0);
    const openMs  = ms(first.time);
    const closeMs = ms(last.time);
    const p = r2(pnl);

    trades.push({
      uid,
      pair:        first.symbol || '',
      direction,
      entry:       first.price != null ? String(first.price) : '',
      closePrice:  last.price  != null ? String(last.price)  : '',
      sl:          '',
      tp:          '',
      lot:         String(r2(lot)),
      pnl:         p,
      result:      p > 0 ? 'WIN' : p < 0 ? 'LOSS' : 'BREAKEVEN',
      tradeDate:   openMs,
      openTime:    new Date(openMs).toISOString(),
      closeTime:   new Date(closeMs).toISOString(),
      holdMinutes: Math.max(0, Math.round((closeMs - openMs) / 6000) / 10),
      swap:        r2(swap),
      commission:  r2(commission),
      session:     getSessionFromTime(openMs),
      ticket:      posId,
      source:      'mt5-direct',
      rr:          '',
      notes:       '',
      rules:       '',
      psychology:  '',
      model:       '',
      accountId:   accountId || '',
      createdAt:   Date.now(),
      updatedAt:   Date.now(),
    });
  }

  trades.sort((a, b) => a.tradeDate - b.tradeDate);
  return trades;
}

module.exports = { buildTradesFromDeals, getSessionFromTime };
