// ─── Timeline state ───────────────────────────────────────────────────────────
// placed = { clip, startTime, stretchRatio, reversed, _container }
// clip   = { startTime, duration, samples }

export const timeline = [];
export const clips    = [];

export const selection = { startTime: null, endTime: null };

// ─── Playback state ───────────────────────────────────────────────────────────

export let mainPlayNode   = null;   // currently playing BufferSourceNode
export let mainPlayStart  = null;   // audioCtx.currentTime when play began
export let mainPlayOffset = null;   // source offset (seconds) when play began
export let transportStart = null;   // audioCtx.currentTime when timeline started
export const activeSources = [];

export function setMainPlayNode(v)   { mainPlayNode   = v; }
export function setMainPlayStart(v)  { mainPlayStart  = v; }
export function setMainPlayOffset(v) { mainPlayOffset = v; }
export function setTransportStart(v) { transportStart = v; }

// ─── UI state ─────────────────────────────────────────────────────────────────

export let shiftDown   = false;
export let clipDragging = false;

export function setShiftDown(v)    { shiftDown    = v; }
export function setClipDragging(v) { clipDragging = v; }
