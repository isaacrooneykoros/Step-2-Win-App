import { Capacitor } from '@capacitor/core';
import { Share } from '@capacitor/share';
import { Directory, Filesystem } from '@capacitor/filesystem';

/**
 * One way to share from anywhere in the app:
 * - Android app: the system share sheet (@capacitor/share); images are written to the cache
 *   directory first (@capacitor/filesystem) and shared as real files via the app's FileProvider.
 * - Web: Web Share API (with files when the browser supports it), else copy to clipboard.
 */
export type ShareResult = 'shared' | 'cancelled' | 'copied' | 'failed';

export type ShareFile = { blob: Blob; name: string };

const isNative = () => Capacitor.isNativePlatform();

export function canShare(): boolean {
  return isNative() || (typeof navigator !== 'undefined' && typeof navigator.share === 'function');
}

function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = String(reader.result || '');
      resolve(result.slice(result.indexOf(',') + 1));
    };
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}

async function writeShareFile(file: ShareFile): Promise<string> {
  const safeName = file.name.replace(/[^\w.-]+/g, '-');
  const { uri } = await Filesystem.writeFile({
    path: `share/${safeName}`,
    data: await blobToBase64(file.blob),
    directory: Directory.Cache,
    recursive: true,
  });
  return uri;
}

function isCancel(error: unknown) {
  const message = String((error as { message?: string })?.message || error || '').toLowerCase();
  return (error as DOMException)?.name === 'AbortError' || message.includes('cancel');
}

export async function shareContent(options: {
  title: string;
  text: string;
  url?: string;
  file?: ShareFile;
  /** Android chooser heading. */
  dialogTitle?: string;
}): Promise<ShareResult> {
  const { title, text, url, file, dialogTitle } = options;
  try {
    if (isNative()) {
      const files = file ? [await writeShareFile(file)] : undefined;
      await Share.share({ title, text, url, files, dialogTitle: dialogTitle ?? title });
      return 'shared';
    }

    if (typeof navigator.share === 'function') {
      if (file) {
        const webFile = new File([file.blob], file.name, { type: file.blob.type || 'image/png' });
        if (typeof navigator.canShare === 'function' && navigator.canShare({ files: [webFile] })) {
          await navigator.share({ title, text, url, files: [webFile] });
          return 'shared';
        }
      }
      await navigator.share({ title, text, url });
      return 'shared';
    }

    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText([text, url].filter(Boolean).join('\n'));
      return 'copied';
    }
    return 'failed';
  } catch (error) {
    if (isCancel(error)) return 'cancelled';
    console.warn('Share failed', error);
    return 'failed';
  }
}

/**
 * "Save image": a real download on the web; in the Android app (where WebView downloads don't
 * work) the share sheet, which offers Save to Photos / Files / Drive.
 */
export async function saveOrShareImage(file: ShareFile, title: string): Promise<ShareResult> {
  if (isNative()) {
    return shareContent({ title, text: title, file, dialogTitle: 'Save or share' });
  }
  const url = URL.createObjectURL(file.blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = file.name;
  link.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 10_000);
  return 'shared';
}

export function canvasToBlob(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error('Could not render image'))), 'image/png');
  });
}
