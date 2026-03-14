import '../style.css';

import { ensureReady, sourceBuffer, makeClipFromSource, playMain, startTimeline, stopTimeline } from './audio.js';
import { clips, selection, timeline } from './state.js';
import { drawFrame, timelineEl } from './draw.js';
import { waveformCanvas } from './draw.js';
import { initWaveformInteraction } from './waveform.js';
import { renderPaletteClip } from './palette.js';
import { placeholder } from './timeline.js';
import { initKeyboard } from './keyboard.js';
import { PALETTE_SLOTS } from './constants.js';
import { stopAll } from './audio.js';

// ─── Boot ─────────────────────────────────────────────────────────────────────

document.addEventListener('click', () => ensureReady(), { once: true });

// ─── Selection deselect on outside click ──────────────────────────────────────

document.addEventListener('click', (e) => {
    if (!e.target.closest('#canvas-container') && !e.target.closest('#preview-btn')) {
        selection.startTime = null;
        selection.endTime   = null;
    }
});

// ─── Button handlers ──────────────────────────────────────────────────────────

document.getElementById('timeline-play-btn').onclick = () => startTimeline();
document.getElementById('timeline-stop-btn').onclick = () => stopTimeline();

document.getElementById('preview-btn').onclick = () => {
    const start = Math.min(selection.startTime, selection.endTime);
    const end   = Math.max(selection.startTime, selection.endTime);
    playMain(start, end - start);
};

document.getElementById('save-btn').onclick = () => {
    const start = Math.min(selection.startTime, selection.endTime);
    const end   = Math.max(selection.startTime, selection.endTime);
    const clip  = makeClipFromSource(start, end - start);
    clips.push(clip);
    renderPaletteClip(clip);
    selection.startTime = null;
    selection.endTime   = null;
};

document.getElementById('timeline-clear-btn').onclick = () => {
    stopTimeline();
    timeline.length = 0;
    timelineEl.innerHTML = '';
    timelineEl.appendChild(placeholder);
    placeholder.style.display = 'none';
};

// ─── Palette empty slots ──────────────────────────────────────────────────────

const clipColumn = document.getElementById('clip-column');
for (let i = 0; i < PALETTE_SLOTS; i++) {
    const slot = document.createElement('div');
    slot.classList.add('palette-slot');
    clipColumn.appendChild(slot);
}

// ─── Init subsystems ──────────────────────────────────────────────────────────

initWaveformInteraction(waveformCanvas, { playMain, stopAll });
initKeyboard();
requestAnimationFrame(drawFrame);
