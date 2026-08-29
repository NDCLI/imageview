export function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max)
}

export function parseAnnotations(xmlText) {
  const parser = new DOMParser()
  const xmlDoc = parser.parseFromString(xmlText, 'text/xml')
  const labels = {}
  const images = {}
  const lookupById = new Map()
  const lookupByName = new Map()

  const jobId = xmlDoc.querySelector('meta > job > id')?.textContent ?? ''
  const startFrame = xmlDoc.querySelector('meta > job > start_frame')?.textContent ?? ''
  const stopFrame = xmlDoc.querySelector('meta > job > stop_frame')?.textContent ?? ''

  xmlDoc.querySelectorAll('label').forEach((node) => {
    const name = node.querySelector('name')?.textContent
    const color = node.querySelector('color')?.textContent
    if (name && color) labels[name] = color
  })

  xmlDoc.querySelectorAll('image').forEach((node) => {
    const name = node.getAttribute('name')
    if (!name) return

    const annotation = {
      id: node.getAttribute('id'),
      width: Number.parseInt(node.getAttribute('width'), 10),
      height: Number.parseInt(node.getAttribute('height'), 10),
      boxes: Array.from(node.querySelectorAll('box'), (box) => ({
        label: box.getAttribute('label'),
        xtl: Number.parseFloat(box.getAttribute('xtl')),
        ytl: Number.parseFloat(box.getAttribute('ytl')),
        xbr: Number.parseFloat(box.getAttribute('xbr')),
        ybr: Number.parseFloat(box.getAttribute('ybr')),
      })),
    }

    images[name] = annotation
    lookupById.set(String(annotation.id), name)
    lookupByName.set(normalizeName(name), name)
    lookupByName.set(normalizeName(name.split('/').pop()), name)
  })

  return { labels, images, lookupById, lookupByName, jobId, startFrame, stopFrame }
}

function normalizeName(name) {
  return (name ?? '').toLowerCase().replace(/\.[^/.]+$/, '')
}

export function findAnnotationKey(img, annotationImages, lookupById, lookupByName) {
  if (!img) return null
  const activeName = img.name.toLowerCase()
  const simpleActiveName = img.name.split('/').pop().toLowerCase()
  const cleanActiveName = normalizeName(simpleActiveName)

  const canLookupByName = typeof lookupByName?.get === 'function'
  const canLookupById =
    typeof lookupById?.has === 'function' && typeof lookupById?.get === 'function'
  const directKey = canLookupByName
    ? (lookupByName.get(cleanActiveName) ?? lookupByName.get(normalizeName(activeName)))
    : null
  if (directKey) return directKey
  if (canLookupById && lookupById.has(cleanActiveName)) return lookupById.get(cleanActiveName)

  const numericId = cleanActiveName.match(/\d+$/)?.[0]
  if (numericId && canLookupById && lookupById.has(String(Number.parseInt(numericId, 10)))) {
    return lookupById.get(String(Number.parseInt(numericId, 10)))
  }

  return (
    Object.keys(annotationImages).find((key) => {
      const keyName = key.toLowerCase()
      if (keyName === activeName || keyName === simpleActiveName) return true
      const simpleKeyName = key.split('/').pop().toLowerCase()
      if (simpleKeyName === simpleActiveName || normalizeName(simpleKeyName) === cleanActiveName)
        return true

      const annotation = annotationImages[key]
      if (annotation?.id == null) return false
      const id = String(annotation.id)
      return (
        cleanActiveName === id ||
        (numericId && Number.parseInt(numericId, 10) === Number.parseInt(id, 10))
      )
    }) ?? null
  )
}

export function getFitState(imageWidth, imageHeight, stage) {
  if (!stage || !imageWidth || !imageHeight) return { scale: 1, panX: 0, panY: 0 }

  const bounds = stage.getBoundingClientRect()
  const scale = Math.min(bounds.width / imageWidth, bounds.height / imageHeight, 1.5)
  return {
    scale,
    panX: (bounds.width - imageWidth * scale) / 2,
    panY: (bounds.height - imageHeight * scale) / 2,
  }
}
