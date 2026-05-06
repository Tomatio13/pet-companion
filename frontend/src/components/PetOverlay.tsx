import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type MutableRefObject,
} from "react";
import type { PetConfig } from "../types";
import {
  ambientLines,
  pickAmbientRow,
  pickAtlasRow,
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

type WalkingDirection = "right" | "left";

interface WalkingMotion {
  dx: number;
  dy: number;
  clampHits: number;
}

const DEFAULT_POSITION: Position = { right: 24, bottom: 24 };
const WAITING_AFTER_MS = 45000;
const EVENT_INTERACTION_TIMEOUT_MS = 2000;
const WALK_IDLE_MIN_MS = 8000;
const WALK_IDLE_VARIANCE_MS = 12000;
const WALK_DURATION_MIN_MS = 1200;
const WALK_DURATION_VARIANCE_MS = 1800;
const WALK_TICK_MS = 32;
const WALK_HORIZONTAL_SPEED_PX = 4;
const WALK_VERTICAL_SPEED_PX = 1.5;
const WALK_DRAG_COOLDOWN_MIN_MS = 2000;
const WALK_DRAG_COOLDOWN_VARIANCE_MS = 3000;

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
const MIN_POSITION = -48;

function resolvePetScale(value: number | undefined): number {
  if (!Number.isFinite(value as number)) return DEFAULT_PET_SCALE;
  return Math.max(MIN_PET_SCALE, Math.min(MAX_PET_SCALE, Number(value)));
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

function setDesktopOverlayInteractivity(interactive: boolean) {
  window.petCompanionDesktop?.setOverlayInteractivity(interactive);
}

function setDesktopHoverRegion(region: {
  left: number;
  top: number;
  right: number;
  bottom: number;
} | null) {
  window.petCompanionDesktop?.updateHoverRegion(region);
}

function clearWindowTimer(ref: MutableRefObject<number | null>) {
  if (ref.current != null) {
    window.clearTimeout(ref.current);
    ref.current = null;
  }
}

function randomDelay(minMs: number, varianceMs: number): number {
  return minMs + Math.floor(Math.random() * varianceMs);
}

export function PetOverlay({ pet }: Props) {
  const active = useMemo(() => resolveActivePet(pet), [pet]);
  const eventMode = pet?.eventMode ?? "full";
  const walkingEnabled = pet?.walkingEnabled ?? true;
  const petScale = resolvePetScale(pet?.petScale);
  const [bubbleOpen, setBubbleOpen] = useState(false);
  const [ambientIdx, setAmbientIdx] = useState(0);
  const [position, setPosition] = useState<Position>(() => loadPosition());
  const [isDragging, setIsDragging] = useState(false);
  const [interaction, setInteraction] = useState<PetInteraction>("idle");
  const [ambientRowId, setAmbientRowId] = useState<string | null>(null);
  const [bubbleLine, setBubbleLine] = useState<string | null>(null);
  const [hovered, setHovered] = useState(false);
  const [walkingDirection, setWalkingDirection] =
    useState<WalkingDirection | null>(null);
  const overlayRef = useRef<HTMLDivElement | null>(null);
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
  const walkingDelayRef = useRef<number | null>(null);
  const walkingTickRef = useRef<number | null>(null);
  const walkingTimeoutAtRef = useRef(0);
  const walkingMotionRef = useRef<WalkingMotion | null>(null);
  const hoveredRef = useRef(false);
  const interactionRef = useRef<PetInteraction>("idle");
  const positionRef = useRef(position);

  const openBubble = useCallback((line: string, durationMs = 3000) => {
    setBubbleLine(line);
    setBubbleOpen(true);
    clearWindowTimer(bubbleTimeoutRef);
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
    positionRef.current = position;
  }, [position]);

  useEffect(() => {
    hoveredRef.current = hovered;
  }, [hovered]);

  useEffect(() => {
    interactionRef.current = interaction;
  }, [interaction]);

  const clearWalkingLoop = useCallback(() => {
    clearWindowTimer(walkingTickRef);
    walkingMotionRef.current = null;
    walkingTimeoutAtRef.current = 0;
    setWalkingDirection(null);
  }, []);

  const canWalkNow = useCallback(() => {
    if (!active) return false;
    if (!walkingEnabled) return false;
    if (dragRef.current) return false;
    if (hoveredRef.current) return false;
    return (
      interactionRef.current === "idle" || interactionRef.current === "waiting"
    );
  }, [active, walkingEnabled]);

  const stopWalking = useCallback(() => {
    clearWindowTimer(walkingDelayRef);
    clearWalkingLoop();
  }, [clearWalkingLoop]);

  const armWaitingTimer = useCallback(() => {
    clearWindowTimer(waitingTimerRef);
    waitingTimerRef.current = window.setTimeout(() => {
      setInteraction((prev) => (prev === "idle" ? "waiting" : prev));
      waitingTimerRef.current = null;
    }, WAITING_AFTER_MS);
  }, []);

  const scheduleNextWalk = useCallback(
    (
      minDelayMs = WALK_IDLE_MIN_MS,
      varianceMs = WALK_IDLE_VARIANCE_MS,
    ) => {
      clearWindowTimer(walkingDelayRef);
      if (!active || !walkingEnabled) return;

      walkingDelayRef.current = window.setTimeout(() => {
        walkingDelayRef.current = null;
        if (!canWalkNow()) {
          scheduleNextWalk(minDelayMs, varianceMs);
          return;
        }

        const current = positionRef.current;
        const nearRightEdge = current.right <= 24;
        const nearLeftEdge = current.right >= window.innerWidth - 160;
        const direction: WalkingDirection = nearRightEdge
          ? "left"
          : nearLeftEdge
            ? "right"
            : Math.random() < 0.5
              ? "left"
              : "right";
        const verticalRoll = Math.random();
        const verticalSpeed =
          verticalRoll < 0.25
            ? WALK_VERTICAL_SPEED_PX
            : verticalRoll > 0.75
              ? -WALK_VERTICAL_SPEED_PX
              : 0;

        clearWindowTimer(waitingTimerRef);
        walkingMotionRef.current = {
          dx:
            direction === "right"
              ? -WALK_HORIZONTAL_SPEED_PX
              : WALK_HORIZONTAL_SPEED_PX,
          dy: verticalSpeed,
          clampHits: 0,
        };
        walkingTimeoutAtRef.current =
          Date.now() +
          randomDelay(WALK_DURATION_MIN_MS, WALK_DURATION_VARIANCE_MS);
        setWalkingDirection(direction);
        clearWindowTimer(walkingTickRef);
        walkingTickRef.current = window.setInterval(() => {
          if (!canWalkNow()) {
            stopWalking();
            return;
          }
          if (Date.now() >= walkingTimeoutAtRef.current) {
            stopWalking();
            armWaitingTimer();
            scheduleNextWalk();
            return;
          }

          const motion = walkingMotionRef.current;
          if (!motion) return;

          const maxRight = window.innerWidth - 48;
          const maxBottom = window.innerHeight - 48;
          let shouldStop = false;
          let nextDirection: WalkingDirection | null = null;

          setAmbientRowId(null);
          setPosition((prev) => {
            let nextRight = prev.right + motion.dx;
            let nextBottom = prev.bottom + motion.dy;

            if (nextRight < MIN_POSITION || nextRight > maxRight) {
              motion.clampHits += 1;
              motion.dx *= -1;
              nextDirection = motion.dx < 0 ? "right" : "left";
              nextRight = Math.max(
                MIN_POSITION,
                Math.min(maxRight, prev.right + motion.dx),
              );
            }

            if (nextBottom < MIN_POSITION || nextBottom > maxBottom) {
              motion.clampHits += 1;
              motion.dy =
                motion.dy === 0
                  ? 0
                  : Math.sign(motion.dy * -1) * WALK_VERTICAL_SPEED_PX;
              nextBottom = Math.max(
                MIN_POSITION,
                Math.min(maxBottom, prev.bottom + motion.dy),
              );
            }

            if (motion.clampHits >= 2) {
              shouldStop = true;
            }

            return {
              right: Math.max(MIN_POSITION, Math.min(maxRight, nextRight)),
              bottom: Math.max(MIN_POSITION, Math.min(maxBottom, nextBottom)),
            };
          });

          if (nextDirection) {
            setWalkingDirection(nextDirection);
          }
          if (shouldStop) {
            stopWalking();
            armWaitingTimer();
            scheduleNextWalk();
          }
        }, WALK_TICK_MS);
      }, randomDelay(minDelayMs, varianceMs));
    },
    [active, armWaitingTimer, canWalkNow, stopWalking, walkingEnabled],
  );

  useEffect(() => {
    return () => {
      clearWindowTimer(bubbleTimeoutRef);
      clearWindowTimer(eventTimeoutRef);
      clearWindowTimer(waitingTimerRef);
      clearWindowTimer(walkingDelayRef);
      clearWalkingLoop();
    };
  }, [clearWalkingLoop]);

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
        stopWalking();
        setInteraction(newInteraction);
        clearWindowTimer(eventTimeoutRef);
        eventTimeoutRef.current = window.setTimeout(() => {
          setInteraction("idle");
          eventTimeoutRef.current = null;
          armWaitingTimer();
          scheduleNextWalk();
        }, EVENT_INTERACTION_TIMEOUT_MS);
      } catch {
        /* ignore parse errors */
      }
    };
    es.onerror = () => {
      /* auto-reconnect */
    };
    return () => es.close();
  }, [active, armWaitingTimer, eventMode, openBubble, scheduleNextWalk, stopWalking]);

  useEffect(() => {
    if (!active) return;
    armWaitingTimer();
    if (walkingEnabled) {
      scheduleNextWalk();
    } else {
      stopWalking();
    }
    return () => {
      clearWindowTimer(waitingTimerRef);
      clearWindowTimer(walkingDelayRef);
      clearWalkingLoop();
    };
  }, [
    active?.id,
    armWaitingTimer,
    clearWalkingLoop,
    scheduleNextWalk,
    stopWalking,
    walkingEnabled,
  ]);

  useEffect(() => {
    if (interaction !== "idle" || walkingDirection) {
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
  }, [interaction, active?.id, active?.atlas, walkingDirection]);

  const startDrag = useCallback(
    (point: NativeDragDetail) => {
      if (point.button != null && point.button !== 0) return;
      if (dragRef.current) return;
      console.info("[pet] drag-start", point);
      stopWalking();
      setIsDragging(true);
      dragRef.current = {
        startX: point.clientX,
        startY: point.clientY,
        startRight: positionRef.current.right,
        startBottom: positionRef.current.bottom,
        moved: false,
        direction: null,
      };
      armWaitingTimer();
    },
    [armWaitingTimer, stopWalking],
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
        MIN_POSITION,
        Math.min(window.innerWidth - 48, drag.startRight - dx),
      );
      const nextBottom = Math.max(
        MIN_POSITION,
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
    scheduleNextWalk(
      WALK_DRAG_COOLDOWN_MIN_MS,
      WALK_DRAG_COOLDOWN_VARIANCE_MS,
    );
    if (!hovered) {
      setDesktopOverlayInteractivity(false);
    }
  }, [ambientIdx, armWaitingTimer, hovered, lines, scheduleNextWalk]);

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
    setDesktopOverlayInteractivity(true);
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
    stopWalking();
    setDesktopOverlayInteractivity(true);
    setHovered(true);
    if (!dragRef.current) setInteraction("hover");
    armWaitingTimer();
  };

  const onPointerLeave = () => {
    setDesktopOverlayInteractivity(false);
    setHovered(false);
    if (!dragRef.current) setInteraction("idle");
    armWaitingTimer();
    scheduleNextWalk(
      WALK_DRAG_COOLDOWN_MIN_MS,
      WALK_DRAG_COOLDOWN_VARIANCE_MS,
    );
  };

  useEffect(() => {
    const onSyntheticEnter = () => {
      stopWalking();
      setHovered(true);
      if (!dragRef.current) setInteraction("hover");
      armWaitingTimer();
    };
    const onSyntheticLeave = () => {
      setHovered(false);
      if (!dragRef.current) setInteraction("idle");
      armWaitingTimer();
      scheduleNextWalk(
        WALK_DRAG_COOLDOWN_MIN_MS,
        WALK_DRAG_COOLDOWN_VARIANCE_MS,
      );
    };
    window.addEventListener("petcompanion-pointer-enter", onSyntheticEnter);
    window.addEventListener("petcompanion-pointer-leave", onSyntheticLeave);
    return () => {
      window.removeEventListener("petcompanion-pointer-enter", onSyntheticEnter);
      window.removeEventListener("petcompanion-pointer-leave", onSyntheticLeave);
    };
  }, [armWaitingTimer, scheduleNextWalk, stopWalking]);

  useEffect(() => {
    return () => {
      setDesktopOverlayInteractivity(false);
      setDesktopHoverRegion(null);
    };
  }, []);

  useEffect(() => {
    const publishRegion = () => {
      const rect = overlayRef.current?.getBoundingClientRect();
      if (!rect) {
        setDesktopHoverRegion(null);
        return;
      }
      setDesktopHoverRegion({
        left: Math.round(rect.left),
        top: Math.round(rect.top),
        right: Math.round(rect.right),
        bottom: Math.round(rect.bottom),
      });
    };

    publishRegion();
    const id = window.setInterval(publishRegion, 120);
    window.addEventListener("resize", publishRegion);
    return () => {
      window.clearInterval(id);
      window.removeEventListener("resize", publishRegion);
    };
  }, [bubbleOpen, petScale, position.bottom, position.right]);

  const preferredRow =
    walkingDirection == null
      ? preferredRowId(interaction)
      : walkingDirection === "right"
        ? "running-right"
        : "running-left";
  const activeRowId =
    ambientRowId ?? pickAtlasRow(active.atlas, preferredRow)?.id ?? preferredRow;

  return (
    <div
      ref={overlayRef}
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
          rowId={activeRowId}
        />
        <span className="pet-sprite-shadow" aria-hidden />
      </div>
    </div>
  );
}
