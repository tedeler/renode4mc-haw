import { useEffect, useRef, useState } from 'react';
import { useControlSocket } from '../context/ControlSocket.jsx';
import Widget from './Widget.jsx';

const ON_RGB = [125, 211, 252];
const OFF_RGB = [4, 8, 16];

/**
 * SSD1306-GRAM -> RGBA. Layout: page-major, je Byte 8 vertikale Pixel (LSB oben).
 * index = page * width + x, bit = y % 8
 */
function rasterize(frame, image) {
  const { width, height, data, on, invert } = frame;
  const px = image.data;
  for (let y = 0; y < height; y++) {
    const page = y >> 3;
    const bit = 1 << (y & 7);
    for (let x = 0; x < width; x++) {
      let lit = (data[page * width + x] & bit) !== 0;
      if (invert) lit = !lit;
      if (!on) lit = false;
      const c = lit ? ON_RGB : OFF_RGB;
      const o = (y * width + x) * 4;
      px[o] = c[0];
      px[o + 1] = c[1];
      px[o + 2] = c[2];
      px[o + 3] = 255;
    }
  }
}

/** OLED-Display: empfängt Framebuffer-Dumps und rendert sie zyklisch (requestAnimationFrame). */
export default function OledDisplay({ width = 128, height = 64, scale = 4, label }) {
  const { subscribeFrame } = useControlSocket();
  const canvasRef = useRef(null);
  const latest = useRef(null);
  const dirty = useRef(false);
  const [info, setInfo] = useState({ frames: 0, on: false });

  useEffect(
    () =>
      subscribeFrame((frame) => {
        latest.current = frame;
        dirty.current = true;
      }),
    [subscribeFrame],
  );

  useEffect(() => {
    const canvas = canvasRef.current;
    const ctx = canvas.getContext('2d');
    const off = document.createElement('canvas');
    off.width = width;
    off.height = height;
    const offCtx = off.getContext('2d');
    const image = offCtx.createImageData(width, height);
    let raf;
    let frames = 0;

    ctx.fillStyle = `rgb(${OFF_RGB.join(',')})`;
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    const loop = () => {
      if (dirty.current && latest.current) {
        dirty.current = false;
        const f = latest.current;
        if (f.width === width && f.height === height) {
          rasterize(f, image);
          offCtx.putImageData(image, 0, 0);
          ctx.imageSmoothingEnabled = false;
          ctx.drawImage(off, 0, 0, canvas.width, canvas.height);
          frames += 1;
          setInfo({ frames, on: f.on });
        }
      }
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [width, height]);

  return (
    <Widget title="OLED-Display" subtitle={label} className="oled">
      <div className="oled-bezel">
        <canvas ref={canvasRef} width={width * scale} height={height * scale} className="oled-canvas" />
      </div>
      <div className="meta">
        {width}×{height} · Display {info.on ? 'ON' : 'OFF'} · {info.frames} Frames
      </div>
    </Widget>
  );
}
