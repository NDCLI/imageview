import { render } from 'solid-js/web'
import posthog from 'posthog-js'
import App from './App'
import './styles.css'

posthog.init('phc_qspiCxaSsvbdvfV74uZfs6Gc8hQN5wiX6g6cvufeN7p8', {
  api_host: 'https://us.i.posthog.com',
  person_profiles: 'identified_only' // Recommended option for profiles
})

render(() => <App />, document.getElementById('root'))