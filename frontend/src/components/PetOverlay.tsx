import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { PetConfig } from "../types";
import {
  ambientLines,
  pickAmbientRow,
  preferredRowId,
  resolveActivePet,
  eventToInteraction,
  eventLines,
  type PetInteraction,
} from "./pets";
import { PetSpriteFace } from "./PetSpriteFace";

interface Props {
  pet: PetConfig | undefined;
}

const STORAGE_KEY = "pet-companion:pet-position";

interface Position {
  right: number;
  bottom: number;
}

interface NativeDragDetail {
  button?: number;
  clientX: number;
  clientY: number;
}

const DEFAULT_POSITION: Position = { right: 24, bottom: 24 };
const WAITING_AFTER_MS = 45000;
const EVENT_INTERACTION_TIMEOUT_MS = 2000;

const AMBIENT_PLAY_MIN_MS = 1400;
const AMBIENT_PLAY_VARIANCE_MS = 900;
const AMBIENT_REST_MIN_MS = 9000;
const AMBIENT_REST_VARIANCE_MS = 9000;
const AMBIENT_INITIAL_DELAY_MIN_MS = 4000;
const AMBIENT_INITIAL_DELAY_VARIANCE_MS = 3000;

const DRAG_GESTURE_MIN_PX = 14;
const DRAG_AXIS_BIAS = 1.18;
const DEFAULT_PET_SCALE = 1;
const MIN_PET_SCALE = 0.5;
const MAX_PET_SCALE = 3;

function resolvePetScale(value: number | undefined): number {
  if (!Number.isFinite(value as number)) return DEFAULT_PET_SCALE;
  return Math.max(
    MIN_PET_SCALE,
    Math.min(MAX_PET_SCALE, Number(value)),
  );
}

function loadPosition(): Position {
  if (typeof window === "undefined") return DEFAULT_POSITION;
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return DEFAULT_POSITION;
    const parsed = JSON.parse(raw) as Partial<Position>;
    return {
      right:
        typeof parsed.right === "number"
          ? parsed.right
          : DEFAULT_POSITION.right,
      bottom:
        typeof parsed.bottom === "number"
          ? parsed.bottom
          : DEFAULT_POSITION.bottom,
    };
  } catch {
    return DEFAULT_POSITION;
  }
}

function savePosition(p: Position) {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(p));
  } catch {
    /* ignore */
  }
}

export function PetOverlay({ pet }: Props) {
  const active = useMemo(() => resolveActivePet(pet), [pet]);
  const eventMode = pet?.eventMode ?? "full";
  const petScale = resolvePetScale(pet?.petScale);
  const [bubbleOpen, setBubbleOpen] = useState(false);
  const [ambientIdx, setAmbientIdx] = useState(0);
  const [position, setPosition] = useState<Position>(() => loadPosition());
  const [isDragging, setIsDragging] = useState(false);
  const [interaction, setInteraction] = useState<PetInteraction>("idle");
  const [ambientRowId, setAmbientRowId] = useState<string | null>(null);
  const [bubbleLine, setBubbleLine] = useState<string | null>(null);
  const [hovered, setHovered] = useState(false);
  const dragRef = useRef<{
    startX: number;
    startY: number;
    startRight: number;
    startBottom: number;
    moved: boolean;
    direction: "right" | "left" | "up" | "down" | null;
  } | null>(null);
  const waitingTimerRef = useRef<number | null>(null);
  const eventTimeoutRef = useRef<number | null>(null);
  const bubbleTimeoutRef = useRef<number | null>(null);

  const openBubble = useCallback((line: string, durationMs = 3000) => {
    setBubbleLine(line);
    setBubbleOpen(true);
    if (bubbleTimeoutRef.current != null) {
      window.clearTimeout(bubbleTimeoutRef.current);
    }
    bubbleTimeoutRef.current = window.setTimeout(() => {
      setBubbleOpen(false);
      bubbleTimeoutRef.current = null;
    }, durationMs);
  }, []);

  useEffect(() => {
    if (!active) return;
    openBubble(active.greeting, 4000);
  }, [active?.id, active?.greeting, openBubble]);

  useEffect(() => {
    savePosition(position);
  }, [position]);

  useEffect(() => {
    return () => {
      if (bubbleTimeoutRef.current != null) {
        window.clearTimeout(bubbleTimeoutRef.current);
      }
      if (eventTimeoutRef.current != null) {
        window.clearTimeout(eventTimeoutRef.current);
      }
      if (waitingTimerRef.current != null) {
        window.clearTimeout(waitingTimerRef.current);
      }
    };
  }, []);

  const lines = useMemo(
    () => (active ? [active.greeting, ...ambientLines(active.name)] : []),
    [active],
  );

  useEffect(() => {
    const es = new EventSource("/api/events");
    es.onmessage = (e) => {
      try {
        const event = JSON.parse(e.data);
        if (event.type === "config-updated") return;
        if (active) {
          const eLines = eventLines(active.name, event);
          if (eLines.length > 0) {
            openBubble(eLines[Math.floor(Math.random() * eLines.length)]);
          }
        }

        if (eventMode === "message-only") {
          return;
        }

        const newInteraction = eventToInteraction(event);
        if (newInteraction === "idle") {
          return;
        }
        setInteraction(newInteraction);
        if (eventTimeoutRef.current != null) {
          window.clearTimeout(eventTimeoutRef.current);
        }
        eventTimeoutRef.current = window.setTimeout(() => {
          setInteraction("idle");
          eventTimeoutRef.current = null;
        }, EVENT_INTERACTION_TIMEOUT_MS);
      } catch {
        /* ignore parse errors */
      }
    };
    es.onerror = () => {
      /* auto-reconnect */
    };
    return () => es.close();
  }, [active, eventMode, openBubble]);

  const armWaitingTimer = useCallback(() => {
    if (waitingTimerRef.current != null) {
      window.clearTimeout(waitingTimerRef.current);
    }
    waitingTimerRef.current = window.setTimeout(() => {
      setInteraction((prev) => (prev === "idle" ? "waiting" : prev));
      waitingTimerRef.current = null;
    }, WAITING_AFTER_MS);
  }, []);

  useEffect(() => {
    if (!active) return;
    armWaitingTimer();
    return () => {
      if (waitingTimerRef.current != null) {
        window.clearTimeout(waitingTimerRef.current);
        waitingTimerRef.current = null;
      }
    };
  }, [active?.id, armWaitingTimer]);

  useEffect(() => {
    if (interaction !== "idle") {
      setAmbientRowId(null);
      return;
    }
    const atlas = active?.atlas;
    if (!atlas || atlas.rowsDef.length === 0) return;

    let playTimer: number | undefined;
    let restTimer: number | undefined;
    let lastPlayedId: string | undefined;

    const playBeat = () => {
      const def = pickAmbientRow(atlas, lastPlayedId);
      if (!def) return;
      lastPlayedId = def.id;
      setAmbientRowId(def.id);
      const playMs =
        AMBIENT_PLAY_MIN_MS +
        Math.floor(Math.random() * AMBIENT_PLAY_VARIANCE_MS);
      playTimer = window.setTimeout(() => {
        setAmbientRowId(null);
        const restMs =
          AMBIENT_REST_MIN_MS +
          Math.floor(Math.random() * AMBIENT_REST_VARIANCE_MS);
        restTimer = window.setTimeout(playBeat, restMs);
      }, playMs);
    };

    const initialDelay =
      AMBIENT_INITIAL_DELAY_MIN_MS +
      Math.floor(Math.random() * AMBIENT_INITIAL_DELAY_VARIANCE_MS);
    restTimer = window.setTimeout(playBeat, initialDelay);

    return () => {
      if (playTimer != null) window.clearTimeout(playTimer);
      if (restTimer != null) window.clearTimeout(restTimer);
      setAmbientRowId(null);
    };
  }, [interaction, active?.id, active?.atlas]);

  const startDrag = useCallback(
    (point: NativeDragDetail) => {
      if (point.button != null && point.button !== 0) return;
      if (dragRef.current) return;
      console.info("[pet] drag-start", point);
      setIsDragging(true);
      dragRef.current = {
        startX: point.clientX,
        startY: point.clientY,
        startRight: position.right,
        startBottom: position.bottom,
        moved: false,
        direction: null,
      };
      armWaitingTimer();
    },
    [armWaitingTimer, position.bottom, position.right],
  );

  const moveDrag = useCallback(
    (point: NativeDragDetail) => {
      const drag = dragRef.current;
      if (!drag) return;
      const dx = point.clientX - drag.startX;
      const dy = point.clientY - drag.startY;
      if (!drag.moved && Math.abs(dx) + Math.abs(dy) < 4) return;
      if (!drag.moved) {
        console.info("[pet] drag-move-first", { dx, dy, point });
      }
      drag.moved = true;
      const nextRight = Math.max(
        -48,
        Math.min(window.innerWidth - 48, drag.startRight - dx),
      );
      const nextBottom = Math.max(
        -48,
        Math.min(window.innerHeight - 48, drag.startBottom - dy),
      );
      setPosition({ right: nextRight, bottom: nextBottom });

      const absX = Math.abs(dx);
      const absY = Math.abs(dy);
      if (absX < DRAG_GESTURE_MIN_PX && absY < DRAG_GESTURE_MIN_PX) return;
      let dir: "right" | "left" | "up" | "down" | null = null;
      if (absX >= absY * DRAG_AXIS_BIAS) {
        dir = dx > 0 ? "right" : "left";
      } else if (absY >= absX * DRAG_AXIS_BIAS) {
        dir = dy < 0 ? "up" : "down";
      }
      if (dir && dir !== drag.direction) {
        drag.direction = dir;
        setInteraction(
          dir === "right"
            ? "drag-right"
            : dir === "left"
              ? "drag-left"
              : dir === "up"
                ? "drag-up"
                : "drag-down",
        );
      }
      armWaitingTimer();
    },
    [armWaitingTimer],
  );

  const endDrag = useCallback(() => {
    const drag = dragRef.current;
    if (!drag) return;
    console.info("[pet] drag-end", {
      moved: drag.moved,
      direction: drag.direction,
    });
    dragRef.current = null;
    setIsDragging(false);
    if (!drag.moved) {
          setBubbleOpen((open) => {
        const next = !open;
        if (next) {
          const visibleLine =
            lines.length > 0 ? lines[ambientIdx % lines.length] : "";
          setBubbleLine(visibleLine);
          setAmbientIdx((i) => (i + 1) % Math.max(1, lines.length));
        }
        return next;
      });
    }
    setInteraction(hovered ? "hover" : "idle");
    armWaitingTimer();
  }, [ambientIdx, armWaitingTimer, hovered, lines]);

  useEffect(() => {
    const onMove = (event: MouseEvent) => {
      moveDrag({ clientX: event.clientX, clientY: event.clientY });
    };
    const onUp = () => {
      endDrag();
    };
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
    return () => {
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
    };
  }, [endDrag, moveDrag]);

  useEffect(() => {
    const onNativeStart = (event: Event) => {
      const detail = (event as CustomEvent<NativeDragDetail>).detail;
      if (!detail) return;
      startDrag(detail);
    };
    const onNativeMove = (event: Event) => {
      const detail = (event as CustomEvent<NativeDragDetail>).detail;
      if (!detail) return;
      moveDrag(detail);
    };
    const onNativeEnd = () => {
      endDrag();
    };
    window.addEventListener("petcompanion-drag-start", onNativeStart);
    window.addEventListener("petcompanion-drag-move", onNativeMove);
    window.addEventListener("petcompanion-drag-end", onNativeEnd);
    return () => {
      window.removeEventListener("petcompanion-drag-start", onNativeStart);
      window.removeEventListener("petcompanion-drag-move", onNativeMove);
      window.removeEventListener("petcompanion-drag-end", onNativeEnd);
    };
  }, [endDrag, moveDrag, startDrag]);

  if (!active) return null;

  const onMouseDown = (event: React.MouseEvent<HTMLDivElement>) => {
    event.preventDefault();
    console.info("[pet] mouse-down", {
      button: event.button,
      clientX: event.clientX,
      clientY: event.clientY,
    });
    startDrag({
      button: event.button,
      clientX: event.clientX,
      clientY: event.clientY,
    });
  };

  const onPointerEnter = () => {
    setHovered(true);
    if (!dragRef.current) setInteraction("hover");
    armWaitingTimer();
  };

  const onPointerLeave = () => {
    setHovered(false);
    if (!dragRef.current) setInteraction("idle");
    armWaitingTimer();
  };

  return (
    <div
      className="pet-overlay"
      role="complementary"
      aria-label="Pet companion"
      data-pet-dragging={isDragging ? "true" : "false"}
      style={{
        right: position.right,
        bottom: position.bottom,
        ["--pet-scale" as string]: String(petScale),
        ["--pet-accent" as string]: active.accent,
        ["--pet-bubble-bg" as string]: active.bubbleBg ?? "var(--bg-panel)",
        ["--pet-bubble-text" as string]: active.bubbleText ?? "var(--text)",
      }}
    >
      {bubbleOpen ? (
        <div className="pet-bubble" role="status">
          <div className="pet-bubble-name">{active.name}</div>
          <div className="pet-bubble-line">
            {bubbleLine ??
              (lines.length > 0 ? lines[ambientIdx % lines.length] : "")}
          </div>
        </div>
      ) : null}
      <div
        className="pet-sprite"
        draggable={false}
        onMouseDown={onMouseDown}
        onPointerEnter={onPointerEnter}
        onPointerLeave={onPointerLeave}
        data-pet-state={interaction}
        data-pet-ambient={ambientRowId ?? undefined}
        style={{
          ["--pet-anim" as string]: active.atlas
            ? "none"
            : `pet-${active.animation}`,
        }}
      >
        <PetSpriteFace
          active={active}
          className="pet-sprite-glyph"
          rowId={ambientRowId ?? preferredRowId(interaction)}
        />
        <span className="pet-sprite-shadow" aria-hidden />
      </div>
    </div>
  );
}
