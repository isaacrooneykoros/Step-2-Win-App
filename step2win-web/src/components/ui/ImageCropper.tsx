import React, { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { X, RotateCw, RotateCcw, ZoomIn } from 'lucide-react';
import { isDataSaverOn } from '../../hooks/useDataSaver';

interface ImageCropperProps {
  imageSrc: string;
  onCropComplete: (croppedImage: Blob) => void;
  onCancel: () => void;
  aspectRatio?: number; // 1 for square, 16/9 for widescreen, etc.
}

const OUTPUT_SIZE = 300; // Output width in pixels

/**
 * Full-screen crop step shown above the photo sheet. Drag to position (mouse or touch),
 * zoom with the slider, rotate in 90° steps. The preview and the exported crop use the
 * same geometry, so what you see is what gets uploaded.
 */
export const ImageCropper: React.FC<ImageCropperProps> = ({ imageSrc, onCropComplete, onCancel, aspectRatio = 1 }) => {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const imageRef = useRef<HTMLImageElement>(null);
  const frameRef = useRef<HTMLDivElement>(null);
  const [scale, setScale] = useState(1);
  const [rotation, setRotation] = useState(0);
  const [position, setPosition] = useState({ x: 0, y: 0 });
  const [natural, setNatural] = useState<{ w: number; h: number } | null>(null);
  const [frameWidth, setFrameWidth] = useState(0);
  const dragRef = useRef<{ x: number; y: number } | null>(null);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.stopPropagation();
        onCancel();
      }
    };
    document.addEventListener('keydown', onKey, true);
    return () => document.removeEventListener('keydown', onKey, true);
  }, [onCancel]);

  useEffect(() => {
    const frame = frameRef.current;
    if (!frame) return;
    const update = () => setFrameWidth(frame.clientWidth);
    update();
    const observer = new ResizeObserver(update);
    observer.observe(frame);
    return () => observer.disconnect();
  }, []);

  const frameHeight = frameWidth / aspectRatio;
  // "Cover" fit at zoom 1, like object-fit: cover.
  const coverScale = natural && frameWidth ? Math.max(frameWidth / natural.w, frameHeight / natural.h) : 1;
  const drawW = natural ? natural.w * coverScale : 0;
  const drawH = natural ? natural.h * coverScale : 0;

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    e.currentTarget.setPointerCapture(e.pointerId);
    dragRef.current = { x: e.clientX - position.x, y: e.clientY - position.y };
  };
  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!dragRef.current) return;
    setPosition({ x: e.clientX - dragRef.current.x, y: e.clientY - dragRef.current.y });
  };
  const onPointerUp = () => {
    dragRef.current = null;
  };

  const handleCrop = () => {
    const canvas = canvasRef.current;
    const img = imageRef.current;
    if (!canvas || !img || !natural || !frameWidth) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    // Data saver: a more compressed upload (roughly half the bytes; the photo shows at <=120px).
    const saver = isDataSaverOn();
    const outW = OUTPUT_SIZE;
    const outH = Math.round(outW / aspectRatio);
    const k = outW / frameWidth; // screen px → output px
    canvas.width = outW;
    canvas.height = outH;
    ctx.clearRect(0, 0, outW, outH);
    ctx.save();
    ctx.translate(outW / 2 + position.x * k, outH / 2 + position.y * k);
    ctx.rotate((rotation * Math.PI) / 180);
    ctx.scale(scale, scale);
    ctx.drawImage(img, (-drawW * k) / 2, (-drawH * k) / 2, drawW * k, drawH * k);
    ctx.restore();

    canvas.toBlob(
      (blob) => {
        if (blob) onCropComplete(blob);
      },
      'image/jpeg',
      saver ? 0.8 : 0.95,
    );
  };

  const reset = () => {
    setScale(1);
    setRotation(0);
    setPosition({ x: 0, y: 0 });
  };

  return createPortal(
    <div className="fixed inset-0 z-[110] flex items-end justify-center sm:items-center sm:p-6" role="dialog" aria-modal="true" aria-labelledby="cropper-title">
      <div className="absolute inset-0 bg-[hsl(var(--scrim)/0.6)]" aria-hidden onClick={onCancel} />
      <div className="relative flex max-h-[96dvh] w-full flex-col overflow-hidden rounded-t-[28px] bg-bg-elevated shadow-modal sm:max-w-md sm:rounded-[24px]">
        <div className="flex items-center justify-between gap-3 px-5 pb-2 pt-4">
          <div>
            <h2 id="cropper-title" className="text-title text-text-primary">
              Crop photo
            </h2>
            <p className="text-callout text-text-secondary">Drag to reposition, then zoom or rotate.</p>
          </div>
          <button
            type="button"
            onClick={onCancel}
            className="-mr-1.5 inline-flex h-11 w-11 items-center justify-center rounded-full text-text-secondary hover:bg-bg-input"
            aria-label="Cancel cropping"
          >
            <X size={20} />
          </button>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto px-5 pb-4 pt-2">
          <div
            ref={frameRef}
            className="relative mx-auto w-full max-w-[360px] cursor-grab touch-none select-none overflow-hidden rounded-card bg-bg-sunken active:cursor-grabbing"
            style={{ aspectRatio: String(aspectRatio) }}
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
            onPointerCancel={onPointerUp}
          >
            <img
              ref={imageRef}
              src={imageSrc}
              alt="Photo being cropped"
              draggable={false}
              onLoad={(e) => setNatural({ w: e.currentTarget.naturalWidth, h: e.currentTarget.naturalHeight })}
              className="pointer-events-none absolute left-1/2 top-1/2 max-w-none"
              style={{
                width: drawW || '100%',
                height: drawH || 'auto',
                transform: `translate(-50%, -50%) translate(${position.x}px, ${position.y}px) rotate(${rotation}deg) scale(${scale})`,
                transformOrigin: 'center',
              }}
            />
            {/* Circular guide shows how the avatar will be framed. */}
            <div className="pointer-events-none absolute inset-[6%] rounded-full border-2 border-bg-card/90 shadow-[0_0_0_9999px_hsl(var(--scrim)/0.35)]" aria-hidden />
          </div>

          <div className="mt-5 space-y-4">
            <div>
              <label htmlFor="cropper-zoom" className="mb-2 flex items-center justify-between text-callout font-semibold text-text-secondary">
                <span className="inline-flex items-center gap-1.5">
                  <ZoomIn size={16} aria-hidden /> Zoom
                </span>
                <span className="num text-text-muted">{Math.round(scale * 100)}%</span>
              </label>
              <input
                id="cropper-zoom"
                type="range"
                min="0.5"
                max="3"
                step="0.05"
                value={scale}
                onChange={(e) => setScale(parseFloat(e.target.value))}
                className="h-11 w-full cursor-pointer accent-[hsl(var(--brand))]"
              />
            </div>

            <div className="grid grid-cols-3 gap-2">
              <button
                type="button"
                onClick={() => setRotation((r) => (r - 90 + 360) % 360)}
                aria-label="Rotate left"
                className="inline-flex h-11 items-center justify-center gap-1.5 rounded-control bg-bg-input text-callout font-semibold text-text-primary hover:bg-border"
              >
                <RotateCcw size={16} aria-hidden />
                Left
              </button>
              <button
                type="button"
                onClick={() => setRotation((r) => (r + 90) % 360)}
                aria-label="Rotate right"
                className="inline-flex h-11 items-center justify-center gap-1.5 rounded-control bg-bg-input text-callout font-semibold text-text-primary hover:bg-border"
              >
                <RotateCw size={16} aria-hidden />
                Right
              </button>
              <button
                type="button"
                onClick={reset}
                aria-label="Reset position, zoom and rotation"
                className="inline-flex h-11 items-center justify-center rounded-control bg-bg-input text-callout font-semibold text-text-primary hover:bg-border"
              >
                Reset
              </button>
            </div>
          </div>
        </div>

        <div className="flex shrink-0 gap-3 border-t border-border-light px-5 pb-safe pt-3">
          <button
            type="button"
            onClick={onCancel}
            className="mb-3 inline-flex h-11 flex-1 items-center justify-center rounded-control border border-border bg-bg-card text-body font-semibold text-text-primary hover:bg-bg-input"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={handleCrop}
            disabled={!natural}
            className="mb-3 inline-flex h-11 flex-1 items-center justify-center rounded-control bg-brand text-body font-semibold text-brand-fg hover:bg-brand-hover disabled:opacity-50"
          >
            Use photo
          </button>
        </div>

        <canvas ref={canvasRef} className="hidden" />
      </div>
    </div>,
    document.body,
  );
};
