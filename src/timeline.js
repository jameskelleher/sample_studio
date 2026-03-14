import { timeline, shiftDown, setClipDragging } from './state.js';
import { sourceBuffer, samples, makeClipFromSource } from './audio.js';
import { drawClipCanvas, timelineEl } from './draw.js';
import { TIMELINE_DURATION, PX_PER_SEC, SNAP_DISTANCE, CLIP_HANDLE_WIDTH } from './constants.js';

// ─── Placeholder ──────────────────────────────────────────────────────────────

export const placeholder = makePlaceholder();

function makePlaceholder() {
    const el = document.createElement('div');
    el.classList.add('timeline-placeholder');
    timelineEl.appendChild(el);
    return el;
}

// ─── Snap ─────────────────────────────────────────────────────────────────────

export function snapToFreePosition(rawTime, duration) {
    let time = Math.max(0, Math.min(rawTime, TIMELINE_DURATION - duration));
    for (const placed of timeline) {
        const sd  = placed.clip.duration * (placed.stretchRatio ?? 1);
        const end = placed.startTime + sd;
        if (time < end && time + duration > placed.startTime) {
            const after  = end;
            const before = placed.startTime - duration;
            time = Math.abs(after - rawTime) < Math.abs(before - rawTime)
                ? after : Math.max(0, before);
        }
    }
    return time;
}

// ─── Clip drag (move / duplicate) ─────────────────────────────────────────────

export function startClipDrag(e, clip, ghostWidth, dragOffset, onDrop) {
    setClipDragging(true);

    const ghost = document.createElement('canvas');
    ghost.width  = ghostWidth;
    ghost.height = 60;
    ghost.classList.add('drag-ghost');
    ghost.style.left = e.clientX - dragOffset + 'px';
    ghost.style.top  = e.clientY - 30 + 'px';
    document.body.appendChild(ghost);
    drawClipCanvas(ghost, clip);

    function onMouseMove(e) {
        ghost.style.left = e.clientX - dragOffset + 'px';
        ghost.style.top  = e.clientY - 30 + 'px';
        const rect = timelineEl.getBoundingClientRect();
        if (e.clientY > rect.top - SNAP_DISTANCE) {
            const rawTime = (e.clientX - dragOffset - rect.left) / PX_PER_SEC;
            const snapped = snapToFreePosition(rawTime, ghostWidth / PX_PER_SEC);
            placeholder.style.display = 'block';
            placeholder.style.left    = snapped * PX_PER_SEC + 'px';
            placeholder.style.width   = ghostWidth + 'px';
        } else {
            placeholder.style.display = 'none';
        }
    }

    function onMouseUp() {
        setClipDragging(false);
        document.removeEventListener('mousemove', onMouseMove);
        document.removeEventListener('mouseup', onMouseUp);
        ghost.remove();
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

// ─── Timeline clip rendering ──────────────────────────────────────────────────

export function renderTimelineClip(placed) {
    const stretchedWidth = Math.round(placed.clip.duration * (placed.stretchRatio ?? 1) * PX_PER_SEC);

    const container = document.createElement('div');
    container.classList.add('timeline-clip');
    container.style.left  = placed.startTime * PX_PER_SEC + 'px';
    container.style.width = stretchedWidth + 'px';

    const canvas = document.createElement('canvas');
    canvas.width  = stretchedWidth;
    canvas.height = 60;
    canvas.classList.add('timeline-clip__canvas');
    drawClipCanvas(canvas, placed.clip);
    container.appendChild(canvas);

    const { outer: leftHandle,  trimHalf: leftTrim,  stretchHalf: leftStretch  } = makeSplitHandle('left');
    const { outer: rightHandle, trimHalf: rightTrim, stretchHalf: rightStretch } = makeSplitHandle('right');
    container.appendChild(leftHandle);
    container.appendChild(rightHandle);

    timelineEl.appendChild(container);
    placed._container = container;

    let handleDragActive = false;

    container.addEventListener('mouseenter', () => {
        leftHandle.style.opacity  = '1';
        rightHandle.style.opacity = '1';
        container.dataset.hovered = 'true';
    });
    container.addEventListener('mouseleave', () => {
        delete container.dataset.hovered;
        if (handleDragActive) return;
        leftHandle.style.opacity  = '0';
        rightHandle.style.opacity = '0';
    });

    // ── Move / duplicate ──────────────────────────────────────────────────────
    container.addEventListener('mousedown', (e) => {
        if (leftHandle.contains(e.target) || rightHandle.contains(e.target)) return;
        const dragOffset = e.clientX - container.getBoundingClientRect().left;
        const ghostWidth = parseFloat(container.style.width);

        if (e.shiftKey || shiftDown) {
            const copy = { ...placed, clip: { ...placed.clip }, reversed: placed.reversed };
            startClipDrag(e, copy.clip, ghostWidth, dragOffset, (snappedTime) => {
                if (snappedTime !== null) {
                    copy.startTime = snappedTime;
                    timeline.push(copy);
                    renderTimelineClip(copy);
                }
            });
        } else {
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
        const tlRect    = timelineEl.getBoundingClientRect();
        const rightEdge = parseFloat(container.style.left) + parseFloat(container.style.width);
        const srcEnd    = placed.clip.startTime + placed.clip.duration;

        function onMouseMove(e) {
            const newLeft = Math.max(0, Math.min(e.clientX - tlRect.left, rightEdge - CLIP_HANDLE_WIDTH * 2));
            const newWidth = rightEdge - newLeft;
            const newDur   = (newWidth / PX_PER_SEC) / (placed.stretchRatio ?? 1);

            let newStart, clampDur;
            if (placed.reversed) {
                newStart  = placed.clip.startTime;
                clampDur  = Math.min(newDur, sourceBuffer.duration - newStart);
            } else {
                newStart  = Math.max(0, srcEnd - newDur);
                clampDur  = srcEnd - newStart;
            }

            const offset  = Math.floor(newStart * sourceBuffer.sampleRate);
            const visible = Math.round(clampDur * sourceBuffer.sampleRate);

            container.style.left  = newLeft + 'px';
            container.style.width = newWidth + 'px';
            canvas.width = Math.max(1, Math.round(newWidth));

            if (placed.reversed) {
                const currentSrcEnd  = newStart + clampDur;
                const srcEndSample   = Math.floor(currentSrcEnd * sourceBuffer.sampleRate);
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
        const tlRect    = timelineEl.getBoundingClientRect();
        const rightEdge = parseFloat(container.style.left) + parseFloat(container.style.width);

        function onMouseMove(e) {
            const newLeft  = Math.max(0, Math.min(e.clientX - tlRect.left, rightEdge - CLIP_HANDLE_WIDTH * 2));
            const newWidth = rightEdge - newLeft;
            const newRatio = (newWidth / PX_PER_SEC) / placed.clip.duration;
            container.style.left  = newLeft + 'px';
            container.style.width = newWidth + 'px';
            canvas.width = Math.max(1, Math.round(newWidth));
            drawClipCanvas(canvas, placed.clip);
            showLabel(container, `${newRatio.toFixed(2)}×`, 'amber');
        }

        function onMouseUp() {
            document.removeEventListener('mousemove', onMouseMove);
            document.removeEventListener('mouseup', onMouseUp);
            handleDragActive = false;
            placed.startTime    = parseFloat(container.style.left) / PX_PER_SEC;
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
        const tlRect   = timelineEl.getBoundingClientRect();
        const leftEdge = parseFloat(container.style.left);
        const srcStart = placed.clip.startTime;
        const srcEnd   = srcStart + placed.clip.duration;
        const maxDur   = sourceBuffer.duration - srcStart;

        function onMouseMove(e) {
            const rawWidth         = Math.max(CLIP_HANDLE_WIDTH * 2, e.clientX - tlRect.left - leftEdge);
            const newDur           = Math.min((rawWidth / PX_PER_SEC) / (placed.stretchRatio ?? 1), maxDur);
            const effectiveSrcStart = placed.reversed ? srcEnd - newDur : srcStart;
            const capWidth         = Math.round(newDur * (placed.stretchRatio ?? 1) * PX_PER_SEC);

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
        const tlRect   = timelineEl.getBoundingClientRect();
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
    outer.classList.add('clip-handle', `clip-handle--${side}`);

    const trimHalf = document.createElement('div');
    trimHalf.classList.add('clip-handle__trim');
    trimHalf.title = side === 'left' ? 'Trim start' : 'Trim end';

    const stretchHalf = document.createElement('div');
    stretchHalf.classList.add('clip-handle__stretch');
    stretchHalf.title = 'Timestretch';

    outer.appendChild(trimHalf);
    outer.appendChild(stretchHalf);
    return { outer, trimHalf, stretchHalf };
}

// ─── Drag label ───────────────────────────────────────────────────────────────

function showLabel(container, text, color = 'teal') {
    let label = container._dragLabel;
    if (!label) {
        label = document.createElement('div');
        label.classList.add('drag-label');
        container.appendChild(label);
        container._dragLabel = label;
    }
    label.dataset.color = color;
    label.textContent   = text;
}

function clearLabel(container) {
    if (container._dragLabel) {
        container._dragLabel.remove();
        container._dragLabel = null;
    }
}
