import { create } from 'zustand';

/** Run status text shown in the context bar. Pages set it while they work. */
export const useRunStatus = create<{ text: string; set: (t: string) => void }>((set) => ({
  text: 'Idle',
  set: (text) => set({ text }),
}));
