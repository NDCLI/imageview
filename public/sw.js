const CACHE_NAME = 'imageview-shell-v2'
const SHELL = ['./', './favicon.svg', './manifest.webmanifest']

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.addAll(SHELL)))
  self.skipWaiting()
})

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys
            .filter((key) => key.startsWith('imageview-shell-') && key !== CACHE_NAME)
            .map((key) => caches.delete(key)),
        ),
      )
      .then(() => self.clients.claim()),
  )
})

self.addEventListener('fetch', (event) => {
  const { request } = event
  const url = new URL(request.url)
  if (request.method !== 'GET' || url.origin !== self.location.origin) return
  const assetPath = new URL('assets/', self.registration.scope).pathname
  const isVersionedAsset = url.pathname.startsWith(assetPath)
  const isShellAsset = SHELL.slice(1).some(
    (path) => url.pathname === new URL(path, self.registration.scope).pathname,
  )
  if (request.mode !== 'navigate' && !isVersionedAsset && !isShellAsset) return

  // Navigations must get the latest HTML so it references the current build.
  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request).catch(async () => {
        return (await caches.match(new URL('./', self.registration.scope).href)) || Response.error()
      }),
    )
    return
  }

  // Build assets contain a content hash and can be reused without revalidation.
  event.respondWith(
    caches.match(request).then(async (cached) => {
      if (cached && isVersionedAsset) return cached
      const network = fetch(request)
        .then((response) => {
          if (response.ok) {
            const copy = response.clone()
            event.waitUntil(
              caches
                .open(CACHE_NAME)
                .then((cache) => cache.put(request, copy))
                .catch(() => {}),
            )
          }
          return response
        })
        .catch(() => cached || Response.error())
      if (cached) event.waitUntil(network)
      return cached || network
    }),
  )
})
