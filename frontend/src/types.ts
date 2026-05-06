export interface PetAtlasRowDef {
  index: number;
  id: string;
  frames: number;
  fps: number;
}

export interface PetAtlasLayout {
  cols: number;
  rows: number;
  rowsDef: PetAtlasRowDef[];
}

export interface PetCustom {
  name: string;
  glyph: string;
  accent: string;
  greeting: string;
  bubbleBg?: string;
  bubbleText?: string;
  imageUrl?: string;
  frames?: number;
  fps?: number;
  atlas?: PetAtlasLayout;
}

export interface PetConfig {
  adopted: boolean;
  enabled: boolean;
  petId: string;
  eventMode?: 'full' | 'message-only';
  walkingEnabled?: boolean;
  petScale?: number;
  custom: PetCustom;
}

export interface PetEvent {
  type: 'idle' | 'thinking' | 'tool-use' | 'tool-result' | 'failed' | 'review' | 'message';
  tool?: string;
  status?: 'success' | 'error';
  message?: string;
  timestamp?: number;
}

declare global {
  interface Window {
    petCompanionDesktop?: {
      setOverlayInteractivity(interactive: boolean): void;
      updateHoverRegion(region: {
        left: number;
        top: number;
        right: number;
        bottom: number;
      } | null): void;
    };
  }
}
