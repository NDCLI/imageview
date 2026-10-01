export const PREVIEW_TAB_NAME = 'image-viewer-tab'
export const VIEWER_STATE_KEY = 'local-image-viewer-state'
export const MIN_ZOOM = 0.05
export const MAX_ZOOM = 100
export const PREVIEW_MAX_DIMENSION = 960
// Only a small burst is prepared before the viewer opens. The viewer requests
// the active frame with high priority and keeps the rest of the archive lazy.
export const INITIAL_PREVIEW_COUNT = 3
