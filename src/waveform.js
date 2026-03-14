import { sourceBuffer } from './audio.js';
import { selection, mainPlayNode } from './state.js';
import { setWaveformMouseX as _setMouseX } from './draw.js';
import { SELECTION_HANDLE_GRAB } from './constants.js';

// Coordinate helpers — exported so draw.js and others can use them
export function srcTimeToX(time) {
    return (time / sourceBuffer.duration) * waveformCanvas.width;
}

export function xToSrcTime(x) {
    return (x / waveformCanvas.width) * sourceBuffer.duration;
}

export function canvasX(e) {
    return e.clientX - waveformCanvas.getBoundingClientRect().left;
}

// waveformCanvas is set by draw.js after it creates the element.
// We use a lazy reference here to avoid a circular import.
let waveformCanvas;
export function initWaveformInteraction(canvas, { playMain, stopAll }) {
    waveformCanvas = canvas;

    let selDragMode = null;

    canvas.addEventListener('mousemove', (e) => {
        const x = canvasX(e);
        _setMouseX(x);

        if (selection.startTime !== null && selection.startTime !== selection.endTime) {
            const left  = Math.min(selection.startTime, selection.endTime);
            const right = Math.max(selection.startTime, selection.endTime);
            if (Math.abs(x - srcTimeToX(left))  < SELECTION_HANDLE_GRAB ||
                Math.abs(x - srcTimeToX(right)) < SELECTION_HANDLE_GRAB) {
                canvas.style.cursor = 'ew-resize';
                return;
            }
        }
        canvas.style.cursor = 'crosshair';
    });

    canvas.addEventListener('mouseleave', () => { _setMouseX(-1); });

    canvas.addEventListener('mousedown', (e) => {
        const x    = canvasX(e);
        const time = xToSrcTime(x);

        if (selection.startTime !== null && selection.startTime !== selection.endTime) {
            const left  = Math.min(selection.startTime, selection.endTime);
            const right = Math.max(selection.startTime, selection.endTime);

            if (Math.abs(x - srcTimeToX(left)) < SELECTION_HANDLE_GRAB) {
                selDragMode = 'start';
                selection.startTime = left;
                selection.endTime   = right;
                return;
            }
            if (Math.abs(x - srcTimeToX(right)) < SELECTION_HANDLE_GRAB) {
                selDragMode = 'end';
                selection.startTime = left;
                selection.endTime   = right;
                return;
            }
        }

        selDragMode = 'new';
        selection.startTime = time;
        selection.endTime   = time;
    });

    document.addEventListener('mousemove', (e) => {
        if (!selDragMode) return;
        const rect = canvas.getBoundingClientRect();
        const x    = Math.max(0, Math.min(e.clientX - rect.left, canvas.width));
        const time = xToSrcTime(x);

        if (selDragMode === 'new')   selection.endTime   = time;
        if (selDragMode === 'start') selection.startTime = time;
        if (selDragMode === 'end')   selection.endTime   = time;
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
            selection.endTime   = null;
        }
    });
}
