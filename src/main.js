import './style.css';
import { SoundTouchNode } from '@soundtouchjs/audio-worklet';

// ─── Constants ────────────────────────────────────────────────────────────────

const TIMELINE_DURATION = 10;
const PX_PER_SEC = window.innerWidth / TIMELINE_DURATION;
const SNAP_DISTANCE = 40;
const CLIP_HANDLE_WIDTH = 4;
const SELECTION_HANDLE_GRAB = 8;
const PALETTE_SLOTS = 6;

// ─── Audio context ────────────────────────────────────────────────────────────

const audioCtx = new AudioContext();
let soundTouchRegistered = false;

async function ensureReady() {
    if (audioCtx.state === 'suspended') await audioCtx.resume();
    if (!soundTouchRegistered) {
        await SoundTouchNode.register(audioCtx, '/soundtouch-processor.js');
        soundTouchRegistered = true;
    }
}

// ─── Load source audio ────────────────────────────────────────────────────────

const sourceBuffer = await fetch('amen.flac')
    .then(r => r.arrayBuffer())
    .then(ab => audioCtx.decodeAudioData(ab));

const samples = sourceBuffer.getChannelData(0); // Float32Array, never mutated

// ─── State ────────────────────────────────────────────────────────────────────

const timeline = [];
// placed = { clip, startTime, stretchRatio, reversed }
// clip   = { startTime, duration, samples }

const clips = [];
const selection = { startTime: null, endTime: null };

let mainPlayNode = null;
let mainPlayStart = null;
let mainPlayOffset = null;
let transportStart = null;
const activeSources = [];

let shiftDown = false;
let clipDragging = false;

// ─── Playback helpers ─────────────────────────────────────────────────────────

function makeBufferSource(clipSamples) {
    const buf = audioCtx.createBuffer(1, clipSamples.length, sourceBuffer.sampleRate);
    buf.copyToChannel(
        clipSamples instanceof Float32Array ? clipSamples : Float32Array.from(clipSamples), 0
    );
    const src = audioCtx.createBufferSource();
    src.buffer = buf;
    return src;
}

async function playStretched(clip, stretchRatio, when = 0) {
    await ensureReady();
    const src = makeBufferSource(clip.samples);
    const stNode = new SoundTouchNode(audioCtx);
    stNode.connect(audioCtx.destination);
    stNode.playbackRate.value = 1 / stretchRatio;
    stNode.pitch.value = 1;
    src.playbackRate.value = 1 / stretchRatio;
    src.connect(stNode);
    src.start(when);
    activeSources.push(src);
    src.onended = () => activeSources.splice(activeSources.indexOf(src), 1);
}

function playDirect(clip, when = 0) {
    const src = makeBufferSource(clip.samples);
    src.connect(audioCtx.destination);
    src.start(when);
    activeSources.push(src);
    src.onended = () => activeSources.splice(activeSources.indexOf(src), 1);
    return src;
}

function stopAll() {
    for (const src of [...activeSources]) {
        try { src.stop(); } catch (_) { }
    }
    activeSources.length = 0;
    mainPlayNode = null;
}

async function playMain(startAt = 0, duration = null) {
    await ensureReady();
    stopAll();

    const src = audioCtx.createBufferSource();
    src.buffer = sourceBuffer;
    src.connect(audioCtx.destination);

    const offset = Math.max(0, Math.min(startAt, sourceBuffer.duration));
    duration !== null
        ? src.start(0, offset, duration)
        : src.start(0, offset);

    mainPlayNode = src;
    mainPlayStart = audioCtx.currentTime;
    mainPlayOffset = offset;

    activeSources.push(src);
    src.onended = () => {
        activeSources.splice(activeSources.indexOf(src), 1);
        if (mainPlayNode === src) mainPlayNode = null;
    };
}

// ─── Timeline transport ───────────────────────────────────────────────────────

async function startTimeline() {
    await ensureReady();
    stopAll();
    transportStart = audioCtx.currentTime;

    for (const placed of timeline) {
        const when = transportStart + placed.startTime;
        const ratio = placed.stretchRatio ?? 1;
        Math.abs(ratio - 1) < 0.01
            ? playDirect(placed.clip, when)
            : playStretched(placed.clip, ratio, when);
    }
}

function stopTimeline() {
    stopAll();
    transportStart = null;
}

// ─── DOM events ───────────────────────────────────────────────────────────────

document.addEventListener('click', () => ensureReady(), { once: true });

document.addEventListener('click', (e) => {
    if (!e.target.closest('#canvas-container') && !e.target.closest('#preview-btn')) {
        selection.startTime = null;
        selection.endTime = null;
    }
});

document.getElementById('timeline-play-btn').onclick = () => startTimeline();
document.getElementById('timeline-stop-btn').onclick = () => stopTimeline();

document.getElementById('preview-btn').onclick = () => {
    const start = Math.min(selection.startTime, selection.endTime);
    const end = Math.max(selection.startTime, selection.endTime);
    playMain(start, end - start);
};

document.getElementById('save-btn').onclick = () => {
    const start = Math.min(selection.startTime, selection.endTime);
    const end = Math.max(selection.startTime, selection.endTime);
    const clip = makeClipFromSource(start, end - start);
    clips.push(clip);
    renderPaletteClip(clip);
    selection.startTime = null;
    selection.endTime = null;
};

document.getElementById('timeline-clear-btn').onclick = () => {
    stopTimeline();
    timeline.length = 0;
    timelineEl.innerHTML = '';
    timelineEl.appendChild(placeholder);
    placeholder.style.display = 'none';
};

// Palette slots
const clipColumn = document.getElementById('clip-column');
for (let i = 0; i < PALETTE_SLOTS; i++) {
    const slot = document.createElement('div');
    slot.style.cssText = 'width:80px;height:60px;border:1px dashed rgba(0,255,208,0.15);border-radius:2px;box-sizing:border-box;';
    slot.classList.add('palette-slot');
    clipColumn.appendChild(slot);
}

// Shift key tracking (for duplicate drag)
document.addEventListener('keydown', (e) => {
    if (e.key === 'Shift') {
        shiftDown = true;
        timelineEl.classList.add('shift-mode');
    }
    // R key = reverse hovered clip
    if (e.key === 'r' || e.key === 'R') {
        const hovered = timelineEl.querySelector('.timeline-clip[data-hovered]');
        if (!hovered) return;
        const placed = timeline.find(p => p._container === hovered);
        if (!placed) return;
        placed.reversed = !placed.reversed;
        placed.clip = { ...placed.clip, samples: placed.clip.samples.slice().reverse() };
        const canvas = hovered.querySelector('canvas');
        canvas.width = canvas.width;
        drawClipCanvas(canvas, placed.clip);
    }
});

document.addEventListener('keyup', (e) => {
    if (e.key === 'Shift') {
        shiftDown = false;
        if (!clipDragging) {
            timelineEl.classList.remove('shift-mode');
            // Force cursor refresh
            timelineEl.style.pointerEvents = 'none';
            requestAnimationFrame(() => timelineEl.style.pointerEvents = '');
        }
    }
});

window.addEventListener('blur', () => {
    shiftDown = false;
    clipDragging = false;
    timelineEl.classList.remove('shift-mode');
});

// ─── Clip helpers ─────────────────────────────────────────────────────────────

function makeClipFromSource(startTime, duration) {
    const s = Math.floor(startTime * sourceBuffer.sampleRate);
    const e = Math.floor((startTime + duration) * sourceBuffer.sampleRate);
    return { startTime, duration, samples: samples.slice(s, e) };
}

// ─── DOM refs ─────────────────────────────────────────────────────────────────

const timelineEl = document.getElementById('timeline');
const timelineCanvas = document.getElementById('timeline-canvas');
timelineCanvas.width = timelineCanvas.offsetWidth;
timelineCanvas.height = timelineCanvas.offsetHeight;
const timelineCtx = timelineCanvas.getContext('2d');
const placeholder = makePlaceholder();

// ─── Waveform canvas ──────────────────────────────────────────────────────────

const waveformCanvas = document.createElement('canvas');
waveformCanvas.width = document.getElementById('canvas-container').offsetWidth;
waveformCanvas.height = 300;
waveformCanvas.style.cssText = 'display:block;cursor:crosshair;';
document.getElementById('canvas-container').appendChild(waveformCanvas);
const wCtx = waveformCanvas.getContext('2d');

// Pre-render static waveform into an offscreen cache
const waveformCache = document.createElement('canvas');
waveformCache.width = waveformCanvas.width;
waveformCache.height = waveformCanvas.height;
(function buildCache() {
    const ctx = waveformCache.getContext('2d');
    const w = waveformCache.width;
    const h = waveformCache.height;
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

// ─── Waveform draw loop ───────────────────────────────────────────────────────

let waveformMouseX = -1;

function drawFrame() {
    const w = waveformCanvas.width;
    const h = waveformCanvas.height;

    wCtx.drawImage(waveformCache, 0, 0);

    // Selection
    if (selection.startTime !== null && selection.startTime !== selection.endTime) {
        const left = Math.min(selection.startTime, selection.endTime);
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
        const top = h / 2 - ((nubs - 1) * spacing) / 2;
        wCtx.fillStyle = '#0a0a0f';
        for (let i = 0; i < nubs; i++) {
            const y = top + i * spacing;
            wCtx.beginPath(); wCtx.arc(x1, y, 2, 0, Math.PI * 2); wCtx.fill();
            wCtx.beginPath(); wCtx.arc(x2, y, 2, 0, Math.PI * 2); wCtx.fill();
        }
    }

    // Mouse cursor
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
            transportStart = null;
        }
    }

    // Button state
    const noSel = selection.startTime === null || selection.startTime === selection.endTime;
    document.getElementById('save-btn').disabled = noSel;
    document.getElementById('preview-btn').disabled = noSel;

    requestAnimationFrame(drawFrame);
}

requestAnimationFrame(drawFrame);

// ─── Waveform interaction ─────────────────────────────────────────────────────

let selDragMode = null;

waveformCanvas.addEventListener('mousemove', (e) => {
    const x = canvasX(e);
    waveformMouseX = x;

    if (selection.startTime !== null && selection.startTime !== selection.endTime) {
        const left = Math.min(selection.startTime, selection.endTime);
        const right = Math.max(selection.startTime, selection.endTime);
        if (Math.abs(x - srcTimeToX(left)) < SELECTION_HANDLE_GRAB ||
            Math.abs(x - srcTimeToX(right)) < SELECTION_HANDLE_GRAB) {
            waveformCanvas.style.cursor = 'ew-resize';
            return;
        }
    }
    waveformCanvas.style.cursor = 'crosshair';
});

waveformCanvas.addEventListener('mouseleave', () => { waveformMouseX = -1; });

waveformCanvas.addEventListener('mousedown', (e) => {
    const x = canvasX(e);
    const time = xToSrcTime(x);

    if (selection.startTime !== null && selection.startTime !== selection.endTime) {
        const left = Math.min(selection.startTime, selection.endTime);
        const right = Math.max(selection.startTime, selection.endTime);

        if (Math.abs(x - srcTimeToX(left)) < SELECTION_HANDLE_GRAB) {
            selDragMode = 'start';
            selection.startTime = left;
            selection.endTime = right;
            return;
        }
        if (Math.abs(x - srcTimeToX(right)) < SELECTION_HANDLE_GRAB) {
            selDragMode = 'end';
            selection.startTime = left;
            selection.endTime = right;
            return;
        }
    }

    selDragMode = 'new';
    selection.startTime = time;
    selection.endTime = time;
});

document.addEventListener('mousemove', (e) => {
    if (!selDragMode) return;
    const rect = waveformCanvas.getBoundingClientRect();
    const x = Math.max(0, Math.min(e.clientX - rect.left, waveformCanvas.width));
    const time = xToSrcTime(x);

    if (selDragMode === 'new') selection.endTime = time;
    if (selDragMode === 'start') selection.startTime = time;
    if (selDragMode === 'end') selection.endTime = time;
});

document.addEventListener('mouseup', () => {
    const mode = selDragMode;
    selDragMode = null;
    if (mode === 'new' && selection.startTime === selection.endTime) {
        if (mainPlayNode !== null) {
            stopAll();
        } else {
            playMain(selection.startTime);
        }
        selection.startTime = null;
        selection.endTime = null;
    }
});

// ─── Coordinate helpers ───────────────────────────────────────────────────────

function srcTimeToX(time) {
    return (time / sourceBuffer.duration) * waveformCanvas.width;
}

function xToSrcTime(x) {
    return (x / waveformCanvas.width) * sourceBuffer.duration;
}

function canvasX(e) {
    return e.clientX - waveformCanvas.getBoundingClientRect().left;
}

// ─── Clip canvas drawing ──────────────────────────────────────────────────────

function drawClipCanvas(canvas, clip, sampleOffset = 0, visibleSampleCount = null) {
    const ctx = canvas.getContext('2d');
    const w = canvas.width;
    const h = canvas.height;
    const visible = visibleSampleCount ?? (clip.samples.length - sampleOffset);
    const spp = visible / w;

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

// ─── Palette clips ────────────────────────────────────────────────────────────

function renderPaletteClip(clip) {
    const wrapper = document.createElement('div');
    wrapper.style.cssText = 'position:relative;width:80px;height:60px;overflow:hidden;';

    const canvas = document.createElement('canvas');
    canvas.width = 80;
    canvas.height = 60;
    drawClipCanvas(canvas, clip);

    const deleteBtn = document.createElement('button');
    deleteBtn.textContent = '×';
    deleteBtn.style.cssText = `
        position:absolute;top:2px;left:2px;width:16px;height:16px;
        padding:0;line-height:1;font-size:12px;background:rgba(0,0,0,0.7);
        color:#ff4466;border:1px solid #ff4466;border-radius:3px;
        cursor:pointer;z-index:10;display:none;
    `;

    wrapper.addEventListener('mouseenter', () => {
        deleteBtn.style.display = 'block';
        canvas.style.cursor = 'grab';
    });
    wrapper.addEventListener('mouseleave', () => {
        deleteBtn.style.display = 'none';
        canvas.style.cursor = '';
    });

    deleteBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        clips.splice(clips.indexOf(clip), 1);
        wrapper.remove();
    });

    let dragged = false;
    canvas.addEventListener('mousedown', (e) => {
        dragged = false;
        document.addEventListener('mousemove', () => { dragged = true; }, { once: true });
        const ghostWidth = clip.duration * PX_PER_SEC;
        const dragOffset = (e.offsetX / canvas.width) * ghostWidth;
        startClipDrag(e, clip, ghostWidth, dragOffset, (snappedTime) => {
            if (snappedTime !== null) {
                const placed = { clip, startTime: snappedTime, stretchRatio: 1, reversed: false };
                timeline.push(placed);
                renderTimelineClip(placed);
            }
        });
    });

    canvas.onclick = () => { if (!dragged) playMain(clip.startTime, clip.duration); };

    wrapper.appendChild(canvas);
    wrapper.appendChild(deleteBtn);
    const column = document.getElementById('clip-column');
    const firstSlot = column.querySelector('.palette-slot');
    firstSlot ? column.insertBefore(wrapper, firstSlot) : column.appendChild(wrapper);
    document.querySelector('#clip-column .palette-slot:last-child')?.remove();
}

// ─── Clip drag ────────────────────────────────────────────────────────────────

function startClipDrag(e, clip, ghostWidth, dragOffset, onDrop) {
    clipDragging = true;

    const ghost = document.createElement('canvas');
    ghost.width = ghostWidth;
    ghost.height = 60;
    ghost.style.cssText = `position:fixed;pointer-events:none;opacity:0.8;
        left:${e.clientX - dragOffset}px;top:${e.clientY - 30}px;`;
    document.body.appendChild(ghost);
    drawClipCanvas(ghost, clip);

    function onMouseMove(e) {
        ghost.style.left = e.clientX - dragOffset + 'px';
        ghost.style.top = e.clientY - 30 + 'px';
        const rect = timelineEl.getBoundingClientRect();
        if (e.clientY > rect.top - SNAP_DISTANCE) {
            const rawTime = (e.clientX - dragOffset - rect.left) / PX_PER_SEC;
            const snapped = snapToFreePosition(rawTime, ghostWidth / PX_PER_SEC);
            placeholder.style.display = 'block';
            placeholder.style.left = snapped * PX_PER_SEC + 'px';
            placeholder.style.width = ghostWidth + 'px';
        } else {
            placeholder.style.display = 'none';
        }
    }

    function onMouseUp() {
        clipDragging = false;
        document.removeEventListener('mousemove', onMouseMove);
        document.removeEventListener('mouseup', onMouseUp);
        ghost.remove();
        // Clean up shift-mode if shift was released during drag
        if (!shiftDown) timelineEl.classList.remove('shift-mode');
        if (placeholder.style.display !== 'none') {
            const snappedTime = parseFloat(placeholder.style.left) / PX_PER_SEC;
            placeholder.style.display = 'none';
            onDrop(snappedTime);
        } else {
            onDrop(null);
        }
    }

    document.addEventListener('mousemove', onMouseMove);
    document.addEventListener('mouseup', onMouseUp);
}

// ─── Timeline clip ────────────────────────────────────────────────────────────

function renderTimelineClip(placed) {
    const stretchedWidth = Math.round(placed.clip.duration * (placed.stretchRatio ?? 1) * PX_PER_SEC);

    const container = document.createElement('div');
    container.classList.add('timeline-clip');
    container.style.cssText = `
        position:absolute;
        left:${placed.startTime * PX_PER_SEC}px;
        width:${stretchedWidth}px;
        height:60px;overflow:visible;cursor:grab;box-sizing:border-box;
    `;

    const canvas = document.createElement('canvas');
    canvas.width = stretchedWidth;
    canvas.height = 60;
    canvas.style.cssText = 'position:absolute;top:0;left:0;width:100%;height:100%;pointer-events:none;';
    drawClipCanvas(canvas, placed.clip);
    container.appendChild(canvas);

    const { outer: leftHandle, trimHalf: leftTrim, stretchHalf: leftStretch } = makeSplitHandle('left');
    const { outer: rightHandle, trimHalf: rightTrim, stretchHalf: rightStretch } = makeSplitHandle('right');
    container.appendChild(leftHandle);
    container.appendChild(rightHandle);

    timelineEl.appendChild(container);

    // Store container ref on placed for R-key reverse lookup
    placed._container = container;

    let handleDragActive = false;

    container.addEventListener('mouseenter', () => {
        leftHandle.style.opacity = '1';
        rightHandle.style.opacity = '1';
        container.dataset.hovered = 'true';
    });
    container.addEventListener('mouseleave', () => {
        delete container.dataset.hovered;
        if (handleDragActive) return;
        leftHandle.style.opacity = '0';
        rightHandle.style.opacity = '0';
    });

    // ── Move / duplicate ──────────────────────────────────────────────────────
    container.addEventListener('mousedown', (e) => {
        if (leftHandle.contains(e.target) || rightHandle.contains(e.target)) return;
        const dragOffset = e.clientX - container.getBoundingClientRect().left;
        const ghostWidth = parseFloat(container.style.width);

        if (e.shiftKey || shiftDown) {
            // Duplicate: leave original, drag a copy
            const copy = { ...placed, clip: { ...placed.clip }, reversed: placed.reversed };
            startClipDrag(e, copy.clip, ghostWidth, dragOffset, (snappedTime) => {
                if (snappedTime !== null) {
                    copy.startTime = snappedTime;
                    timeline.push(copy);
                    renderTimelineClip(copy);
                }
            });
        } else {
            // Move: remove original, re-place on drop
            timeline.splice(timeline.indexOf(placed), 1);
            container.remove();
            startClipDrag(e, placed.clip, ghostWidth, dragOffset, (snappedTime) => {
                if (snappedTime !== null) {
                    placed.startTime = snappedTime;
                    timeline.push(placed);
                    renderTimelineClip(placed);
                }
            });
        }
    });

    // ── Left trim ─────────────────────────────────────────────────────────────
    leftTrim.addEventListener('mousedown', (e) => {
        e.stopPropagation(); e.preventDefault();
        handleDragActive = true;
        const tlRect = timelineEl.getBoundingClientRect();
        const rightEdge = parseFloat(container.style.left) + parseFloat(container.style.width);
        const srcEnd = placed.clip.startTime + placed.clip.duration;

        function onMouseMove(e) {
            const newLeft = Math.max(0, Math.min(e.clientX - tlRect.left, rightEdge - CLIP_HANDLE_WIDTH * 2));
            const newWidth = rightEdge - newLeft;
            const newDur = (newWidth / PX_PER_SEC) / (placed.stretchRatio ?? 1);

            let newStart, clampDur;
            if (placed.reversed) {
                // Source start is fixed; we trim from the source end
                newStart = placed.clip.startTime;
                clampDur = Math.min(newDur, sourceBuffer.duration - newStart);
            } else {
                // Source end is fixed; we trim from the source start
                newStart = Math.max(0, srcEnd - newDur);
                clampDur = srcEnd - newStart;
            }

            const offset = Math.floor(newStart * sourceBuffer.sampleRate);
            const visible = Math.round(clampDur * sourceBuffer.sampleRate);

            container.style.left = newLeft + 'px';
            container.style.width = newWidth + 'px';
            canvas.width = Math.max(1, Math.round(newWidth));
            if (placed.reversed) {
                const currentSrcEnd = newStart + clampDur;
                const srcEndSample = Math.floor(currentSrcEnd * sourceBuffer.sampleRate);
                const srcStartSample = Math.floor(newStart * sourceBuffer.sampleRate);
                const previewSamples = samples.slice(srcStartSample, srcEndSample).reverse();
                drawClipCanvas(canvas, { samples: previewSamples });
            } else {
                drawClipCanvas(canvas, { samples }, offset, visible);
            }
            showLabel(container, `${clampDur.toFixed(2)}s`, 'teal');
            container._pendingTrim = { newStart, clampDur, newLeft, newWidth };
        }

        function onMouseUp() {
            document.removeEventListener('mousemove', onMouseMove);
            document.removeEventListener('mouseup', onMouseUp);
            handleDragActive = false;
            if (container._pendingTrim) {
                const { newStart, clampDur, newLeft, newWidth } = container._pendingTrim;
                placed.clip = makeClipFromSource(newStart, clampDur);
                // Re-apply reverse if needed
                if (placed.reversed) placed.clip = { ...placed.clip, samples: placed.clip.samples.slice().reverse() };
                placed.startTime = newLeft / PX_PER_SEC;
                canvas.width = Math.max(1, Math.round(newWidth));
                drawClipCanvas(canvas, placed.clip);
                delete container._pendingTrim;
            }
            clearLabel(container);
        }

        document.addEventListener('mousemove', onMouseMove);
        document.addEventListener('mouseup', onMouseUp);
    });

    // ── Left stretch ──────────────────────────────────────────────────────────
    leftStretch.addEventListener('mousedown', (e) => {
        e.stopPropagation(); e.preventDefault();
        handleDragActive = true;
        const tlRect = timelineEl.getBoundingClientRect();
        const rightEdge = parseFloat(container.style.left) + parseFloat(container.style.width);

        function onMouseMove(e) {
            const newLeft = Math.max(0, Math.min(e.clientX - tlRect.left, rightEdge - CLIP_HANDLE_WIDTH * 2));
            const newWidth = rightEdge - newLeft;
            const newRatio = (newWidth / PX_PER_SEC) / placed.clip.duration;
            container.style.left = newLeft + 'px';
            container.style.width = newWidth + 'px';
            canvas.width = Math.max(1, Math.round(newWidth));
            drawClipCanvas(canvas, placed.clip);
            showLabel(container, `${newRatio.toFixed(2)}×`, 'amber');
        }

        function onMouseUp() {
            document.removeEventListener('mousemove', onMouseMove);
            document.removeEventListener('mouseup', onMouseUp);
            handleDragActive = false;
            placed.startTime = parseFloat(container.style.left) / PX_PER_SEC;
            placed.stretchRatio = (parseFloat(container.style.width) / PX_PER_SEC) / placed.clip.duration;
            clearLabel(container);
        }

        document.addEventListener('mousemove', onMouseMove);
        document.addEventListener('mouseup', onMouseUp);
    });

    // ── Right trim ────────────────────────────────────────────────────────────
    rightTrim.addEventListener('mousedown', (e) => {
        e.stopPropagation(); e.preventDefault();
        handleDragActive = true;
        const tlRect = timelineEl.getBoundingClientRect();
        const leftEdge = parseFloat(container.style.left);
        const srcStart = placed.clip.startTime;
        const srcEnd = srcStart + placed.clip.duration;
        const maxDur = sourceBuffer.duration - srcStart;

        function onMouseMove(e) {
            const rawWidth = Math.max(CLIP_HANDLE_WIDTH * 2, e.clientX - tlRect.left - leftEdge);
            const newDur = Math.min((rawWidth / PX_PER_SEC) / (placed.stretchRatio ?? 1), maxDur);
            const effectiveSrcStart = placed.reversed ? srcEnd - newDur : srcStart; const capWidth = Math.round(newDur * (placed.stretchRatio ?? 1) * PX_PER_SEC);
            container.style.width = capWidth + 'px';
            canvas.width = Math.max(1, capWidth);
            const previewClip = makeClipFromSource(effectiveSrcStart, newDur);
            if (placed.reversed) previewClip.samples = previewClip.samples.slice().reverse();
            drawClipCanvas(canvas, previewClip);
            showLabel(container, `${newDur.toFixed(2)}s`, 'teal');
            container._pendingRightTrim = { newDur };
        }

        function onMouseUp() {
            document.removeEventListener('mousemove', onMouseMove);
            document.removeEventListener('mouseup', onMouseUp);
            handleDragActive = false;
            if (container._pendingRightTrim) {
                const finalSrcStart = placed.reversed ? srcEnd - container._pendingRightTrim.newDur : srcStart;
                placed.clip = makeClipFromSource(finalSrcStart, container._pendingRightTrim.newDur);
                // Re-apply reverse if needed
                if (placed.reversed) placed.clip = { ...placed.clip, samples: placed.clip.samples.slice().reverse() };
                drawClipCanvas(canvas, placed.clip);
                delete container._pendingRightTrim;
            }
            clearLabel(container);
        }

        document.addEventListener('mousemove', onMouseMove);
        document.addEventListener('mouseup', onMouseUp);
    });

    // ── Right stretch ─────────────────────────────────────────────────────────
    rightStretch.addEventListener('mousedown', (e) => {
        e.stopPropagation(); e.preventDefault();
        handleDragActive = true;
        const tlRect = timelineEl.getBoundingClientRect();
        const leftEdge = parseFloat(container.style.left);

        function onMouseMove(e) {
            const newWidth = Math.max(CLIP_HANDLE_WIDTH * 2, Math.min(
                e.clientX - tlRect.left - leftEdge,
                TIMELINE_DURATION * PX_PER_SEC - leftEdge
            ));
            const newRatio = (newWidth / PX_PER_SEC) / placed.clip.duration;
            container.style.width = newWidth + 'px';
            canvas.width = Math.max(1, Math.round(newWidth));
            drawClipCanvas(canvas, placed.clip);
            showLabel(container, `${newRatio.toFixed(2)}×`, 'amber');
        }

        function onMouseUp() {
            document.removeEventListener('mousemove', onMouseMove);
            document.removeEventListener('mouseup', onMouseUp);
            handleDragActive = false;
            placed.stretchRatio = (parseFloat(container.style.width) / PX_PER_SEC) / placed.clip.duration;
            clearLabel(container);
        }

        document.addEventListener('mousemove', onMouseMove);
        document.addEventListener('mouseup', onMouseUp);
    });
}

// ─── Handle factory ───────────────────────────────────────────────────────────

function makeSplitHandle(side) {
    const outer = document.createElement('div');
    outer.style.cssText = `
        position:absolute;top:0;${side}:0;
        width:${CLIP_HANDLE_WIDTH}px;height:100%;z-index:10;
        border-radius:${side === 'left' ? '3px 0 0 3px' : '0 3px 3px 0'};
        overflow:hidden;opacity:0;transition:opacity 0.15s;
    `;

    // Top half = trim (teal)
    const trimHalf = document.createElement('div');
    trimHalf.title = side === 'left' ? 'Trim start' : 'Trim end';
    trimHalf.style.cssText = `
        position:absolute;top:0;left:0;width:100%;height:50%;
        background:rgba(0,255,208,0.85);
        cursor:${side === 'left' ? 'w-resize' : 'e-resize'};
    `;

    // Bottom half = stretch (amber)
    const stretchHalf = document.createElement('div');
    stretchHalf.title = 'Timestretch';
    stretchHalf.style.cssText = `
        position:absolute;bottom:0;left:0;width:100%;height:50%;
        background:rgba(255,180,0,0.75);cursor:ew-resize;
    `;

    outer.appendChild(trimHalf);
    outer.appendChild(stretchHalf);
    return { outer, trimHalf, stretchHalf };
}

// ─── Floating drag label ──────────────────────────────────────────────────────

function showLabel(container, text, color = 'teal') {
    let label = container._dragLabel;
    if (!label) {
        label = document.createElement('div');
        label.style.cssText = `
            position:absolute;top:-22px;left:50%;transform:translateX(-50%);
            background:rgba(0,0,0,0.85);font-size:11px;font-family:monospace;
            padding:2px 6px;border-radius:3px;white-space:nowrap;
            pointer-events:none;z-index:20;border:1px solid;
        `;
        container.appendChild(label);
        container._dragLabel = label;
    }
    label.style.color = color === 'teal' ? '#00ffd0' : '#ffb400';
    label.style.borderColor = color === 'teal' ? 'rgba(0,255,208,0.3)' : 'rgba(255,180,0,0.3)';
    label.textContent = text;
}

function clearLabel(container) {
    if (container._dragLabel) { container._dragLabel.remove(); container._dragLabel = null; }
}

// ─── Snap ─────────────────────────────────────────────────────────────────────

function snapToFreePosition(rawTime, duration) {
    let time = Math.max(0, Math.min(rawTime, TIMELINE_DURATION - duration));
    for (const placed of timeline) {
        const sd = placed.clip.duration * (placed.stretchRatio ?? 1);
        const end = placed.startTime + sd;
        if (time < end && time + duration > placed.startTime) {
            const after = end;
            const before = placed.startTime - duration;
            time = Math.abs(after - rawTime) < Math.abs(before - rawTime)
                ? after : Math.max(0, before);
        }
    }
    return time;
}

// ─── Placeholder ──────────────────────────────────────────────────────────────

function makePlaceholder() {
    const el = document.createElement('div');
    el.style.cssText = `
        position:absolute;height:60px;
        background:rgba(0,255,208,0.2);border:1px solid #00ffd0;display:none;
    `;
    timelineEl.appendChild(el);
    return el;
}