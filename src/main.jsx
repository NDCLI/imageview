import { render } from 'solid-js/web'
import App from './App'
import './styles.css'

render(() => <App />, document.getElementById('root'))

// Lazy-load PostHog analytics after page is interactive
// This prevents ~98 KiB of JS from blocking FCP/LCP
const initPostHog = () => {
  import('posthog-js').then(({ default: posthog }) => {
    posthog.init('phc_qspiCxaSsvbdvfV74uZfs6Gc8hQN5wiX6g6cvufeN7p8', {
      api_host: 'https://us.i.posthog.com',
      person_profiles: 'identified_only',
      loaded: (ph) => {
        // PostHog is ready
      }
    })
  })
}

if (typeof requestIdleCallback === 'function') {
  requestIdleCallback(initPostHog, { timeout: 3000 })
} else {
  setTimeout(initPostHog, 2000)
}