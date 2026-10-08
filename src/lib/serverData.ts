import { api } from '../api';
import { friendlyError } from '../api/problem';
import { useApp } from '../store/app';
import { clearResults } from '../store/results';
import { toast } from '../components/ui';

/**
 * Deletes the person's video, analyses and results from the server and from this browser.
 * The server copy is removed first. If it cannot be reached the local copy is kept, so nothing is
 * left on a server the person can no longer find.
 */
export async function deleteMyVideoAndResults(): Promise<boolean> {
  const { serverVideo, perceptionOrigin, setServerVideo, setPerception } = useApp.getState();
  if (!serverVideo) {
    toast('There is no uploaded video to delete.');
    return false;
  }
  try {
    await api.deleteServerVideo(serverVideo.videoId);
  } catch (e) {
    const f = friendlyError(e);
    toast(`${f.title}. ${f.fix}`, 'error');
    return false;
  }
  await clearResults();
  setServerVideo(null);
  if (perceptionOrigin === 'backend') setPerception(null);
  toast('Your video, its analyses and its results were deleted from the server and from this browser.');
  return true;
}
