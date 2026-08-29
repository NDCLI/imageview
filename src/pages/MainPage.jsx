import { createSignal, createEffect, onCleanup, onMount, Show, startTransition } from 'solid-js'
import { clearFolderHandle, getFolderHandle, setFolderHandle } from '../storage'
import { PREVIEW_MAX_DIMENSION, PREVIEW_TAB_NAME, VIEWER_STATE_KEY } from '../lib/constants'
import { parseAnnotations } from '../lib/annotations'
import { openZip } from '../lib/zip-loader'

export default function MainPage(props) {
  const [images, setImages] = createSignal([])
  const [isLoading, setIsLoading] = createSignal(false)
  const [loadDone, setLoadDone] = createSignal(false)
  const [hasSavedFolder, setHasSavedFolder] = createSignal(false)
  const [showReloadPrompt, setShowReloadPrompt] = createSignal(false)
  const [zipEntries, setZipEntries] = createSignal(null)
  const [annotations, setAnnotations] = createSignal({ labels: {}, images: {} })
  const [extractAllMode, setExtractAllMode] = createSignal(false)
  const [isDragging, setIsDragging] = createSignal(false)
  const [dropError, setDropError] = createSignal('')
  const [previewPreparation, setPreviewPreparation] = createSignal({
    completed: 0,
    total: 0,
    error: '',
  })

  let channel = null
  let dragDepth = 0

  const previewsReady = () => {
    const preparation = previewPreparation()
    return (
      Boolean(preparation.error) ||
      preparation.total === 0 ||
      preparation.completed >= preparation.total
    )
  }

  onMount(() => {
    document.title = 'Image View'
    window.name = 'image-preview-main'

    // BroadcastChannel for cross-tab communication (Main side)
    channel = new BroadcastChannel('image-view-channel')

    onCleanup(() => {
      if (channel) channel.close()
      zipEntries()?.terminate()
    })
  })

  // Listen to channel messages for image request
  createEffect(() => {
    const currentZipEntries = zipEntries()
    if (channel) {
      channel.onmessage = async (e) => {
        if (e.data.type === 'REQ_IMG' && currentZipEntries) {
          if (currentZipEntries.paths.includes(e.data.name)) {
            try {
              const blob = await currentZipEntries.getBlob(e.data.name, {
                maxDimension: e.data.maxDimension,
                priority: e.data.priority,
              })
              channel.postMessage({ type: 'RES_IMG', idx: e.data.idx, blob })
            } catch (err) {
              console.error('Lỗi khi đọc blob qua channel:', err)
            }
          }
        }
      }
    }
  })

  // Restore folder handle if available
  onMount(() => {
    getFolderHandle()
      .then(async (handle) => {
        if (handle) {
          setHasSavedFolder(true)
          if (images().length === 0) {
            setShowReloadPrompt(true)
          }
        }
      })
      .catch(() => {})
  })

  // Top Navbar action helpers
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
      await readZipHandle(handle)
    } catch (err) {
      console.error(err)
    }
  }

  async function readZipHandle(fileHandle) {
    await readZipFile(await fileHandle.getFile())
  }

  async function readZipFile(zipFile) {
    zipEntries()?.terminate()
    setZipEntries(null)
    setIsLoading(true)
    setImages([])
    setAnnotations({ labels: {}, images: {} })
    setPreviewPreparation({ completed: 0, total: 0, error: '' })
    try {
      setExtractAllMode(false)
      const zip = await openZip(zipFile)
      setZipEntries(zip)

      const imageData = []
      let annFileContent = null

      for (const path of zip.paths) {
        if (path.match(/\.(png|jpg|jpeg|gif|webp|bmp)$/i)) {
          imageData.push({ name: path })
        } else if (path.endsWith('annotations.xml')) {
          annFileContent = zip.annotationsText
        }
      }

      let parsedAnnotations = { labels: {}, images: {} }
      if (annFileContent) {
        parsedAnnotations = parseAnnotations(annFileContent)
        setAnnotations(parsedAnnotations)
      }

      imageData.sort((a, b) => a.name.localeCompare(b.name))

      const nextRecords = imageData.map((data, index) => {
        const ann =
          parsedAnnotations.images[data.name] ||
          parsedAnnotations.images[data.name.split('/').pop()] ||
          {}
        return {
          id: `${data.name}-${index}`,
          name: data.name,
          width: ann.width || 0,
          height: ann.height || 0,
          url: '',
        }
      })

      startTransition(() => {
        setImages(nextRecords)
      })

      setPreviewPreparation({ completed: 0, total: nextRecords.length, error: '' })
      navigator.storage?.persist?.().catch(() => {})
      void zip
        .warmBlobs(
          nextRecords.map((record) => record.name),
          { maxDimension: PREVIEW_MAX_DIMENSION },
          (completed, total) =>
            setPreviewPreparation((current) => ({ ...current, completed, total })),
        )
        .catch((error) => {
          console.warn('Không thể chuẩn bị toàn bộ preview:', error)
          setPreviewPreparation((current) => ({
            ...current,
            error: 'Không đủ dung lượng hoặc trình duyệt không cho phép lưu OPFS',
          }))
        })
    } catch (err) {
      console.error('Lỗi khi tải lại zip:', err)
      setDropError(`Không thể mở file ZIP: ${err.message || 'lỗi không xác định'}`)
    } finally {
      setIsLoading(false)
      setLoadDone(true)
    }
  }

  async function openZipPicker() {
    try {
      const [fileHandle] = await window.showOpenFilePicker({
        id: 'zip-file',
        types: [{ description: 'ZIP Files', accept: { 'application/zip': ['.zip'] } }],
      })
      await setFolderHandle(fileHandle)
      setHasSavedFolder(true)
      await readZipHandle(fileHandle)
    } catch (err) {
      if (err.name !== 'AbortError') console.error('Lỗi khi xử lý zip:', err)
    }
  }

  function handleDragEnter(event) {
    event.preventDefault()
    dragDepth += 1
    setIsDragging(true)
  }

  function handleDragLeave(event) {
    event.preventDefault()
    dragDepth -= 1
    if (dragDepth <= 0) {
      dragDepth = 0
      setIsDragging(false)
    }
  }

  function handleDragOver(event) {
    event.preventDefault()
    event.dataTransfer.dropEffect = 'copy'
  }

  async function handleDrop(event) {
    event.preventDefault()
    dragDepth = 0
    setIsDragging(false)
    const file = Array.from(event.dataTransfer.files).find((item) =>
      item.name.toLowerCase().endsWith('.zip'),
    )
    if (!file) {
      setDropError('Hãy thả một file ZIP.')
      return
    }

    setDropError('')
    await clearFolderHandle()
    setHasSavedFolder(false)
    await readZipFile(file)
  }

  async function clearImages() {
    setImages([])
    setAnnotations({ labels: {}, images: {} })
    setPreviewPreparation({ completed: 0, total: 0, error: '' })
    zipEntries()?.terminate()
    setZipEntries(null)
    await clearFolderHandle()
    setHasSavedFolder(false)
  }

  async function skipReload() {
    setShowReloadPrompt(false)
    await clearFolderHandle()
    setHasSavedFolder(false)
  }

  function openImageInNewTab(image) {
    const snapshot = images().map((currentImage) => ({
      id: currentImage.id,
      name: currentImage.name,
      width: currentImage.width,
      height: currentImage.height,
    }))

    const currentIndex = snapshot.findIndex((item) => item.id === image.id)
    if (currentIndex < 0) return

    try {
      localStorage.setItem(
        VIEWER_STATE_KEY,
        JSON.stringify({
          images: snapshot,
          selectedImageId: image.id,
          savedAt: Date.now(),
          isExtractAll: extractAllMode(),
        }),
      )
      // Save annotations to local storage too
      localStorage.setItem('local-image-viewer-annotations', JSON.stringify(annotations()))
    } catch (err) {
      console.warn('Không thể lưu trạng thái preview vào localStorage:', err)
    }

    const viewerUrl = `${window.location.pathname}?viewer=1&index=${currentIndex}`
    const newTab = window.open(viewerUrl, PREVIEW_TAB_NAME)
    if (newTab) {
      newTab.focus()
    } else {
      console.warn('Popup bị chặn hoặc không mở được tab mới, chuyển về cùng một tab')
      window.location.assign(viewerUrl)
    }
  }

  return (
    <div class="app-shell">
      <div class="bg-orb bg-orb-left" />
      <div class="bg-orb bg-orb-right" />

      <main
        class="page"
        onDragEnter={handleDragEnter}
        onDragLeave={handleDragLeave}
        onDragOver={handleDragOver}
        onDrop={handleDrop}
      >
        <Show when={isDragging()}>
          <div class="zip-drop-overlay" role="status" aria-live="polite">
            <span>📦</span>
            <strong>Thả file ZIP để mở</strong>
          </div>
        </Show>
        <Show when={dropError()}>
          <p class="drop-error" role="alert">
            {dropError()}
          </p>
        </Show>
        {/* ─── TOP NAVBAR ─── */}
        <header class="hero-panel">
          <div class="navbar-brand">
            <div class="brand-dot" />
            <span>ImageView</span>
          </div>

          <div class="hero-actions">
            <button
              type="button"
              class="primary-btn hero-action-btn"
              onClick={openZipPicker}
              aria-label="Chọn file ZIP"
            >
              ＋ Chọn file ZIP
            </button>
            <Show when={images().length > 0 || hasSavedFolder()}>
              <button
                type="button"
                class="ghost-btn hero-action-btn hero-clear-btn"
                onClick={clearImages}
                aria-label="Xóa dữ liệu ZIP hiện tại"
              >
                Xóa tất cả
              </button>
            </Show>
          </div>

          <div class="hero-stats">
            <Show when={images().length > 0}>
              <article>
                <span>{images().length}</span>
                <p>ảnh</p>
              </article>
            </Show>
            <Show
              when={isLoading()}
              fallback={
                <Show when={loadDone() && images().length > 0}>
                  <span class="stat-ok-badge">Sẵn sàng</span>
                </Show>
              }
            >
              <span class="loading-spinner loading-spinner-small" />
            </Show>
          </div>
        </header>

        {/* ─── RELOAD PROMPT ─── */}
        <Show when={showReloadPrompt()}>
          <div class="reload-banner">
            <div class="reload-banner-copy">
              <span class="reload-banner-icon">💾</span>
              <div>
                <strong>Phát hiện dữ liệu ZIP cũ!</strong>
                <span>Bạn có muốn khôi phục lại file ZIP này không?</span>
              </div>
            </div>
            <div class="reload-banner-actions">
              <button type="button" class="primary-btn reload-banner-btn" onClick={reloadFolder}>
                Khôi phục
              </button>
              <button type="button" class="ghost-btn reload-banner-btn" onClick={skipReload}>
                Bỏ qua
              </button>
            </div>
          </div>
        </Show>

        {/* ─── DASHBOARD ─── */}
        <section class="gallery-panel">
          <Show
            when={images().length > 0}
            fallback={
              <div class="dash-empty">
                <div class="dash-empty-icon">📦</div>
                <h3>Chưa có file nào được mở</h3>
                <p>
                  Nhấn <strong>＋ Chọn file ZIP</strong> ở trên để bắt đầu
                </p>
              </div>
            }
          >
            <div class="dashboard">
              {/* ─── OPEN PREVIEW - CTA ─── */}
              <div class="dash-launch dash-launch-start">
                <div class="dash-launch-info">
                  <div class="dash-launch-icon">🎬</div>
                  <div class="dash-launch-copy">
                    <button
                      type="button"
                      class="dash-open-btn dash-open-btn-compact"
                      onClick={() => openImageInNewTab(images()[0])}
                      disabled={!images().length || !previewsReady()}
                    >
                      <span class="dash-open-icon">▶</span>
                      {previewsReady()
                        ? 'Mở Image View'
                        : `Đang chuẩn bị ${previewPreparation().completed}/${previewPreparation().total}`}
                    </button>
                    <span>Xem và điều hướng ảnh từ file ZIP trong cửa sổ riêng</span>
                  </div>
                </div>
              </div>

              {/* ─── STATS GRID ─── */}
              <div class="dash-stats">
                <div class="dash-stat-card">
                  <div class="dash-stat-icon">🖼</div>
                  <div class="dash-stat-body">
                    <span class="dash-stat-value">{images().length.toLocaleString()}</span>
                    <span class="dash-stat-label">Tổng số ảnh</span>
                  </div>
                </div>

                <div class="dash-stat-card">
                  <div class="dash-stat-icon">📁</div>
                  <div class="dash-stat-body">
                    <span class="dash-stat-value">
                      {(() => {
                        const folders = new Set(
                          images().map((img) => {
                            const parts = img.name.split('/')
                            parts.pop()
                            return parts.join('/') || '/'
                          }),
                        )
                        return folders.size
                      })()}
                    </span>
                    <span class="dash-stat-label">Thư mục</span>
                  </div>
                </div>

                <div class="dash-stat-card">
                  <div class="dash-stat-icon">✅</div>
                  <div class="dash-stat-body">
                    <span class="dash-stat-value dash-stat-value-success">
                      {isLoading()
                        ? 'Đang nạp...'
                        : previewPreparation().error
                          ? previewPreparation().error
                          : !previewsReady()
                            ? `Đang chuẩn bị ${previewPreparation().completed}/${previewPreparation().total}`
                            : loadDone()
                              ? 'Sẵn sàng'
                              : '—'}
                    </span>
                    <span class="dash-stat-label">Trạng thái</span>
                  </div>
                </div>

                <div class="dash-stat-card">
                  <div class="dash-stat-icon">🔖</div>
                  <div class="dash-stat-body">
                    <span class="dash-stat-value">
                      {Object.keys(annotations().labels).length > 0
                        ? Object.keys(annotations().labels).length
                        : '—'}
                    </span>
                    <span class="dash-stat-label">Label</span>
                  </div>
                </div>
              </div>

              {/* ─── FILE INFO ─── */}
              <div class="dash-info-row">
                <div class="dash-info-card">
                  <span class="dash-info-label">🏢 Job ID</span>
                  <span class="dash-info-value">{annotations().jobId || '—'}</span>
                </div>
                <div class="dash-info-card">
                  <span class="dash-info-label">🎬 Frame</span>
                  <span class="dash-info-value">
                    {annotations().startFrame
                      ? `${annotations().startFrame} - ${annotations().stopFrame}`
                      : '—'}
                  </span>
                </div>
                <div class="dash-info-card">
                  <span class="dash-info-label">📦 Nguồn dữ liệu</span>
                  <span class="dash-info-value">ZIP Archive (File System Access API)</span>
                </div>
                <div class="dash-info-card">
                  <span class="dash-info-label">🖼 Ảnh đầu tiên</span>
                  <span class="dash-info-value">{images()[0]?.name.split('/').pop() ?? '—'}</span>
                </div>
                <div class="dash-info-card">
                  <span class="dash-info-label">🖼 Ảnh cuối cùng</span>
                  <span class="dash-info-value">
                    {images()[images().length - 1]?.name.split('/').pop() ?? '—'}
                  </span>
                </div>
              </div>

              {/* ─── SHORTCUTS ─── */}
              <div class="dash-shortcuts">
                <p class="dash-shortcuts-title">⌨️ Phím tắt</p>
                <div class="dash-shortcuts-grid">
                  <div class="dash-shortcut">
                    <kbd>F</kbd> / <kbd>→</kbd>
                    <span>Ảnh tiếp theo</span>
                  </div>
                  <div class="dash-shortcut">
                    <kbd>D</kbd> / <kbd>←</kbd>
                    <span>Ảnh trước</span>
                  </div>
                  <div class="dash-shortcut">
                    <kbd>Cuộn chuột</kbd>
                    <span>Zoom in/out</span>
                  </div>
                  <div class="dash-shortcut">
                    <kbd>Click giữ</kbd>
                    <span>Di chuyển ảnh</span>
                  </div>
                  <div class="dash-shortcut">
                    <kbd>Ctrl+F</kbd>
                    <span>Tìm kiếm theo ID</span>
                  </div>
                  <div class="dash-shortcut">
                    <kbd>Double-click</kbd>
                    <span>Fit về kích thước gốc</span>
                  </div>
                </div>
              </div>
            </div>
          </Show>
        </section>
      </main>
    </div>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// 3. MAIN ROUTER
// ─────────────────────────────────────────────────────────────────────────────
