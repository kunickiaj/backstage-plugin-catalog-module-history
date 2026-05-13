import { CycleInput } from './types';

export interface HistoryStore {
  loadCurrentEtags(provider: string): Promise<Map<string, string>>;
  recordCycle(input: CycleInput): Promise<void>;
}
