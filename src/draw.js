import { audioCtx, sourceBuffer, samples } from './audio.js';
import { selection, mainPlayNode, mainPlayStart, mainPlayOffset, transportStart, setTransportStart } from './state.js';
import { TIMELINE_DURATION, PX_PER_SEC, SELECTION_HANDLE_GRAB } from './constants.js';
import { srcTimeToX } from './waveform.js';

// ─── DOM refs ─────────────────────────────────────────────────────────────────

export const timelineEl     = document.getElementById('timeline');
export const timelineCanvas = document.getElementById('timeline-canvas');
timelineCanvas.width  = timelineCanvas.offsetWidth;
timelineCanvas.height = timelineCanvas.offsetHeight;
export const timelineCtx = timelineCanvas.getContext('2d');

// ─── Waveform canvas ──────────────────────────────────────────────────────────

export const waveformCanvas = document.createElement('canvas');
waveformCanvas.width  = document.getElementById('canvas-container').offsetWidth;
waveformCanvas.height = 300;
waveformCanvas.id = 'waveform-canvas';
document.getElementById('canvas-container').appendChild(waveformCanvas);
export const wCtx = waveformCanvas.getContext('2d');

// Pre-render static waveform into an offscreen cache
const waveformCache = document.createElement('canvas');
waveformCache.width  = waveformCanvas.width;
waveformCache.height = waveformCanvas.height;

(function buildCache() {
    const ctx = waveformCache.getContext('2d');
    const w   = waveformCache.width;
    const h   = waveformCache.height;
    const spp = samples.length / w;
    ctx.fillStyle = '#0a0a0f';
    ctx.fillRect(0, 0, w, h);
    ctx.strokeStyle = '#00ffd0';
    ctx.lineWidth = 1;
    for (let px = 0; px < w; px++) {
        const s = Math.floor(px * spp);
        const e = Math.floor((px + 1) * spp);
        let min = 1, max = -1;
        for (let i = s; i < e; i++) {
            if (samples[i] < min) min = samples[i];
            if (samples[i] > max) max = samples[i];
        }
        const yMin = ((min * -1 + 1) / 2) * h * 0.8 + h * 0.1;
        const yMax = ((max * -1 + 1) / 2) * h * 0.8 + h * 0.1;
        ctx.beginPath();
        ctx.moveTo(px, yMax);
        ctx.lineTo(px, yMin);
        ctx.stroke();
    }
})();

// ─── Draw loop ────────────────────────────────────────────────────────────────

export let waveformMouseX = -1;
export function setWaveformMouseX(v) { waveformMouseX = v; }

export function drawFrame() {
    const w = waveformCanvas.width;
    const h = waveformCanvas.height;

    wCtx.drawImage(waveformCache, 0, 0);

    // Selection
    if (selection.startTime !== null && selection.startTime !== selection.endTime) {
        const left  = Math.min(selection.startTime, selection.endTime);
        const right = Math.max(selection.startTime, selection.endTime);
        const x1 = srcTimeToX(left);
        const x2 = srcTimeToX(right);

        wCtx.fillStyle = 'rgba(0,255,208,0.15)';
        wCtx.fillRect(x1, 0, x2 - x1, h);

        wCtx.fillStyle = 'rgba(0,255,208,0.85)';
        wCtx.fillRect(x1 - 1, 0, 2, h);
        wCtx.fillRect(x2 - 1, 0, 2, h);

        // Grip nubs
        const nubs = 3, spacing = 8;
        const top  = h / 2 - ((nubs - 1) * spacing) / 2;
        wCtx.fillStyle = '#0a0a0f';
        for (let i = 0; i < nubs; i++) {
            const y = top + i * spacing;
            wCtx.beginPath(); wCtx.arc(x1, y, 2, 0, Math.PI * 2); wCtx.fill();
            wCtx.beginPath(); wCtx.arc(x2, y, 2, 0, Math.PI * 2); wCtx.fill();
        }
    }

    // Mouse cursor line
    if (waveformMouseX >= 0 && waveformMouseX <= w) {
        wCtx.strokeStyle = 'rgba(255,255,255,0.3)';
        wCtx.lineWidth = 1;
        wCtx.beginPath();
        wCtx.moveTo(waveformMouseX, 0);
        wCtx.lineTo(waveformMouseX, h);
        wCtx.stroke();
    }

    // Main playhead
    if (mainPlayNode !== null) {
        const elapsed = audioCtx.currentTime - mainPlayStart;
        const x = srcTimeToX(mainPlayOffset + elapsed);
        wCtx.strokeStyle = 'rgba(255,255,255,0.7)';
        wCtx.lineWidth = 1;
        wCtx.beginPath();
        wCtx.moveTo(x, 0);
        wCtx.lineTo(x, h);
        wCtx.stroke();
    }

    // Timeline playhead
    timelineCtx.clearRect(0, 0, timelineCanvas.width, timelineCanvas.height);
    if (transportStart !== null) {
        const elapsed = audioCtx.currentTime - transportStart;
        if (elapsed <= TIMELINE_DURATION) {
            const x = elapsed * PX_PER_SEC;
            timelineCtx.strokeStyle = 'rgba(255,255,255,0.7)';
            timelineCtx.lineWidth = 1;
            timelineCtx.beginPath();
            timelineCtx.moveTo(x, 0);
            timelineCtx.lineTo(x, timelineCanvas.height);
            timelineCtx.stroke();
        } else {
            setTransportStart(null);
        }
    }

    // Button state
    const noSel = selection.startTime === null || selection.startTime === selection.endTime;
    document.getElementById('save-btn').disabled    = noSel;
    document.getElementById('preview-btn').disabled = noSel;

    requestAnimationFrame(drawFrame);
}

// ─── Clip canvas drawing ──────────────────────────────────────────────────────

export function drawClipCanvas(canvas, clip, sampleOffset = 0, visibleSampleCount = null) {
    const ctx = canvas.getContext('2d');
    const w   = canvas.width;
    const h   = canvas.height;
    const visible = visibleSampleCount ?? (clip.samples.length - sampleOffset);
    const spp     = visible / w;

    ctx.fillStyle = '#0a0a0f';
    ctx.fillRect(0, 0, w, h);
    ctx.strokeStyle = '#00ffd0';
    ctx.lineWidth = 1;

    for (let px = 0; px < w; px++) {
        const s = sampleOffset + Math.floor(px * spp);
        const e = sampleOffset + Math.floor((px + 1) * spp);
        let min = 1, max = -1;
        for (let i = s; i < e; i++) {
            if (clip.samples[i] < min) min = clip.samples[i];
            if (clip.samples[i] > max) max = clip.samples[i];
        }
        const yMin = ((min * -1 + 1) / 2) * h;
        const yMax = ((max * -1 + 1) / 2) * h;
        ctx.beginPath();
        ctx.moveTo(px, yMax);
        ctx.lineTo(px, yMin);
        ctx.stroke();
    }
}
