import { VIEWER_STATE_KEY } from './constants'

export function getViewerRouteState() {
  const params = new URLSearchParams(window.location.search)
  const rawIndex = Number.parseInt(params.get('index') || '0', 10)
  return { isViewer: params.get('viewer') === '1', index: Number.isFinite(rawIndex) ? rawIndex : 0 }
}

export function readViewerImagesFromStorage() {
  try {
    const raw = localStorage.getItem(VIEWER_STATE_KEY)
    if (!raw) return []
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed.images) ? parsed.images : []
  } catch {
    return []
  }
}

export function readExtractAllFromStorage() {
  return false
}

export function writeViewerIndexToUrl(index) {
  const params = new URLSearchParams(window.location.search)
  params.set('viewer', '1')
  params.set('index', String(index))
  window.history.replaceState(null, '', `${window.location.pathname}?${params.toString()}`)
}
