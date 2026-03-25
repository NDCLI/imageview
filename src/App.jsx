import { startTransition, useEffect, useRef, useState } from 'react'
import JSZip from 'jszip'
import { getFolderHandle, setFolderHandle, clearFolderHandle } from './storage'

const PREVIEW_TAB_NAME = 'local-image-preview'
const VIEWER_STATE_KEY = 'local-image-viewer-state'
const MIN_ZOOM = 1
const MAX_ZOOM = 6
const ZOOM_STEP = 0.2

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max)
}

function getViewerRouteState() {
  const params = new URLSearchParams(window.location.search)
  const rawIndex = Number.parseInt(params.get('index') || '0', 10)

  return {
    isViewer: params.get('viewer') === '1',
    index: Number.isFinite(rawIndex) ? rawIndex : 0,
  }
}

function readViewerImagesFromStorage() {
  try {
    const raw = localStorage.getItem(VIEWER_STATE_KEY)
    if (!raw) {
      return []
    }

    const parsed = JSON.parse(raw)
    return Array.isArray(parsed.images) ? parsed.images : []
  } catch {
    return []
  }
}

function writeViewerIndexToUrl(index) {
  const params = new URLSearchParams(window.location.search)
  params.set('viewer', '1')
  params.set('index', String(index))
  window.history.replaceState(null, '', `${window.location.pathname}?${params.toString()}`)
}

function readImageDimensions(url) {
  return new Promise((resolve, reject) => {
    const image = new Image()
    image.onload = () => {
      resolve({ width: image.naturalWidth, height: image.naturalHeight })
    }
    image.onerror = () => reject(new Error('Không đọc được ảnh'))
    image.src = url
  })
}

async function createImageRecord(file, indexSeed, overrideName = null) {
  const url = URL.createObjectURL(file)

  try {
    const dimensions = await readImageDimensions(url)
    const displayName = overrideName || file.name

    return {
      id: `${displayName}-${file.lastModified}-${indexSeed}`,
      file,
      url,
      name: displayName,
      size: file.size,
      type: file.type || 'image/*',
      ...dimensions,
    }
  } catch (error) {
    URL.revokeObjectURL(url)
    throw error
  }
}

export default function App() {
  // Viewer mode with free panning and zoom at cursor
  const initialRouteState = getViewerRouteState()
  const [viewerImages, setViewerImages] = useState(() =>
    initialRouteState.isViewer ? readViewerImagesFromStorage() : [],
  )
  const [viewerIndex, setViewerIndex] = useState(initialRouteState.index)
  const viewerTxRef = useRef({ scale: 1, panX: 0, panY: 0 })
  const [viewerTx, setViewerTx] = useState({ scale: 1, panX: 0, panY: 0 })
  const viewerStageRef = useRef(null)
  const viewerDragRef = useRef(null)
  const isViewerMode = initialRouteState.isViewer

  const [images, setImages] = useState([])
  const [isLoading, setIsLoading] = useState(false)
  const [hasSavedFolder, setHasSavedFolder] = useState(false)
  const [showReloadPrompt, setShowReloadPrompt] = useState(false)
  const imagesRef = useRef([])

  useEffect(() => {
    getFolderHandle().then(handle => {
      if (handle) {
        setHasSavedFolder(true)
        setShowReloadPrompt(true)
      }
    }).catch(() => {})
  }, [])

  useEffect(() => {
    imagesRef.current = images
  }, [images])

  useEffect(() => {
    return () => {
      imagesRef.current.forEach((image) => URL.revokeObjectURL(image.url))
    }
  }, [])

  useEffect(() => {
    if (!isViewerMode) {
      return undefined
    }

    function handleStorage(event) {
      if (event.key === VIEWER_STATE_KEY) {
        setViewerImages(readViewerImagesFromStorage())
      }
    }

    window.addEventListener('storage', handleStorage)
    return () => window.removeEventListener('storage', handleStorage)
  }, [isViewerMode])

  useEffect(() => {
    if (!isViewerMode) {
      return
    }

    const maxIndex = Math.max(0, viewerImages.length - 1)
    const safeIndex = Math.min(Math.max(viewerIndex, 0), maxIndex)

    if (safeIndex !== viewerIndex) {
      setViewerIndex(safeIndex)
      return
    }

    writeViewerIndexToUrl(safeIndex)
  }, [isViewerMode, viewerImages.length, viewerIndex])

  function openImageInNewTab(image) {
    const snapshot = imagesRef.current.map((currentImage) => ({
      id: currentImage.id,
      url: currentImage.url,
      name: currentImage.name,
      width: currentImage.width,
      height: currentImage.height,
    }))

    const currentIndex = snapshot.findIndex((item) => item.id === image.id)
    if (currentIndex < 0) {
      return
    }

    localStorage.setItem(
      VIEWER_STATE_KEY,
      JSON.stringify({
        images: snapshot,
        selectedImageId: image.id,
        savedAt: Date.now(),
      }),
    )

    // Force open in new tab with explicit target
    const viewerUrl = `${window.location.pathname}?viewer=1&index=${currentIndex}`
    const newTab = window.open(viewerUrl, PREVIEW_TAB_NAME)
    if (newTab) {
      newTab.focus()
    } else {
      // Fallback if popup is blocked
      window.location.href = viewerUrl
    }
  }

  function goToPreviousImage() {
    setViewerIndex((current) => Math.max(0, current - 1))
  }

  function goToNextImage() {
    setViewerIndex((current) => Math.min(viewerImages.length - 1, current + 1))
  }

  function updateViewerTx(next) {
    viewerTxRef.current = next
    setViewerTx(next)
  }

  function constrainViewerPan(tx, stage) {
    if (!stage) return tx
    
    const { scale, panX, panY } = tx
    
    const bounds = stage.getBoundingClientRect()
    const stageWidth = bounds.width
    const stageHeight = bounds.height
    
    // Get the active image dimensions from viewer images
    const activeImage = viewerImages[Math.min(Math.max(viewerIndex, 0), viewerImages.length - 1)]
    if (!activeImage || activeImage.width === 0 || activeImage.height === 0) {
      return { scale, panX: 0, panY: 0 }
    }
    
    const imgWidth = activeImage.width * scale
    const imgHeight = activeImage.height * scale
    
    // Allow free panning with larger bounds for zoomed images
    // This lets users drag fully across the image at all zoom levels
    const maxPanX = imgWidth + stageWidth
    const maxPanY = imgHeight + stageHeight
    
    const constrainedPanX = Math.min(Math.max(panX, -maxPanX), maxPanX)
    const constrainedPanY = Math.min(Math.max(panY, -maxPanY), maxPanY)
    
    return { scale, panX: constrainedPanX, panY: constrainedPanY }
  }

  function resetViewerZoom() {
    const reset = { scale: 1, panX: 0, panY: 0 }
    viewerTxRef.current = reset
    setViewerTx(reset)
  }

  useEffect(() => {
    if (!isViewerMode) {
      return
    }

    resetViewerZoom()
  }, [isViewerMode])

  useEffect(() => {
    if (!isViewerMode) {
      return undefined
    }

    const stage = viewerStageRef.current
    if (!stage) {
      return undefined
    }

    function onWheel(event) {
      event.preventDefault()
      const { scale, panX, panY } = viewerTxRef.current
      const bounds = stage.getBoundingClientRect()
      const cx = event.clientX - bounds.left
      const cy = event.clientY - bounds.top
      
      // Calculate zoom center in image coordinates (before zoom)
      const ix = (cx - panX) / scale
      const iy = (cy - panY) / scale
      
      // Apply new scale
      const newScale = clamp(scale + (event.deltaY < 0 ? ZOOM_STEP : -ZOOM_STEP), MIN_ZOOM, MAX_ZOOM)
      
      // Calculate new pan to keep the same point under cursor
      const newPanX = cx - ix * newScale
      const newPanY = cy - iy * newScale
      
      const newTx = { scale: newScale, panX: newPanX, panY: newPanY }
      const constrainedTx = constrainViewerPan(newTx, stage)
      updateViewerTx(constrainedTx)
    }

    stage.addEventListener('wheel', onWheel, { passive: false })
    return () => stage.removeEventListener('wheel', onWheel)
  }, [isViewerMode])

  useEffect(() => {
    if (!isViewerMode) {
      return undefined
    }

    function onKeyDown(event) {
      if (event.key === 'ArrowRight' || event.key === 'f' || event.key === 'F') {
        goToNextImage()
      } else if (event.key === 'ArrowLeft' || event.key === 'd' || event.key === 'D') {
        goToPreviousImage()
      }
    }

    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [isViewerMode])

  function handleViewerDoubleClick() {
    resetViewerZoom()
  }

  function handleViewerMouseDown(event) {
    event.preventDefault()
    viewerDragRef.current = { lastX: event.clientX, lastY: event.clientY }
    document.body.style.cursor = 'grabbing'
  }

  function handleViewerMouseMove(event) {
    if (!viewerDragRef.current) {
      return
    }

    const dx = event.clientX - viewerDragRef.current.lastX
    const dy = event.clientY - viewerDragRef.current.lastY
    viewerDragRef.current = { lastX: event.clientX, lastY: event.clientY }
    const { scale, panX, panY } = viewerTxRef.current
    const newTx = { scale, panX: panX + dx, panY: panY + dy }
    const constrainedTx = constrainViewerPan(newTx, viewerStageRef.current)
    updateViewerTx(constrainedTx)
  }

  function handleViewerMouseUp() {
    viewerDragRef.current = null
    document.body.style.cursor = ''
  }

  if (isViewerMode) {
    const hasImages = viewerImages.length > 0
    const activeImage = hasImages ? viewerImages[Math.min(Math.max(viewerIndex, 0), viewerImages.length - 1)] : null

    return (
      <main className="viewer-shell">
        <section className="viewer-panel">
          {hasImages && activeImage ? (
            <>
              <div
                ref={viewerStageRef}
                className="viewer-stage"
                style={{ cursor: viewerTx.scale > 1 ? 'grab' : 'zoom-in' }}
                onMouseDown={handleViewerMouseDown}
                onMouseMove={handleViewerMouseMove}
                onMouseUp={handleViewerMouseUp}
                onMouseLeave={handleViewerMouseUp}
                onDoubleClick={handleViewerDoubleClick}
              >
                <img
                  src={activeImage.url}
                  alt={activeImage.name}
                  className="viewer-image"
                  style={{
                    transform: `translate(${viewerTx.panX}px, ${viewerTx.panY}px) scale(${viewerTx.scale})`,
                    transformOrigin: '0 0',
                  }}
                />
              </div>
              <p className="viewer-meta">
                {activeImage.name} • {viewerIndex + 1}/{viewerImages.length} • {activeImage.width} x {activeImage.height} • Zoom {Math.round(viewerTx.scale * 100)}% • ← → để chuyển ảnh
              </p>
            </>
          ) : (
            <div className="empty-gallery">
              <h3>Tab preview chưa có dữ liệu ảnh</h3>
              <p>Quay lại tab chính và bấm vào một ảnh để nạp danh sách vào đây.</p>
            </div>
          )}
        </section>
      </main>
    )
  }

  async function reloadFolder() {
    setShowReloadPrompt(false)
    try {
      const handle = await getFolderHandle()
      if (!handle) return
      const perm = await handle.queryPermission({ mode: 'read' })
      if (perm !== 'granted') {
        const req = await handle.requestPermission({ mode: 'read' })
        if (req !== 'granted') return
      }
      
      if (handle.kind === 'directory') {
        await readDirectoryHandle(handle)
      } else if (handle.kind === 'file') {
        await readZipHandle(handle)
      }
    } catch (err) {
      console.error(err)
    }
  }

  async function readDirectoryHandle(dirHandle) {
    setIsLoading(true)
    imagesRef.current.forEach((image) => URL.revokeObjectURL(image.url))
    setImages([])
    const imageData = []
    try {
      async function traverse(handle, currentPath = '') {
        for await (const entry of handle.values()) {
          if (entry.kind === 'file' && entry.name.match(/\.(png|jpg|jpeg|gif|webp|bmp)$/i)) {
            const file = await entry.getFile()
            imageData.push({ file, name: currentPath + entry.name })
          } else if (entry.kind === 'directory') {
            await traverse(entry, currentPath + entry.name + '/')
          }
        }
      }
      await traverse(dirHandle, dirHandle.name + '/')
      imageData.sort((a, b) => a.name.localeCompare(b.name))
      if (!imageData.length) return
      const nextRecords = await Promise.all(
        imageData.map((data, index) => createImageRecord(data.file, `${Date.now()}-${index}`, data.name))
      )
      startTransition(() => {
        setImages(nextRecords)
      })
    } catch (err) {
      console.error(err)
    } finally {
      setIsLoading(false)
    }
  }

  async function openPicker() {
    try {
      const handle = await window.showDirectoryPicker({ id: 'image-folder', mode: 'read' })
      await setFolderHandle(handle)
      setHasSavedFolder(true)
      await readDirectoryHandle(handle)
    } catch (err) {
      if (err.name !== 'AbortError') console.error(err)
    }
  }

  async function readZipHandle(fileHandle) {
    setIsLoading(true)
    imagesRef.current.forEach((image) => URL.revokeObjectURL(image.url))
    setImages([])
    try {
      const zipFile = await fileHandle.getFile()
      const zip = new JSZip()
      const zipContent = await zip.loadAsync(zipFile)
      
      const imageData = []
      for (const [path, zipEntry] of Object.entries(zipContent.files)) {
        if (zipEntry.dir || !path.match(/\.(png|jpg|jpeg|gif|webp|bmp)$/i)) continue
        const blob = await zipEntry.async('blob')
        // Lấy tên zip làm thư mục gốc (nếu zip file không gom chung vào 1 folder to) hoặc lấy luôn path trong zip
        // `path` của ZIP mặc định đã chứa full folder hierarchy như "folder/image.png", nên dùng trực tiếp `path` là tốt nhất
        const imageFile = new File([blob], path, { type: blob.type || 'image/*' })
        imageData.push({ file: imageFile, name: path })
      }
      
      imageData.sort((a, b) => a.name.localeCompare(b.name))
      if (!imageData.length) return
      
      const nextRecords = await Promise.all(
        imageData.map((data, index) => createImageRecord(data.file, `${Date.now()}-${index}`, data.name))
      )
      startTransition(() => {
        setImages(nextRecords)
      })
    } catch (err) {
      console.error('Lỗi khi tải lại zip:', err)
    } finally {
      setIsLoading(false)
    }
  }

  async function openZipPicker() {
    try {
      const [fileHandle] = await window.showOpenFilePicker({
        id: 'zip-file',
        types: [{ description: 'ZIP Files', accept: { 'application/zip': ['.zip'] } }]
      })
      await setFolderHandle(fileHandle)
      setHasSavedFolder(true)
      await readZipHandle(fileHandle)
    } catch (err) {
      if (err.name !== 'AbortError') console.error('Lỗi khi xử lý zip:', err)
    }
  }

  async function clearImages() {
    imagesRef.current.forEach((image) => URL.revokeObjectURL(image.url))
    setImages([])
    await clearFolderHandle()
    setHasSavedFolder(false)
  }

  function removeImage(imageId) {
    setImages((current) => {
      const imageToRemove = current.find((image) => image.id === imageId)
      if (imageToRemove) {
        URL.revokeObjectURL(imageToRemove.url)
      }

      return current.filter((image) => image.id !== imageId)
    })
  }

  return (
    <div className="app-shell">
      <div className="bg-orb bg-orb-left" />
      <div className="bg-orb bg-orb-right" />

      <main className="page">
        <section className="hero-panel">
          <div className="hero-actions">
            <button type="button" className="primary-btn" onClick={openPicker}>
              Chọn folder ảnh
            </button>
            <button type="button" className="primary-btn" onClick={openZipPicker}>
              Chọn file ZIP
            </button>
            <button type="button" className="ghost-btn" onClick={clearImages} disabled={!images.length && !hasSavedFolder}>
              Xóa tất cả
            </button>
          </div>

          {showReloadPrompt && (
            <div className="reload-overlay" style={{
              marginTop: '16px',
              padding: '16px',
              background: 'rgba(255,255,255,0.05)',
              borderRadius: '8px',
              border: '1px solid rgba(255,255,255,0.1)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              gap: '16px'
            }}>
              <div>
                <strong style={{ display: 'block', color: 'white' }}>Phát hiện dữ liệu ảnh cũ (Folder/ZIP)!</strong>
                <span style={{ fontSize: '0.9em', color: 'rgba(255,255,255,0.7)' }}>Bạn có muốn khôi phục lại dữ liệu này không? (Trình duyệt sẽ yêu cầu quyền đọc)</span>
              </div>
              <div style={{ display: 'flex', gap: '8px' }}>
                <button type="button" className="primary-btn" onClick={reloadFolder}>
                  Đồng ý tải lại
                </button>
                <button type="button" className="ghost-btn" onClick={() => setShowReloadPrompt(false)}>
                  Bỏ qua
                </button>
              </div>
            </div>
          )}

          <div className="hero-stats">
            <article>
              <span>{images.length}</span>
              <p>Tổng ảnh đã nạp</p>
            </article>
            <article>
              <span>{isLoading ? '...' : 'OK'}</span>
              <p>{isLoading ? 'Đang đọc ảnh' : 'ready'}</p>
            </article>
          </div>
        </section>

        <section className="gallery-panel">
          <div className="section-heading">
            <div>
              <p className="section-kicker">Preview list</p>

            </div>
            <p className="section-note">
              {isLoading
                ? 'Đang đọc thông tin ảnh...'
                : 'Danh sách chỉ hiển thị preview nhỏ. Bấm ảnh để mở trong cùng 1 tab preview, hoặc xóa từng ảnh.'}
            </p>
          </div>

          {!images.length ? (
            <div className="empty-gallery">
              <h3>Chưa có ảnh nào được nạp</h3>
              <p>Chọn nhiều file ảnh từ máy tính để tạo list preview.</p>
            </div>
          ) : (
            <div className="preview-list" role="list">
              {images.map((image) => (
                <article key={image.id} className="preview-item" role="listitem">
                  <button type="button" className="preview-button" onClick={() => openImageInNewTab(image)}>
                    <img src={image.url} alt={image.name} />
                  </button>

                  <div className="preview-meta">
                    <strong title={image.name}>{image.name}</strong>
                    <span>
                      {image.width} x {image.height}
                    </span>
                  </div>

                  <button type="button" className="danger-btn preview-remove" onClick={() => removeImage(image.id)}>
                    Xóa
                  </button>
                </article>
              ))}
            </div>
          )}
        </section>
      </main>

    </div>
  )
}
