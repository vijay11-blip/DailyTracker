const CACHE = 'daily-tracker-v30';
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
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(ASSETS)).then(() => self.skipWaiting()));
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
  if (new URL(e.request.url).origin !== self.location.origin) return; // let Google API/sign-in calls go straight to network
  e.respondWith(
    caches.match(e.request).then(cached => {
      const network = fetch(e.request)
        .then(res => {
          if (res && res.status === 200) {
            const copy = res.clone();
            caches.open(CACHE).then(c => c.put(e.request, copy));
          }
          return res;
        })
        .catch(() => cached || caches.match('./index.html'));
      return cached || network;
    })
  );
});

// Best-effort background due-reminder check (Chrome/Android only, requires
// the app to be installed and used regularly — not guaranteed by the OS).
self.addEventListener('periodicsync', e => {
  if (e.tag === 'check-dues') e.waitUntil(checkDuesInSW());
});

function openDBinSW() {
  return new Promise((res, rej) => {
    const r = indexedDB.open('financeDB'); // no version pinned — always opens at whatever version the app created
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
}

const REMINDER_LEAD_DAYS = 10;

function pad2(n) { return String(n).padStart(2, '0'); }
function ymLocal(d) { return d.getFullYear() + '-' + pad2(d.getMonth() + 1); }
function ymdLocal(d) { return ymLocal(d) + '-' + pad2(d.getDate()); }

function cardDueDateSW(card) {
  const billingDay = card.billingDay || card.dueDay;
  const now = new Date(); now.setHours(0, 0, 0, 0);
  const y = now.getFullYear(), m = now.getMonth();
  const mostRecentBilling = now.getDate() >= billingDay ? new Date(y, m, billingDay) : new Date(y, m - 1, billingDay);
  if (card.cycleDays) {
    const d = new Date(mostRecentBilling);
    d.setDate(d.getDate() + card.cycleDays);
    return d;
  }
  const dueMonthOffset = card.dueDay >= billingDay ? 0 : 1;
  return new Date(mostRecentBilling.getFullYear(), mostRecentBilling.getMonth() + dueMonthOffset, card.dueDay);
}

async function checkDuesInSW() {
  try {
    const db = await openDBinSW();
    const now = new Date();
    const ym = ymLocal(now); // local calendar month, not UTC — a UTC-based key silently shifts a month for anyone ahead of UTC
    const todayDay = now.getDate();

    const dues = await new Promise((res, rej) => {
      const tx = db.transaction('dues').objectStore('dues').getAll();
      tx.onsuccess = () => res(tx.result);
      tx.onerror = () => rej(tx.error);
    });
    for (const d of dues) {
      const days = d.days || (d.day ? [d.day] : []); // tolerate a not-yet-migrated old-shape record
      const paidDates = d.paidDates || [];
      for (const day of days) {
        const dateStr = ym + '-' + pad2(day);
        if ((day - todayDay) <= REMINDER_LEAD_DAYS && !paidDates.includes(dateStr)) {
          await self.registration.showNotification('Due reminder: ' + d.name, {
            body: '₹' + Number(d.amount).toLocaleString('en-IN') + ' — due on day ' + day + ' this month.',
            tag: 'due-' + d.id + '-' + dateStr,
            icon: 'icon-192.png',
            badge: 'icon-192.png'
          });
        }
      }
    }

    let cards = [];
    try {
      cards = await new Promise((res, rej) => {
        const tx = db.transaction('creditcards').objectStore('creditcards').getAll();
        tx.onsuccess = () => res(tx.result);
        tx.onerror = () => rej(tx.error);
      });
    } catch (e) { /* store may not exist on an older DB version — skip */ }
    for (const c of cards) {
      const paidSoFar = (c.payments || []).reduce((a, p) => a + p.amount, 0);
      const remaining = c.balance - paidSoFar;
      if (remaining <= 0) continue;
      const dueDate = cardDueDateSW(c);
      const daysUntil = Math.round((dueDate.setHours(0,0,0,0) - now.setHours(0,0,0,0)) / 86400000);
      if (daysUntil <= REMINDER_LEAD_DAYS) {
        const dateStr = ymdLocal(dueDate);
        await self.registration.showNotification('Card payment due: ' + c.cardName, {
          body: '₹' + Number(remaining).toLocaleString('en-IN') + ' — due ' + dateStr + '.',
          tag: 'card-' + c.id + '-' + dateStr,
          icon: 'icon-192.png',
          badge: 'icon-192.png'
        });
      }
    }
  } catch (e) { /* IndexedDB not reachable here — ignore */ }
}

self.addEventListener('notificationclick', e => {
  e.notification.close();
  e.waitUntil(
    clients.matchAll({ type: 'window' }).then(list => {
      for (const c of list) if ('focus' in c) return c.focus();
      if (clients.openWindow) return clients.openWindow('./index.html');
    })
  );
});
