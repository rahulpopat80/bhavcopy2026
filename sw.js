const CACHE_NAME = 'rahul-finance-cache-v1';
const ASSETS_TO_CACHE = [
  './',
  './index.html',
  './app.js',
  './style.css',
  './manifest.json',
  './icon.png',
  './run_bhavcopy_no_cors.bat'
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

// Activate Event - Clean up old caches
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

// Fetch Event - Network First fallback to Cache
self.addEventListener('fetch', (e) => {
  // Exclude Firebase, live quote sources, translations and search APIs from service worker static caching
  if (e.request.url.includes('firestore.googleapis.com') || 
      e.request.url.includes('finance.yahoo.com') ||
      e.request.url.includes('duckduckgo.com') ||
      e.request.url.includes('translate.googleapis.com') ||
      e.request.url.includes('google-analytics.com')) {
    return;
  }

  e.respondWith(
    fetch(e.request)
      .then((response) => {
        // If request succeeds, clone response and cache it
        if (response.status === 200 && response.type === 'basic') {
          const responseToCache = response.clone();
          caches.open(CACHE_NAME).then((cache) => {
            cache.put(e.request, responseToCache);
          });
        }
        return response;
      })
      .catch(() => {
        // Fallback to cache if network fails
        return caches.match(e.request);
      })
  );
});
