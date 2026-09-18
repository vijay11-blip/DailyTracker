const CACHE = 'daily-tracker-v10';
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
    const r = indexedDB.open('financeDB', 1);
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
}

async function checkDuesInSW() {
  try {
    const db = await openDBinSW();
    const dues = await new Promise((res, rej) => {
      const tx = db.transaction('dues').objectStore('dues').getAll();
      tx.onsuccess = () => res(tx.result);
      tx.onerror = () => rej(tx.error);
    });
    const todayDay = new Date().getDate();
    for (const d of dues) {
      if (d.paid || d.day > todayDay) continue;
      await self.registration.showNotification('Due reminder: ' + d.name, {
        body: '₹' + Number(d.amount).toLocaleString('en-IN') + ' was due on day ' + d.day + ' this month.',
        tag: 'due-' + d.id,
        icon: 'icon-192.png',
        badge: 'icon-192.png'
      });
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
