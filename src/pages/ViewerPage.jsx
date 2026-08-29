import {
  createSignal,
  createEffect,
  createMemo,
  onMount,
  onCleanup,
  Show,
  For,
  startTransition,
  untrack,
} from 'solid-js'
import { getFolderHandle, setFolderHandle, clearFolderHandle } from '../storage'
import {
  PREVIEW_TAB_NAME,
  VIEWER_STATE_KEY,
  MIN_ZOOM,
  MAX_ZOOM,
  PREVIEW_MAX_DIMENSION,
} from '../lib/constants'
import { clamp, findAnnotationKey, getFitState, parseAnnotations } from '../lib/annotations'
import {
  readExtractAllFromStorage,
  readViewerImagesFromStorage,
  writeViewerIndexToUrl,
} from '../lib/viewer-state'
import { openZip } from '../lib/zip-loader'

const PREFETCH_FORWARD_COUNT = 30
const PREFETCH_BACKWARD_COUNT = 4
const PREFETCH_OFFSETS = [
  0,
  ...Array.from({ length: PREFETCH_FORWARD_COUNT }, (_, index) => index + 1),
  ...Array.from({ length: PREFETCH_BACKWARD_COUNT }, (_, index) => -(index + 1)),
]
export default function ViewerPage(props) {
  const [viewerImages, setViewerImages] = createSignal(readViewerImagesFromStorage())
  const [extractAllMode, setExtractAllMode] = createSignal(readExtractAllFromStorage())
  const [viewerIndex, setViewerIndex] = createSignal(props.initialRouteState.index)
  const [searchQuery, setSearchQuery] = createSignal('')
  const [viewerTx, setViewerTx] = createSignal({ scale: 1, panX: 0, panY: 0 })
  const [viewerAnnotations, setViewerAnnotations] = createSignal({ labels: {}, images: {} })
  const [showReloadPrompt, setShowReloadPrompt] = createSignal(false)
  const [showBoxes, setShowBoxes] = createSignal(false)
  const [zipEntries, setZipEntries] = createSignal(null)
  const [extractedUrls, setExtractedUrls] = createSignal({})
  const [displayedViewerIndex, setDisplayedViewerIndex] = createSignal(
    props.initialRouteState.index,
  )
  const [image1Url, setImage1Url] = createSignal('')
  const [image2Url, setImage2Url] = createSignal('')
  const [activeBuffer, setActiveBuffer] = createSignal(1) // 1 or 2
  const decodedUrls = new Set()
  const decodePromises = new Map()
  const paintedUrls = new Set()
  const paintPromises = new Map()

  function activatePaintedBuffer(buffer, url) {
    if (!paintedUrls.has(url)) return
    const bufferUrl = buffer === 1 ? image1Url() : image2Url()
    if (bufferUrl !== url || extractedUrls()[viewerIndex()] !== url) return

    setDisplayedViewerIndex(viewerIndex())
    setActiveBuffer(buffer)
  }

  function prePaintBuffer(buffer, url) {
    if (!url) return
    if (paintedUrls.has(url)) {
      activatePaintedBuffer(buffer, url)
      return
    }
    if (paintPromises.has(url)) return

    const paintPromise = new Promise((resolve) => {
      requestAnimationFrame(() => requestAnimationFrame(resolve))
    })
      .then(() => {
        paintedUrls.add(url)
        activatePaintedBuffer(buffer, url)
      })
      .finally(() => paintPromises.delete(url))

    paintPromises.set(url, paintPromise)
  }

  const displayedImage = () => {
    const list = viewerImages()
    if (list.length === 0) return null
    return list[Math.min(Math.max(displayedViewerIndex(), 0), list.length - 1)]
  }

  createEffect(() => {
    const url = extractedUrls()[viewerIndex()]
    if (!url) return

    const currentActive = activeBuffer()
    const activeUrl = currentActive === 1 ? image1Url() : image2Url()

    // If the target URL is already loaded and active, we just sync displayedViewerIndex immediately
    if (url === activeUrl) {
      setDisplayedViewerIndex(viewerIndex())
      return
    }

    const inactiveUrl = currentActive === 1 ? image2Url() : image1Url()

    if (url === inactiveUrl) {
      activatePaintedBuffer(currentActive === 1 ? 2 : 1, url)
      return
    }

    // If the active buffer is empty (initial load), load directly into it
    if (currentActive === 1 && !image1Url()) {
      setImage1Url(url)
      setDisplayedViewerIndex(viewerIndex()) // sync immediately for first load
      return
    }
    if (currentActive === 2 && !image2Url()) {
      setImage2Url(url)
      setDisplayedViewerIndex(viewerIndex()) // sync immediately for first load
      return
    }

    // Otherwise, load into the inactive buffer to prevent flash
    if (currentActive === 1) {
      setImage2Url(url)
    } else {
      setImage1Url(url)
    }
  })

  function preDecodeUrl(url) {
    if (decodedUrls.has(url)) return Promise.resolve()
    if (decodePromises.has(url)) return decodePromises.get(url)

    const img = new Image()
    img.src = url
    const decodePromise = (
      img.decode
        ? img.decode()
        : new Promise((resolve, reject) => {
            img.onload = resolve
            img.onerror = reject
          })
    )
      .then(() => decodedUrls.add(url))
      .catch(() => {})
      .finally(() => decodePromises.delete(url))

    decodePromises.set(url, decodePromise)
    return decodePromise
  }

  let searchInput
  let viewerStage = null
  let viewerDrag = null
  let viewerTouch = null
  let lastFitScale = 1
  let channel = null
  const requestedImages = new Set()

  const activeImage = () => {
    const list = viewerImages()
    if (list.length === 0) return null
    return list[Math.min(Math.max(viewerIndex(), 0), list.length - 1)]
  }

  onMount(() => {
    document.title = 'Image View'
    window.name = PREVIEW_TAB_NAME

    // BroadcastChannel for cross-tab communication (Viewer side)
    channel = new BroadcastChannel('image-view-channel')
    channel.onmessage = async (e) => {
      if (e.data.type === 'RES_IMG') {
        const url = URL.createObjectURL(e.data.blob)
        await preDecodeUrl(url)
        setExtractedUrls((prev) => {
          if (prev[e.data.idx]) {
            decodedUrls.delete(url)
            paintedUrls.delete(url)
            URL.revokeObjectURL(url)
            return prev
          }
          return { ...prev, [e.data.idx]: url }
        })
        setShowReloadPrompt(false)
      }
    }

    onCleanup(() => {
      if (channel) channel.close()
    })
  })

  // Restore annotations from localStorage first (fallback)
  onMount(() => {
    try {
      const raw = localStorage.getItem('local-image-viewer-annotations')
      if (raw) {
        const parsed = JSON.parse(raw)
        if (parsed && parsed.labels && parsed.images) {
          setViewerAnnotations(parsed)
        }
      }
    } catch (e) {
      console.warn('Không thể đọc annotations từ localStorage:', e)
    }
  })

  // Restore folder handle if available (zip annotations will override localStorage)
  onMount(() => {
    getFolderHandle()
      .then(async (handle) => {
        if (handle) {
          try {
            const perm = await handle.queryPermission({ mode: 'read' })
            if (perm !== 'granted') {
              setShowReloadPrompt(true)
              return
            }
            const zipFile = await handle.getFile()
            setExtractAllMode(false)
            zipEntries()?.terminate()
            const zip = await openZip(zipFile)
            setZipEntries(zip)
            const annFileContent = zip.annotationsText
            if (annFileContent) {
              const parsed = parseAnnotations(annFileContent)
              setViewerAnnotations(parsed)
            }
          } catch (e) {
            console.error('Lỗi khi nạp zip trong viewer:', e)
            setShowReloadPrompt(true)
          }
        }
      })
      .catch(() => {})
  })

  onCleanup(() => {
    // Revoke all created URLs
    Object.values(extractedUrls()).forEach((url) => URL.revokeObjectURL(url))
    decodedUrls.clear()
    decodePromises.clear()
    paintedUrls.clear()
    paintPromises.clear()
    zipEntries()?.terminate()
  })

  // Sliding window pre-fetching effect
  createEffect(() => {
    const displayImages = viewerImages()
    if (displayImages.length === 0) return

    const activeIdx = viewerIndex()
    let timer

    untrack(() => {
      const isExtractAll = extractAllMode()

      if (isExtractAll) {
        const fetchImage = (idx, priority = false) => {
          if (extractedUrls()[idx] || (requestedImages.has(idx) && !priority)) return
          const imgRecord = displayImages[idx]
          if (!imgRecord) return

          const entries = zipEntries()
          if (entries) {
            if (entries.paths.includes(imgRecord.name)) {
              requestedImages.add(idx)
              entries
                .getBlob(imgRecord.name, {
                  maxDimension: PREVIEW_MAX_DIMENSION,
                  priority,
                })
                .then((blob) => {
                  const url = URL.createObjectURL(blob)
                  preDecodeUrl(url)
                  setExtractedUrls((current) => ({ ...current, [idx]: url }))
                })
            }
          } else if (channel) {
            requestedImages.add(idx)
            channel.postMessage({
              type: 'REQ_IMG',
              idx,
              name: imgRecord.name,
              maxDimension: PREVIEW_MAX_DIMENSION,
              priority,
            })
          }
        }

        fetchImage(activeIdx, true)
        displayImages.forEach((_, idx) => {
          if (idx !== activeIdx) fetchImage(idx)
        })
      } else {
        const neighborRange = new Set()
        for (const offset of PREFETCH_OFFSETS) {
          const idx = activeIdx + offset
          if (idx >= 0 && idx < displayImages.length) {
            neighborRange.add(idx)
          }
        }

        // Clean up URLs out of neighbor range IMMEDIATELY
        setExtractedUrls((prev) => {
          const nextUrls = { ...prev }
          let changed = false
          Object.keys(nextUrls).forEach((idxStr) => {
            const idx = parseInt(idxStr, 10)
            const url = nextUrls[idx]
            const isBufferUrl = url === image1Url() || url === image2Url()
            if (!neighborRange.has(idx) && !isBufferUrl) {
              decodedUrls.delete(url)
              paintedUrls.delete(url)
              URL.revokeObjectURL(nextUrls[idx])
              delete nextUrls[idx]
              requestedImages.delete(idx)
              changed = true
            }
          })
          return changed ? nextUrls : prev
        })

        const fetchImage = (idx, priority = false) => {
          if (extractedUrls()[idx] || (requestedImages.has(idx) && !priority)) return
          const imgRecord = displayImages[idx]
          if (!imgRecord) return

          const entries = zipEntries()
          if (entries) {
            if (entries.paths.includes(imgRecord.name)) {
              requestedImages.add(idx)
              entries
                .getBlob(imgRecord.name, {
                  maxDimension: PREVIEW_MAX_DIMENSION,
                  priority,
                })
                .then(async (blob) => {
                  const url = URL.createObjectURL(blob)
                  await preDecodeUrl(url)
                  setExtractedUrls((current) => {
                    if (neighborRange.has(idx) && !current[idx]) {
                      return { ...current, [idx]: url }
                    } else {
                      decodedUrls.delete(url)
                      paintedUrls.delete(url)
                      URL.revokeObjectURL(url)
                      return current
                    }
                  })
                })
                .catch(() => requestedImages.delete(idx))
            }
          } else if (channel) {
            requestedImages.add(idx)
            channel.postMessage({
              type: 'REQ_IMG',
              idx,
              name: imgRecord.name,
              maxDimension: PREVIEW_MAX_DIMENSION,
              priority,
            })
          }
        }

        fetchImage(activeIdx, true)

        timer = setTimeout(() => {
          PREFETCH_OFFSETS.slice(1).forEach((offset) => {
            const idx = activeIdx + offset
            if (!neighborRange.has(idx)) return
            if (idx !== activeIdx) fetchImage(idx)
          })
        }, 50)
      }
    })

    onCleanup(() => {
      if (timer) clearTimeout(timer)
    })
  })

  // Listen to cross-tab storage changes
  onMount(() => {
    function handleStorage(event) {
      if (event.key === VIEWER_STATE_KEY) {
        requestedImages.clear()
        setViewerImages(readViewerImagesFromStorage())
        setExtractAllMode(readExtractAllFromStorage())
      }
    }
    window.addEventListener('storage', handleStorage)
    onCleanup(() => window.removeEventListener('storage', handleStorage))
  })

  // Sync index with URL and search query
  createEffect(() => {
    const displayImages = viewerImages()
    const maxIndex = Math.max(0, displayImages.length - 1)
    const safeIndex = Math.min(Math.max(viewerIndex(), 0), maxIndex)

    if (safeIndex !== viewerIndex()) {
      setViewerIndex(safeIndex)
      return
    }

    writeViewerIndexToUrl(safeIndex)
    if (displayImages[safeIndex]) {
      if (document.activeElement !== searchInput) {
        setSearchQuery(displayImages[safeIndex].name)
      }
    }
  })

  function goToPreviousImage() {
    setViewerIndex((current) => Math.max(0, current - 1))
  }

  function goToNextImage() {
    const displayImages = viewerImages()
    setViewerIndex((current) => Math.min(displayImages.length - 1, current + 1))
  }

  function constrainViewerPan(tx, stage) {
    if (!stage) return tx
    const { scale, panX, panY } = tx

    const bounds = stage.getBoundingClientRect()
    const stageWidth = bounds.width
    const stageHeight = bounds.height

    const img = displayedImage()
    if (!img || img.width === 0 || img.height === 0) return tx

    const imgWidth = img.width * scale
    const imgHeight = img.height * scale

    const maxPanX = imgWidth + stageWidth * 5
    const maxPanY = imgHeight + stageHeight * 5

    const constrainedPanX = Math.min(Math.max(panX, -maxPanX), maxPanX)
    const constrainedPanY = Math.min(Math.max(panY, -maxPanY), maxPanY)

    return { scale, panX: constrainedPanX, panY: constrainedPanY }
  }

  function resetViewerZoom() {
    const stage = viewerStage
    const img = displayedImage()

    if (stage && img && img.width > 0) {
      const fit = getFitState(img.width, img.height, stage)
      setViewerTx(fit)
      lastFitScale = fit.scale
    } else {
      const reset = { scale: 1, panX: 0, panY: 0 }
      setViewerTx(reset)
      lastFitScale = 1
    }
  }

  // Maintain zoom or reset to fit when switching images
  createEffect(() => {
    // Run this when displayed index actually changes
    const dispIdx = displayedViewerIndex()

    untrack(() => {
      const currentScale = viewerTx().scale
      const isAtFitScale = Math.abs(currentScale - lastFitScale) < 0.01
      const stage = viewerStage
      const img = displayedImage()

      // Image not loaded yet (width=0) — keep current viewerTx, will be handled in onLoad
      if (!img || img.width === 0) return

      if (isAtFitScale) {
        resetViewerZoom()
      }
      // User has zoomed — keep scale + pan exactly as-is for position comparison
    })
  })

  // Fit scale when mode matches
  onMount(() => {
    resetViewerZoom()
  })

  // Wheel zoom effect
  function onWheel(event) {
    event.preventDefault()
    if (!viewerStage) return

    const { scale, panX, panY } = viewerTx()
    const bounds = viewerStage.getBoundingClientRect()
    const cx = event.clientX - bounds.left
    const cy = event.clientY - bounds.top

    const ix = (cx - panX) / scale
    const iy = (cy - panY) / scale

    const zoomFactor = event.deltaY < 0 ? 1.1 : 0.9
    let newScale = scale * zoomFactor

    newScale = Math.min(Math.max(newScale, MIN_ZOOM), MAX_ZOOM)

    const newPanX = cx - ix * newScale
    const newPanY = cy - iy * newScale

    const newTx = { scale: newScale, panX: newPanX, panY: newPanY }
    const constrainedTx = constrainViewerPan(newTx, viewerStage)
    setViewerTx(constrainedTx)
  }

  // Ref callback to cleanly handle mount/unmount event bindings
  const handleStageRef = (el) => {
    if (viewerStage) {
      viewerStage.removeEventListener('wheel', onWheel)
    }
    viewerStage = el
    if (el) {
      el.addEventListener('wheel', onWheel, { passive: false })
    }
  }

  onCleanup(() => {
    if (viewerStage) {
      viewerStage.removeEventListener('wheel', onWheel)
    }
  })

  // Keyboard navigation
  onMount(() => {
    function onKeyDown(event) {
      if ((event.ctrlKey || event.metaKey) && (event.key === 'f' || event.key === 'F')) {
        event.preventDefault()
        if (searchInput) searchInput.focus()
        return
      }

      if (['INPUT', 'TEXTAREA'].includes(event.target.tagName)) return

      if (event.key === 'ArrowRight' || event.key === 'f' || event.key === 'F') {
        goToNextImage()
      } else if (event.key === 'ArrowLeft' || event.key === 'd' || event.key === 'D') {
        goToPreviousImage()
      }
    }

    window.addEventListener('keydown', onKeyDown)
    onCleanup(() => window.removeEventListener('keydown', onKeyDown))
  })

  function handleViewerDoubleClick() {
    resetViewerZoom()
  }

  function handleViewerMouseDown(event) {
    event.preventDefault()
    if (searchInput) searchInput.blur()
    viewerDrag = { lastX: event.clientX, lastY: event.clientY }
    document.body.style.cursor = 'grabbing'
  }

  function handleViewerMouseMove(event) {
    if (!viewerDrag) return

    const dx = event.clientX - viewerDrag.lastX
    const dy = event.clientY - viewerDrag.lastY
    viewerDrag = { lastX: event.clientX, lastY: event.clientY }

    const { scale, panX, panY } = viewerTx()
    const newTx = { scale, panX: panX + dx, panY: panY + dy }
    const constrainedTx = constrainViewerPan(newTx, viewerStage)
    setViewerTx(constrainedTx)
  }

  function handleViewerMouseUp() {
    viewerDrag = null
    document.body.style.cursor = ''
  }

  function getTouchDistance(touches) {
    return Math.hypot(
      touches[0].clientX - touches[1].clientX,
      touches[0].clientY - touches[1].clientY,
    )
  }

  function handleViewerTouchStart(event) {
    if (searchInput) searchInput.blur()
    const { touches } = event
    if (touches.length === 2 && viewerStage) {
      event.preventDefault()
      const bounds = viewerStage.getBoundingClientRect()
      const centerX = (touches[0].clientX + touches[1].clientX) / 2 - bounds.left
      const centerY = (touches[0].clientY + touches[1].clientY) / 2 - bounds.top
      const tx = viewerTx()
      viewerTouch = {
        distance: getTouchDistance(touches),
        tx,
        imageX: (centerX - tx.panX) / tx.scale,
        imageY: (centerY - tx.panY) / tx.scale,
      }
    } else if (touches.length === 1) {
      const touch = touches[0]
      viewerTouch = {
        startX: touch.clientX,
        startY: touch.clientY,
        lastX: touch.clientX,
        lastY: touch.clientY,
        scale: viewerTx().scale,
      }
    }
  }

  function handleViewerTouchMove(event) {
    if (!viewerTouch || !viewerStage) return
    event.preventDefault()
    const { touches } = event
    if (touches.length === 2 && viewerTouch.distance) {
      const bounds = viewerStage.getBoundingClientRect()
      const centerX = (touches[0].clientX + touches[1].clientX) / 2 - bounds.left
      const centerY = (touches[0].clientY + touches[1].clientY) / 2 - bounds.top
      const scale = clamp(
        viewerTouch.tx.scale * (getTouchDistance(touches) / viewerTouch.distance),
        MIN_ZOOM,
        MAX_ZOOM,
      )
      setViewerTx(
        constrainViewerPan(
          {
            scale,
            panX: centerX - viewerTouch.imageX * scale,
            panY: centerY - viewerTouch.imageY * scale,
          },
          viewerStage,
        ),
      )
      return
    }

    if (touches.length === 1 && viewerTouch.lastX != null) {
      const touch = touches[0]
      const tx = viewerTx()
      setViewerTx(
        constrainViewerPan(
          {
            scale: tx.scale,
            panX: tx.panX + touch.clientX - viewerTouch.lastX,
            panY: tx.panY + touch.clientY - viewerTouch.lastY,
          },
          viewerStage,
        ),
      )
      viewerTouch.lastX = touch.clientX
      viewerTouch.lastY = touch.clientY
    }
  }

  function handleViewerTouchEnd() {
    if (
      viewerTouch?.startX != null &&
      Math.abs(viewerTouch.startX - viewerTouch.lastX) >= 64 &&
      Math.abs(viewerTouch.startX - viewerTouch.lastX) >
        Math.abs(viewerTouch.startY - viewerTouch.lastY) &&
      Math.abs(viewerTouch.scale - lastFitScale) < 0.01
    ) {
      if (viewerTouch.startX > viewerTouch.lastX) goToNextImage()
      else goToPreviousImage()
    }
    viewerTouch = null
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

      await readZipHandle(handle)
    } catch (err) {
      console.error(err)
    }
  }

  async function readZipHandle(fileHandle) {
    try {
      const zipFile = await fileHandle.getFile()
      setExtractAllMode(false)
      zipEntries()?.terminate()
      const zip = await openZip(zipFile)
      setZipEntries(zip)
      const annFileContent = zip.annotationsText
      if (annFileContent) {
        const parsed = parseAnnotations(annFileContent)
        setViewerAnnotations(parsed)
      }
    } catch (err) {
      console.error('Lỗi khi tải lại zip:', err)
    }
  }

  async function skipReload() {
    setShowReloadPrompt(false)
    await clearFolderHandle()
  }

  function handleViewerImageLoad(event) {
    const { naturalWidth, naturalHeight } = event.target
    if (!naturalWidth) return

    // Find which index this loaded URL belongs to (not necessarily viewerIndex
    // which may have changed during loading).
    const loadedUrl = event.target.src
    const urls = extractedUrls()
    let loadedIdx = -1
    for (const [idxStr, url] of Object.entries(urls)) {
      if (url === loadedUrl) {
        loadedIdx = parseInt(idxStr, 10)
        break
      }
    }
    if (loadedIdx < 0) return

    const list = viewerImages()
    const img = list[Math.min(Math.max(loadedIdx, 0), list.length - 1)]
    if (!img || img.width > 0 || img.height > 0) return

    const wasZero = !img.width || img.width === 0

    setViewerImages((current) =>
      current.map((item) =>
        item.id === img.id ? { ...item, width: naturalWidth, height: naturalHeight } : item,
      ),
    )

    if (wasZero) {
      setTimeout(() => {
        const currentScale = viewerTx().scale
        const isAtFitScale = Math.abs(currentScale - lastFitScale) < 0.01
        if (isAtFitScale) {
          resetViewerZoom()
        }
      }, 0)
    }
  }

  // Memoised annotation data for the currently displayed image.
  // Replaces three separate helpers that each duplicated the foundKey lookup.
  const currentAnnotation = createMemo(() => {
    const img = displayedImage()
    const currentAnnotations = viewerAnnotations()
    if (!img) return null
    const foundKey = findAnnotationKey(
      img,
      currentAnnotations.images,
      currentAnnotations.lookupById,
      currentAnnotations.lookupByName,
    )
    return foundKey ? currentAnnotations.images[foundKey] : null
  })

  const getAnnotationViewBox = (img) => {
    const ann = currentAnnotation()
    if (ann && ann.width && ann.height) {
      return `0 0 ${ann.width} ${ann.height}`
    }
    return img && img.width && img.height ? `0 0 ${img.width} ${img.height}` : undefined
  }

  const getBoxes = () => {
    const ann = currentAnnotation()
    return {
      boxes: ann?.boxes || [],
      labels: viewerAnnotations().labels,
    }
  }

  const getAnnotationIdText = () => {
    const ann = currentAnnotation()
    return ann ? `ID: ${ann.id}` : 'No ID'
  }

  return (
    <main class="viewer-shell viewer-shell-contained">
      <Show when={showReloadPrompt()}>
        <div class="reload-overlay">
          <div class="reload-overlay-copy">
            <strong>Cần nạp lại dữ liệu ảnh!</strong>
            <span>Tab chính đã đóng hoặc dữ liệu cũ hết hạn. Bấm để khôi phục.</span>
          </div>
          <div class="reload-overlay-actions">
            <button type="button" class="primary-btn reload-overlay-btn" onClick={reloadFolder}>
              Tải lại
            </button>
            <button type="button" class="ghost-btn reload-overlay-btn" onClick={skipReload}>
              Bỏ qua
            </button>
          </div>
        </div>
      </Show>

      <section class="viewer-panel">
        <Show
          when={activeImage()}
          fallback={
            <div class="empty-gallery">
              <h3>Tab preview chưa có dữ liệu ảnh</h3>
              <p>Quay lại tab chính và bấm vào một ảnh để nạp danh sách vào đây.</p>
            </div>
          }
        >
          {(img) => (
            <>
              <div
                ref={handleStageRef}
                class="viewer-stage"
                role="img"
                tabindex="0"
                aria-label={`Xem ảnh ${displayedImage()?.name || ''}. Dùng mũi tên trái và phải để chuyển ảnh.`}
                style={{ cursor: viewerTx().scale > 1 ? 'grab' : 'default' }}
                onMouseDown={handleViewerMouseDown}
                onMouseMove={handleViewerMouseMove}
                onMouseUp={handleViewerMouseUp}
                onMouseLeave={handleViewerMouseUp}
                onDblClick={handleViewerDoubleClick}
                onTouchStart={handleViewerTouchStart}
                onTouchMove={handleViewerTouchMove}
                onTouchEnd={handleViewerTouchEnd}
                onTouchCancel={handleViewerTouchEnd}
              >
                <div
                  class="viewer-image-container"
                  style={{
                    position: 'absolute',
                    top: 0,
                    left: 0,
                    transform: `translate(${viewerTx().panX}px, ${viewerTx().panY}px) scale(${viewerTx().scale})`,
                    'transform-origin': '0 0',
                    width: displayedImage()?.width ? `${displayedImage().width}px` : 'auto',
                    height: displayedImage()?.height ? `${displayedImage().height}px` : 'auto',
                  }}
                >
                  <img
                    src={image1Url()}
                    alt={displayedImage()?.name}
                    onLoad={(e) => {
                      handleViewerImageLoad(e)
                      prePaintBuffer(1, e.currentTarget.src)
                    }}
                    class="viewer-image"
                    style={{
                      position: 'absolute',
                      top: 0,
                      left: 0,
                      width: '100%',
                      height: '100%',
                      opacity: 1,
                      'z-index': activeBuffer() === 1 ? 2 : 1,
                      'pointer-events': activeBuffer() === 1 ? 'auto' : 'none',
                      display: image1Url() ? 'block' : 'none',
                    }}
                  />
                  <img
                    src={image2Url()}
                    alt={displayedImage()?.name}
                    onLoad={(e) => {
                      handleViewerImageLoad(e)
                      prePaintBuffer(2, e.currentTarget.src)
                    }}
                    class="viewer-image"
                    style={{
                      position: 'absolute',
                      top: 0,
                      left: 0,
                      width: '100%',
                      height: '100%',
                      opacity: 1,
                      'z-index': activeBuffer() === 2 ? 2 : 1,
                      'pointer-events': activeBuffer() === 2 ? 'auto' : 'none',
                      display: image2Url() ? 'block' : 'none',
                    }}
                  />
                  <Show when={!extractedUrls()[viewerIndex()] && !image1Url() && !image2Url()}>
                    <div
                      style={{
                        display: 'flex',
                        'align-items': 'center',
                        'justify-content': 'center',
                        width: '100%',
                        height: '100%',
                        'min-height': '300px',
                      }}
                    >
                      <span class="loading-spinner" />
                    </div>
                  </Show>

                  <Show when={showBoxes()}>
                    <svg
                      class="viewer-annotations"
                      viewBox={getAnnotationViewBox(displayedImage())}
                      style={{
                        position: 'absolute',
                        top: 0,
                        left: 0,
                        width: '100%',
                        height: '100%',
                        'pointer-events': 'none',
                      }}
                    >
                      {(() => {
                        const data = getBoxes()
                        return (
                          <For each={data.boxes}>
                            {(box) => {
                              const labelColor = data.labels[box.label] || '#ff0000'
                              return (
                                <g>
                                  <rect
                                    x={box.xtl}
                                    y={box.ytl}
                                    width={box.xbr - box.xtl}
                                    height={box.ybr - box.ytl}
                                    fill="transparent"
                                    stroke={labelColor}
                                    stroke-width={2 / viewerTx().scale}
                                  />
                                  <text
                                    x={box.xtl}
                                    y={box.ytl - 2 / viewerTx().scale}
                                    fill="#ffffff"
                                    style={{
                                      'font-size': `${12 / viewerTx().scale}px`,
                                      'font-weight': 'bold',
                                      'paint-order': 'stroke',
                                      stroke: labelColor,
                                      'stroke-width': `${3 / viewerTx().scale}px`,
                                      'dominant-baseline': 'text-after-edge',
                                    }}
                                  >
                                    {box.label}
                                  </text>
                                </g>
                              )
                            }}
                          </For>
                        )
                      })()}
                    </svg>
                  </Show>
                </div>
              </div>

              <div class="viewer-meta viewer-meta-content">
                <input
                  ref={searchInput}
                  type="text"
                  value={searchQuery()}
                  onInput={(e) => {
                    const query = e.target.value.trim()
                    setSearchQuery(query)
                    if (!query) return

                    const displayList = viewerImages()
                    const currentAnns = viewerAnnotations()
                    let foundIndex = -1

                    const isNumeric = /^\d+$/.test(query)
                    if (isNumeric) {
                      const foundKey = Object.keys(currentAnns.images).find((k) => {
                        const ann = currentAnns.images[k]
                        return ann && ann.id !== null && ann.id.toString() === query
                      })

                      if (foundKey) {
                        const cleanKey = foundKey.toLowerCase().split('/').pop()
                        foundIndex = displayList.findIndex((item) => {
                          const imgName = item.name.toLowerCase()
                          return imgName === foundKey.toLowerCase() || imgName.endsWith(cleanKey)
                        })
                      }
                    }

                    if (foundIndex === -1) {
                      foundIndex = displayList.findIndex((item) =>
                        item.name.toLowerCase().includes(query.toLowerCase()),
                      )
                    }

                    if (foundIndex !== -1 && foundIndex !== viewerIndex()) {
                      setViewerIndex(foundIndex)
                    }
                  }}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === 'Escape') {
                      e.target.blur()
                    }
                  }}
                  onFocus={() => setSearchQuery('')}
                  onBlur={() => {
                    const displayList = viewerImages()
                    if (displayList[viewerIndex()]) {
                      setSearchQuery(displayList[viewerIndex()].name)
                    }
                  }}
                  class="viewer-search-input"
                  aria-label="Tìm kiếm ảnh theo tên hoặc ID annotation"
                  placeholder="Dán hoặc nhập tên ảnh để tìm..."
                  title="Tìm kiếm tên ảnh"
                />
                <button
                  class={`box-toggle-btn ${showBoxes() ? 'active' : ''}`}
                  onClick={() => setShowBoxes(!showBoxes())}
                  title={showBoxes() ? 'Ẩn các box annotation' : 'Hiện các box annotation'}
                  aria-pressed={showBoxes()}
                >
                  {showBoxes() ? 'Hide Boxes' : 'Show Boxes'}
                </button>
                <span>
                  • Job: {viewerAnnotations().jobId || 'N/A'}
                  <span class="viewer-separator">•</span>
                  {viewerIndex() + 1}/{viewerImages().length}
                  <span class="viewer-separator">•</span>
                  {getAnnotationIdText()}
                  <span class="viewer-separator">•</span>
                  {displayedImage()?.width || 0} x {displayedImage()?.height || 0} • Zoom{' '}
                  {Math.round(viewerTx().scale * 100)}% • ← → để chuyển
                </span>
              </div>
            </>
          )}
        </Show>
      </section>
    </main>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// 2. MAIN PAGE COMPONENT
// ─────────────────────────────────────────────────────────────────────────────
