import { createSignal, createEffect, onMount, onCleanup, Show, For, startTransition, untrack } from 'solid-js'
import { unzip } from 'unzipit'
import { getFolderHandle, setFolderHandle, clearFolderHandle } from './storage'

const PREVIEW_TAB_NAME = 'image-viewer-tab'
const VIEWER_STATE_KEY = 'local-image-viewer-state'
const MIN_ZOOM = 0.05
const MAX_ZOOM = 100

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max)
}

function parseAnnotations(xmlText) {
  const parser = new DOMParser()
  const xmlDoc = parser.parseFromString(xmlText, 'text/xml')
  const labels = {}
  const images = {}
  
  const jobNode = xmlDoc.querySelector('meta > job > id')
  const jobId = jobNode ? jobNode.textContent : ''
  
  const startFrameNode = xmlDoc.querySelector('meta > job > start_frame')
  const stopFrameNode = xmlDoc.querySelector('meta > job > stop_frame')
  const startFrame = startFrameNode ? startFrameNode.textContent : ''
  const stopFrame = stopFrameNode ? stopFrameNode.textContent : ''

  // Parse labels/colors
  const labelNodes = xmlDoc.querySelectorAll('label')
  labelNodes.forEach(node => {
    const name = node.querySelector('name')?.textContent
    const color = node.querySelector('color')?.textContent
    if (name && color) labels[name] = color
  })

  // Parse images and boxes
  const imageNodes = xmlDoc.querySelectorAll('image')
  imageNodes.forEach(node => {
    const name = node.getAttribute('name')
    const id = node.getAttribute('id')
    const width = parseInt(node.getAttribute('width'))
    const height = parseInt(node.getAttribute('height'))
    const boxes = []
    const boxNodes = node.querySelectorAll('box')
    boxNodes.forEach(box => {
      boxes.push({
        label: box.getAttribute('label'),
        xtl: parseFloat(box.getAttribute('xtl')),
        ytl: parseFloat(box.getAttribute('ytl')),
        xbr: parseFloat(box.getAttribute('xbr')),
        ybr: parseFloat(box.getAttribute('ybr'))
      })
    })
    images[name] = { id, width, height, boxes }
  })

  return { labels, images, jobId, startFrame, stopFrame }
}

function getFitState(imageWidth, imageHeight, stage) {
  if (!stage || !imageWidth || !imageHeight) return { scale: 1, panX: 0, panY: 0 }
  
  const bounds = stage.getBoundingClientRect()
  const sw = bounds.width
  const sh = bounds.height
  
  const scale = Math.min(sw / imageWidth, sh / imageHeight, 1.5) // Max 1.5x upscaling automatically
  const panX = (sw - imageWidth * scale) / 2
  const panY = (sh - imageHeight * scale) / 2
  
  return { scale, panX, panY }
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

function readExtractAllFromStorage() {
  try {
    const raw = localStorage.getItem(VIEWER_STATE_KEY)
    if (raw) {
      return !!JSON.parse(raw).isExtractAll
    }
  } catch {}
  return false
}

function writeViewerIndexToUrl(index) {
  const params = new URLSearchParams(window.location.search)
  params.set('viewer', '1')
  params.set('index', String(index))
  window.history.replaceState(null, '', `${window.location.pathname}?${params.toString()}`)
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. VIEWER PAGE COMPONENT
// ─────────────────────────────────────────────────────────────────────────────
function ViewerPage(props) {
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
  const [displayedViewerIndex, setDisplayedViewerIndex] = createSignal(props.initialRouteState.index)
  const [image1Url, setImage1Url] = createSignal('')
  const [image2Url, setImage2Url] = createSignal('')
  const [activeBuffer, setActiveBuffer] = createSignal(1) // 1 or 2

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
    
    // If the target URL is already in the inactive buffer, it won't fire onLoad again.
    // So we can just swap buffers and sync index immediately.
    if (url === inactiveUrl) {
      setDisplayedViewerIndex(viewerIndex())
      setActiveBuffer(currentActive === 1 ? 2 : 1)
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

  // Pre-decode image so browser has it ready to paint instantly
  function preDecodeUrl(url) {
    const img = new Image()
    img.src = url
    if (img.decode) img.decode().catch(() => {})
  }
  
  let searchInput
  let viewerStage = null
  let viewerDrag = null
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
    channel.onmessage = (e) => {
      if (e.data.type === 'RES_IMG') {
        const url = URL.createObjectURL(e.data.blob)
        preDecodeUrl(url)
        setExtractedUrls(prev => {
          if (prev[e.data.idx]) URL.revokeObjectURL(prev[e.data.idx])
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
    getFolderHandle().then(async (handle) => {
      if (handle) {
        try {
          const perm = await handle.queryPermission({ mode: 'read' })
          if (perm !== 'granted') {
            setShowReloadPrompt(true)
            return
          }
          const zipFile = await handle.getFile()
          setExtractAllMode(zipFile.size < 1024 * 1024 * 1024)
          const { entries } = await unzip(zipFile)
          setZipEntries(entries)
          
          let annFileContent = null
          for (const [path, entry] of Object.entries(entries)) {
            if (path.endsWith('annotations.xml')) {
              annFileContent = await entry.text()
              break
            }
          }
          if (annFileContent) {
            const parsed = parseAnnotations(annFileContent)
            setViewerAnnotations(parsed)
          }
        } catch (e) {
          console.error('Lỗi khi nạp zip trong viewer:', e)
          setShowReloadPrompt(true)
        }
      }
    }).catch(() => { })
  })

  onCleanup(() => {
    // Revoke all created URLs
    Object.values(extractedUrls()).forEach(url => URL.revokeObjectURL(url))
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
        const fetchImage = (idx) => {
          if (requestedImages.has(idx) || extractedUrls()[idx]) return
          const imgRecord = displayImages[idx]
          if (!imgRecord) return

          const entries = zipEntries()
          if (entries) {
            const entry = entries[imgRecord.name]
            if (entry) {
              requestedImages.add(idx)
              entry.blob().then(blob => {
                const url = URL.createObjectURL(blob)
                preDecodeUrl(url)
                setExtractedUrls(current => ({ ...current, [idx]: url }))
              })
            }
          } else if (channel) {
            requestedImages.add(idx)
            channel.postMessage({ type: 'REQ_IMG', idx, name: imgRecord.name })
          }
        }

        displayImages.forEach((_, idx) => fetchImage(idx))
      } else {
        const neighborRange = new Set()
        for (let offset = -2; offset <= 2; offset++) {
          const idx = activeIdx + offset
          if (idx >= 0 && idx < displayImages.length) {
            neighborRange.add(idx)
          }
        }

        // Clean up URLs out of neighbor range IMMEDIATELY
        setExtractedUrls(prev => {
          const nextUrls = { ...prev }
          let changed = false
          Object.keys(nextUrls).forEach(idxStr => {
            const idx = parseInt(idxStr, 10)
            if (!neighborRange.has(idx)) {
              URL.revokeObjectURL(nextUrls[idx])
              delete nextUrls[idx]
              requestedImages.delete(idx)
              changed = true
            }
          })
          return changed ? nextUrls : prev
        })

        const fetchImage = (idx) => {
          if (requestedImages.has(idx) || extractedUrls()[idx]) return
          const imgRecord = displayImages[idx]
          if (!imgRecord) return

          const entries = zipEntries()
          if (entries) {
            const entry = entries[imgRecord.name]
            if (entry) {
              requestedImages.add(idx)
              entry.blob().then(blob => {
                const url = URL.createObjectURL(blob)
                preDecodeUrl(url)
                setExtractedUrls(current => {
                  if (neighborRange.has(idx) && !current[idx]) {
                    return { ...current, [idx]: url }
                  } else {
                    URL.revokeObjectURL(url)
                    return current
                  }
                })
              })
            }
          } else if (channel) {
            requestedImages.add(idx)
            channel.postMessage({ type: 'REQ_IMG', idx, name: imgRecord.name })
          }
        }

        fetchImage(activeIdx)

        timer = setTimeout(() => {
          neighborRange.forEach(idx => {
            if (idx !== activeIdx) fetchImage(idx)
          })
        }, 150)
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
      setExtractAllMode(zipFile.size < 1024 * 1024 * 1024)
      const { entries } = await unzip(zipFile)
      setZipEntries(entries)

      let annFileContent = null
      for (const [path, entry] of Object.entries(entries)) {
        if (path.endsWith('annotations.xml')) {
          annFileContent = await entry.text()
          break
        }
      }
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
    
    // Guard against race conditions when loading fast
    const targetUrl = extractedUrls()[viewerIndex()]
    if (event.target.src !== targetUrl) {
      return
    }

    const list = viewerImages()
    const img = list[Math.min(Math.max(viewerIndex(), 0), list.length - 1)]
    if (!img || (img.width === naturalWidth && img.height === naturalHeight)) return

    const wasZero = !img.width || img.width === 0

    setViewerImages((current) =>
      current.map((item) =>
        item.id === img.id ? { ...item, width: naturalWidth, height: naturalHeight } : item
      )
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



  // Annotation utility helpers
  const getAnnotationViewBox = (img) => {
    if (!img) return undefined
    const currentAnnotations = viewerAnnotations()
    const activeName = img.name.toLowerCase()
    const simpleActiveName = img.name.split('/').pop().toLowerCase()
    const cleanActiveName = simpleActiveName.replace(/\.[^/.]+$/, "")
    
    const foundKey = Object.keys(currentAnnotations.images).find(k => {
      const kn = k.toLowerCase()
      if (kn === activeName || kn === simpleActiveName) return true
      const skn = k.split('/').pop().toLowerCase()
      if (skn === simpleActiveName) return true
      const ckn = skn.replace(/\.[^/.]+$/, "")
      if (ckn === cleanActiveName) return true
      
      const ann = currentAnnotations.images[k]
      if (ann && ann.id !== null) {
         const idStr = ann.id.toString()
         if (cleanActiveName === idStr) return true
         const nameNum = cleanActiveName.match(/\d+$/)?.[0]
         if (nameNum && parseInt(nameNum) === parseInt(idStr)) return true
      }
      return false
    })
    
    const annotationData = foundKey ? currentAnnotations.images[foundKey] : null
    if (annotationData && annotationData.width && annotationData.height) {
      return `0 0 ${annotationData.width} ${annotationData.height}`
    }
    return img.width && img.height ? `0 0 ${img.width} ${img.height}` : undefined
  }

  const getBoxes = (img) => {
    if (!img) return { boxes: [], labels: {} }
    const currentAnnotations = viewerAnnotations()
    const activeName = img.name.toLowerCase()
    const simpleActiveName = img.name.split('/').pop().toLowerCase()
    const cleanActiveName = simpleActiveName.replace(/\.[^/.]+$/, "")
    
    const foundKey = Object.keys(currentAnnotations.images).find(k => {
      const kn = k.toLowerCase()
      if (kn === activeName || kn === simpleActiveName) return true
      const skn = k.split('/').pop().toLowerCase()
      if (skn === simpleActiveName) return true
      const ckn = skn.replace(/\.[^/.]+$/, "")
      if (ckn === cleanActiveName) return true
      
      const ann = currentAnnotations.images[k]
      if (ann && ann.id !== null) {
         const idStr = ann.id.toString()
         if (cleanActiveName === idStr) return true
         const nameNum = cleanActiveName.match(/\d+$/)?.[0]
         if (nameNum && parseInt(nameNum) === parseInt(idStr)) return true
      }
      return false
    })
    
    const annotationData = foundKey ? currentAnnotations.images[foundKey] : null
    return {
      boxes: annotationData?.boxes || [],
      labels: currentAnnotations.labels
    }
  }

  const getAnnotationIdText = (img) => {
    if (!img) return 'No ID'
    const currentAnnotations = viewerAnnotations()
    const activeName = img.name.toLowerCase()
    const simpleActiveName = img.name.split('/').pop().toLowerCase()
    const cleanActiveName = simpleActiveName.replace(/\.[^/.]+$/, "")
    
    const foundKey = Object.keys(currentAnnotations.images).find(k => {
      const kn = k.toLowerCase()
      if (kn === activeName || kn === simpleActiveName) return true
      const skn = k.split('/').pop().toLowerCase()
      if (skn === simpleActiveName) return true
      const ckn = skn.replace(/\.[^/.]+$/, "")
      if (ckn === cleanActiveName) return true
      
      const ann = currentAnnotations.images[k]
      if (ann && ann.id !== null) {
         const idStr = ann.id.toString()
         if (cleanActiveName === idStr) return true
         const nameNum = cleanActiveName.match(/\d+$/)?.[0]
         if (nameNum && parseInt(nameNum) === parseInt(idStr)) return true
      }
      return false
    })
    const annotationData = foundKey ? currentAnnotations.images[foundKey] : null
    return annotationData ? `ID: ${annotationData.id}` : 'No ID'
  }

  return (
    <main class="viewer-shell" style={{ position: 'relative', overflow: 'hidden' }}>
      <Show when={showReloadPrompt()}>
        <div class="reload-overlay" style={{
          position: 'fixed',
          top: '20px',
          left: '50%',
          transform: 'translateX(-50%)',
          "z-index": 1000,
          width: 'min(600px, 90%)',
          padding: '16px',
          background: 'rgba(20, 30, 45, 0.95)',
          "border-radius": '12px',
          border: '1px solid rgba(255,255,255,0.2)',
          display: 'flex',
          "align-items": 'center',
          "justify-content": 'space-between',
          gap: '16px',
          "box-shadow": '0 10px 30px rgba(0,0,0,0.5)',
          "backdrop-filter": 'blur(10px)'
        }}>
          <div style={{ "text-align": 'left' }}>
            <strong style={{ display: 'block', color: 'white' }}>Cần nạp lại dữ liệu ảnh!</strong>
            <span style={{ "font-size": '0.85em', color: 'rgba(255,255,255,0.7)' }}>Tab chính đã đóng hoặc dữ liệu cũ hết hạn. Bấm để khôi phục.</span>
          </div>
          <div style={{ display: 'flex', gap: '8px' }}>
            <button type="button" class="primary-btn" onClick={reloadFolder} style={{ padding: '8px 16px', "font-size": '0.9em' }}>
              Tải lại
            </button>
            <button type="button" class="ghost-btn" onClick={skipReload} style={{ padding: '8px 16px', "font-size": '0.9em' }}>
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
                style={{ cursor: viewerTx().scale > 1 ? 'grab' : 'default' }}
                onMouseDown={handleViewerMouseDown}
                onMouseMove={handleViewerMouseMove}
                onMouseUp={handleViewerMouseUp}
                onMouseLeave={handleViewerMouseUp}
                onDblClick={handleViewerDoubleClick}
              >
                <div
                  class="viewer-image-container"
                  style={{
                    position: 'absolute',
                    top: 0,
                    left: 0,
                    transform: `translate(${viewerTx().panX}px, ${viewerTx().panY}px) scale(${viewerTx().scale})`,
                    "transform-origin": '0 0',
                    width: displayedImage()?.width ? `${displayedImage().width}px` : 'auto',
                    height: displayedImage()?.height ? `${displayedImage().height}px` : 'auto',
                  }}
                >
                  <img
                    src={image1Url()}
                    alt={displayedImage()?.name}
                    onLoad={(e) => {
                      handleViewerImageLoad(e)
                      if (activeBuffer() === 2 && image1Url() === extractedUrls()[viewerIndex()]) {
                        setDisplayedViewerIndex(viewerIndex())
                        setActiveBuffer(1)
                      }
                    }}
                    class="viewer-image"
                    style={{
                      position: 'absolute',
                      top: 0,
                      left: 0,
                      width: '100%',
                      height: '100%',
                      opacity: activeBuffer() === 1 ? 1 : 0,
                      "pointer-events": activeBuffer() === 1 ? 'auto' : 'none',
                      display: image1Url() ? 'block' : 'none',
                    }}
                  />
                  <img
                    src={image2Url()}
                    alt={displayedImage()?.name}
                    onLoad={(e) => {
                      handleViewerImageLoad(e)
                      if (activeBuffer() === 1 && image2Url() === extractedUrls()[viewerIndex()]) {
                        setDisplayedViewerIndex(viewerIndex())
                        setActiveBuffer(2)
                      }
                    }}
                    class="viewer-image"
                    style={{
                      position: 'absolute',
                      top: 0,
                      left: 0,
                      width: '100%',
                      height: '100%',
                      opacity: activeBuffer() === 2 ? 1 : 0,
                      "pointer-events": activeBuffer() === 2 ? 'auto' : 'none',
                      display: image2Url() ? 'block' : 'none',
                    }}
                  />
                  <Show when={!extractedUrls()[viewerIndex()] && !image1Url() && !image2Url()}>
                    <div style={{ display: 'flex', "align-items": 'center', "justify-content": 'center', width: '100%', height: '100%', "min-height": '300px' }}>
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
                        "pointer-events": 'none',
                      }}
                    >
                      {(() => {
                        const data = getBoxes(displayedImage())
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
                                      "font-size": `${12 / viewerTx().scale}px`,
                                      "font-weight": 'bold',
                                      "paint-order": 'stroke',
                                      stroke: labelColor,
                                      "stroke-width": `${3 / viewerTx().scale}px`,
                                      "dominant-baseline": 'text-after-edge'
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

              <div class="viewer-meta" style={{ display: 'flex', "align-items": 'center', gap: '8px', "flex-wrap": 'wrap', "justify-content": 'center' }}>
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
                      const foundKey = Object.keys(currentAnns.images).find(k => {
                        const ann = currentAnns.images[k]
                        return ann && ann.id !== null && ann.id.toString() === query
                      })

                      if (foundKey) {
                        const cleanKey = foundKey.toLowerCase().split('/').pop()
                        foundIndex = displayList.findIndex(item => {
                          const imgName = item.name.toLowerCase()
                          return imgName === foundKey.toLowerCase() || imgName.endsWith(cleanKey)
                        })
                      }
                    }

                    if (foundIndex === -1) {
                      foundIndex = displayList.findIndex(item => 
                        item.name.toLowerCase().includes(query.toLowerCase())
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
                  style={{
                    background: 'rgba(0, 0, 0, 0.5)',
                    border: '1px solid rgba(255, 255, 255, 0.2)',
                    color: '#fff',
                    padding: '4px 8px',
                    "border-radius": '4px',
                    outline: 'none',
                    "min-width": '300px',
                    "font-family": 'inherit',
                    "font-size": 'inherit'
                  }}
                  placeholder="Dán hoặc nhập tên ảnh để tìm..."
                  title="Tìm kiếm tên ảnh"
                />
                <button
                  class={`box-toggle-btn ${showBoxes() ? 'active' : ''}`}
                  onClick={() => setShowBoxes(!showBoxes())}
                  title={showBoxes() ? "Ẩn các box annotation" : "Hiện các box annotation"}
                >
                  {showBoxes() ? 'Hide Boxes' : 'Show Boxes'}
                </button>
                <span>
                  • Job: {viewerAnnotations().jobId || 'N/A'}
                  <span style={{ margin: '0 8px', opacity: 0.3 }}>•</span>
                  {viewerIndex() + 1}/{viewerImages().length} 
                  <span style={{ margin: '0 8px', opacity: 0.3 }}>•</span>
                  {getAnnotationIdText(displayedImage())}
                  <span style={{ margin: '0 8px', opacity: 0.3 }}>•</span>
                  {displayedImage()?.width || 0} x {displayedImage()?.height || 0} • Zoom {Math.round(viewerTx().scale * 100)}% • ← → để chuyển
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
function MainPage(props) {
  const [images, setImages] = createSignal([])
  const [isLoading, setIsLoading] = createSignal(false)
  const [loadDone, setLoadDone] = createSignal(false)
  const [hasSavedFolder, setHasSavedFolder] = createSignal(false)
  const [showReloadPrompt, setShowReloadPrompt] = createSignal(false)
  const [zipEntries, setZipEntries] = createSignal(null)
  const [annotations, setAnnotations] = createSignal({ labels: {}, images: {} })
  const [extractAllMode, setExtractAllMode] = createSignal(false)
  
  let channel = null

  onMount(() => {
    document.title = 'Image View'
    window.name = 'image-preview-main'

    // BroadcastChannel for cross-tab communication (Main side)
    channel = new BroadcastChannel('image-view-channel')

    onCleanup(() => {
      if (channel) channel.close()
    })
  })

  // Listen to channel messages for image request
  createEffect(() => {
    const currentZipEntries = zipEntries()
    if (channel) {
      channel.onmessage = async (e) => {
        if (e.data.type === 'REQ_IMG' && currentZipEntries) {
          const entry = currentZipEntries[e.data.name]
          if (entry) {
            try {
              const blob = await entry.blob()
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
    getFolderHandle().then(async (handle) => {
      if (handle) {
        setHasSavedFolder(true)
        if (images().length === 0) {
          setShowReloadPrompt(true)
        }
      }
    }).catch(() => { })
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
    setIsLoading(true)
    setImages([])
    setAnnotations({ labels: {}, images: {} })
    try {
      const zipFile = await fileHandle.getFile()
      setExtractAllMode(zipFile.size < 1024 * 1024 * 1024)
      const { entries } = await unzip(zipFile)
      setZipEntries(entries)

      const imageData = []
      let annFileContent = null

      for (const [path, entry] of Object.entries(entries)) {
        if (path.match(/\.(png|jpg|jpeg|gif|webp|bmp)$/i)) {
          imageData.push({ name: path, entry })
        } else if (path.endsWith('annotations.xml')) {
          annFileContent = await entry.text()
        }
      }

      let parsedAnnotations = { labels: {}, images: {} }
      if (annFileContent) {
        parsedAnnotations = parseAnnotations(annFileContent)
        setAnnotations(parsedAnnotations)
      }

      imageData.sort((a, b) => a.name.localeCompare(b.name))

      const nextRecords = imageData.map((data, index) => {
        const ann = parsedAnnotations.images[data.name] || parsedAnnotations.images[data.name.split('/').pop()] || {}
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
    setImages([])
    setAnnotations({ labels: {}, images: {} })
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
      localStorage.setItem(
        'local-image-viewer-annotations',
        JSON.stringify(annotations())
      )
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

      <main class="page">
        {/* ─── TOP NAVBAR ─── */}
        <header class="hero-panel">
          <div class="navbar-brand">
            <div class="brand-dot" />
            <span>ImageView</span>
          </div>

          <div class="hero-actions" style={{ margin: 0 }}>
            <button type="button" class="primary-btn" onClick={openZipPicker} style={{ padding: '0.5rem 1.2rem', "font-size": '0.85rem' }}>
              ＋ Chọn file ZIP
            </button>
            <Show when={images().length > 0 || hasSavedFolder()}>
              <button type="button" class="ghost-btn" onClick={clearImages} style={{ padding: '0.5rem 1rem', "font-size": '0.85rem' }}>
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
              <span class="loading-spinner" style={{ width: '20px', height: '20px', "border-width": '2px' }} />
            </Show>
          </div>
        </header>

        {/* ─── RELOAD PROMPT ─── */}
        <Show when={showReloadPrompt()}>
          <div style={{
            margin: '0',
            padding: '12px 2rem',
            background: 'rgba(255, 165, 50, 0.08)',
            "border-bottom": '1px solid rgba(255, 165, 50, 0.2)',
            display: 'flex',
            "align-items": 'center',
            "justify-content": 'space-between',
            gap: '16px'
          }}>
            <div style={{ display: 'flex', "align-items": 'center', gap: '10px' }}>
              <span style={{ "font-size": '1rem' }}>💾</span>
              <div>
                <strong style={{ display: 'block', color: '#ffcf91', "font-size": '0.88rem' }}>Phát hiện dữ liệu ZIP cũ!</strong>
                <span style={{ "font-size": '0.8rem', color: 'rgba(255,255,255,0.5)' }}>Bạn có muốn khôi phục lại file ZIP này không?</span>
              </div>
            </div>
            <div style={{ display: 'flex', gap: '8px', "flex-shrink": 0 }}>
              <button type="button" class="primary-btn" onClick={reloadFolder} style={{ padding: '0.4rem 1rem', "font-size": '0.82rem' }}>
                Khôi phục
              </button>
              <button type="button" class="ghost-btn" onClick={skipReload} style={{ padding: '0.4rem 0.9rem', "font-size": '0.82rem' }}>
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
                <p>Nhấn <strong>＋ Chọn file ZIP</strong> ở trên để bắt đầu</p>
              </div>
            }
          >
            <div class="dashboard">
              {/* ─── OPEN PREVIEW - CTA ─── */}
              <div class="dash-launch" style={{ "justify-content": "flex-start" }}>
                <div class="dash-launch-info">
                  <div class="dash-launch-icon">🎬</div>
                  <div style={{ display: 'flex', "flex-direction": 'column', gap: '6px', "align-items": 'flex-start' }}>
                    <button
                      type="button"
                      class="dash-open-btn"
                      onClick={() => openImageInNewTab(images()[0])}
                      disabled={!images().length}
                      style={{ padding: '0.6rem 1.5rem', "font-size": '0.9rem', "margin-bottom": '4px' }}
                    >
                      <span class="dash-open-icon">▶</span>
                      Mở Image View
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
                        const folders = new Set(images().map(img => {
                          const parts = img.name.split('/')
                          parts.pop()
                          return parts.join('/') || '/'
                        }))
                        return folders.size
                      })()}
                    </span>
                    <span class="dash-stat-label">Thư mục</span>
                  </div>
                </div>

                <div class="dash-stat-card">
                  <div class="dash-stat-icon">✅</div>
                  <div class="dash-stat-body">
                    <span class="dash-stat-value" style={{ color: 'var(--success)' }}>
                      {loadDone() ? 'Sẵn sàng' : isLoading() ? 'Đang nạp...' : '—'}
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
                  <span class="dash-info-value">{annotations().startFrame ? `${annotations().startFrame} - ${annotations().stopFrame}` : '—'}</span>
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
                  <span class="dash-info-value">{images()[images().length - 1]?.name.split('/').pop() ?? '—'}</span>
                </div>
              </div>

              {/* ─── SHORTCUTS ─── */}
              <div class="dash-shortcuts">
                <p class="dash-shortcuts-title">⌨️ Phím tắt trong Viewer</p>
                <div class="dash-shortcuts-grid">
                  <div class="dash-shortcut"><kbd>F</kbd> / <kbd>→</kbd><span>Ảnh tiếp theo</span></div>
                  <div class="dash-shortcut"><kbd>D</kbd> / <kbd>←</kbd><span>Ảnh trước</span></div>
                  <div class="dash-shortcut"><kbd>Cuộn chuột</kbd><span>Zoom in/out</span></div>
                  <div class="dash-shortcut"><kbd>Click giữ</kbd><span>Di chuyển ảnh</span></div>
                  <div class="dash-shortcut"><kbd>Ctrl+F</kbd><span>Tìm kiếm theo ID</span></div>
                  <div class="dash-shortcut"><kbd>Double-click</kbd><span>Fit về kích thước gốc</span></div>
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
export default function App() {
  // Bust cache
  onMount(() => {
    const currentBuild = typeof __BUILD_DATE__ !== 'undefined' ? __BUILD_DATE__ : null
    if (currentBuild) {
      const lastBuild = localStorage.getItem('last_build_date')
      if (lastBuild && lastBuild !== String(currentBuild)) {
        console.log("New build detected! Reloading to clear cache...")
        localStorage.setItem('last_build_date', String(currentBuild))
        window.location.reload(true)
      } else {
        localStorage.setItem('last_build_date', String(currentBuild))
      }
    }
  })

  const initialRouteState = getViewerRouteState()

  if (initialRouteState.isViewer) {
    return <ViewerPage initialRouteState={initialRouteState} />
  } else {
    return <MainPage initialRouteState={initialRouteState} />
  }
}
