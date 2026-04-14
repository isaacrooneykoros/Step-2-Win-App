import React, { useRef, useState } from 'react';
import { X, RotateCw, RotateCcw } from 'lucide-react';

interface ImageCropperProps {
  imageSrc: string;
  onCropComplete: (croppedImage: Blob) => void;
  onCancel: () => void;
  aspectRatio?: number; // 1 for square, 16/9 for widescreen, etc.
}

export const ImageCropper: React.FC<ImageCropperProps> = ({
  imageSrc,
  onCropComplete,
  onCancel,
  aspectRatio = 1,
}) => {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const imageRef = useRef<HTMLImageElement>(null);
  const [scale, setScale] = useState(1);
  const [rotation, setRotation] = useState(0);
  const [position, setPosition] = useState({ x: 0, y: 0 });
  const [isDragging, setIsDragging] = useState(false);
  const [dragStart, setDragStart] = useState({ x: 0, y: 0 });

  const handleMouseDown = (e: React.MouseEvent<HTMLDivElement>) => {
    setIsDragging(true);
    setDragStart({ x: e.clientX - position.x, y: e.clientY - position.y });
  };

  const handleMouseMove = (e: React.MouseEvent<HTMLDivElement>) => {
    if (!isDragging) return;
    setPosition({
      x: e.clientX - dragStart.x,
      y: e.clientY - dragStart.y,
    });
  };

  const handleMouseUp = () => {
    setIsDragging(false);
  };

  const handleCrop = () => {
    if (!canvasRef.current || !imageRef.current) return;

    const canvas = canvasRef.current;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const size = 300; // Square crop size in pixels
    canvas.width = size;
    canvas.height = size;

    ctx.clearRect(0, 0, size, size);

    // Save context
    ctx.save();

    // Translate to center
    ctx.translate(size / 2, size / 2);

    // Rotate
    ctx.rotate((rotation * Math.PI) / 180);

    // Draw image
    const img = imageRef.current;
    ctx.drawImage(
      img,
      -img.width * scale / 2 + position.x,
      -img.height * scale / 2 + position.y,
      img.width * scale,
      img.height * scale
    );

    // Restore context
    ctx.restore();

    // Convert canvas to blob
    canvas.toBlob((blob) => {
      if (blob) {
        onCropComplete(blob);
      }
    }, 'image/jpeg', 0.95);
  };

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
      <div className="bg-bg-elevated rounded-3xl shadow-xl w-full max-w-md">
        {/* Header */}
        <div className="flex items-center justify-between p-4 border-b border-border">
          <h2 className="text-lg font-semibold text-text-primary">Crop Photo</h2>
          <button
            onClick={onCancel}
            className="p-2 hover:bg-bg-page rounded-lg transition-colors"
          >
            <X size={20} className="text-text-secondary" />
          </button>
        </div>

        {/* Canvas Area */}
        <div className="p-4">
          <div
            className="w-full aspect-square bg-black rounded-2xl overflow-hidden cursor-move relative mb-4"
            onMouseDown={handleMouseDown}
            onMouseMove={handleMouseMove}
            onMouseUp={handleMouseUp}
            onMouseLeave={handleMouseUp}
            style={{ userSelect: 'none', aspectRatio: String(aspectRatio) }}
          >
            <img
              ref={imageRef}
              src={imageSrc}
              alt="Crop"
              className="absolute inset-0 w-full h-full object-cover"
              style={{
                transform: `scale(${scale}) rotate(${rotation}deg) translate(${position.x}px, ${position.y}px)`,
                transformOrigin: 'center',
              }}
            />
            {/* Crop guide overlay */}
            <div className="absolute inset-0 border-2 border-accent-blue/50 box-border" />
            <div className="absolute inset-0 grid grid-cols-3 grid-rows-3 pointer-events-none">
              {Array.from({ length: 9 }).map((_, i) => (
                <div key={i} className="border border-white/10" />
              ))}
            </div>
          </div>

          {/* Controls */}
          <div className="space-y-4">
            {/* Zoom Control */}
            <div>
              <label className="text-xs font-medium text-text-muted mb-2 block">
                Zoom: {Math.round(scale * 100)}%
              </label>
              <input
                type="range"
                min="0.5"
                max="3"
                step="0.1"
                value={scale}
                onChange={(e) => setScale(parseFloat(e.target.value))}
                className="w-full h-2 bg-bg-page rounded-lg appearance-none cursor-pointer slider"
              />
            </div>

            {/* Rotation Control */}
            <div className="flex gap-2">
              <button
                onClick={() => setRotation((r) => (r - 90 + 360) % 360)}
                className="flex-1 flex items-center justify-center gap-2 py-2 px-3 bg-bg-page hover:bg-bg-elevated rounded-xl transition-colors text-sm font-medium text-text-primary"
              >
                <RotateCcw size={16} />
                Rotate Left
              </button>
              <button
                onClick={() => setRotation((r) => (r + 90) % 360)}
                className="flex-1 flex items-center justify-center gap-2 py-2 px-3 bg-bg-page hover:bg-bg-elevated rounded-xl transition-colors text-sm font-medium text-text-primary"
              >
                <RotateCw size={16} />
                Rotate Right
              </button>
            </div>

            {/* Reset Button */}
            <button
              onClick={() => {
                setScale(1);
                setRotation(0);
                setPosition({ x: 0, y: 0 });
              }}
              className="w-full py-2 px-3 bg-bg-page hover:bg-bg-elevated rounded-xl transition-colors text-sm font-medium text-text-primary"
            >
              Reset
            </button>
          </div>
        </div>

        {/* Actions */}
        <div className="flex gap-2 p-4 border-t border-border">
          <button
            onClick={onCancel}
            className="flex-1 py-2 px-4 rounded-xl border border-border text-text-primary font-medium hover:bg-bg-page transition-colors"
          >
            Cancel
          </button>
          <button
            onClick={handleCrop}
            className="flex-1 py-2 px-4 rounded-xl bg-accent-blue text-white font-medium hover:bg-accent-blue/90 transition-colors"
          >
            Save Crop
          </button>
        </div>

        {/* Hidden Canvas */}
        <canvas ref={canvasRef} className="hidden" />
      </div>
    </div>
  );
};
