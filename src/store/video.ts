import { create } from 'zustand';

/** The chosen video lives in this browser tab and is not saved between visits. It is sent to the back end only when the person starts an analysis. */
export const useVideo = create<{
  url: string | null;
  name: string | null;
  /** The chosen file, kept in memory so it can be sent to the back end if the person asks for an analysis. */
  file: File | null;
  size: { w: number; h: number; duration: number } | null;
  set: (v: { url: string; name: string; size: { w: number; h: number; duration: number }; file?: File }) => void;
  clear: () => void;
}>((set, get) => ({
  url: null,
  name: null,
  file: null,
  size: null,
  set: (v) => {
    const old = get().url;
    if (old) URL.revokeObjectURL(old);
    set({ file: null, ...v });
  },
  clear: () => {
    const old = get().url;
    if (old) URL.revokeObjectURL(old);
    set({ url: null, name: null, file: null, size: null });
  },
}));
