import { lazy, onMount, Show, Suspense } from 'solid-js'
import ErrorBoundary from './components/ErrorBoundary'
import { getViewerRouteState } from './lib/viewer-state'

const ViewerPage = lazy(() => import('./pages/ViewerPage'))
const MainPage = lazy(() => import('./pages/MainPage'))

export default function App() {
  onMount(() => {
    const currentBuild = typeof __BUILD_DATE__ !== 'undefined' ? __BUILD_DATE__ : null
    if (!currentBuild) return

    const lastBuild = localStorage.getItem('last_build_date')
    if (lastBuild && lastBuild !== String(currentBuild)) {
      localStorage.setItem('last_build_date', String(currentBuild))
      window.location.reload()
      return
    }
    localStorage.setItem('last_build_date', String(currentBuild))
  })

  const initialRouteState = getViewerRouteState()

  return (
    <ErrorBoundary>
      <Suspense fallback={<main class="page-loading">Đang tải…</main>}>
        <Show
          when={initialRouteState.isViewer}
          fallback={<MainPage initialRouteState={initialRouteState} />}
        >
          <ViewerPage initialRouteState={initialRouteState} />
        </Show>
      </Suspense>
    </ErrorBoundary>
  )
}
