export type CalibrationQuality = 'excellent' | 'good' | 'noisy';

export const qualityMeta: Record<CalibrationQuality, { label: string; tone: 'success' | 'info' | 'warning' }> = {
  excellent: { label: 'Excellent', tone: 'success' },
  good: { label: 'Good', tone: 'info' },
  noisy: { label: 'Noisy', tone: 'warning' },
};
