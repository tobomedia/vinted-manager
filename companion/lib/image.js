// Convert any photo the browser can display (incl. iPhone HEIC in Safari)
// into a JPEG no larger than `max` px on its long edge.
export async function toJpeg(file, max = 1600, quality = 0.85) {
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise((res, rej) => {
      const i = new Image();
      i.onload = () => res(i);
      i.onerror = () => rej(new Error(`Couldn't read "${file.name || 'photo'}". Try saving it as a JPG first.`));
      i.src = url;
    });
    const k = Math.min(1, max / Math.max(img.naturalWidth, img.naturalHeight));
    const w = Math.round(img.naturalWidth * k), h = Math.round(img.naturalHeight * k);
    const canvas = document.createElement('canvas');
    canvas.width = w; canvas.height = h;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, w, h); // transparent PNGs → white, not black
    ctx.drawImage(img, 0, 0, w, h); // browsers apply EXIF rotation to <img> automatically
    const blob = await new Promise((res, rej) =>
      canvas.toBlob((b) => (b ? res(b) : rej(new Error('Could not convert photo'))), 'image/jpeg', quality));
    canvas.width = canvas.height = 0; // free memory early on iOS
    return { buf: await blob.arrayBuffer(), w, h };
  } finally {
    URL.revokeObjectURL(url);
  }
}
