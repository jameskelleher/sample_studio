import { timeline, setShiftDown, shiftDown, clipDragging } from './state.js';
import { drawClipCanvas, timelineEl } from './draw.js';

export function initKeyboard() {
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Shift') {
            setShiftDown(true);
            timelineEl.classList.add('shift-mode');
        }

        // R = reverse hovered clip
        if (e.key === 'r' || e.key === 'R') {
            const hovered = timelineEl.querySelector('.timeline-clip[data-hovered]');
            if (!hovered) return;
            const placed = timeline.find(p => p._container === hovered);
            if (!placed) return;
            placed.reversed = !placed.reversed;
            placed.clip = { ...placed.clip, samples: placed.clip.samples.slice().reverse() };
            const canvas = hovered.querySelector('canvas');
            canvas.width = canvas.width; // clear
            drawClipCanvas(canvas, placed.clip);
        }
    });

    document.addEventListener('keyup', (e) => {
        if (e.key === 'Shift') {
            setShiftDown(false);
            if (!clipDragging) {
                timelineEl.classList.remove('shift-mode');
                // Force cursor refresh
                timelineEl.style.pointerEvents = 'none';
                requestAnimationFrame(() => timelineEl.style.pointerEvents = '');
            }
        }
    });

    window.addEventListener('blur', () => {
        setShiftDown(false);
        timelineEl.classList.remove('shift-mode');
    });
}
