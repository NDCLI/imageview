import { render } from 'solid-js/web'
import App from './App'
import './styles.css'

render(() => <App />, document.getElementById('root'))

if (import.meta.env.PROD && 'serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register(`${import.meta.env.BASE_URL}sw.js`).catch(() => {})
  })
} else if ('serviceWorker' in navigator) {
  navigator.serviceWorker.getRegistrations().then((registrations) => {
    registrations.forEach((registration) => registration.unregister())
  })
}

// Track a page view without loading the full PostHog SDK and its optional
// recorder, surveys, web-vitals and autocapture modules.
const capturePageView = () => {
  const storageKey = 'imageview_visitor_id'
  let distinctId = localStorage.getItem(storageKey)

  if (!distinctId) {
    distinctId = crypto.randomUUID()
    localStorage.setItem(storageKey, distinctId)
  }

  const apiKey = import.meta.env.VITE_POSTHOG_KEY
  if (!apiKey) return

  const payload = JSON.stringify({
    api_key: apiKey,
    event: '$pageview',
    properties: {
      distinct_id: distinctId,
      $current_url: location.href,
      $host: location.host,
      $pathname: location.pathname,
      $referrer: document.referrer,
      $title: document.title,
    },
  })

  navigator.sendBeacon(
    'https://us.i.posthog.com/capture/',
    new Blob([payload], { type: 'application/json' }),
  )
}

if (typeof requestIdleCallback === 'function') {
  requestIdleCallback(capturePageView, { timeout: 3000 })
} else {
  setTimeout(capturePageView, 2000)
}
