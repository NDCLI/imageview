import { readExtractAllFromStorage, readViewerImagesFromStorage } from './viewer-state'
import { VIEWER_STATE_KEY } from './constants'

describe('viewer state', () => {
  afterEach(() => localStorage.clear())

  it('returns an empty list for missing or malformed state', () => {
    expect(readViewerImagesFromStorage()).toEqual([])
    localStorage.setItem(VIEWER_STATE_KEY, '{invalid')
    expect(readViewerImagesFromStorage()).toEqual([])
  })

  it('reads saved images but always uses bounded on-demand extraction', () => {
    localStorage.setItem(
      VIEWER_STATE_KEY,
      JSON.stringify({ images: [{ name: 'a.jpg' }], isExtractAll: true }),
    )
    expect(readViewerImagesFromStorage()).toEqual([{ name: 'a.jpg' }])
    expect(readExtractAllFromStorage()).toBe(false)
  })
})
