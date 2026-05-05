import type { PetAtlasLayout, PetAtlasRowDef, PetCustom, PetConfig } from '../types';
import { prepareCodexAtlas } from './codexAtlas';

export const CUSTOM_PET_ID = 'custom';

export interface ResolvedPet {
  id: string;
  name: string;
  glyph: string;
  accent: string;
  greeting: string;
  bubbleBg?: string;
  bubbleText?: string;
  animation: 'bounce' | 'sway' | 'float' | 'wiggle';
  imageUrl?: string;
  frames?: number;
  fps?: number;
  atlas?: PetAtlasLayout;
}

export function resolveActivePet(pet: PetConfig | undefined): ResolvedPet | null {
  if (!pet?.adopted) return null;
  const resolved = resolveCustomPet(pet.custom);
  return {
    ...resolved,
    id: pet.petId?.trim() || CUSTOM_PET_ID,
  };
}

function resolveCustomPet(c: PetCustom): ResolvedPet {
  return {
    id: CUSTOM_PET_ID,
    name: c.name?.trim() || 'Buddy',
    glyph: c.glyph?.trim() || '🦄',
    accent: c.accent?.trim() || '#c96442',
    greeting: c.greeting?.trim() || 'Hi! I am here whenever you need me.',
    bubbleBg: c.bubbleBg?.trim() || undefined,
    bubbleText: c.bubbleText?.trim() || undefined,
    animation: 'float',
    imageUrl: c.imageUrl,
    frames: clampFrames(c.frames),
    fps: clampFps(c.fps),
    atlas: sanitizeAtlas(c.atlas),
  };
}

const FRAMES_MIN = 1;
const FRAMES_MAX = 24;
const FPS_MIN = 1;
const FPS_MAX = 30;

function clampFrames(v: number | undefined): number {
  if (!Number.isFinite(v as number)) return 1;
  return Math.max(FRAMES_MIN, Math.min(FRAMES_MAX, Math.round(v as number)));
}

function clampFps(v: number | undefined): number {
  if (!Number.isFinite(v as number)) return 6;
  return Math.max(FPS_MIN, Math.min(FPS_MAX, Math.round(v as number)));
}

function sanitizeAtlas(input: PetAtlasLayout | undefined): PetAtlasLayout | undefined {
  if (!input) return undefined;
  const cols = Math.max(1, Math.floor(input.cols));
  const rows = Math.max(1, Math.floor(input.rows));
  if (!Number.isFinite(cols) || !Number.isFinite(rows)) return undefined;
  const seen = new Set<number>();
  const rowsDef: PetAtlasRowDef[] = [];
  for (const row of input.rowsDef ?? []) {
    if (!row || typeof row.id !== 'string' || !row.id.trim()) continue;
    const index = Math.floor(row.index);
    if (!Number.isFinite(index) || index < 0 || index >= rows) continue;
    if (seen.has(index)) continue;
    seen.add(index);
    rowsDef.push({
      index,
      id: row.id.trim(),
      frames: Math.max(1, Math.min(cols, Math.floor(row.frames) || 1)),
      fps: Math.max(FPS_MIN, Math.min(FPS_MAX, Math.floor(row.fps) || 6)),
    });
  }
  if (rowsDef.length === 0) return undefined;
  rowsDef.sort((a, b) => a.index - b.index);
  return { cols, rows, rowsDef };
}

export type PetInteraction =
  | 'idle'
  | 'hover'
  | 'drag-right'
  | 'drag-left'
  | 'drag-up'
  | 'drag-down'
  | 'waiting'
  | 'failed'
  | 'review';

const INTERACTION_ROW_ID: Record<PetInteraction, string> = {
  idle: 'idle',
  hover: 'waving',
  'drag-right': 'running-right',
  'drag-left': 'running-left',
  'drag-up': 'jumping',
  'drag-down': 'waving',
  waiting: 'waiting',
  failed: 'failed',
  review: 'review',
};

const ROW_FALLBACK_ORDER: readonly string[] = [
  'idle', 'waiting', 'waving', 'running', 'running-right',
];

export function preferredRowId(state: PetInteraction): string {
  return INTERACTION_ROW_ID[state];
}

export function pickAtlasRow(
  layout: PetAtlasLayout | undefined,
  preferred: string,
): PetAtlasRowDef | undefined {
  if (!layout || layout.rowsDef.length === 0) return undefined;
  const direct = layout.rowsDef.find((r) => r.id === preferred);
  if (direct) return direct;
  for (const id of ROW_FALLBACK_ORDER) {
    const fallback = layout.rowsDef.find((r) => r.id === id);
    if (fallback) return fallback;
  }
  return layout.rowsDef[0];
}

const AMBIENT_ROW_POOL: readonly string[] = [
  'waving', 'review', 'jumping', 'running', 'running-right', 'running-left',
];

export function pickAmbientRow(
  layout: PetAtlasLayout | undefined,
  avoidId?: string,
): PetAtlasRowDef | null {
  if (!layout || layout.rowsDef.length === 0) return null;
  const pool = layout.rowsDef.filter((r) => AMBIENT_ROW_POOL.includes(r.id));
  if (pool.length === 0) return null;
  const candidates = pool.length > 1 && avoidId ? pool.filter((r) => r.id !== avoidId) : pool;
  const choices = candidates.length > 0 ? candidates : pool;
  return choices[Math.floor(Math.random() * choices.length)] ?? null;
}

export function ambientLines(name: string): string[] {
  return [
    `${name}: nudge me when you want a fresh idea.`,
    `${name}: I will keep you company while it builds.`,
    `${name}: take a breath — the prototype will wait.`,
    `${name}: small tweaks compound. Keep going!`,
  ];
}

export function eventToInteraction(event: { type: string; status?: string }): PetInteraction {
  switch (event.type) {
    case 'thinking': return 'waiting';
    case 'tool-use': return 'drag-right';
    case 'tool-result': return event.status === 'error' ? 'failed' : 'idle';
    case 'failed': return 'failed';
    case 'review': return 'review';
    case 'message': return 'idle';
    default: return 'idle';
  }
}

export function eventLines(name: string, event: { type: string; status?: string; message?: string }): string[] {
  if (event.message) return [event.message];
  const lines: Record<string, string[]> = {
    thinking: [`${name}: Hmm, thinking about this...`, `${name}: Working on it...`],
    'tool-use': [`${name}: Running a command...`, `${name}: Let me do that...`],
    'tool-result': event.status === 'error'
      ? [`${name}: That didn't work...`, `${name}: Let me try again...`]
      : [`${name}: That worked!`, `${name}: Looking good!`],
    failed: [`${name}: Oh no...`, `${name}: Something went wrong...`],
    review: [`${name}: Take a look at this.`, `${name}: What do you think?`],
    message: [`${name}: Message received.`],
  };
  return lines[event.type] ?? [];
}

export function defaultCustomPet(): PetCustom {
  return {
    name: 'Buddy',
    glyph: '🦄',
    accent: '#c96442',
    greeting: 'Hi! I am here whenever you need me.',
  };
}
