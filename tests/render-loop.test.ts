import { afterEach, beforeEach, expect, test } from "bun:test";
import type { WebGPUState } from "../src/renderer";
import { createRuntimeControllerRenderLoop } from "../src/runtime/create-runtime/runtime-controller.render-loop";
import type { RuntimeControllerSharedState } from "../src/runtime/create-runtime/runtime-controller.state.types";

const originalRequestAnimationFrame = globalThis.requestAnimationFrame;

beforeEach(() => {
  Object.defineProperty(globalThis, "requestAnimationFrame", {
    configurable: true,
    writable: true,
    value: () => 1,
  });
});

afterEach(() => {
  if (originalRequestAnimationFrame) {
    Object.defineProperty(globalThis, "requestAnimationFrame", {
      configurable: true,
      writable: true,
      value: originalRequestAnimationFrame,
    });
  } else {
    delete (globalThis as { requestAnimationFrame?: unknown }).requestAnimationFrame;
  }
});

function createLoopHarness(
  options: { synchronizedOutput?: () => boolean; imageChanged?: () => boolean } = {},
) {
  const renderUpdates: number[] = [];
  const ticks: number[] = [];
  const wasm = {
    tickKittyAnimations: options.imageChanged ?? (() => false),
    renderUpdate: (handle: number) => {
      renderUpdates.push(handle);
    },
  };
  const sharedState = {
    wasm: wasm as never,
    wasmExports: null,
    wasmHandle: 1,
    wasmReady: true,
    activeState: null,
    needsRender: true,
    lastRenderTime: 0,
    currentContextType: "webgpu",
    isFocused: true,
    lastKeydownSeq: "",
    lastKeydownSeqAt: 0,
  } as RuntimeControllerSharedState;
  const internalState = {
    paused: false,
    backend: "webgpu" as const,
    preferredRenderer: "webgpu" as const,
    rafId: 0,
    nextBlinkTime: performance.now() + 600,
  };
  const { loop } = createRuntimeControllerRenderLoop({
    internalState,
    readState: () => sharedState,
    writeState: (patch) => Object.assign(sharedState, patch),
    resizeState: { lastAt: -10_000 },
    CURSOR_BLINK_MS: 600,
    RESIZE_ACTIVE_MS: 180,
    BACKGROUND_RENDER_FPS: 15,
    isSynchronizedOutput: options.synchronizedOutput ?? (() => false),
    tickWebGPU: () => {
      ticks.push(1);
    },
    tickWebGL: () => {},
  });
  const gpuState = { device: {} } as WebGPUState;
  return { loop, sharedState, renderUpdates, ticks, gpuState };
}

test("render loop presents dirty frames on consecutive rAF ticks without an FPS budget", () => {
  const harness = createLoopHarness();

  harness.loop(harness.gpuState);
  expect(harness.ticks.length).toBe(1);
  expect(harness.sharedState.needsRender).toBe(false);

  harness.sharedState.needsRender = true;
  harness.loop(harness.gpuState);
  expect(harness.ticks.length).toBe(2);
});

test("render loop refreshes the terminal snapshot before each presented frame", () => {
  const harness = createLoopHarness();

  harness.loop(harness.gpuState);

  expect(harness.renderUpdates).toEqual([1]);
});

test("render loop holds presentation while synchronized output is active", () => {
  let syncActive = true;
  const harness = createLoopHarness({ synchronizedOutput: () => syncActive });

  harness.loop(harness.gpuState);
  harness.loop(harness.gpuState);
  expect(harness.ticks.length).toBe(0);
  expect(harness.renderUpdates.length).toBe(0);
  expect(harness.sharedState.needsRender).toBe(true);

  syncActive = false;
  harness.loop(harness.gpuState);
  expect(harness.ticks.length).toBe(1);
  expect(harness.renderUpdates).toEqual([1]);
  expect(harness.sharedState.needsRender).toBe(false);
});

test("image frame changes render without new terminal output", () => {
  const harness = createLoopHarness({ imageChanged: () => true });
  harness.sharedState.needsRender = false;
  harness.loop(harness.gpuState);
  expect(harness.ticks).toEqual([1]);
  expect(harness.sharedState.needsRender).toBe(false);
});

function createIdleHarness(
  options: {
    animated?: () => boolean;
    blinking?: () => boolean;
    synchronizedOutput?: () => boolean;
  } = {},
) {
  const frames: Array<() => void> = [];
  Object.defineProperty(globalThis, "requestAnimationFrame", {
    configurable: true,
    writable: true,
    value: (callback: () => void) => frames.push(callback),
  });
  Object.defineProperty(globalThis, "cancelAnimationFrame", {
    configurable: true,
    writable: true,
    value: (id: number) => {
      frames[id - 1] = () => {};
    },
  });
  const ticks: number[] = [];
  const sharedState = {
    wasm: { tickKittyAnimations: () => false, renderUpdate: () => {} } as never,
    wasmExports: null,
    wasmHandle: 1,
    wasmReady: true,
    activeState: null,
    needsRender: true,
    lastRenderTime: 0,
    currentContextType: "webgpu",
    isFocused: true,
    lastKeydownSeq: "",
    lastKeydownSeqAt: 0,
  } as RuntimeControllerSharedState;
  const internalState = {
    paused: false,
    backend: "webgpu" as const,
    preferredRenderer: "webgpu" as const,
    rafId: 0,
    nextBlinkTime: performance.now() + 600,
  };
  const renderLoop = createRuntimeControllerRenderLoop({
    internalState,
    readState: () => sharedState,
    writeState: (patch) => Object.assign(sharedState, patch),
    resizeState: { lastAt: -10_000 },
    CURSOR_BLINK_MS: 600,
    RESIZE_ACTIVE_MS: 180,
    BACKGROUND_RENDER_FPS: 15,
    isSynchronizedOutput: options.synchronizedOutput ?? (() => false),
    tickWebGPU: () => {
      ticks.push(1);
      onTick?.();
    },
    tickWebGL: () => {},
    isAnimated: options.animated ?? (() => false),
    isCursorBlinking: options.blinking ?? (() => false),
  });
  let onTick: (() => void) | undefined;
  const gpuState = { device: {} } as WebGPUState;
  /** runs the frames requested so far, as the browser would on its next vsync */
  const runFrames = () => {
    for (const frame of frames.splice(0)) frame();
  };
  return {
    ...renderLoop,
    sharedState,
    internalState,
    frames,
    ticks,
    gpuState,
    runFrames,
    onTick: (hook: () => void) => {
      onTick = hook;
    },
  };
}

test("an idle render loop requests no frame until the screen is marked for drawing", () => {
  const harness = createIdleHarness();
  harness.loop(harness.gpuState);
  expect(harness.ticks).toEqual([1]);
  expect(harness.frames).toHaveLength(0);

  harness.sharedState.needsRender = true;
  harness.wake();
  harness.wake();
  expect(harness.frames).toHaveLength(1);
  harness.runFrames();
  expect(harness.ticks).toEqual([1, 1]);
  expect(harness.frames).toHaveLength(0);
});

test("a render marked while a frame draws asks for one frame, not one more each frame", () => {
  // a screen that keeps the loop busy, and a frame that marks another render while it draws
  const harness = createIdleHarness({ animated: () => true });
  harness.onTick(() => harness.wake());
  harness.loop(harness.gpuState);
  for (let i = 0; i < 5; i += 1) {
    harness.sharedState.needsRender = true;
    harness.runFrames();
  }
  expect(harness.frames).toHaveLength(1);
});

test("a frame still pending keeps the loop on every frame", () => {
  let syncActive = true;
  const harness = createIdleHarness({ synchronizedOutput: () => syncActive });
  harness.loop(harness.gpuState);
  expect(harness.ticks).toHaveLength(0);
  expect(harness.frames).toHaveLength(1);
  syncActive = false;
  harness.runFrames();
  expect(harness.ticks).toEqual([1]);
  expect(harness.frames).toHaveLength(0);
});

test("a screen that moves by itself keeps the loop on every frame", () => {
  const harness = createIdleHarness({ animated: () => true });
  harness.loop(harness.gpuState);
  expect(harness.frames).toHaveLength(1);
  harness.runFrames();
  expect(harness.frames).toHaveLength(1);
});

test("a blinking cursor wakes an idle loop for its next blink", async () => {
  const harness = createIdleHarness({ blinking: () => true });
  harness.loop(harness.gpuState);
  expect(harness.frames).toHaveLength(0);
  await until(() => harness.frames.length > 0, "the blink frame");
  expect(harness.sharedState.needsRender).toBe(true);
  harness.runFrames();
  expect(harness.ticks).toEqual([1, 1]);
  harness.stop();
});

test("a paused or stopped loop requests no frame, and unpausing wakes it", () => {
  const harness = createIdleHarness();
  harness.internalState.paused = true;
  harness.loop(harness.gpuState);
  expect(harness.ticks).toHaveLength(0);
  expect(harness.frames).toHaveLength(0);
  harness.internalState.paused = false;
  harness.wake();
  harness.runFrames();
  expect(harness.ticks).toEqual([1]);

  harness.stop();
  harness.sharedState.needsRender = true;
  harness.wake();
  expect(harness.frames).toHaveLength(0);
});

async function until(check: () => boolean, label: string, timeout = 2000): Promise<void> {
  const deadline = Date.now() + timeout;
  while (!check()) {
    if (Date.now() >= deadline) throw new Error(`Timed out: ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
