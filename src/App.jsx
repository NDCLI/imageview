import { startTransition, useEffect, useRef, useState } from 'react'
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

  return { labels, images }
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

function writeViewerIndexToUrl(index) {
  const params = new URLSearchParams(window.location.search)
  params.set('viewer', '1')
  params.set('index', String(index))
  window.history.replaceState(null, '', `${window.location.pathname}?${params.toString()}`)
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
  const [annotations, setAnnotations] = useState({ labels: {}, images: {} })
  const [viewerAnnotations, setViewerAnnotations] = useState(() => {
    if (!initialRouteState.isViewer) return { labels: {}, images: {} }
    try {
      const raw = localStorage.getItem('local-image-viewer-annotations')
      return raw ? JSON.parse(raw) : { labels: {}, images: {} }
    } catch {
      return { labels: {}, images: {} }
    }
  })
  const viewerStageRef = useRef(null)
  const viewerDragRef = useRef(null)
  const lastFitScaleRef = useRef(1)
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
  const [showBoxes, setShowBoxes] = useState(false)
  const imagesRef = useRef([])
  const [zipEntries, setZipEntries] = useState(null)
  const [extractedUrls, setExtractedUrls] = useState({})

  useEffect(() => {
    // Cache busting: Force reload if a new build is detected
    const currentBuild = typeof __BUILD_DATE__ !== 'undefined' ? __BUILD_DATE__ : null;
    if (currentBuild) {
      const lastBuild = localStorage.getItem('last_build_date');
      if (lastBuild && lastBuild !== String(currentBuild)) {
        console.log("New build detected! Reloading to clear cache...");
        localStorage.setItem('last_build_date', String(currentBuild));
        window.location.reload(true);
      } else {
        localStorage.setItem('last_build_date', String(currentBuild));
      }
    }
  }, []);

  const [visibleCount, setVisibleCount] = useState(50)

  useEffect(() => {
    getFolderHandle().then(async (handle) => {
      if (handle) {
        setHasSavedFolder(true)
        if (isViewerMode) {
          try {
            const perm = await handle.queryPermission({ mode: 'read' })
            if (perm !== 'granted') {
              setShowReloadPrompt(true)
              return
            }
            const zipFile = await handle.getFile()
            const { entries } = await unzip(zipFile)
            setZipEntries(entries)
            
            // Extract annotations if present in viewer mode
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
            // Trigger state change to fetch active images
            setImages([]) 
          } catch (e) {
            console.error('Lỗi khi nạp zip trong viewer:', e)
            setShowReloadPrompt(true)
          }
        } else {
          // Hiển thị thông báo nếu chưa có ảnh nào được nạp ở tab chính (persistence qua restart)
          if (imagesRef.current.length === 0) {
            setShowReloadPrompt(true)
          }
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
      setExtractedUrls(current => {
        Object.values(current).forEach(url => URL.revokeObjectURL(url));
        return {};
      });
    }
  }, [])

  // Sliding window pre-fetching effect for viewer mode
  useEffect(() => {
    if (!zipEntries) return;
    const displayImages = images.length > 0 ? images : viewerImages;
    if (displayImages.length === 0) return;

    const activeIdx = viewerIndex;
    const neighborRange = new Set();
    for (let offset = -2; offset <= 2; offset++) {
      const idx = viewerIndex + offset;
      if (idx >= 0 && idx < displayImages.length) {
        neighborRange.add(idx);
      }
    }

    // Clean up URLs out of neighbor range IMMEDIATELY to free RAM
    setExtractedUrls(prev => {
      const nextUrls = { ...prev };
      let changed = false;
      Object.keys(nextUrls).forEach(idxStr => {
        const idx = parseInt(idxStr, 10);
        if (!neighborRange.has(idx)) {
          URL.revokeObjectURL(nextUrls[idx]);
          delete nextUrls[idx];
          changed = true;
        }
      });
      return changed ? nextUrls : prev;
    });

    // 1. Fetch active image IMMEDIATELY for instant loading
    const activeImgRecord = displayImages[activeIdx];
    if (activeImgRecord && !extractedUrls[activeIdx]) {
      const entry = zipEntries[activeImgRecord.name];
      if (entry) {
        entry.blob().then(blob => {
          const url = URL.createObjectURL(blob);
          setExtractedUrls(current => {
            if (!current[activeIdx]) {
              return { ...current, [activeIdx]: url };
            } else {
              URL.revokeObjectURL(url);
              return current;
            }
          });
        });
      }
    }

    // 2. Debounce pre-fetching of neighboring images (150ms) to avoid lag when holding Next button
    const timer = setTimeout(() => {
      setExtractedUrls(prev => {
        neighborRange.forEach(idx => {
          if (idx !== activeIdx && !prev[idx]) {
            const imgRecord = displayImages[idx];
            const entry = zipEntries[imgRecord.name];
            if (entry) {
              entry.blob().then(blob => {
                const url = URL.createObjectURL(blob);
                setExtractedUrls(current => {
                  if (neighborRange.has(idx) && !current[idx]) {
                    return { ...current, [idx]: url };
                  } else {
                    URL.revokeObjectURL(url);
                    return current;
                  }
                });
              });
            }
          }
        });
        return prev;
      });
    }, 150);

    return () => clearTimeout(timer);
  }, [viewerIndex, images, viewerImages, zipEntries, extractedUrls]);

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

    localStorage.setItem(
      'local-image-viewer-annotations',
      JSON.stringify(annotations)
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
    // Relax constraints significantly for freedom of movement (like CVAT)
    const maxPanX = imgWidth + stageWidth * 5
    const maxPanY = imgHeight + stageHeight * 5

    const constrainedPanX = Math.min(Math.max(panX, -maxPanX), maxPanX)
    const constrainedPanY = Math.min(Math.max(panY, -maxPanY), maxPanY)

    return { scale, panX: constrainedPanX, panY: constrainedPanY }
  }

  function resetViewerZoom() {
    const stage = viewerStageRef.current
    const displayImages = images.length > 0 ? images : viewerImages
    const activeImage = displayImages[Math.min(Math.max(viewerIndex, 0), displayImages.length - 1)]
    
    if (stage && activeImage && activeImage.width > 0) {
      const fit = getFitState(activeImage.width, activeImage.height, stage)
      viewerTxRef.current = fit
      setViewerTx(fit)
      lastFitScaleRef.current = fit.scale
    } else {
      const reset = { scale: 1, panX: 0, panY: 0 }
      viewerTxRef.current = reset
      setViewerTx(reset)
      lastFitScaleRef.current = 1
    }
  }

  // Handle maintaining zoom vs resetting to fit when switching images
  useEffect(() => {
    if (!isViewerMode) return

    const displayImages = images.length > 0 ? images : viewerImages
    const activeImage = displayImages[Math.min(Math.max(viewerIndex, 0), displayImages.length - 1)]

    const currentScale = viewerTxRef.current.scale
    const isAtFitScale = Math.abs(currentScale - lastFitScaleRef.current) < 0.01

    if (isAtFitScale) {
      // If we were at fit scale on the previous image, reset to fit on the new image
      resetViewerZoom()
    }
  }, [viewerIndex, images, viewerImages])

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

      // Multiplicative zoom (like CVAT/Google Maps/etc)
      // deltaY < 0 means scroll up (zoom in)
      const zoomFactor = event.deltaY < 0 ? 1.1 : 0.9
      let newScale = scale * zoomFactor

      // Clamp new scale
      newScale = Math.min(Math.max(newScale, MIN_ZOOM), MAX_ZOOM)

      // Calculate new pan to keep the same image point (ix, iy) under the cursor (cx, cy)
      const newPanX = cx - ix * newScale
      const newPanY = cy - iy * newScale

      const newTx = { scale: newScale, panX: newPanX, panY: newPanY }
      
      // Update with the new transformation
      // Note: We might want to keep the constraint, but let's see if it's too restrictive
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
      <main className="viewer-shell" style={{ position: 'relative', overflow: 'hidden' }}>

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
              <button type="button" className="ghost-btn" onClick={skipReload} style={{ padding: '8px 16px', fontSize: '0.9em' }}>
                Bỏ qua
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
                <div
                  className="viewer-image-container"
                  style={{
                    position: 'absolute',
                    top: 0,
                    left: 0,
                    transform: `translate(${viewerTx.panX}px, ${viewerTx.panY}px) scale(${viewerTx.scale})`,
                    transformOrigin: '0 0',
                    width: activeImage.width ? `${activeImage.width}px` : 'auto',
                    height: activeImage.height ? `${activeImage.height}px` : 'auto',
                  }}
                >
                  {extractedUrls[viewerIndex] ? (
                    <img
                      src={extractedUrls[viewerIndex]}
                      alt={activeImage.name}
                      onLoad={handleViewerImageLoad}
                      className="viewer-image"
                      style={{
                        display: 'block',
                        width: '100%',
                        height: '100%',
                      }}
                    />
                  ) : (
                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', width: '100%', height: '100%', minHeight: '300px' }}>
                      <span className="loading-spinner" />
                    </div>
                  )}
                  {showBoxes && (
                    <svg
                      className="viewer-annotations"
                      viewBox={(() => {
                        const currentAnnotations = images.length > 0 ? annotations : viewerAnnotations;
                        const activeName = activeImage.name.toLowerCase();
                        const simpleActiveName = activeImage.name.split('/').pop().toLowerCase();
                        const cleanActiveName = simpleActiveName.replace(/\.[^/.]+$/, "");
                        
                        const foundKey = Object.keys(currentAnnotations.images).find(k => {
                          const kn = k.toLowerCase();
                          if (kn === activeName || kn === simpleActiveName) return true;
                          const skn = k.split('/').pop().toLowerCase();
                          if (skn === simpleActiveName) return true;
                          const ckn = skn.replace(/\.[^/.]+$/, "");
                          if (ckn === cleanActiveName) return true;
                          
                          const ann = currentAnnotations.images[k];
                          if (ann && ann.id !== null) {
                             const idStr = ann.id.toString();
                             if (cleanActiveName === idStr) return true;
                             const nameNum = cleanActiveName.match(/\d+$/)?.[0];
                             if (nameNum && parseInt(nameNum) === parseInt(idStr)) return true;
                          }
                          return false;
                        });
                        
                        const annotationData = foundKey ? currentAnnotations.images[foundKey] : null;
                        if (annotationData && annotationData.width && annotationData.height) {
                          return `0 0 ${annotationData.width} ${annotationData.height}`;
                        }
                        return activeImage.width && activeImage.height ? `0 0 ${activeImage.width} ${activeImage.height}` : undefined;
                      })()}
                      style={{
                        position: 'absolute',
                        top: 0,
                        left: 0,
                        width: '100%',
                        height: '100%',
                        pointerEvents: 'none',
                      }}
                    >
                      {(() => {
                        const currentAnnotations = images.length > 0 ? annotations : viewerAnnotations;
                        const activeName = activeImage.name.toLowerCase();
                        const simpleActiveName = activeImage.name.split('/').pop().toLowerCase();
                        const cleanActiveName = simpleActiveName.replace(/\.[^/.]+$/, "");
                        
                        const foundKey = Object.keys(currentAnnotations.images).find(k => {
                          const kn = k.toLowerCase();
                          if (kn === activeName || kn === simpleActiveName) return true;
                          const skn = k.split('/').pop().toLowerCase();
                          if (skn === simpleActiveName) return true;
                          const ckn = skn.replace(/\.[^/.]+$/, "");
                          if (ckn === cleanActiveName) return true;
                          
                          const ann = currentAnnotations.images[k];
                          if (ann && ann.id !== null) {
                             const idStr = ann.id.toString();
                             if (cleanActiveName === idStr) return true;
                             const nameNum = cleanActiveName.match(/\d+$/)?.[0];
                             if (nameNum && parseInt(nameNum) === parseInt(idStr)) return true;
                          }
                          return false;
                        });
                        
                        const annotationData = foundKey ? currentAnnotations.images[foundKey] : null;
                        const boxes = annotationData?.boxes || [];

                        return boxes.map((box, i) => {
                          const labelColor = currentAnnotations.labels[box.label] || '#ff0000'
                          return (
                            <g key={i}>
                              <rect
                                x={box.xtl}
                                y={box.ytl}
                                width={box.xbr - box.xtl}
                                height={box.ybr - box.ytl}
                                fill="transparent"
                                stroke={labelColor}
                                strokeWidth={2 / viewerTx.scale}
                              />
                              <text
                                x={box.xtl}
                                y={box.ytl - 2 / viewerTx.scale}
                                fill="#ffffff"
                                style={{
                                  fontSize: `${12 / viewerTx.scale}px`,
                                  fontWeight: 'bold',
                                  paintOrder: 'stroke',
                                  stroke: labelColor,
                                  strokeWidth: `${3 / viewerTx.scale}px`,
                                  dominantBaseline: 'text-after-edge'
                                }}
                              >
                                {box.label}
                              </text>
                            </g>
                          )
                        });
                      })()}
                    </svg>
                  )}
                </div>
              </div>
              <div className="viewer-meta" style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap', justifyContent: 'center' }}>
                <input
                  ref={searchInputRef}
                  type="text"
                  value={searchQuery}
                  onChange={(e) => {
                    const query = e.target.value.trim();
                    setSearchQuery(query);
                    if (!query) return;

                    const displayImages = images.length > 0 ? images : viewerImages;
                    const currentAnnotations = images.length > 0 ? annotations : viewerAnnotations;
                    let foundIndex = -1;

                    // 1. Try to find by Exact ID from annotations XML
                    const isNumeric = /^\d+$/.test(query);
                    if (isNumeric) {
                      const foundKey = Object.keys(currentAnnotations.images).find(k => {
                        const ann = currentAnnotations.images[k];
                        return ann && ann.id !== null && ann.id.toString() === query;
                      });

                      if (foundKey) {
                        // Found a filename in XML with this ID, now find its index in our current image list
                        const cleanKey = foundKey.toLowerCase().split('/').pop();
                        foundIndex = displayImages.findIndex(img => {
                          const imgName = img.name.toLowerCase();
                          return imgName === foundKey.toLowerCase() || imgName.endsWith(cleanKey);
                        });
                      }
                    }

                    // 2. Fallback to simple name inclusion search if not found by ID
                    if (foundIndex === -1) {
                      foundIndex = displayImages.findIndex(img => 
                        img.name.toLowerCase().includes(query.toLowerCase())
                      );
                    }

                    if (foundIndex !== -1 && foundIndex !== viewerIndex) {
                      setViewerIndex(foundIndex);
                    }
                  }}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === 'Escape') {
                      e.target.blur()
                    }
                  }}
                  onFocus={() => setSearchQuery('')}
                  onBlur={() => {
                    const displayImages = images.length > 0 ? images : viewerImages
                    if (displayImages[viewerIndex]) {
                      setSearchQuery(displayImages[viewerIndex].name)
                    }
                  }}
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
                <button
                  className={`box-toggle-btn ${showBoxes ? 'active' : ''}`}
                  onClick={() => setShowBoxes(!showBoxes)}
                  title={showBoxes ? "Ẩn các box annotation" : "Hiện các box annotation"}
                >
                  {showBoxes ? 'Hide Boxes' : 'Show Boxes'}
                </button>
                <span>
                  • {viewerIndex + 1}/{displayImages.length} 
                  <span style={{ margin: '0 8px', opacity: 0.3 }}>•</span>
                  {(() => {
                    const currentAnnotations = images.length > 0 ? annotations : viewerAnnotations;
                    const activeName = activeImage.name.toLowerCase();
                    const simpleActiveName = activeImage.name.split('/').pop().toLowerCase();
                    const cleanActiveName = simpleActiveName.replace(/\.[^/.]+$/, "");
                    const foundKey = Object.keys(currentAnnotations.images).find(k => {
                      const kn = k.toLowerCase();
                      if (kn === activeName || kn === simpleActiveName) return true;
                      const skn = k.split('/').pop().toLowerCase();
                      if (skn === simpleActiveName) return true;
                      const ckn = skn.replace(/\.[^/.]+$/, "");
                      if (ckn === cleanActiveName) return true;
                      const ann = currentAnnotations.images[k];
                      if (ann && ann.id !== null) {
                         const idStr = ann.id.toString();
                         if (cleanActiveName === idStr) return true;
                         const nameNum = cleanActiveName.match(/\d+$/)?.[0];
                         if (nameNum && parseInt(nameNum) === parseInt(idStr)) return true;
                      }
                      return false;
                    });
                    const annotationData = foundKey ? currentAnnotations.images[foundKey] : null;
                    return annotationData ? `ID: ${annotationData.id}` : 'No ID';
                  })()}
                  <span style={{ margin: '0 8px', opacity: 0.3 }}>•</span>
                  {activeImage.width} x {activeImage.height} • Zoom {Math.round(viewerTx.scale * 100)}% • ← → để chuyển
                </span>
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

      await readZipHandle(handle)
    } catch (err) {
      console.error(err)
    }
  }


  async function readZipHandle(fileHandle) {
    setIsLoading(true)
    setExtractedUrls(current => {
      Object.values(current).forEach(url => URL.revokeObjectURL(url));
      return {};
    });
    setImages([])
    setAnnotations({ labels: {}, images: {} })
    try {
      const zipFile = await fileHandle.getFile()
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

      let parsedAnnotations = { labels: {}, images: {} };
      if (annFileContent) {
        parsedAnnotations = parseAnnotations(annFileContent)
        setAnnotations(parsedAnnotations)
      }

      imageData.sort((a, b) => a.name.localeCompare(b.name))

      const nextRecords = imageData.map((data, index) => {
        const ann = parsedAnnotations.images[data.name] || parsedAnnotations.images[data.name.split('/').pop()] || {};
        return {
          id: `${data.name}-${index}`,
          name: data.name,
          width: ann.width || 0,
          height: ann.height || 0,
          url: '', // dynamic
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
    setExtractedUrls(current => {
      Object.values(current).forEach(url => URL.revokeObjectURL(url));
      return {};
    });
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
        {/* ─── TOP NAVBAR ─── */}
        <header className="hero-panel">
          {/* Brand */}
          <div className="navbar-brand">
            <div className="brand-dot" />
            <span>ImageView</span>
          </div>

          {/* Center: action buttons */}
          <div className="hero-actions" style={{ margin: 0 }}>
            <button type="button" className="primary-btn" onClick={openZipPicker} style={{ padding: '0.5rem 1.2rem', fontSize: '0.85rem' }}>
              ＋ Chọn file ZIP
            </button>
            <button type="button" className="ghost-btn" onClick={clearImages} disabled={!images.length && !hasSavedFolder} style={{ padding: '0.5rem 1rem', fontSize: '0.85rem' }}>
              Xóa tất cả
            </button>
          </div>

          {/* Right: stats */}
          <div className="hero-stats">
            {images.length > 0 && (
              <article>
                <span>{images.length}</span>
                <p>ảnh</p>
              </article>
            )}
            {isLoading ? (
              <span className="loading-spinner" style={{ width: 20, height: 20, borderWidth: 2 }} />
            ) : loadDone && images.length > 0 ? (
              <span className="stat-ok-badge">Sẵn sàng</span>
            ) : null}
          </div>
        </header>

        {/* ─── RELOAD PROMPT ─── */}
        {showReloadPrompt && (
          <div style={{
            margin: '0',
            padding: '12px 2rem',
            background: 'rgba(255, 165, 50, 0.08)',
            borderBottom: '1px solid rgba(255, 165, 50, 0.2)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: '16px'
          }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <span style={{ fontSize: '1rem' }}>💾</span>
              <div>
                <strong style={{ display: 'block', color: '#ffcf91', fontSize: '0.88rem' }}>Phát hiện dữ liệu ZIP cũ!</strong>
                <span style={{ fontSize: '0.8rem', color: 'rgba(255,255,255,0.5)' }}>Bạn có muốn khôi phục lại file ZIP này không?</span>
              </div>
            </div>
            <div style={{ display: 'flex', gap: '8px', flexShrink: 0 }}>
              <button type="button" className="primary-btn" onClick={reloadFolder} style={{ padding: '0.4rem 1rem', fontSize: '0.82rem' }}>
                Khôi phục
              </button>
              <button type="button" className="ghost-btn" onClick={skipReload} style={{ padding: '0.4rem 0.9rem', fontSize: '0.82rem' }}>
                Bỏ qua
              </button>
            </div>
          </div>
        )}

        {/* ─── DASHBOARD ─── */}
        <section className="gallery-panel">
          {!images.length ? (
            /* Empty state */
            <div className="dash-empty">
              <div className="dash-empty-icon">📦</div>
              <h3>Chưa có file nào được mở</h3>
              <p>Chọn một file ZIP chứa ảnh để bắt đầu xem trước</p>
              <button type="button" className="primary-btn dash-cta-btn" onClick={openZipPicker}>
                ＋ Chọn file ZIP
              </button>
            </div>
          ) : (
            <div className="dashboard">
              {/* ─── OPEN PREVIEW - CTA ─── */}
              <div className="dash-launch">
                <div className="dash-launch-info">
                  <div className="dash-launch-icon">🎬</div>
                  <div>
                    <strong>Mở Preview Viewer</strong>
                    <span>Xem và điều hướng ảnh từ file ZIP trong cửa sổ riêng</span>
                  </div>
                </div>
                <button
                  type="button"
                  className="dash-open-btn"
                  onClick={() => openImageInNewTab(images[0])}
                  disabled={!images.length}
                >
                  <span className="dash-open-icon">▶</span>
                  Mở Preview
                </button>
              </div>

              {/* ─── STATS GRID ─── */}
              <div className="dash-stats">
                <div className="dash-stat-card">
                  <div className="dash-stat-icon">🖼</div>
                  <div className="dash-stat-body">
                    <span className="dash-stat-value">{images.length.toLocaleString()}</span>
                    <span className="dash-stat-label">Tổng số ảnh</span>
                  </div>
                </div>

                <div className="dash-stat-card">
                  <div className="dash-stat-icon">📁</div>
                  <div className="dash-stat-body">
                    <span className="dash-stat-value">
                      {(() => {
                        const folders = new Set(images.map(img => {
                          const parts = img.name.split('/');
                          parts.pop();
                          return parts.join('/') || '/';
                        }));
                        return folders.size;
                      })()}
                    </span>
                    <span className="dash-stat-label">Thư mục</span>
                  </div>
                </div>

                <div className="dash-stat-card">
                  <div className="dash-stat-icon">✅</div>
                  <div className="dash-stat-body">
                    <span className="dash-stat-value" style={{ color: 'var(--success)' }}>
                      {loadDone ? 'Sẵn sàng' : isLoading ? 'Đang nạp...' : '—'}
                    </span>
                    <span className="dash-stat-label">Trạng thái</span>
                  </div>
                </div>

                <div className="dash-stat-card">
                  <div className="dash-stat-icon">🔖</div>
                  <div className="dash-stat-body">
                    <span className="dash-stat-value">
                      {Object.keys(annotations.labels).length > 0
                        ? Object.keys(annotations.labels).length
                        : '—'}
                    </span>
                    <span className="dash-stat-label">Label</span>
                  </div>
                </div>
              </div>

              {/* ─── FILE INFO ─── */}
              <div className="dash-info-row">
                <div className="dash-info-card">
                  <span className="dash-info-label">📦 Nguồn dữ liệu</span>
                  <span className="dash-info-value">ZIP Archive (File System Access API)</span>
                </div>
                <div className="dash-info-card">
                  <span className="dash-info-label">🖼 Ảnh đầu tiên</span>
                  <span className="dash-info-value">{images[0]?.name.split('/').pop() ?? '—'}</span>
                </div>
                <div className="dash-info-card">
                  <span className="dash-info-label">🖼 Ảnh cuối cùng</span>
                  <span className="dash-info-value">{images[images.length - 1]?.name.split('/').pop() ?? '—'}</span>
                </div>
              </div>

              {/* ─── SHORTCUTS ─── */}
              <div className="dash-shortcuts">
                <p className="dash-shortcuts-title">⌨️ Phím tắt trong Viewer</p>
                <div className="dash-shortcuts-grid">
                  <div className="dash-shortcut"><kbd>F</kbd> / <kbd>→</kbd><span>Ảnh tiếp theo</span></div>
                  <div className="dash-shortcut"><kbd>D</kbd> / <kbd>←</kbd><span>Ảnh trước</span></div>
                  <div className="dash-shortcut"><kbd>Cuộn chuột</kbd><span>Zoom in/out</span></div>
                  <div className="dash-shortcut"><kbd>Click giữ</kbd><span>Di chuyển ảnh</span></div>
                  <div className="dash-shortcut"><kbd>Ctrl+F</kbd><span>Tìm kiếm theo ID</span></div>
                  <div className="dash-shortcut"><kbd>Double-click</kbd><span>Fit về kích thước gốc</span></div>
                </div>
              </div>
            </div>
          )}
        </section>
      </main>

    </div>
  )
}
