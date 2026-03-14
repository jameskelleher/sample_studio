import { clips, timeline } from './state.js';
import { playMain } from './audio.js';
import { drawClipCanvas } from './draw.js';
import { startClipDrag } from './timeline.js';
import { renderTimelineClip } from './timeline.js';
import { PX_PER_SEC } from './constants.js';

export function renderPaletteClip(clip) {
    const wrapper = document.createElement('div');
    wrapper.classList.add('palette-clip');

    const canvas = document.createElement('canvas');
    canvas.width  = 80;
    canvas.height = 60;
    canvas.classList.add('palette-clip__canvas');
    drawClipCanvas(canvas, clip);

    const deleteBtn = document.createElement('button');
    deleteBtn.textContent = '×';
    deleteBtn.classList.add('palette-clip__delete');

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

    const column    = document.getElementById('clip-column');
    const firstSlot = column.querySelector('.palette-slot');
    firstSlot ? column.insertBefore(wrapper, firstSlot) : column.appendChild(wrapper);
    document.querySelector('#clip-column .palette-slot:last-child')?.remove();
}
