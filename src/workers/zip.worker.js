import { unzip } from 'unzipit'

let entries = {}
const workQueue = []
let isWorking = false
let previewCacheDirectory = null
const cacheFileNames = new Map()

async function hashText(value) {
  const data = new TextEncoder().encode(value)
  const digest = await crypto.subtle.digest('SHA-256', data)
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('')
}

async function initializePreviewCache(cacheKey) {
  previewCacheDirectory = null
  cacheFileNames.clear()
  if (!navigator.storage?.getDirectory || !cacheKey) return

  try {
    const root = await navigator.storage.getDirectory()
    const appDirectory = await root.getDirectoryHandle('imageview-previews', { create: true })
    const archiveDirectoryName = `v1-${(await hashText(cacheKey)).slice(0, 24)}`
    previewCacheDirectory = await appDirectory.getDirectoryHandle(archiveDirectoryName, {
      create: true,
    })
  } catch {
    previewCacheDirectory = null
  }
}

async function getCacheFileName(name, maxDimension) {
  const key = `${maxDimension}:${name}`
  if (!cacheFileNames.has(key)) {
    cacheFileNames.set(key, `${await hashText(key)}.img`)
  }
  return cacheFileNames.get(key)
}

async function readCachedPreview(name, maxDimension) {
  if (!previewCacheDirectory || !maxDimension) return null
  try {
    const fileHandle = await previewCacheDirectory.getFileHandle(
      await getCacheFileName(name, maxDimension),
    )
    const file = await fileHandle.getFile()
    return file.size > 0 ? file : null
  } catch {
    return null
  }
}

async function writeCachedPreview(name, maxDimension, blob) {
  if (!previewCacheDirectory || !maxDimension) return false
  try {
    const fileHandle = await previewCacheDirectory.getFileHandle(
      await getCacheFileName(name, maxDimension),
      { create: true },
    )
    const writable = await fileHandle.createWritable()
    await writable.write(blob)
    await writable.close()
    return true
  } catch {
    // Another tab may be writing the same preview. The in-memory blob remains usable.
    return false
  }
}

async function getImageDimensions(blob) {
  const bytes = new Uint8Array(await blob.slice(0, 64 * 1024).arrayBuffer())

  if (
    bytes.length >= 24 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47
  ) {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    return { width: view.getUint32(16), height: view.getUint32(20) }
  }

  if (bytes[0] !== 0xff || bytes[1] !== 0xd8) return null

  const startOfFrameMarkers = new Set([
    0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf,
  ])
  let offset = 2
  while (offset + 8 < bytes.length) {
    if (bytes[offset] !== 0xff) {
      offset += 1
      continue
    }

    const marker = bytes[offset + 1]
    if (startOfFrameMarkers.has(marker)) {
      return {
        height: (bytes[offset + 5] << 8) | bytes[offset + 6],
        width: (bytes[offset + 7] << 8) | bytes[offset + 8],
      }
    }

    if (marker === 0xd8 || marker === 0xd9 || (marker >= 0xd0 && marker <= 0xd7)) {
      offset += 2
      continue
    }

    const segmentLength = (bytes[offset + 2] << 8) | bytes[offset + 3]
    if (segmentLength < 2) return null
    offset += segmentLength + 2
  }

  return null
}

async function createPreviewBlob(blob, maxDimension) {
  if (
    !maxDimension ||
    typeof createImageBitmap !== 'function' ||
    typeof OffscreenCanvas !== 'function'
  ) {
    return blob
  }

  const dimensions = await getImageDimensions(blob)
  let bitmap

  if (dimensions) {
    const scale = Math.min(1, maxDimension / Math.max(dimensions.width, dimensions.height))
    if (scale === 1) return blob
    bitmap = await createImageBitmap(blob, {
      resizeWidth: Math.max(1, Math.round(dimensions.width * scale)),
      resizeHeight: Math.max(1, Math.round(dimensions.height * scale)),
      resizeQuality: 'medium',
    })
  } else {
    bitmap = await createImageBitmap(blob)
    const scale = Math.min(1, maxDimension / Math.max(bitmap.width, bitmap.height))
    if (scale === 1) {
      bitmap.close()
      return blob
    }
  }

  const scale = Math.min(1, maxDimension / Math.max(bitmap.width, bitmap.height))
  const canvas = new OffscreenCanvas(
    Math.max(1, Math.round(bitmap.width * scale)),
    Math.max(1, Math.round(bitmap.height * scale)),
  )
  const context = canvas.getContext('2d', { alpha: false })
  context.drawImage(bitmap, 0, 0, canvas.width, canvas.height)
  bitmap.close()
  return canvas.convertToBlob({ type: 'image/webp', quality: 0.88 })
}

async function handleMessage(data) {
  try {
    if (data.type === 'load') {
      const archive = await unzip(data.file)
      entries = archive.entries
      await initializePreviewCache(data.cacheKey)
      const annotationPath = Object.keys(entries).find((path) => path.endsWith('annotations.xml'))
      const annotationsText = annotationPath ? await entries[annotationPath].text() : null
      self.postMessage({
        type: 'loaded',
        requestId: data.requestId,
        paths: Object.keys(entries),
        annotationsText,
      })
      return
    }

    if (data.type === 'blob' || data.type === 'warm') {
      const entry = entries[data.name]
      if (!entry) throw new Error(`Không tìm thấy ${data.name} trong ZIP`)
      let blob = await readCachedPreview(data.name, data.maxDimension)
      if (!blob) {
        blob = await createPreviewBlob(await entry.blob(), data.maxDimension)
        const stored = await writeCachedPreview(data.name, data.maxDimension, blob)
        if (data.type === 'warm' && !stored) {
          throw new Error('Không thể lưu preview xuống bộ nhớ đĩa OPFS')
        }
      }
      self.postMessage(
        data.type === 'blob'
          ? { type: 'blob', requestId: data.requestId, blob }
          : { type: 'warmed', requestId: data.requestId },
      )
    }
  } catch (error) {
    self.postMessage({ type: 'error', requestId: data.requestId, message: error.message })
  }
}

async function processQueue() {
  if (isWorking) return
  isWorking = true

  while (workQueue.length > 0) {
    await handleMessage(workQueue.shift())
  }

  isWorking = false
}

self.onmessage = ({ data }) => {
  if (data.priority) {
    workQueue.unshift(data)
  } else {
    workQueue.push(data)
  }
  void processQueue()
}
