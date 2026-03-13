import './style.css';

import p5 from 'p5';
import * as Tone from 'tone';
import { SoundTouchNode } from '@soundtouchjs/audio-worklet';

// #region Setup

const buffer = await Tone.ToneAudioBuffer.fromUrl('amen.flac');
const samples = buffer.toArray(0);
const player = new Tone.Player(buffer).toDestination();

const TIMELINE_DURATION = 10;
const PX_PER_SEC = window.innerWidth / TIMELINE_DURATION;
const SNAP_DISTANCE = 40; // px
const HANDLE_WIDTH = 8; // px

const timelineEl = document.getElementById('timeline');
const timelineCanvas = document.getElementById('timeline-canvas');
timelineCanvas.width = timelineCanvas.offsetWidth;
timelineCanvas.height = timelineCanvas.offsetHeight;
const timelineCtx = timelineCanvas.getContext('2d');

const placeholder = setupPlaceholderDiv();

const selection = { startTime: null, endTime: null };
let isDragging = false;
let startTime = null;

const timeline = []; // { clip, startTime, stretchRatio }
const clips = [];   // { startTime, duration, samples }

// Web Audio context for SoundTouch playback
let audioCtx = null;
let soundTouchRegistered = false;

async function getAudioContext() {
    if (!audioCtx) {
        audioCtx = new AudioContext();
    }
    if (!soundTouchRegistered) {
        await SoundTouchNode.register(audioCtx, '/soundtouch-processor.js');
        soundTouchRegistered = true;
    }
    return audioCtx;
}

const activeSoundTouchSources = [];

function stopAllStretched() {
    for (const src of activeSoundTouchSources) {
        try { src.stop(); } catch (e) { /* already stopped */ }
    }
    activeSoundTouchSources.length = 0;
}

/**
 * Play a clip with time-stretching (pitch preserved).
 * stretchRatio > 1 = slower, < 1 = faster.
 */
async function playStretchedClip(clip, stretchRatio = 1) {
    const ctx = await getAudioContext();
    if (ctx.state === 'suspended') await ctx.resume();

    // Build a native AudioBuffer from the clip's Float32 samples
    const nativeBuffer = ctx.createBuffer(1, clip.samples.length, buffer.sampleRate);
    nativeBuffer.copyToChannel(
        clip.samples instanceof Float32Array ? clip.samples : Float32Array.from(clip.samples),
        0
    );

    const stNode = new SoundTouchNode(ctx);
    stNode.connect(ctx.destination);

    const src = ctx.createBufferSource();
    src.buffer = nativeBuffer;

    // Feed samples at stretchRatio speed; SoundTouch corrects pitch back to 1:1
    src.playbackRate.value = 1 / stretchRatio;
    stNode.playbackRate.value = 1 / stretchRatio;
    stNode.pitch.value = 1; // keep original pitch

    src.connect(stNode);
    src.start();

    activeSoundTouchSources.push(src);
    src.onended = () => {
        const idx = activeSoundTouchSources.indexOf(src);
        if (idx !== -1) activeSoundTouchSources.splice(idx, 1);
    };
}

// #endregion

// #region DOM Events

document.addEventListener('click', async () => {
    await Tone.start();
    await getAudioContext();
}, { once: true });

document.addEventListener('click', (e) => {
    const deselect =
        !e.target.closest('#canvas-container') &&
        !e.target.closest('#preview-btn');

    if (deselect) {
        selection.startTime = null;
        selection.endTime = null;
    }
});

document.getElementById('play-btn').onclick = () => {
    playSelection();
};

document.getElementById('stop-btn').onclick = () => {
    player.stop();
};

document.getElementById('preview-btn').onclick = () => {
    const start = Math.min(selection.startTime, selection.endTime);
    const end = Math.max(selection.startTime, selection.endTime);
    playSelection(start, end - start);
};

document.getElementById('save-btn').onclick = () => {
    saveClip();
};

document.getElementById('timeline-play-btn').onclick = async () => {
    Tone.Transport.stop();
    Tone.Transport.cancel();
    stopAllStretched();
    player.stop();

    await getAudioContext();

    for (const placed of timeline) {
        const ratio = placed.stretchRatio ?? 1;
        const placedStart = placed.startTime;

        if (Math.abs(ratio - 1) < 0.01) {
            // Unmodified: use Tone.Player
            Tone.Transport.schedule((time) => {
                player.start(time, placed.clip.startTime, placed.clip.duration);
            }, placedStart);
        } else {
            // Stretched: schedule via Transport, play via SoundTouch
            Tone.Transport.schedule((_time) => {
                playStretchedClip(placed.clip, ratio);
            }, placedStart);
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

// #endregion

// #region Audio

function saveClip() {
    const start = Math.min(selection.startTime, selection.endTime);
    const end = Math.max(selection.startTime, selection.endTime);
    const startSample = Math.floor(start * buffer.sampleRate);
    const endSample = Math.floor(end * buffer.sampleRate);

    const clip = {
        samples: samples.slice(startSample, endSample),
        startTime: start,
        duration: end - start,
    };

    clips.push(clip);
    renderClip(clip);

    selection.startTime = null;
    selection.endTime = null;
}

function playSelection(startAt = null, duration = null) {
    player.stop();

    if (startAt === null) {
        startTime = Tone.now();
        player.start();
        return;
    }

    startTime = Tone.now() - startAt;

    if (duration === null) {
        player.start(Tone.now(), startAt);
        return;
    }

    player.start(Tone.now(), startAt, duration);
}

// #endregion

// #region Drag

function startClipDrag(e, clip, dragOffset, onDrop) {
    const ghostWidth = Math.round(clip.duration * PX_PER_SEC);

    const ghost = document.createElement('canvas');
    ghost.width = ghostWidth;
    ghost.height = 60;
    ghost.style.position = 'fixed';
    ghost.style.pointerEvents = 'none';
    ghost.style.opacity = '0.8';
    ghost.style.left = e.clientX - dragOffset + 'px';
    ghost.style.top = e.clientY - 30 + 'px';
    document.body.appendChild(ghost);
    drawClipCanvas(ghost, clip);

    function onMouseMove(e) {
        ghost.style.left = e.clientX - dragOffset + 'px';
        ghost.style.top = e.clientY - 30 + 'px';

        const timelineRect = timelineEl.getBoundingClientRect();

        if (e.clientY > timelineRect.top - SNAP_DISTANCE) {
            const rawTime = (e.clientX - dragOffset - timelineRect.left) / PX_PER_SEC;
            const snappedTime = snapToFreePosition(rawTime, clip.duration);
            placeholder.style.display = 'block';
            placeholder.style.left = snappedTime * PX_PER_SEC + 'px';
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

// #endregion

// #region Rendering

function renderClip(clip) {
    const canvas = document.createElement('canvas');
    canvas.width = 80;
    canvas.height = 60;
    drawClipCanvas(canvas, clip);

    let dragged = false;

    canvas.addEventListener('mousedown', (e) => {
        dragged = false;
        const ghostWidth = clip.duration * PX_PER_SEC;
        const dragOffset = (e.offsetX / canvas.width) * ghostWidth;

        startClipDrag(e, clip, dragOffset, (snappedTime) => {
            if (snappedTime !== null) {
                const placed = { clip, startTime: snappedTime, stretchRatio: 1 };
                timeline.push(placed);
                renderTimelineClip(placed);
            }
        });

        const onAnyMove = () => { dragged = true; };
        document.addEventListener('mousemove', onAnyMove, { once: true });
    });

    canvas.onclick = () => {
        if (!dragged) playSelection(clip.startTime, clip.duration);
    };

    document.getElementById('clip-column').appendChild(canvas);
}

/**
 * Render a placed clip on the timeline with left/right stretch handles.
 */
function renderTimelineClip(placed) {
    const { clip } = placed;
    const stretchRatio = placed.stretchRatio ?? 1;
    const stretchedDuration = clip.duration * stretchRatio;
    const width = Math.round(stretchedDuration * PX_PER_SEC);

    const container = document.createElement('div');
    container.style.position = 'absolute';
    container.style.left = placed.startTime * PX_PER_SEC + 'px';
    container.style.width = width + 'px';
    container.style.height = '60px';
    container.style.overflow = 'visible';
    container.style.cursor = 'grab';
    container.style.boxSizing = 'border-box';

    // Waveform canvas
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = 60;
    canvas.style.position = 'absolute';
    canvas.style.top = '0';
    canvas.style.left = '0';
    canvas.style.width = '100%';
    canvas.style.height = '100%';
    canvas.style.pointerEvents = 'none';
    drawClipCanvas(canvas, clip);
    container.appendChild(canvas);

    // Resize handles
    const leftHandle = createHandle('left');
    const rightHandle = createHandle('right');
    container.appendChild(leftHandle);
    container.appendChild(rightHandle);

    timelineEl.appendChild(container);

    // --- Main clip drag (middle area = move) ---
    container.addEventListener('mousedown', (e) => {
        if (e.target === leftHandle || e.target === rightHandle) return;

        const containerRect = container.getBoundingClientRect();
        const dragOffset = e.clientX - containerRect.left;

        const index = timeline.indexOf(placed);
        timeline.splice(index, 1);
        container.remove();

        startClipDrag(e, clip, dragOffset, (snappedTime) => {
            if (snappedTime !== null) {
                placed.startTime = snappedTime;
                timeline.push(placed);
                renderTimelineClip(placed);
            }
        });
    });

    // --- Left handle: drag left/right to stretch from left edge ---
    leftHandle.addEventListener('mousedown', (e) => {
        e.stopPropagation();
        e.preventDefault();
        const timelineRect = timelineEl.getBoundingClientRect();
        // The right edge stays fixed
        const rightEdgePx = parseFloat(container.style.left) + parseFloat(container.style.width);

        function onMouseMove(e) {
            const cursorPx = e.clientX - timelineRect.left;
            const newLeft = Math.max(0, Math.min(cursorPx, rightEdgePx - HANDLE_WIDTH * 2));
            const newWidth = rightEdgePx - newLeft;
            const newRatio = (newWidth / PX_PER_SEC) / clip.duration;

            container.style.left = newLeft + 'px';
            container.style.width = newWidth + 'px';
            canvas.width = Math.max(1, Math.round(newWidth));
            drawClipCanvas(canvas, clip);
            updateStretchLabel(container, newRatio);
        }

        function onMouseUp() {
            document.removeEventListener('mousemove', onMouseMove);
            document.removeEventListener('mouseup', onMouseUp);

            const newLeft = parseFloat(container.style.left);
            const newWidth = parseFloat(container.style.width);
            placed.startTime = newLeft / PX_PER_SEC;
            placed.stretchRatio = (newWidth / PX_PER_SEC) / clip.duration;
            clearStretchLabel(container);
        }

        document.addEventListener('mousemove', onMouseMove);
        document.addEventListener('mouseup', onMouseUp);
    });

    // --- Right handle: drag left/right to stretch from right edge ---
    rightHandle.addEventListener('mousedown', (e) => {
        e.stopPropagation();
        e.preventDefault();
        const timelineRect = timelineEl.getBoundingClientRect();
        const leftEdgePx = parseFloat(container.style.left);

        function onMouseMove(e) {
            const cursorPx = e.clientX - timelineRect.left;
            const newWidth = Math.max(HANDLE_WIDTH * 2, Math.min(
                cursorPx - leftEdgePx,
                TIMELINE_DURATION * PX_PER_SEC - leftEdgePx
            ));
            const newRatio = (newWidth / PX_PER_SEC) / clip.duration;

            container.style.width = newWidth + 'px';
            canvas.width = Math.max(1, Math.round(newWidth));
            drawClipCanvas(canvas, clip);
            updateStretchLabel(container, newRatio);
        }

        function onMouseUp() {
            document.removeEventListener('mousemove', onMouseMove);
            document.removeEventListener('mouseup', onMouseUp);

            const newWidth = parseFloat(container.style.width);
            placed.stretchRatio = (newWidth / PX_PER_SEC) / clip.duration;
            clearStretchLabel(container);
        }

        document.addEventListener('mousemove', onMouseMove);
        document.addEventListener('mouseup', onMouseUp);
    });
}

function createHandle(side) {
    const handle = document.createElement('div');
    handle.style.cssText = `
        position: absolute;
        top: 0;
        ${side}: 0;
        width: ${HANDLE_WIDTH}px;
        height: 100%;
        cursor: ew-resize;
        background: rgba(0, 255, 208, 0.7);
        z-index: 10;
        border-radius: ${side === 'left' ? '3px 0 0 3px' : '0 3px 3px 0'};
        display: flex;
        align-items: center;
        justify-content: center;
    `;

    // Grip lines
    const grip = document.createElement('div');
    grip.style.cssText = `
        display: flex;
        flex-direction: column;
        gap: 2px;
        pointer-events: none;
    `;
    for (let i = 0; i < 3; i++) {
        const line = document.createElement('div');
        line.style.cssText = 'width: 2px; height: 2px; background: rgba(0,0,0,0.5); border-radius: 50%;';
        grip.appendChild(line);
    }
    handle.appendChild(grip);

    return handle;
}

function updateStretchLabel(container, ratio) {
    let label = container._stretchLabel;
    if (!label) {
        label = document.createElement('div');
        label.style.cssText = `
            position: absolute;
            top: -22px;
            left: 50%;
            transform: translateX(-50%);
            background: rgba(0,0,0,0.85);
            color: #00ffd0;
            font-size: 11px;
            font-family: monospace;
            padding: 2px 6px;
            border-radius: 3px;
            white-space: nowrap;
            pointer-events: none;
            z-index: 20;
            border: 1px solid rgba(0,255,208,0.3);
        `;
        container.appendChild(label);
        container._stretchLabel = label;
    }
    label.textContent = `${ratio.toFixed(2)}×`;
}

function clearStretchLabel(container) {
    if (container._stretchLabel) {
        container._stretchLabel.remove();
        container._stretchLabel = null;
    }
}

function drawClipCanvas(canvas, clip) {
    const ctx = canvas.getContext('2d');
    const w = canvas.width;
    const h = canvas.height;
    const samplesPerPixel = clip.samples.length / w;

    ctx.fillStyle = '#0a0a0f';
    ctx.fillRect(0, 0, w, h);
    ctx.strokeStyle = '#00ffd0';
    ctx.lineWidth = 1;

    for (let px = 0; px < w; px++) {
        const start = Math.floor(px * samplesPerPixel);
        const end = Math.floor((px + 1) * samplesPerPixel);

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

function setupPlaceholderDiv() {
    const placeholder = document.createElement('div');
    placeholder.style.position = 'absolute';
    placeholder.style.height = '60px';
    placeholder.style.background = 'rgba(0, 255, 208, 0.2)';
    placeholder.style.border = '1px solid #00ffd0';
    placeholder.style.display = 'none';
    timelineEl.appendChild(placeholder);
    return placeholder;
}

// #endregion

// #region Snap

function snapToFreePosition(rawTime, duration) {
    let time = Math.max(0, Math.min(rawTime, TIMELINE_DURATION - duration));

    for (const placed of timeline) {
        const stretchedDuration = placed.clip.duration * (placed.stretchRatio ?? 1);
        const overlapStart = placed.startTime;
        const overlapEnd = placed.startTime + stretchedDuration;

        if (time < overlapEnd && time + duration > overlapStart) {
            const snapAfter = overlapEnd;
            const snapBefore = overlapStart - duration;

            if (Math.abs(snapAfter - rawTime) < Math.abs(snapBefore - rawTime)) {
                time = snapAfter;
            } else {
                time = Math.max(0, snapBefore);
            }
        }
    }

    return time;
}

// #endregion

// #region p5 Sketch

new p5(function (p) {

    p.setup = function () {
        p.createCanvas(700, 300).parent('canvas-container');
    };

    p.draw = function () {
        const hasSelection =
            selection.startTime === null ||
            selection.startTime === selection.endTime;

        document.getElementById('save-btn').disabled = hasSelection;
        document.getElementById('preview-btn').disabled = hasSelection;

        drawWaveform();
        drawSelection();
        drawMousePos();
        drawMainPlayhead();
        drawTimelinePlayhead();
    };

    p.mousePressed = function () {
        if (p.mouseX < 0 || p.mouseX > p.width || p.mouseY < 0 || p.mouseY > p.height) return;
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
        if (
            selection.startTime !== null &&
            selection.startTime === selection.endTime &&
            p.mouseX >= 0 && p.mouseX <= p.width &&
            p.mouseY >= 0 && p.mouseY <= p.height
        ) {
            playSelection(selection.startTime);
            selection.startTime = null;
            selection.endTime = null;
        }
    };

    function drawMousePos() {
        const x = p.mouseX;
        if (x < 0 || x > p.width) return;
        p.stroke(255, 255, 255, 180);
        p.strokeWeight(1);
        p.line(x, 0, x, p.height);
    }

    function drawMainPlayhead() {
        if (player.state === 'stopped') return;
        const elapsed = Tone.now() - startTime;
        const progress = Math.min(elapsed / buffer.duration, 1);
        const x = p.map(progress, 0, 1, 0, p.width);
        p.stroke(255, 255, 255, 100);
        p.strokeWeight(1);
        p.line(x, 0, x, p.height);
    }

    function drawTimelinePlayhead() {
        timelineCtx.clearRect(0, 0, timelineCanvas.width, timelineCanvas.height);
        if (Tone.Transport.state !== 'started') return;

        const x = Tone.Transport.seconds * PX_PER_SEC;
        timelineCtx.strokeStyle = 'rgba(255, 255, 255, 0.7)';
        timelineCtx.lineWidth = 1;
        timelineCtx.beginPath();
        timelineCtx.moveTo(x, 0);
        timelineCtx.lineTo(x, timelineCanvas.height);
        timelineCtx.stroke();
    }

    function drawSelection() {
        if (
            selection.startTime !== null &&
            selection.endTime !== null &&
            selection.startTime !== selection.endTime
        ) {
            const x1 = p.map(Math.min(selection.startTime, selection.endTime), 0, buffer.duration, 0, p.width);
            const x2 = p.map(Math.max(selection.startTime, selection.endTime), 0, buffer.duration, 0, p.width);
            p.noStroke();
            p.fill(0, 255, 208, 40);
            p.rect(x1, 0, x2 - x1, p.height);
        }
    }

    function drawWaveform() {
        p.background(10, 10, 15);

        const samplesPerPixel = samples.length / p.width;

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

            p.stroke(0, 255, 208);
            p.strokeWeight(1);
            p.line(px, yMax, px, yMin);
        }
    }

});

// #endregion