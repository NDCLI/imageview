import { render, fireEvent, waitFor, cleanup } from '@solidjs/testing-library'
import { vi } from 'vitest'
import ViewerPage from './ViewerPage'
import { VIEWER_STATE_KEY } from '../lib/constants'
import { getFolderHandle } from '../storage'
import { openZip } from '../lib/zip-loader'

vi.mock('../storage', () => ({
  getFolderHandle: vi.fn(),
  setFolderHandle: vi.fn(),
  clearFolderHandle: vi.fn(),
}))
vi.mock('../lib/zip-loader', () => ({ openZip: vi.fn() }))

describe('viewer loading', () => {
  let channel
  beforeEach(() => {
    localStorage.setItem(
      VIEWER_STATE_KEY,
      JSON.stringify({ images: [{ id: 'a', name: 'a.png', width: 1280, height: 720 }] }),
    )
    vi.stubGlobal(
      'BroadcastChannel',
      class {
        constructor() {
          channel = this
        }
        postMessage() {}
        close() {}
      },
    )
    vi.stubGlobal(
      'Image',
      class {
        decode() {
          return Promise.resolve()
        }
      },
    )
    vi.stubGlobal('requestAnimationFrame', (callback) => setTimeout(callback, 0))
    vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:test-image')
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {})
    getFolderHandle.mockResolvedValue(null)
  })
  afterEach(() => {
    cleanup()
    localStorage.clear()
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  it('requests the active image when a saved ZIP finishes restoring', async () => {
    let resolveZip
    getFolderHandle.mockResolvedValue({
      queryPermission: async () => 'granted',
      getFile: async () => new Blob(),
    })
    openZip.mockReturnValue(
      new Promise((resolve) => {
        resolveZip = resolve
      }),
    )
    const getBlob = vi.fn().mockResolvedValue(new Blob(['image']))
    render(() => <ViewerPage initialRouteState={{ index: 0 }} />)
    await waitFor(() => expect(openZip).toHaveBeenCalled())
    resolveZip({ hasPath: () => true, getBlob, terminate() {} })
    await waitFor(() =>
      expect(getBlob).toHaveBeenCalledWith('a.png', expect.objectContaining({ priority: true })),
    )
  })

  it('clears the initial loading indicator after the first buffer is painted', async () => {
    const view = render(() => <ViewerPage initialRouteState={{ index: 0 }} />)
    await channel.onmessage({
      data: { type: 'RES_IMG', idx: 0, name: 'a.png', blob: new Blob(['image']) },
    })
    const image = view.container.querySelector('img[src="blob:test-image"]')
    fireEvent.load(image)
    await waitFor(() => expect(view.getByText('Sẵn sàng')).toBeTruthy())
    expect(view.container.querySelector('.viewer-stage').getAttribute('aria-busy')).toBe('false')
  })
})
