import { startTransition, useEffect, useRef, useState } from 'react'
import JSZip from 'jszip'
import { getFolderHandle, setFolderHandle, clearFolderHandle } from './storage'

const PREVIEW_TAB_NAME = 'image-viewer-tab'

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

function createImageRecord(file, indexSeed, overrideName = null) {
  const url = URL.createObjectURL(file)
  const displayName = overrideName || file.name

  return {
    id: `${displayName}-${file.lastModified}-${indexSeed}`,
    file,
    url,
    name: displayName,
    size: file.size,
    type: file.type || 'image/*',
    width: 0,
    height: 0,
  }
}

export default function App() {
  // Viewer mode with free panning and zoom at cursor
  const initialRouteState = getViewerRouteState()
  const [viewerImages, setViewerImages] = useState(() =>
    initialRouteState.isViewer ? readViewerImagesFromStorage() : [],
  )
  const [viewerIndex, setViewerIndex] = useState(initialRouteState.index)
  const [searchQuery, setSearchQuery] = useState('')
  const searchInputRef = useRef(null)
  const viewerTxRef = useRef({ scale: 1, panX: 0, panY: 0 })
  const [viewerTx, setViewerTx] = useState({ scale: 1, panX: 0, panY: 0 })
  const viewerStageRef = useRef(null)
  const viewerDragRef = useRef(null)
  const isViewerMode = initialRouteState.isViewer

  useEffect(() => {
    if (!isViewerMode) {
      window.name = 'image-preview-main'
      document.title = 'Preview'
    } else {
      window.name = 'image-viewer-tab'
      document.title = 'Images Preview'
    }
  }, [isViewerMode])

  const [images, setImages] = useState([])
  const [isLoading, setIsLoading] = useState(false)
  const [loadDone, setLoadDone] = useState(false)
  const [hasSavedFolder, setHasSavedFolder] = useState(false)
  const [showReloadPrompt, setShowReloadPrompt] = useState(false)
  const imagesRef = useRef([])

  const [visibleCount, setVisibleCount] = useState(50)

  useEffect(() => {
    getFolderHandle().then(handle => {
      if (handle) {
        setHasSavedFolder(true)
        if (!isViewerMode) {
          setShowReloadPrompt(true)
        }
      }
    }).catch(() => { })
  }, [isViewerMode])

  useEffect(() => {
    setVisibleCount(50)
  }, [images.length])

  useEffect(() => {
    imagesRef.current = images
  }, [images])

  useEffect(() => {
    return () => {
      imagesRef.current.forEach((image) => URL.revokeObjectURL(image.url))
    }
  }, [])

  useEffect(() => {
    if (!isViewerMode || viewerImages.length === 0) return

    // Poll the blob URL to see if the main tab is still alive
    const testUrl = viewerImages[0].url
    
    // We do a quick fetch check every 2 seconds
    const intervalId = setInterval(() => {
      fetch(testUrl)
        .then(res => {
          if (!res.ok) {
            setShowReloadPrompt(true)
            clearInterval(intervalId)
          } else {
            setShowReloadPrompt(false)
          }
        })
        .catch(() => {
          setShowReloadPrompt(true)
          clearInterval(intervalId)
        })
    }, 2000)

    // Run once immediately on mount
    fetch(testUrl).then(res => {
      if (!res.ok) setShowReloadPrompt(true)
      else setShowReloadPrompt(false)
    }).catch(() => setShowReloadPrompt(true))

    return () => clearInterval(intervalId)
  }, [isViewerMode, viewerImages])

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

    const displayImages = images.length > 0 ? images : viewerImages
    const maxIndex = Math.max(0, displayImages.length - 1)
    const safeIndex = Math.min(Math.max(viewerIndex, 0), maxIndex)

    if (safeIndex !== viewerIndex) {
      setViewerIndex(safeIndex)
      return
    }

    writeViewerIndexToUrl(safeIndex)
    if (displayImages[safeIndex]) {
      if (document.activeElement !== searchInputRef.current) {
        setSearchQuery(displayImages[safeIndex].name)
      }
    }
  }, [isViewerMode, viewerImages, viewerIndex, images])



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

    // Force open in new tab with explicit target (reusing the same viewer tab)
    const viewerUrl = `${window.location.pathname}?viewer=1&index=${currentIndex}`
    const newTab = window.open(viewerUrl, PREVIEW_TAB_NAME)
    if (newTab) {
      newTab.focus()
    } else {
      // Fallback if popup is blocked - we should NOT replace the current tab, 
      // just inform the user instead of destroying their preview page.
      alert('Vui lòng cho phép mở popup (Allow Popups) để xem tab ảnh!')
    }
  }

  function goToPreviousImage() {
    setViewerIndex((current) => Math.max(0, current - 1))
  }

  function goToNextImage() {
    const displayImages = images.length > 0 ? images : viewerImages
    setViewerIndex((current) => Math.min(displayImages.length - 1, current + 1))
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

    const displayImages = images.length > 0 ? images : viewerImages
    const activeImage = displayImages[Math.min(Math.max(viewerIndex, 0), displayImages.length - 1)]
    if (!activeImage || activeImage.width === 0 || activeImage.height === 0) {
      return tx
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
      if ((event.ctrlKey || event.metaKey) && (event.key === 'f' || event.key === 'F')) {
        event.preventDefault()
        if (searchInputRef.current) {
          searchInputRef.current.focus()
          searchInputRef.current.select()
        }
        return
      }

      if (['INPUT', 'TEXTAREA'].includes(event.target.tagName)) {
        return
      }

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
    if (searchInputRef.current) {
      searchInputRef.current.blur()
    }
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
    const displayImages = images.length > 0 ? images : viewerImages
    const hasImages = displayImages.length > 0
    const activeImage = hasImages ? displayImages[Math.min(Math.max(viewerIndex, 0), displayImages.length - 1)] : null

    return (
      <main className="viewer-shell">
        {showReloadPrompt && (
          <div className="reload-overlay" style={{
            position: 'fixed',
            top: '20px',
            left: '50%',
            transform: 'translateX(-50%)',
            zIndex: 1000,
            width: 'min(600px, 90%)',
            padding: '16px',
            background: 'rgba(20, 30, 45, 0.95)',
            borderRadius: '12px',
            border: '1px solid rgba(255,255,255,0.2)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: '16px',
            boxShadow: '0 10px 30px rgba(0,0,0,0.5)',
            backdropFilter: 'blur(10px)'
          }}>
            <div style={{ textAlign: 'left' }}>
              <strong style={{ display: 'block', color: 'white' }}>Cần nạp lại dữ liệu ảnh!</strong>
              <span style={{ fontSize: '0.85em', color: 'rgba(255,255,255,0.7)' }}>Tab chính đã đóng hoặc dữ liệu cũ hết hạn. Bấm để khôi phục.</span>
            </div>
            <div style={{ display: 'flex', gap: '8px' }}>
              <button type="button" className="primary-btn" onClick={reloadFolder} style={{ padding: '8px 16px', fontSize: '0.9em' }}>
                Tải lại
              </button>
            </div>
          </div>
        )}
        <section className="viewer-panel">
          {hasImages && activeImage ? (
            <>
              <div
                ref={viewerStageRef}
                className="viewer-stage"
                style={{ cursor: viewerTx.scale > 1 ? 'grab' : 'default' }}
                onMouseDown={handleViewerMouseDown}
                onMouseMove={handleViewerMouseMove}
                onMouseUp={handleViewerMouseUp}
                onMouseLeave={handleViewerMouseUp}
                onDoubleClick={handleViewerDoubleClick}
              >
                <img
                  src={activeImage.url}
                  alt={activeImage.name}
                  onLoad={handleViewerImageLoad}
                  className="viewer-image"
                  style={{
                    transform: `translate(${viewerTx.panX}px, ${viewerTx.panY}px) scale(${viewerTx.scale})`,
                    transformOrigin: '0 0',
                  }}
                  onError={() => {
                    // Mất file (Blob URL hỏng do tab chính bị đóng)
                    setShowReloadPrompt(true)
                  }}
                />
              </div>
              <div className="viewer-meta" style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap', justifyContent: 'center' }}>
                <input
                  ref={searchInputRef}
                  type="text"
                  value={searchQuery}
                  onChange={(e) => {
                    const query = e.target.value;
                    setSearchQuery(query);
                    if (query) {
                      const foundIndex = displayImages.findIndex(img => img.name.toLowerCase().includes(query.toLowerCase()));
                      if (foundIndex !== -1 && foundIndex !== viewerIndex) {
                        setViewerIndex(foundIndex);
                      }
                    }
                  }}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === 'Escape') {
                      e.target.blur()
                    }
                  }}
                  onFocus={(e) => e.target.select()}
                  style={{
                    background: 'rgba(0, 0, 0, 0.5)',
                    border: '1px solid rgba(255, 255, 255, 0.2)',
                    color: '#fff',
                    padding: '4px 8px',
                    borderRadius: '4px',
                    outline: 'none',
                    minWidth: '300px',
                    fontFamily: 'inherit',
                    fontSize: 'inherit'
                  }}
                  placeholder="Dán hoặc nhập tên ảnh để tìm..."
                  title="Tìm kiếm tên ảnh"
                />
                <span>• {viewerIndex + 1}/{displayImages.length} • {activeImage.width} x {activeImage.height} • Zoom {Math.round(viewerTx.scale * 100)}% • ← → để chuyển</span>
              </div>
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
      const nextRecords = imageData.map((data, index) =>
        createImageRecord(data.file, `${Date.now()}-${index}`, data.name)
      )
      startTransition(() => {
        setImages(nextRecords)
      })
    } catch (err) {
      console.error(err)
    } finally {
      setIsLoading(false)
      setLoadDone(true)
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

      const nextRecords = imageData.map((data, index) =>
        createImageRecord(data.file, `${Date.now()}-${index}`, data.name)
      )
      startTransition(() => {
        setImages(nextRecords)
      })
    } catch (err) {
      console.error('Lỗi khi tải lại zip:', err)
    } finally {
      setIsLoading(false)
      setLoadDone(true)
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

  function handleThumbnailLoad(imageId, event) {
    const { naturalWidth, naturalHeight } = event.target
    if (!naturalWidth) return
    setImages((current) =>
      current.map((img) =>
        img.id === imageId ? { ...img, width: naturalWidth, height: naturalHeight } : img
      )
    )
  }

  function handleViewerImageLoad(event) {
    const { naturalWidth, naturalHeight } = event.target
    if (!naturalWidth) return
    const displayImages = images.length > 0 ? images : viewerImages
    const activeImage = displayImages[Math.min(Math.max(viewerIndex, 0), displayImages.length - 1)]
    if (!activeImage || (activeImage.width === naturalWidth && activeImage.height === naturalHeight)) return

    if (images.length > 0) {
      setImages((current) =>
        current.map((img) =>
          img.id === activeImage.id ? { ...img, width: naturalWidth, height: naturalHeight } : img
        )
      )
    } else {
      setViewerImages((current) =>
        current.map((img) =>
          img.id === activeImage.id ? { ...img, width: naturalWidth, height: naturalHeight } : img
        )
      )
    }
  }

  return (
    <div className="app-shell">
      <div className="bg-orb bg-orb-left" />
      <div className="bg-orb bg-orb-right" />

      <main className="page">
        <section className="hero-panel">
          <div className="hero-actions">
            <button type="button" className="primary-btn" onClick={openPicker}>
              Chọn Folder
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
            <article style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', minHeight: '80px' }}>
              {isLoading ? (
                <span className="loading-spinner" />
              ) : loadDone ? (
                <>
                  <span style={{ color: '#4ade80', fontSize: 'clamp(1.8rem, 4vw, 2.8rem)', fontWeight: 700 }}>OK</span>
                </>
              ) : null}
            </article>
          </div>
        </section>

        <section className="gallery-panel">
          <div className="section-heading">
            <div>
              <p className="section-kicker">Preview list</p>

            </div>
            <p className="section-note">
              {isLoading && 'Đang đọc thông tin ảnh...'}
            </p>
          </div>

          {!images.length ? (
            <div className="empty-gallery">
              <h3>Chưa có ảnh nào được nạp</h3>
            </div>
          ) : (
            <div className="preview-list" role="list">
              {images.slice(0, visibleCount).map((image) => (
                <article key={image.id} className="preview-item" role="listitem">
                  <button type="button" className="preview-button" onClick={() => openImageInNewTab(image)}>
                    <img src={image.url} alt={image.name} loading="lazy" onLoad={(e) => handleThumbnailLoad(image.id, e)} />
                  </button>

                  <div className="preview-meta">
                    <strong title={image.name}>{image.name}</strong>
                    <span>
                      {image.width ? `${image.width} x ${image.height}` : '...'}
                    </span>
                  </div>
                </article>
              ))}
              {visibleCount < images.length && (
                <div className="show-more-actions" style={{
                  gridColumn: '1 / -1',
                  display: 'flex',
                  justifyContent: 'center',
                  gap: '12px',
                  padding: '40px 0'
                }}>
                  <button type="button" className="primary-btn" onClick={() => setVisibleCount(prev => prev + 100)}>
                    Xem thêm 100 ảnh
                  </button>
                  <button type="button" className="ghost-btn" onClick={() => setVisibleCount(images.length)}>
                    Xem tất cả {images.length} ảnh
                  </button>
                </div>
              )}
            </div>
          )}
        </section>
      </main>

    </div>
  )
}
