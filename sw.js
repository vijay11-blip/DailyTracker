const CACHE = 'daily-tracker-v49';
const ASSETS = [
  './',
  './index.html',
  './app.js',
  './manifest.json',
  './icon-192.png',
  './icon-512.png',
  './icon-512-maskable.png'
];

self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE).then(async c => {
      // Cache each file individually so one missing asset can't block install.
      // cache:'reload' skips the HTTP cache so a new version really gets new files.
      const results = await Promise.allSettled(ASSETS.map(url => c.add(new Request(url, { cache: 'reload' }))));
      results.forEach((r, i) => {
        if (r.status === 'rejected') console.warn('SW install: could not cache', ASSETS[i], r.reason);
      });
      // No skipWaiting() here: the page shows "A new version is ready — Reload"
      // and tells this worker to take over when the user taps it.
    })
  );
});

self.addEventListener('message', e => {
  if (e.data && e.data.type === 'SKIP_WAITING') self.skipWaiting();
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', e => {
  if (e.request.method !== 'GET') return;
  if (new URL(e.request.url).origin !== self.location.origin) return; // Google Apps Script etc. go straight to network
  e.respondWith(
    // ignoreSearch for page loads so home-screen shortcuts (index.html?quick=expense) open offline too
    caches.match(e.request, { ignoreSearch: e.request.mode === 'navigate' }).then(cached => {
      const network = fetch(e.request)
        .then(res => {
          if (res && res.status === 200) {
            const copy = res.clone();
            caches.open(CACHE).then(c => c.put(e.request, copy));
          }
          return res;
        })
        .catch(() => cached || (e.request.mode === 'navigate' ? caches.match('./index.html') : Response.error()));
      return cached || network;
    })
  );
});

// Best-effort background reminder check (Chrome/Android only, not guaranteed by the OS).
self.addEventListener('periodicsync', e => {
  if (e.tag === 'check-dues') e.waitUntil(checkDuesInSW());
});

function openDBinSW() {
  return new Promise((res, rej) => {
    const r = indexedDB.open('financeDB'); // no version pinned — opens whatever version the app created
    r.onsuccess = () => {
      const db = r.result;
      // Never hold the connection open: it would block the app from upgrading the database.
      db.onversionchange = () => db.close();
      res(db);
    };
    r.onerror = () => rej(r.error);
  });
}
function getAllSW(db, store) {
  return new Promise((res, rej) => {
    if (!db.objectStoreNames.contains(store)) return res([]);
    const q = db.transaction(store).objectStore(store).getAll();
    q.onsuccess = () => res(q.result);
    q.onerror = () => rej(q.error);
  });
}

const REMINDER_LEAD_DAYS = 10;
const DUE_LOOKBACK_MONTHS = 12;
const FREQ_INTERVAL = { monthly: 1, quarterly: 3, halfyearly: 6, yearly: 12 };

function pad2(n) { return String(n).padStart(2, '0'); }
function ymLocal(d) { return d.getFullYear() + '-' + pad2(d.getMonth() + 1); }
function ymdLocal(d) { return ymLocal(d) + '-' + pad2(d.getDate()); }
function parseYMD(s) { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d); }
function daysInMonth(ym) { const [y, m] = ym.split('-').map(Number); return new Date(y, m, 0).getDate(); }
function addMonths(ym, n) { const [y, m] = ym.split('-').map(Number); return ymLocal(new Date(y, m - 1 + n, 1)); }
function monthsBetween(a, b) { const [ay, am] = a.split('-').map(Number), [by, bm] = b.split('-').map(Number); return (by - ay) * 12 + (bm - am); }
function dateForDay(ym, day) { return ym + '-' + pad2(Math.min(day, daysInMonth(ym))); }
function dateInMonth(y, m, day) { const dim = new Date(y, m + 1, 0).getDate(); return new Date(y, m, Math.min(day, dim)); }
function daysFromToday(dateStr) { const t = new Date(); t.setHours(0, 0, 0, 0); return Math.round((parseYMD(dateStr) - t) / 86400000); }
function sumAmt(arr) { return (arr || []).reduce((a, p) => a + (+p.amount || 0), 0); }

function cardDueDateSW(card) {
  if (!card.billingDay) { // due day only: next due day on/after the bill date
    const r = card.statementDate ? parseYMD(card.statementDate) : new Date(); r.setHours(0, 0, 0, 0);
    let d = dateInMonth(r.getFullYear(), r.getMonth(), card.dueDay || 1);
    if (d < r) d = dateInMonth(r.getFullYear(), r.getMonth() + 1, card.dueDay || 1);
    return d;
  }
  const billingDay = card.billingDay;
  const now = new Date(); now.setHours(0, 0, 0, 0);
  const y = now.getFullYear(), m = now.getMonth();
  const thisBill = dateInMonth(y, m, billingDay);
  const bill = now >= thisBill ? thisBill : dateInMonth(y, m - 1, billingDay);
  if (card.cycleDays) { const d = new Date(bill); d.setDate(d.getDate() + card.cycleDays); return d; }
  const offset = card.dueDay >= billingDay ? 0 : 1;
  return dateInMonth(bill.getFullYear(), bill.getMonth() + offset, card.dueDay || billingDay);
}

async function checkDuesInSW() {
  let db;
  try {
    db = await openDBinSW();
    const now = new Date();
    const ym = ymLocal(now);
    const toYM = ymLocal(new Date(now.getFullYear(), now.getMonth(), now.getDate() + REMINDER_LEAD_DAYS));
    const floor = addMonths(ym, -DUE_LOOKBACK_MONTHS);
    const [dues, cards] = await Promise.all([getAllSW(db, 'dues'), getAllSW(db, 'creditcards')]);

    for (const d of dues) {
      const days = d.days || (d.day ? [d.day] : []);
      const paid = d.paidDates || [];
      const start = d.startYM || ym;
      let from = start > floor ? start : floor;
      for (let m = from, g = 0; monthsBetween(m, toYM) >= 0 && g < 60; m = addMonths(m, 1), g++) {
        const diffM = monthsBetween(start, m);
        if (diffM < 0 || diffM % (FREQ_INTERVAL[d.frequency] || 1) !== 0) continue;
        for (const day of days) {
          const dateStr = dateForDay(m, day);
          if (paid.includes(dateStr) || paid.includes(m + '-' + pad2(day))) continue;
          const diff = daysFromToday(dateStr);
          if (diff > REMINDER_LEAD_DAYS) continue;
          await self.registration.showNotification((diff < 0 ? 'Overdue: ' : 'Due reminder: ') + d.name, {
            body: '₹' + Number(d.amount).toLocaleString('en-IN') + ' — ' + (diff < 0 ? 'was ' : '') + 'due ' + dateStr + '.',
            tag: 'due-' + d.id + '-' + dateStr,
            icon: 'icon-192.png',
            badge: 'icon-192.png'
          });
        }
      }
    }

    for (const c of cards) {
      // only the current BILL counts for the due reminder (new spends go on the next bill)
      const left = (+c.balance || 0) - sumAmt(c.payments);
      if (left <= 0) continue;
      const dateStr = c.stmtDueDate || ymdLocal(cardDueDateSW(c));
      const diff = daysFromToday(dateStr);
      if (diff <= REMINDER_LEAD_DAYS) {
        await self.registration.showNotification((diff < 0 ? 'Card bill overdue: ' : 'Card bill due: ') + c.cardName, {
          body: '₹' + Number(left).toLocaleString('en-IN') + (c.minDue ? ' (min ₹' + Number(c.minDue).toLocaleString('en-IN') + ')' : '') + ' — ' + (diff < 0 ? 'was ' : '') + 'due ' + dateStr + '.',
          tag: 'card-' + c.id + '-' + dateStr,
          icon: 'icon-192.png',
          badge: 'icon-192.png'
        });
      }
    }
  } catch (e) { /* IndexedDB not reachable here — ignore */ }
  finally { if (db) db.close(); }
}

self.addEventListener('notificationclick', e => {
  e.notification.close();
  e.waitUntil(
    clients.matchAll({ type: 'window' }).then(list => {
      for (const c of list) if ('focus' in c) return c.focus();
      if (clients.openWindow) return clients.openWindow('./index.html?tab=dash');
    })
  );
});
