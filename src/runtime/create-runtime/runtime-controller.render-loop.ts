import type { WebGPUState, WebGLState } from "../../renderer";
import type {
  RuntimeControllerInternalState,
  RuntimeControllerSharedState,
} from "./runtime-controller.state.types";

type CreateRuntimeControllerRenderLoopOptions = {
  internalState: RuntimeControllerInternalState;
  readState: () => RuntimeControllerSharedState;
  writeState: (patch: Partial<RuntimeControllerSharedState>) => void;
  resizeState: { lastAt: number };
  CURSOR_BLINK_MS: number;
  RESIZE_ACTIVE_MS: number;
  BACKGROUND_RENDER_FPS: number;
  isSynchronizedOutput: () => boolean;
  tickWebGPU: (state: WebGPUState) => void;
  tickWebGL: (state: WebGLState) => void;
  /** The screen changes with time alone (shader stages, Kitty images): the loop runs every frame. */
  isAnimated?: () => boolean;
  /** The cursor drawn last blinks: an idle loop wakes for each blink. */
  isCursorBlinking?: () => boolean;
};

/**
 * The render loop runs on requestAnimationFrame only while there is something to draw. Idle, it
 * schedules no frame at all (an idle rAF loop keeps the page and the GPU process awake 60 times
 * a second): `wake` starts it again when the screen is marked for drawing, and a blinking cursor
 * wakes it on a timer for each blink.
 */
export function createRuntimeControllerRenderLoop(
  options: CreateRuntimeControllerRenderLoopOptions,
) {
  /** the surface the loop draws on; null once it is stopped */
  let surface: WebGPUState | WebGLState | null = null;
  let blinkTimer: ReturnType<typeof setTimeout> | null = null;
  /** inside a frame: what it marks for drawing is taken by the frame's own end, not by `wake` */
  let inFrame = false;

  function canRenderFrame(shared: RuntimeControllerSharedState): boolean {
    return Boolean(shared.wasmReady && shared.wasm && shared.wasmHandle);
  }

  function clearBlinkTimer() {
    if (blinkTimer === null) return;
    clearTimeout(blinkTimer);
    blinkTimer = null;
  }

  function schedule(state: WebGPUState | WebGLState) {
    if (options.internalState.rafId !== 0) return;
    options.internalState.rafId = requestAnimationFrame(() => loop(state));
  }

  function loop(state: WebGPUState | WebGLState) {
    surface = state;
    options.internalState.rafId = 0;
    clearBlinkTimer();
    // paused, the loop stays idle: unpausing wakes it
    if (options.internalState.paused) return;
    inFrame = true;
    try {
      frame(state);
    } finally {
      inFrame = false;
    }
  }

  function frame(state: WebGPUState | WebGLState) {
    const now = performance.now();
    const blinking = options.isCursorBlinking?.() ?? false;
    if (now >= options.internalState.nextBlinkTime) {
      options.internalState.nextBlinkTime = now + options.CURSOR_BLINK_MS;
      if (blinking) options.writeState({ needsRender: true });
    }
    const resizeActive = now - options.resizeState.lastAt <= options.RESIZE_ACTIVE_MS;
    if (resizeActive) {
      options.writeState({ needsRender: true });
    }
    const hidden =
      typeof document !== "undefined" &&
      typeof document.visibilityState === "string" &&
      document.visibilityState !== "visible";
    const shared = options.readState();
    // Foreground frames present on every rAF tick when dirty; rAF is
    // already vsync-aligned, so an elapsed-time budget only drops frames.
    // Hidden surfaces keep a low-rate budget.
    const renderBudget = hidden
      ? now - shared.lastRenderTime >= 1000 / options.BACKGROUND_RENDER_FPS
      : true;
    const imageChanged =
      canRenderFrame(shared) && shared.wasm!.tickKittyAnimations(shared.wasmHandle, now);
    if (imageChanged) options.writeState({ needsRender: true });
    if ((shared.needsRender || imageChanged) && renderBudget) {
      // Avoid presenting a cleared frame before the terminal core has a live handle.
      // Leaving needsRender=true retries immediately once startup finishes.
      // While the app holds synchronized output (mode 2026) presentation
      // pauses on the last stable frame; needsRender stays pending so the
      // frame right after the end sequence presents the complete update.
      if (canRenderFrame(shared) && !options.isSynchronizedOutput()) {
        shared.wasm!.renderUpdate(shared.wasmHandle);
        if (options.internalState.backend === "webgpu" && "device" in state) {
          options.tickWebGPU(state);
        }
        if (options.internalState.backend === "webgl2" && "gl" in state) {
          options.tickWebGL(state);
        }
        options.writeState({ lastRenderTime: now, needsRender: false });
      }
    }
    // a frame still pending (synchronized output, startup, the hidden budget), a resize settling
    // or a screen that moves by itself takes the next frame too
    if (options.readState().needsRender || resizeActive || (options.isAnimated?.() ?? false)) {
      schedule(state);
      return;
    }
    if (blinking) {
      // the cursor's visibility flips on each multiple of the blink period
      const delay = options.CURSOR_BLINK_MS - (now % options.CURSOR_BLINK_MS);
      blinkTimer = setTimeout(() => {
        blinkTimer = null;
        options.writeState({ needsRender: true });
        wake();
      }, delay);
    }
  }

  /** The screen was marked for drawing, or the loop unpaused: an idle loop takes the next frame. */
  function wake() {
    if (surface === null || inFrame || options.internalState.rafId !== 0) return;
    clearBlinkTimer();
    schedule(surface);
  }

  /** The surface goes (another renderer, destroy): the loop draws nothing more until started again. */
  function stop() {
    if (options.internalState.rafId !== 0) cancelAnimationFrame(options.internalState.rafId);
    options.internalState.rafId = 0;
    clearBlinkTimer();
    surface = null;
  }

  return {
    loop,
    wake,
    stop,
  };
}
