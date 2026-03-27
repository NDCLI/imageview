import * as fflate from 'fflate';

self.onmessage = async (e) => {
  const { file } = e.data;
  try {
    const buffer = await file.arrayBuffer();
    const uint8view = new Uint8Array(buffer);
    
    // Use unzip for automatic detection
    fflate.unzip(uint8view, (err, unzipped) => {
      if (err) {
        self.postMessage({ error: err.message });
        return;
      }

      const files = [];
      let annotationsXml = null;

      for (const [path, data] of Object.entries(unzipped)) {
        if (data.length === 0) continue; // skip directories or empty files
        
        if (path.match(/\.(png|jpg|jpeg|gif|webp|bmp)$/i)) {
          // Send as ArrayBuffer to transfer ownership if possible, 
          // but for simplicity we'll just send the Uint8Array or Blob
          const blob = new Blob([data], { type: 'image/*' });
          files.push({ name: path, blob });
        } else if (path.endsWith('annotations.xml')) {
          annotationsXml = new TextDecoder().decode(data);
        }
      }

      self.postMessage({ files, annotationsXml });
    });
  } catch (err) {
    self.postMessage({ error: err.message });
  }
};
