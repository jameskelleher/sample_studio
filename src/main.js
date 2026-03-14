import './style.css';
import p5 from 'p5';
import * as Tone from 'tone';
import { SoundTouchNode } from '@soundtouchjs/audio-worklet';

// ─── Constants ───────────────────────────────────────────────────────────────

const TIMELINE_DURATION = 10;
const PX_PER_SEC = window.innerWidth / TIMELINE_DURATION;
const SNAP_DISTANCE = 40;
const HANDLE_WIDTH = 6;

// ─── Audio setup ─────────────────────────────────────────────────────────────

const buffer = await Tone.ToneAudioBuffer.fromUrl('amen.flac');
const samples = buffer.toArray(0); // full source samples, never mutated
const player = new Tone.Player(buffer).toDestination();

let audioCtx = null;
let soundTouchRegistered = false;
const activeSources = [];

async function getAudioContext() {
    if (!audioCtx) audioCtx = new AudioContext();
    if (!soundTouchRegistered) {
        await SoundTouchNode.register(audioCtx, '/soundtouch-processor.js');
        soundTouchRegistered = true;
    }
    return audioCtx;
}

function stopAllStretched() {
    for (const src of activeSources) {
        try { src.stop(); } catch (_) { }
    }
    activeSources.length = 0;
}

async function playStretchedClip(clip, stretchRatio) {
    const ctx = await getAudioContext();
    if (ctx.state === 'suspended') await ctx.resume();

    const nativeBuffer = ctx.createBuffer(1, clip.samples.length, buffer.sampleRate);
    nativeBuffer.copyToChannel(
        clip.samples instanceof Float32Array ? clip.samples : Float32Array.from(clip.samples),
        0
    );

    const stNode = new SoundTouchNode(ctx);
    stNode.connect(ctx.destination);
    stNode.playbackRate.value = 1 / stretchRatio;
    stNode.pitch.value = 1;

    const src = ctx.createBufferSource();
    src.buffer = nativeBuffer;
    src.playbackRate.value = 1 / stretchRatio;
    src.connect(stNode);
    src.start();

    activeSources.push(src);
    src.onended = () => {
        const i = activeSources.indexOf(src);
        if (i !== -1) activeSources.splice(i, 1);
    };
}

// ─── State ───────────────────────────────────────────────────────────────────

const timeline = [];
// placed = { clip, startTime, stretchRatio }
// clip   = { startTime, duration, samples }
// clip.startTime/duration refer to position within the *source* buffer
// samples is always a slice of the source — trimming creates a new slice

const clips = [];
const selection = { startTime: null, endTime: null };
let mainPlayheadStart = null;
let isDragging = false;

// ─── DOM refs ────────────────────────────────────────────────────────────────

const timelineEl = document.getElementById('timeline');
const timelineCanvas = document.getElementById('timeline-canvas');
timelineCanvas.width = timelineCanvas.offsetWidth;
timelineCanvas.height = timelineCanvas.offsetHeight;
const timelineCtx = timelineCanvas.getContext('2d');
const placeholder = makePlaceholder();

// ─── DOM events ──────────────────────────────────────────────────────────────

document.addEventListener('click', async () => {
    await Tone.start();
    await getAudioContext();
}, { once: true });

document.addEventListener('click', (e) => {
    if (!e.target.closest('#canvas-container') && !e.target.closest('#preview-btn')) {
        selection.startTime = null;
        selection.endTime = null;
    }
});

document.getElementById('play-btn').onclick = () => playSelection();
document.getElementById('stop-btn').onclick = () => player.stop();

document.getElementById('preview-btn').onclick = () => {
    const start = Math.min(selection.startTime, selection.endTime);
    const end = Math.max(selection.startTime, selection.endTime);
    playSelection(start, end - start);
};

document.getElementById('save-btn').onclick = () => saveClip();

document.getElementById('timeline-play-btn').onclick = async () => {
    Tone.Transport.stop();
    Tone.Transport.cancel();
    stopAllStretched();
    player.stop();
    await getAudioContext();

    for (const placed of timeline) {
        const ratio = placed.stretchRatio ?? 1;
        if (Math.abs(ratio - 1) < 0.01) {
            Tone.Transport.schedule((time) => {
                player.start(time, placed.clip.startTime, placed.clip.duration);
            }, placed.startTime);
        } else {
            Tone.Transport.schedule(() => {
                playStretchedClip(placed.clip, ratio);
            }, placed.startTime);
        }
    }

    Tone.Transport.start();
};

document.getElementById('timeline-stop-btn').onclick = () => {
    Tone.Transport.stop();
    player.stop();
    stopAllStretched();
};

document.getElementById('timeline-clear-btn').onclick = () => {
    Tone.Transport.stop();
    Tone.Transport.cancel();
    player.stop();
    stopAllStretched();
    timeline.length = 0;
    timelineEl.innerHTML = '';
    timelineEl.appendChild(placeholder);
    placeholder.style.display = 'none';
};

// ─── Audio helpers ────────────────────────────────────────────────────────────

function saveClip() {
    const start = Math.min(selection.startTime, selection.endTime);
    const end = Math.max(selection.startTime, selection.endTime);
    const clip = makeClipFromSource(start, end - start);
    clips.push(clip);
    renderPaletteClip(clip);
    selection.startTime = null;
    selection.endTime = null;
}

function makeClipFromSource(startTime, duration) {
    const startSample = Math.floor(startTime * buffer.sampleRate);
    const endSample = Math.floor((startTime + duration) * buffer.sampleRate);
    return { startTime, duration, samples: samples.slice(startSample, endSample) };
}

function playSelection(startAt = null, duration = null) {
    player.stop();
    if (startAt === null) {
        mainPlayheadStart = Tone.now();
        player.start();
        return;
    }
    mainPlayheadStart = Tone.now() - startAt;
    if (duration === null) {
        player.start(Tone.now(), startAt);
    } else {
        player.start(Tone.now(), startAt, duration);
    }
}

// ─── Waveform drawing ─────────────────────────────────────────────────────────

/**
 * Draw clip waveform onto a canvas.
 * sampleOffset lets us pan the view into the samples array (for trim-scrolling).
 */
function drawClipCanvas(canvas, clip, sampleOffset = 0, visibleSampleCount = null) {
    const ctx = canvas.getContext('2d');
    const w = canvas.width;
    const h = canvas.height;
    const visibleSamples = visibleSampleCount ?? (clip.samples.length - sampleOffset);
    const samplesPerPixel = visibleSamples / w;

    ctx.fillStyle = '#0a0a0f';
    ctx.fillRect(0, 0, w, h);
    ctx.strokeStyle = '#00ffd0';
    ctx.lineWidth = 1;

    for (let px = 0; px < w; px++) {
        const start = sampleOffset + Math.floor(px * samplesPerPixel);
        const end = sampleOffset + Math.floor((px + 1) * samplesPerPixel);

        let min = 1, max = -1;
        for (let i = start; i < end; i++) {
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
    wrapper.style.cssText = 'position: relative; width: 80px; height: 60px; overflow: hidden;';

    const canvas = document.createElement('canvas');
    canvas.width = 80;
    canvas.height = 60;
    drawClipCanvas(canvas, clip);

    const deleteBtn = document.createElement('button');
    deleteBtn.textContent = '×';
    deleteBtn.style.cssText = `
        position: absolute; top: 2px; left: 2px;
        width: 16px; height: 16px; padding: 0;
        line-height: 1; font-size: 12px;
        background: rgba(0,0,0,0.7); color: #ff4466;
        border: 1px solid #ff4466; border-radius: 3px;
        cursor: pointer; z-index: 10; display: none;
    `;

    wrapper.addEventListener('mouseenter', () => deleteBtn.style.display = 'block');
    wrapper.addEventListener('mouseleave', () => deleteBtn.style.display = 'none');

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
                const placed = { clip, startTime: snappedTime, stretchRatio: 1 };
                timeline.push(placed);
                renderTimelineClip(placed);
            }
        });
    });

    canvas.onclick = () => {
        if (!dragged) playSelection(clip.startTime, clip.duration);
    };

    wrapper.appendChild(canvas);
    wrapper.appendChild(deleteBtn);
    document.getElementById('clip-column').appendChild(wrapper);
}

// ─── Timeline clip drag (move) ────────────────────────────────────────────────

/**
 * @param {MouseEvent} e
 * @param {object} clip
 * @param {number} ghostWidth - pixel width of the ghost (may differ from clip.duration * PX_PER_SEC if stretched)
 * @param {number} dragOffset - px from clip left edge to cursor
 * @param {function} onDrop
 */
function startClipDrag(e, clip, ghostWidth, dragOffset, onDrop) {
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
            const displayDuration = ghostWidth / PX_PER_SEC;
            const snapped = snapToFreePosition(rawTime, displayDuration);
            placeholder.style.display = 'block';
            placeholder.style.left = snapped * PX_PER_SEC + 'px';
            placeholder.style.width = ghostWidth + 'px';
        } else {
            placeholder.style.display = 'none';
        }
    }

    function onMouseUp() {
        document.removeEventListener('mousemove', onMouseMove);
        document.removeEventListener('mouseup', onMouseUp);
        ghost.remove();

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

// ─── Timeline clip rendering ──────────────────────────────────────────────────

function renderTimelineClip(placed) {
    const stretchedWidth = Math.round(placed.clip.duration * (placed.stretchRatio ?? 1) * PX_PER_SEC);

    const container = document.createElement('div');
    container.style.cssText = `
        position: absolute;
        left: ${placed.startTime * PX_PER_SEC}px;
        width: ${stretchedWidth}px;
        height: 60px;
        overflow: visible;
        cursor: grab;
        box-sizing: border-box;
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

    let handleDragActive = false;

    // Show/hide handles on hover
    container.addEventListener('mouseenter', () => {
        leftHandle.style.opacity = '1';
        rightHandle.style.opacity = '1';
    });
    container.addEventListener('mouseleave', () => {
        if (handleDragActive) return;
        leftHandle.style.opacity = '0';
        rightHandle.style.opacity = '0';
    });

    // ── Move drag ────────────────────────────────────────────────────────────
    container.addEventListener('mousedown', (e) => {
        // Only fire from the container itself or the canvas, not handles
        if (e.target === leftHandle || e.target === rightHandle ||
            leftHandle.contains(e.target) || rightHandle.contains(e.target)) return;

        const dragOffset = e.clientX - container.getBoundingClientRect().left;
        const ghostWidth = parseFloat(container.style.width);

        timeline.splice(timeline.indexOf(placed), 1);
        container.remove();

        startClipDrag(e, placed.clip, ghostWidth, dragOffset, (snappedTime) => {
            if (snappedTime !== null) {
                placed.startTime = snappedTime;
                timeline.push(placed);
                renderTimelineClip(placed);
            }
        });
    });

    // ── Left TRIM (top half) ──────────────────────────────────────────────────
    // Moves the start point into the source sample. Right edge stays fixed.
    // Waveform scrolls to reveal the trimmed region.
    leftTrim.addEventListener('mousedown', (e) => {
        e.stopPropagation();
        e.preventDefault();

        handleDragActive = true;

        const timelineRect = timelineEl.getBoundingClientRect();
        const rightEdgePx = parseFloat(container.style.left) + parseFloat(container.style.width);

        // The source clip's end point never changes during a left trim
        const srcEnd = placed.clip.startTime + placed.clip.duration;
        // The earliest we can trim back to is the beginning of the source buffer
        const minSrcStart = 0;

        function onMouseMove(e) {
            const cursorPx = e.clientX - timelineRect.left;
            const newLeft = Math.max(0, Math.min(cursorPx, rightEdgePx - HANDLE_WIDTH * 2));
            const newWidth = rightEdgePx - newLeft;

            // Convert the new timeline width back to source duration (removing stretch)
            const newDuration = (newWidth / PX_PER_SEC) / (placed.stretchRatio ?? 1);
            // The new start is the end minus the new duration
            const newSrcStart = Math.max(minSrcStart, srcEnd - newDuration);
            const clampedDuration = srcEnd - newSrcStart;

            // sampleOffset = how many samples into the full source buffer the new start is
            const sampleOffset = Math.floor(newSrcStart * buffer.sampleRate);
            // Build a preview clip spanning from 0 to srcEnd so sampleOffset pans correctly
            const visibleSampleCount = Math.round(clampedDuration * buffer.sampleRate);
            const previewClip = { samples };

            container.style.left = newLeft + 'px';
            container.style.width = newWidth + 'px';
            canvas.width = Math.max(1, Math.round(newWidth));
            drawClipCanvas(canvas, previewClip, sampleOffset, visibleSampleCount);
            showLabel(container, `${clampedDuration.toFixed(2)}s`, 'amber');
            container._pendingTrim = { newSrcStart, newDuration: clampedDuration, newLeft, newWidth };
        }

        function onMouseUp() {
            handleDragActive = false;
            document.removeEventListener('mousemove', onMouseMove);
            document.removeEventListener('mouseup', onMouseUp);
            if (container._pendingTrim) {
                const { newSrcStart, newDuration, newLeft, newWidth } = container._pendingTrim;
                placed.clip = makeClipFromSource(newSrcStart, newDuration);
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

    // ── Left STRETCH (bottom half) ────────────────────────────────────────────
    // Moves left edge; right edge fixed. Changes stretchRatio.
    leftStretch.addEventListener('mousedown', (e) => {
        e.stopPropagation();
        e.preventDefault();

        handleDragActive = true;

        const timelineRect = timelineEl.getBoundingClientRect();
        const rightEdgePx = parseFloat(container.style.left) + parseFloat(container.style.width);

        function onMouseMove(e) {
            const cursorPx = e.clientX - timelineRect.left;
            const newLeft = Math.max(0, Math.min(cursorPx, rightEdgePx - HANDLE_WIDTH * 2));
            const newWidth = rightEdgePx - newLeft;
            const newRatio = (newWidth / PX_PER_SEC) / placed.clip.duration;

            container.style.left = newLeft + 'px';
            container.style.width = newWidth + 'px';
            canvas.width = Math.max(1, Math.round(newWidth));
            drawClipCanvas(canvas, placed.clip);
            showLabel(container, `${newRatio.toFixed(2)}×`, 'teal');
        }

        function onMouseUp() {
            handleDragActive = false;
            document.removeEventListener('mousemove', onMouseMove);
            document.removeEventListener('mouseup', onMouseUp);
            placed.startTime = parseFloat(container.style.left) / PX_PER_SEC;
            placed.stretchRatio = (parseFloat(container.style.width) / PX_PER_SEC) / placed.clip.duration;
            clearLabel(container);
        }

        document.addEventListener('mousemove', onMouseMove);
        document.addEventListener('mouseup', onMouseUp);
    });

    // ── Right TRIM (top half) ─────────────────────────────────────────────────
    // Moves right edge. Left edge fixed. Trims the end of the clip.
    // Capped at original source end — can't extend beyond source material.
    rightTrim.addEventListener('mousedown', (e) => {
        e.stopPropagation();
        e.preventDefault();

        handleDragActive = true;

        const timelineRect = timelineEl.getBoundingClientRect();
        const leftEdgePx = parseFloat(container.style.left);
        const srcStart = placed.clip.startTime;
        const maxDuration = buffer.duration - srcStart; // source boundary

        function onMouseMove(e) {
            const cursorPx = e.clientX - timelineRect.left;
            const rawWidth = Math.max(HANDLE_WIDTH * 2, cursorPx - leftEdgePx);

            // Convert pixel width → source duration (un-stretch), capped at source end
            const newDuration = Math.min(
                (rawWidth / PX_PER_SEC) / (placed.stretchRatio ?? 1),
                maxDuration
            );
            const cappedWidth = Math.round(newDuration * (placed.stretchRatio ?? 1) * PX_PER_SEC);

            container.style.width = cappedWidth + 'px';
            canvas.width = Math.max(1, cappedWidth);
            const previewClip = makeClipFromSource(srcStart, newDuration);
            drawClipCanvas(canvas, previewClip);
            showLabel(container, `${newDuration.toFixed(2)}s`, 'amber');

            container._pendingRightTrim = { newDuration, cappedWidth };
        }

        function onMouseUp() {
            handleDragActive = false;
            document.removeEventListener('mousemove', onMouseMove);
            document.removeEventListener('mouseup', onMouseUp);

            if (container._pendingRightTrim) {
                const { newDuration } = container._pendingRightTrim;
                placed.clip = makeClipFromSource(srcStart, newDuration);
                drawClipCanvas(canvas, placed.clip);
                delete container._pendingRightTrim;
                clearLabel(container);
            }
        }

        document.addEventListener('mousemove', onMouseMove);
        document.addEventListener('mouseup', onMouseUp);
    });

    // ── Right STRETCH (bottom half) ───────────────────────────────────────────
    // Moves right edge. Left edge fixed. Changes stretchRatio.
    rightStretch.addEventListener('mousedown', (e) => {
        e.stopPropagation();
        e.preventDefault();

        handleDragActive = true;

        const timelineRect = timelineEl.getBoundingClientRect();
        const leftEdgePx = parseFloat(container.style.left);

        function onMouseMove(e) {
            const cursorPx = e.clientX - timelineRect.left;
            const newWidth = Math.max(HANDLE_WIDTH * 2, Math.min(
                cursorPx - leftEdgePx,
                TIMELINE_DURATION * PX_PER_SEC - leftEdgePx
            ));
            const newRatio = (newWidth / PX_PER_SEC) / placed.clip.duration;

            container.style.width = newWidth + 'px';
            canvas.width = Math.max(1, Math.round(newWidth));
            drawClipCanvas(canvas, placed.clip);
            showLabel(container, `${newRatio.toFixed(2)}×`, 'teal');
        }

        function onMouseUp() {
            handleDragActive = false;
            document.removeEventListener('mousemove', onMouseMove);
            document.removeEventListener('mouseup', onMouseUp);
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
        position: absolute;
        top: 0; ${side}: 0;
        width: ${HANDLE_WIDTH}px;
        height: 100%;
        z-index: 10;
        border-radius: ${side === 'left' ? '3px 0 0 3px' : '0 3px 3px 0'};
        overflow: hidden;
        opacity: 0;
        transition: opacity 0.15s;
    `;

    // Top half = trim (amber)
    const trimHalf = document.createElement('div');
    trimHalf.style.cssText = `
        position: absolute; top: 0; left: 0;
        width: 100%; height: 50%;
        background: rgba(255, 180, 0, 0.85);
        cursor: ${side === 'left' ? 'w-resize' : 'e-resize'};
    `;
    trimHalf.title = side === 'left' ? 'Trim start' : 'Trim end';

    // Bottom half = stretch (teal)
    const stretchHalf = document.createElement('div');
    stretchHalf.style.cssText = `
        position: absolute; bottom: 0; left: 0;
        width: 100%; height: 50%;
        background: rgba(0, 255, 208, 0.75);
        cursor: ew-resize;
    `;
    stretchHalf.title = 'Timestretch';

    outer.appendChild(trimHalf);
    outer.appendChild(stretchHalf);

    return { outer, trimHalf, stretchHalf };
}

// ─── Floating label (shown while dragging handles) ────────────────────────────

function showLabel(container, text, color = 'teal') {
    let label = container._dragLabel;
    if (!label) {
        label = document.createElement('div');
        label.style.cssText = `
            position: absolute; top: -22px; left: 50%;
            transform: translateX(-50%);
            background: rgba(0,0,0,0.85);
            font-size: 11px; font-family: monospace;
            padding: 2px 6px; border-radius: 3px;
            white-space: nowrap; pointer-events: none;
            z-index: 20;
        `;
        container.appendChild(label);
        container._dragLabel = label;
    }
    label.style.color = color === 'teal' ? '#00ffd0' : '#ffb400';
    label.style.borderColor = color === 'teal' ? 'rgba(0,255,208,0.3)' : 'rgba(255,180,0,0.3)';
    label.style.border = '1px solid';
    label.textContent = text;
}

function clearLabel(container) {
    if (container._dragLabel) {
        container._dragLabel.remove();
        container._dragLabel = null;
    }
}

// ─── Snap ─────────────────────────────────────────────────────────────────────

function snapToFreePosition(rawTime, duration) {
    let time = Math.max(0, Math.min(rawTime, TIMELINE_DURATION - duration));

    for (const placed of timeline) {
        const stretchedDuration = placed.clip.duration * (placed.stretchRatio ?? 1);
        const overlapEnd = placed.startTime + stretchedDuration;

        if (time < overlapEnd && time + duration > placed.startTime) {
            const snapAfter = overlapEnd;
            const snapBefore = placed.startTime - duration;
            time = Math.abs(snapAfter - rawTime) < Math.abs(snapBefore - rawTime)
                ? snapAfter
                : Math.max(0, snapBefore);
        }
    }

    return time;
}

// ─── Placeholder ──────────────────────────────────────────────────────────────

function makePlaceholder() {
    const el = document.createElement('div');
    el.style.cssText = `
        position: absolute; height: 60px;
        background: rgba(0,255,208,0.2);
        border: 1px solid #00ffd0;
        display: none;
    `;
    timelineEl.appendChild(el);
    return el;
}

// ─── p5 sketch (waveform viewer + selection) ──────────────────────────────────

new p5(function (p) {

    p.setup = function () {
        p.createCanvas(700, 300).parent('canvas-container');
    };

    p.draw = function () {
        const hasSelection = selection.startTime === null || selection.startTime === selection.endTime;
        document.getElementById('save-btn').disabled = hasSelection;
        document.getElementById('preview-btn').disabled = hasSelection;

        drawWaveform();
        drawSelection();
        drawMouseCursor();
        drawMainPlayhead();
        drawTimelinePlayhead();
    };

    p.mousePressed = function () {
        if (outOfBounds()) return;
        selection.startTime = p.map(p.mouseX, 0, p.width, 0, buffer.duration);
        selection.endTime = selection.startTime;
        isDragging = true;
    };

    p.mouseDragged = function () {
        if (!isDragging) return;
        selection.endTime = p.map(p.constrain(p.mouseX, 0, p.width), 0, p.width, 0, buffer.duration);
    };

    p.mouseReleased = function () {
        isDragging = false;
        if (selection.startTime !== null && selection.startTime === selection.endTime && !outOfBounds()) {
            playSelection(selection.startTime);
            selection.startTime = null;
            selection.endTime = null;
        }
    };

    function outOfBounds() {
        return p.mouseX < 0 || p.mouseX > p.width || p.mouseY < 0 || p.mouseY > p.height;
    }

    function drawWaveform() {
        p.background(10, 10, 15);
        const samplesPerPixel = samples.length / p.width;
        p.stroke(0, 255, 208);
        p.strokeWeight(1);
        for (let px = 0; px < p.width; px++) {
            const start = Math.floor(px * samplesPerPixel);
            const end = Math.floor((px + 1) * samplesPerPixel);
            let min = 1, max = -1;
            for (let i = start; i < end; i++) {
                if (samples[i] < min) min = samples[i];
                if (samples[i] > max) max = samples[i];
            }
            const yMin = p.map(min, -1, 1, p.height * 0.9, p.height * 0.1);
            const yMax = p.map(max, -1, 1, p.height * 0.9, p.height * 0.1);
            p.line(px, yMax, px, yMin);
        }
    }

    function drawSelection() {
        if (selection.startTime === null || selection.startTime === selection.endTime) return;
        const x1 = p.map(Math.min(selection.startTime, selection.endTime), 0, buffer.duration, 0, p.width);
        const x2 = p.map(Math.max(selection.startTime, selection.endTime), 0, buffer.duration, 0, p.width);
        p.noStroke();
        p.fill(0, 255, 208, 40);
        p.rect(x1, 0, x2 - x1, p.height);
    }

    function drawMouseCursor() {
        if (outOfBounds()) return;
        p.stroke(255, 255, 255, 180);
        p.strokeWeight(1);
        p.line(p.mouseX, 0, p.mouseX, p.height);
    }

    function drawMainPlayhead() {
        if (player.state === 'stopped') return;
        const elapsed = Tone.now() - mainPlayheadStart;
        const x = p.map(Math.min(elapsed / buffer.duration, 1), 0, 1, 0, p.width);
        p.stroke(255, 255, 255, 100);
        p.strokeWeight(1);
        p.line(x, 0, x, p.height);
    }

    function drawTimelinePlayhead() {
        timelineCtx.clearRect(0, 0, timelineCanvas.width, timelineCanvas.height);
        if (Tone.Transport.state !== 'started') return;
        const x = Tone.Transport.seconds * PX_PER_SEC;
        timelineCtx.strokeStyle = 'rgba(255,255,255,0.7)';
        timelineCtx.lineWidth = 1;
        timelineCtx.beginPath();
        timelineCtx.moveTo(x, 0);
        timelineCtx.lineTo(x, timelineCanvas.height);
        timelineCtx.stroke();
    }

});