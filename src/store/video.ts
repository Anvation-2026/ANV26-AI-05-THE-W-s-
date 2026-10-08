import { create } from 'zustand';

/** The uploaded video lives only in this browser tab. It is never sent anywhere and is not saved between visits. */
export const useVideo = create<{
  url: string | null;
  name: string | null;
  size: { w: number; h: number; duration: number } | null;
  set: (v: { url: string; name: string; size: { w: number; h: number; duration: number } }) => void;
  clear: () => void;
}>((set, get) => ({
  url: null,
  name: null,
  size: null,
  set: (v) => {
    const old = get().url;
    if (old) URL.revokeObjectURL(old);
    set(v);
  },
  clear: () => {
    const old = get().url;
    if (old) URL.revokeObjectURL(old);
    set({ url: null, name: null, size: null });
  },
}));
