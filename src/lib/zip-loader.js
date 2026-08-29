export async function openZip(file) {
  const worker = new Worker(new URL('../workers/zip.worker.js', import.meta.url), {
    type: 'module',
  })
  let nextRequestId = 0
  const pending = new Map()

  worker.onmessage = ({ data }) => {
    const request = pending.get(data.requestId)
    if (!request) return
    pending.delete(data.requestId)
    if (data.type === 'error') {
      request.reject(new Error(data.message))
    } else {
      request.resolve(data)
    }
  }

  worker.onerror = (event) => {
    pending.forEach(({ reject }) => reject(event.error ?? new Error(event.message)))
    pending.clear()
  }

  const request = (message) =>
    new Promise((resolve, reject) => {
      const requestId = String(++nextRequestId)
      pending.set(requestId, { resolve, reject })
      worker.postMessage({ ...message, requestId })
    })

  const cacheKey = `${file.name}:${file.size}:${file.lastModified}:preview-v1`
  const loaded = await request({ type: 'load', file, cacheKey })
  return {
    paths: loaded.paths,
    annotationsText: loaded.annotationsText,
    getBlob: async (name, options = {}) => (await request({ type: 'blob', name, ...options })).blob,
    warmBlobs: async (names, options = {}, onProgress) => {
      let completed = 0
      await Promise.all(
        names.map(async (name) => {
          await request({ type: 'warm', name, ...options })
          completed += 1
          onProgress?.(completed, names.length)
        }),
      )
    },
    terminate: () => worker.terminate(),
  }
}
