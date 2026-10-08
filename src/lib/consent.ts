/** One-time notice before the first upload: the video leaves this browser. */
const KEY = 'signaltwin-upload-consent-v1';

export function hasUploadConsent(): boolean {
  try {
    return localStorage.getItem(KEY) === 'yes';
  } catch {
    return false;
  }
}

export function giveUploadConsent(): void {
  try {
    localStorage.setItem(KEY, 'yes');
  } catch {
    /* without storage the notice shows again next time, which is fine */
  }
}

export function clearUploadConsent(): void {
  try {
    localStorage.removeItem(KEY);
  } catch {
    /* nothing to clear */
  }
}
