export type StepShareCardInput = {
  dateLabel: string;
  steps: number;
  km: number;
  kcal: number;
  minutes: number;
};

export async function buildStepShareCard(input: StepShareCardInput): Promise<Blob> {
  const width = 1080;
  const height = 1350;
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');

  if (!ctx) {
    throw new Error('Could not create share card');
  }

  const bg = ctx.createLinearGradient(0, 0, width, height);
  bg.addColorStop(0, '#0F172A');
  bg.addColorStop(0.5, '#111827');
  bg.addColorStop(1, '#1E3A8A');
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, width, height);

  // Atmosphere glows
  drawGlow(ctx, 180, 200, 240, 'rgba(79, 156, 249, 0.22)');
  drawGlow(ctx, 920, 280, 270, 'rgba(52, 211, 153, 0.18)');
  drawGlow(ctx, 540, 1100, 340, 'rgba(167, 139, 250, 0.2)');

  // Header
  ctx.fillStyle = '#E2E8F0';
  ctx.font = '700 56px "DM Sans", "Segoe UI", sans-serif';
  ctx.fillText('Step2Win Daily Win', 72, 120);

  ctx.fillStyle = '#93C5FD';
  ctx.font = '500 34px "DM Sans", "Segoe UI", sans-serif';
  ctx.fillText(input.dateLabel, 72, 172);

  // Main card
  roundRect(ctx, 60, 220, width - 120, 760, 36, 'rgba(15, 23, 42, 0.72)', 'rgba(148, 163, 184, 0.2)');

  ctx.fillStyle = '#F8FAFC';
  ctx.font = '700 48px "DM Sans", "Segoe UI", sans-serif';
  ctx.fillText('Today I walked', 100, 310);

  ctx.fillStyle = '#60A5FA';
  ctx.font = '800 116px "DM Sans", "Segoe UI", sans-serif';
  ctx.fillText(input.steps.toLocaleString(), 100, 430);

  ctx.fillStyle = '#E2E8F0';
  ctx.font = '700 52px "DM Sans", "Segoe UI", sans-serif';
  ctx.fillText('steps', 100, 495);

  drawMetric(ctx, 100, 560, 'Distance', `${input.km.toFixed(2)} km`, '#34D399');
  drawMetric(ctx, 100, 670, 'Calories', `${input.kcal.toLocaleString()} kcal`, '#FBBF24');
  drawMetric(ctx, 100, 780, 'Active Time', `${input.minutes} min`, '#A78BFA');

  // CTA footer
  roundRect(ctx, 60, 1020, width - 120, 230, 30, 'rgba(30, 64, 175, 0.35)', 'rgba(96, 165, 250, 0.5)');
  ctx.fillStyle = '#DBEAFE';
  ctx.font = '700 44px "DM Sans", "Segoe UI", sans-serif';
  ctx.fillText('Join me on Step2Win', 100, 1120);

  ctx.fillStyle = '#BFDBFE';
  ctx.font = '500 31px "DM Sans", "Segoe UI", sans-serif';
  ctx.fillText('Track steps, challenge friends, and earn rewards.', 100, 1180);

  return await new Promise<Blob>((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (!blob) {
        reject(new Error('Unable to create share image'));
        return;
      }
      resolve(blob);
    }, 'image/png', 0.95);
  });
}

function drawMetric(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  label: string,
  value: string,
  accent: string,
) {
  ctx.fillStyle = accent;
  ctx.beginPath();
  ctx.arc(x + 12, y - 12, 10, 0, Math.PI * 2);
  ctx.fill();

  ctx.fillStyle = '#CBD5E1';
  ctx.font = '500 30px "DM Sans", "Segoe UI", sans-serif';
  ctx.fillText(label, x + 38, y);

  ctx.fillStyle = '#F8FAFC';
  ctx.font = '700 42px "DM Sans", "Segoe UI", sans-serif';
  ctx.fillText(value, x + 38, y + 50);
}

function drawGlow(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  radius: number,
  color: string,
) {
  const g = ctx.createRadialGradient(x, y, 0, x, y, radius);
  g.addColorStop(0, color);
  g.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.fillStyle = g;
  ctx.fillRect(x - radius, y - radius, radius * 2, radius * 2);
}

function roundRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  width: number,
  height: number,
  radius: number,
  fill: string,
  stroke: string,
) {
  ctx.beginPath();
  ctx.moveTo(x + radius, y);
  ctx.lineTo(x + width - radius, y);
  ctx.quadraticCurveTo(x + width, y, x + width, y + radius);
  ctx.lineTo(x + width, y + height - radius);
  ctx.quadraticCurveTo(x + width, y + height, x + width - radius, y + height);
  ctx.lineTo(x + radius, y + height);
  ctx.quadraticCurveTo(x, y + height, x, y + height - radius);
  ctx.lineTo(x, y + radius);
  ctx.quadraticCurveTo(x, y, x + radius, y);
  ctx.closePath();

  ctx.fillStyle = fill;
  ctx.fill();

  ctx.strokeStyle = stroke;
  ctx.lineWidth = 2;
  ctx.stroke();
}
