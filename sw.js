// FIX: Bumped cache version so updated app.js/index.html/style.css are served immediately
const CACHE_NAME = 'rahul-finance-cache-v10-20261123';
const ASSETS_TO_CACHE = [
  './',
  './index.html',
  './app.js',
  './style.css',
  './manifest.json',
  './icon.png'
];

// Install Event - Caching App Shell
self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      console.log('Service Worker: Caching files...');
      return cache.addAll(ASSETS_TO_CACHE);
    }).then(() => self.skipWaiting())
  );
});

// Activate Event - Clean up old caches and take control immediately
self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then((keys) => {
      return Promise.all(
        keys.map((key) => {
          if (key !== CACHE_NAME) {
            console.log('Service Worker: Clearing Old Cache', key);
            return caches.delete(key);
          }
        })
      );
    }).then(() => self.clients.claim())
  );
});

// FIX: Network-First strategy for app.js, index.html, style.css (cache only as offline fallback)
self.addEventListener('fetch', (e) => {
  const url = e.request.url;

  // Exclude API routes, Firebase, live quote sources, translations, and search APIs
  if (
    e.request.method !== 'GET' ||
    url.includes('/api/') ||
    url.includes('firestore.googleapis.com') ||
    url.includes('finance.yahoo.com') ||
    url.includes('duckduckgo.com') ||
    url.includes('translate.googleapis.com') ||
    url.includes('google-analytics.com')
  ) {
    return;
  }

  const isCoreAppFile =
    e.request.mode === 'navigate' ||
    url.endsWith('/app.js') ||
    url.endsWith('/index.html') ||
    url.endsWith('/style.css') ||
    url.endsWith('/');

  e.respondWith(
    fetch(isCoreAppFile ? new Request(e.request, { cache: 'no-cache' }) : e.request)
      .then((response) => {
        if (response && response.status === 200 && response.type === 'basic') {
          const responseToCache = response.clone();
          caches.open(CACHE_NAME).then((cache) => {
            cache.put(e.request, responseToCache);
          });
        }
        return response;
      })
      .catch(() => {
        return caches.match(e.request);
      })
  );
});
