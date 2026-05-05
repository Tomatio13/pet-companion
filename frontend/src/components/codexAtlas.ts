import type { PetAtlasLayout, PetAtlasRowDef } from '../types';

export const CODEX_ATLAS_COLS = 8;
export const CODEX_ATLAS_ROWS = 9;
export const CODEX_CELL_WIDTH = 192;
export const CODEX_CELL_HEIGHT = 208;
export const CODEX_ATLAS_WIDTH = CODEX_ATLAS_COLS * CODEX_CELL_WIDTH;
export const CODEX_ATLAS_HEIGHT = CODEX_ATLAS_ROWS * CODEX_CELL_HEIGHT;
export const CODEX_ATLAS_ASPECT = CODEX_ATLAS_WIDTH / CODEX_ATLAS_HEIGHT;

export interface CodexAtlasRow {
  index: number;
  id: 'idle' | 'running-right' | 'running-left' | 'waving' | 'jumping' | 'failed' | 'waiting' | 'running' | 'review';
  frames: number;
  fps: number;
}

export const CODEX_ATLAS_ROWS_DEF: CodexAtlasRow[] = [
  { index: 0, id: 'idle', frames: 6, fps: 6 },
  { index: 1, id: 'running-right', frames: 8, fps: 8 },
  { index: 2, id: 'running-left', frames: 8, fps: 8 },
  { index: 3, id: 'waving', frames: 4, fps: 6 },
  { index: 4, id: 'jumping', frames: 5, fps: 7 },
  { index: 5, id: 'failed', frames: 8, fps: 7 },
  { index: 6, id: 'waiting', frames: 6, fps: 6 },
  { index: 7, id: 'running', frames: 6, fps: 8 },
  { index: 8, id: 'review', frames: 6, fps: 6 },
];

export const CODEX_ATLAS_LAYOUT: PetAtlasLayout = {
  cols: CODEX_ATLAS_COLS,
  rows: CODEX_ATLAS_ROWS,
  rowsDef: CODEX_ATLAS_ROWS_DEF.map(
    (row): PetAtlasRowDef => ({
      index: row.index,
      id: row.id,
      frames: row.frames,
      fps: row.fps,
    }),
  ),
};

export function looksLikeCodexAtlas(width: number, height: number): boolean {
  if (!Number.isFinite(width) || !Number.isFinite(height)) return false;
  if (width <= 0 || height <= 0) return false;
  const aspect = width / height;
  return Math.abs(aspect - CODEX_ATLAS_ASPECT) < 0.06;
}

export interface RawAtlasImage {
  dataUrl: string;
  width: number;
  height: number;
}

export async function loadAtlasImageFromFile(file: File): Promise<RawAtlasImage> {
  if (!file.type.startsWith('image/')) {
    throw new Error('Only image files are supported.');
  }
  const dataUrl = await readFileAsDataUrl(file);
  const dims = await measureImage(dataUrl);
  return { dataUrl, width: dims.width, height: dims.height };
}

export async function prepareCodexAtlas(
  sourceDataUrl: string,
  options?: { maxCellHeight?: number | null },
): Promise<{ dataUrl: string; width: number; height: number; layout: PetAtlasLayout }> {
  const maxCellHeight = options?.maxCellHeight ?? 80;
  const img = await loadImage(sourceDataUrl);
  const cellWidth = Math.floor(img.naturalWidth / CODEX_ATLAS_COLS);
  const cellHeight = Math.floor(img.naturalHeight / CODEX_ATLAS_ROWS);
  if (cellWidth <= 0 || cellHeight <= 0) {
    throw new Error('Atlas image is too small to slice.');
  }
  const targetCellHeight = maxCellHeight && cellHeight > maxCellHeight ? maxCellHeight : cellHeight;
  const scale = targetCellHeight / cellHeight;
  const targetCellWidth = Math.max(1, Math.round(cellWidth * scale));
  const targetWidth = targetCellWidth * CODEX_ATLAS_COLS;
  const targetHeight = targetCellHeight * CODEX_ATLAS_ROWS;
  const canvas = document.createElement('canvas');
  canvas.width = targetWidth;
  canvas.height = targetHeight;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Canvas is unavailable in this browser.');
  ctx.imageSmoothingEnabled = false;
  for (let r = 0; r < CODEX_ATLAS_ROWS; r++) {
    for (let c = 0; c < CODEX_ATLAS_COLS; c++) {
      ctx.drawImage(
        img,
        c * cellWidth, r * cellHeight, cellWidth, cellHeight,
        c * targetCellWidth, r * targetCellHeight, targetCellWidth, targetCellHeight,
      );
    }
  }
  const dataUrl = canvas.toDataURL('image/png');
  return { dataUrl, width: targetWidth, height: targetHeight, layout: CODEX_ATLAS_LAYOUT };
}

function readFileAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error ?? new Error('Read failed'));
    reader.onload = () => {
      if (typeof reader.result !== 'string') { reject(new Error('Could not decode.')); return; }
      resolve(reader.result);
    };
    reader.readAsDataURL(file);
  });
}

function measureImage(dataUrl: string): Promise<{ width: number; height: number }> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve({ width: img.naturalWidth, height: img.naturalHeight });
    img.onerror = () => reject(new Error('Could not load image.'));
    img.src = dataUrl;
  });
}

function loadImage(dataUrl: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('Could not load image.'));
    img.src = dataUrl;
  });
}
