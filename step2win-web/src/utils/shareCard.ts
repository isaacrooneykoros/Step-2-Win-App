export type StepShareCardInput = {
  dateLabel: string;
  steps: number;
  km: number;
  kcal: number;
  minutes: number;
};

// Brand palette (mirrors the light theme tokens in index.css).
const C = {
  page: '#F6F5F2',
  card: '#FFFFFF',
  ink: '#13191C',
  secondary: '#51595D',
  muted: '#6A7276',
  border: '#E3E0DA',
  brand: '#14855D',
  brandSoft: '#E6F3EC',
  reward: '#F5A30A',
};
const FONT = '"DM Sans Variable", "DM Sans", "Segoe UI", sans-serif';

/** 1080×1350 (4:5) share image of today's real step data. */
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

  // Make sure the self-hosted font is ready before drawing text.
  await document.fonts?.load?.(`700 64px ${FONT}`).catch(() => null);

  ctx.fillStyle = C.page;
  ctx.fillRect(0, 0, width, height);

  // Brand header
  drawMark(ctx, 80, 80, 88);
  ctx.fillStyle = C.ink;
  ctx.font = `700 44px ${FONT}`;
  ctx.fillText('Step', 196, 138);
  const stepW = ctx.measureText('Step').width;
  ctx.fillStyle = C.brand;
  ctx.fillText('2', 196 + stepW, 138);
  const twoW = ctx.measureText('2').width;
  ctx.fillStyle = C.ink;
  ctx.fillText('Win', 196 + stepW + twoW, 138);

  // Main card
  roundRect(ctx, 60, 230, width - 120, 660, 44, C.card, C.border);

  ctx.fillStyle = C.muted;
  ctx.font = `600 30px ${FONT}`;
  ctx.fillText(input.dateLabel.toUpperCase(), 120, 320);

  ctx.fillStyle = C.ink;
  ctx.font = `700 168px ${FONT}`;
  ctx.fillText(input.steps.toLocaleString('en-KE'), 112, 500);

  ctx.fillStyle = C.secondary;
  ctx.font = `500 44px ${FONT}`;
  ctx.fillText('steps walked', 120, 572);

  // Divider
  ctx.fillStyle = C.border;
  ctx.fillRect(120, 650, width - 240, 2);

  // Metrics, three columns
  const colW = (width - 240) / 3;
  drawMetric(ctx, 120, 740, 'Distance', `${input.km.toFixed(1)} km`);
  drawMetric(ctx, 120 + colW, 740, 'Active', `${input.minutes} min`);
  drawMetric(ctx, 120 + colW * 2, 740, 'Calories', `${input.kcal.toLocaleString('en-KE')} kcal`);

  // Footer
  ctx.fillStyle = C.ink;
  ctx.font = `700 46px ${FONT}`;
  ctx.fillText('Walk with me on Step2Win', 80, 1080);
  ctx.fillStyle = C.secondary;
  ctx.font = `500 32px ${FONT}`;
  ctx.fillText('Daily steps, community challenges, real rewards.', 80, 1138);

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

function drawMetric(ctx: CanvasRenderingContext2D, x: number, y: number, label: string, value: string) {
  ctx.fillStyle = C.muted;
  ctx.font = `500 30px ${FONT}`;
  ctx.fillText(label, x, y);
  ctx.fillStyle = C.ink;
  ctx.font = `700 52px ${FONT}`;
  ctx.fillText(value, x, y + 66);
}

/** Stair mark from BrandMark, drawn at (x, y) with the given size. */
function drawMark(ctx: CanvasRenderingContext2D, x: number, y: number, size: number) {
  const s = size / 40;
  roundRect(ctx, x, y, size, size, 11 * s, C.brand, C.brand);
  ctx.save();
  ctx.translate(x, y);
  ctx.scale(s, s);
  ctx.strokeStyle = '#FFFFFF';
  ctx.lineWidth = 3.4;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.beginPath();
  ctx.moveTo(11, 29);
  ctx.lineTo(17.5, 29);
  ctx.lineTo(17.5, 22.5);
  ctx.lineTo(24, 22.5);
  ctx.lineTo(24, 16);
  ctx.lineTo(30.5, 16);
  ctx.lineTo(30.5, 9.5);
  ctx.stroke();
  ctx.fillStyle = C.reward;
  ctx.beginPath();
  ctx.arc(30.5, 9.5, 2.6, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
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
