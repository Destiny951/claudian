import type { PiEvent } from '../adapters/types';

export interface PiSkillInfo {
  name: string;
  description?: string;
  source: 'extension' | 'prompt' | 'skill';
  sourceInfo?: {
    path?: string;
  };
}

export interface PiContextUsage {
  tokens: number | null;
  contextWindow: number;
  percent: number | null;
}

export interface PiSessionStats {
  tokens: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    total: number;
  };
  cost: number;
  contextUsage?: PiContextUsage;
}

export type BridgeRequest =
  | { type: 'init'; id: string; cwd: string; sessionId?: string }
  | { type: 'prompt'; id: string; prompt: string }
  | { type: 'cancel'; id: string }
  | { type: 'reset'; id: string }
  | { type: 'list_skills'; id: string }
  | { type: 'discover_skills'; id: string; cwd: string }
  | { type: 'get_context_usage'; id: string }
  | { type: 'get_session_stats'; id: string }
  | { type: 'compact'; id: string; customInstructions?: string };

export type BridgeResponse =
  | { type: 'init_ok'; id: string; sessionId: string | null }
  | { type: 'prompt_event'; id: string; event: PiEvent }
  | { type: 'prompt_done'; id: string }
  | { type: 'cancel_ok'; id: string }
  | { type: 'reset_ok'; id: string }
  | { type: 'list_skills_ok'; id: string; skills: PiSkillInfo[] }
  | { type: 'context_usage'; id: string; usage: PiContextUsage | null }
  | { type: 'session_stats'; id: string; stats: PiSessionStats }
  | { type: 'compact_done'; id: string; result: { tokensBefore: number; estimatedTokensAfter: number | null; summary?: string; _diagnostics?: { modelId: string; hasAgentYaml: boolean; summaryLength: number; messagesCount: number } } }
  | { type: 'error'; id?: string; message: string };
