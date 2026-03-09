import { create } from 'zustand';

interface StepsSyncStore {
  isStepsSocketConnected: boolean;
  lastStepsUpdateAt: string | null;
  setStepsSocketConnected: (connected: boolean) => void;
  setLastStepsUpdateAt: (timestamp: string | null) => void;
}

export const useStepsSyncStore = create<StepsSyncStore>((set) => ({
  isStepsSocketConnected: false,
  lastStepsUpdateAt: null,
  setStepsSocketConnected: (connected) => set({ isStepsSocketConnected: connected }),
  setLastStepsUpdateAt: (timestamp) => set({ lastStepsUpdateAt: timestamp }),
}));
