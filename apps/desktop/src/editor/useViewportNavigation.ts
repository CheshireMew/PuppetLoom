import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import type React from "react";

interface ViewportTransform {
  zoom: number;
  x: number;
  y: number;
}

interface PanGesture {
  pointerId: number;
  startX: number;
  startY: number;
  originX: number;
  originY: number;
}

const MIN_ZOOM = 0.25;
const MAX_ZOOM = 8;
const MINIMUM_VISIBLE_PIXELS = 64;

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(maximum, value));
}

function isEditableTarget(target: EventTarget | null): boolean {
  return target instanceof Element && Boolean(target.closest("input, select, textarea, [contenteditable='true']"));
}

function isViewportControl(target: EventTarget | null): boolean {
  return target instanceof Element && Boolean(target.closest("button, input, select, textarea, a, [contenteditable='true']"));
}

function isEditorHandle(target: EventTarget | null): boolean {
  return target instanceof Element && Boolean(target.closest(".handle, .handle-hit"));
}

export function useViewportNavigation(aspectRatio: number): {
  viewportRef: React.RefObject<HTMLDivElement | null>;
  stageRef: React.RefObject<HTMLDivElement | null>;
  transform: ViewportTransform;
  stageSize: { width: number; height: number };
  zoomPercent: number;
  panning: boolean;
  spacePressed: boolean;
  zoomIn: () => void;
  zoomOut: () => void;
  fit: () => void;
  viewportHandlers: {
    onWheel: React.WheelEventHandler<HTMLDivElement>;
    onPointerDownCapture: React.PointerEventHandler<HTMLDivElement>;
    onPointerMoveCapture: React.PointerEventHandler<HTMLDivElement>;
    onPointerUpCapture: React.PointerEventHandler<HTMLDivElement>;
    onPointerCancelCapture: React.PointerEventHandler<HTMLDivElement>;
    onLostPointerCapture: React.PointerEventHandler<HTMLDivElement>;
    onPointerEnter: React.PointerEventHandler<HTMLDivElement>;
    onPointerLeave: React.PointerEventHandler<HTMLDivElement>;
    onDoubleClick: React.MouseEventHandler<HTMLDivElement>;
  };
} {
  const viewportRef = useRef<HTMLDivElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const panGesture = useRef<PanGesture | undefined>(undefined);
  const pointerInside = useRef(false);
  const spaceDown = useRef(false);
  const [transform, setTransform] = useState<ViewportTransform>({ zoom: 1, x: 0, y: 0 });
  const [stageSize, setStageSize] = useState(() => ({ width: 760, height: 760 / Math.max(0.01, aspectRatio) }));
  const [panning, setPanning] = useState(false);
  const [spacePressed, setSpacePressed] = useState(false);

  useLayoutEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    const safeAspectRatio = Math.max(0.01, aspectRatio);
    const measure = () => {
      const availableWidth = Math.max(1, viewport.clientWidth - 2);
      const availableHeight = Math.max(1, viewport.clientHeight - 2);
      const width = Math.min(760, availableWidth, availableHeight * safeAspectRatio);
      setStageSize({ width, height: width / safeAspectRatio });
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(viewport);
    return () => observer.disconnect();
  }, [aspectRatio]);

  const clampTransform = useCallback((next: ViewportTransform): ViewportTransform => {
    const viewport = viewportRef.current;
    const stage = stageRef.current;
    if (!viewport || !stage) return next;
    const maximumX = Math.max(0, (viewport.clientWidth + stage.offsetWidth * next.zoom) / 2 - MINIMUM_VISIBLE_PIXELS);
    const maximumY = Math.max(0, (viewport.clientHeight + stage.offsetHeight * next.zoom) / 2 - MINIMUM_VISIBLE_PIXELS);
    return { ...next, x: clamp(next.x, -maximumX, maximumX), y: clamp(next.y, -maximumY, maximumY) };
  }, []);

  const fit = useCallback(() => {
    setTransform({ zoom: 1, x: 0, y: 0 });
  }, []);

  const zoomBy = useCallback((factor: number, clientX?: number, clientY?: number) => {
    setTransform((current) => {
      const viewport = viewportRef.current;
      const zoom = clamp(current.zoom * factor, MIN_ZOOM, MAX_ZOOM);
      if (!viewport || zoom === current.zoom) return current;
      const rect = viewport.getBoundingClientRect();
      const anchorX = (clientX ?? rect.left + rect.width / 2) - (rect.left + rect.width / 2);
      const anchorY = (clientY ?? rect.top + rect.height / 2) - (rect.top + rect.height / 2);
      const ratio = zoom / current.zoom;
      return clampTransform({
        zoom,
        x: anchorX - (anchorX - current.x) * ratio,
        y: anchorY - (anchorY - current.y) * ratio
      });
    });
  }, [clampTransform]);

  const zoomIn = useCallback(() => {
    zoomBy(1.25);
  }, [zoomBy]);

  const zoomOut = useCallback(() => {
    zoomBy(1 / 1.25);
  }, [zoomBy]);

  useEffect(() => {
    function keyDown(event: KeyboardEvent): void {
      if (!pointerInside.current || isEditableTarget(event.target)) return;
      if (event.code === "Space") {
        spaceDown.current = true;
        setSpacePressed(true);
        event.preventDefault();
      } else if (event.key === "0") {
        fit();
        event.preventDefault();
      } else if (event.key === "+" || event.key === "=") {
        zoomIn();
        event.preventDefault();
      } else if (event.key === "-" || event.key === "_") {
        zoomOut();
        event.preventDefault();
      }
    }

    function keyUp(event: KeyboardEvent): void {
      if (event.code !== "Space") return;
      spaceDown.current = false;
      setSpacePressed(false);
    }

    function loseFocus(): void {
      spaceDown.current = false;
      setSpacePressed(false);
      panGesture.current = undefined;
      setPanning(false);
    }

    window.addEventListener("keydown", keyDown);
    window.addEventListener("keyup", keyUp);
    window.addEventListener("blur", loseFocus);
    return () => {
      window.removeEventListener("keydown", keyDown);
      window.removeEventListener("keyup", keyUp);
      window.removeEventListener("blur", loseFocus);
    };
  }, [fit, zoomIn, zoomOut]);

  useEffect(() => {
    function resize(): void {
      setTransform((current) => clampTransform(current));
    }
    window.addEventListener("resize", resize);
    return () => window.removeEventListener("resize", resize);
  }, [clampTransform]);

  const onWheel = useCallback<React.WheelEventHandler<HTMLDivElement>>((event) => {
    event.preventDefault();
    const unit = event.deltaMode === WheelEvent.DOM_DELTA_LINE ? 16 : event.deltaMode === WheelEvent.DOM_DELTA_PAGE ? event.currentTarget.clientHeight : 1;
    zoomBy(Math.exp(-event.deltaY * unit * 0.0015), event.clientX, event.clientY);
  }, [zoomBy]);

  const onPointerDownCapture = useCallback<React.PointerEventHandler<HTMLDivElement>>((event) => {
    const forcedPan = event.button === 1 || event.button === 0 && spaceDown.current;
    const backgroundPan = event.button === 0 && !isEditorHandle(event.target) && !isViewportControl(event.target);
    if (!forcedPan && !backgroundPan) return;
    event.preventDefault();
    event.stopPropagation();
    event.currentTarget.focus({ preventScroll: true });
    event.currentTarget.setPointerCapture(event.pointerId);
    panGesture.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      originX: transform.x,
      originY: transform.y
    };
    setPanning(true);
  }, [transform.x, transform.y]);

  const onPointerMoveCapture = useCallback<React.PointerEventHandler<HTMLDivElement>>((event) => {
    const gesture = panGesture.current;
    if (!gesture || gesture.pointerId !== event.pointerId) return;
    event.preventDefault();
    event.stopPropagation();
    setTransform((current) => clampTransform({
      ...current,
      x: gesture.originX + event.clientX - gesture.startX,
      y: gesture.originY + event.clientY - gesture.startY
    }));
  }, [clampTransform]);

  const finishPan = useCallback<React.PointerEventHandler<HTMLDivElement>>((event) => {
    const gesture = panGesture.current;
    if (!gesture || gesture.pointerId !== event.pointerId) return;
    event.preventDefault();
    event.stopPropagation();
    panGesture.current = undefined;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    setPanning(false);
  }, []);

  const onLostPointerCapture = useCallback<React.PointerEventHandler<HTMLDivElement>>((event) => {
    if (panGesture.current?.pointerId !== event.pointerId) return;
    panGesture.current = undefined;
    setPanning(false);
  }, []);

  const onDoubleClick = useCallback<React.MouseEventHandler<HTMLDivElement>>((event) => {
    if (isEditorHandle(event.target) || isViewportControl(event.target)) return;
    event.preventDefault();
    fit();
  }, [fit]);

  return {
    viewportRef,
    stageRef,
    transform,
    stageSize,
    zoomPercent: Math.round(transform.zoom * 100),
    panning,
    spacePressed,
    zoomIn,
    zoomOut,
    fit,
    viewportHandlers: {
      onWheel,
      onPointerDownCapture,
      onPointerMoveCapture,
      onPointerUpCapture: finishPan,
      onPointerCancelCapture: finishPan,
      onLostPointerCapture,
      onPointerEnter: () => { pointerInside.current = true; },
      onPointerLeave: () => { pointerInside.current = false; },
      onDoubleClick
    }
  };
}
