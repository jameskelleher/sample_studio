import { SoundTouchNode } from '@soundtouchjs/audio-worklet';
import {
    activeSources, mainPlayNode,
    setMainPlayNode, setMainPlayStart, setMainPlayOffset, setTransportStart,
    timeline,
} from './state.js';
import { TIMELINE_DURATION } from './constants.js';

// ─── Context ──────────────────────────────────────────────────────────────────

export const audioCtx = new AudioContext();
let soundTouchRegistered = false;

export async function ensureReady() {
    if (audioCtx.state === 'suspended') await audioCtx.resume();
    if (!soundTouchRegistered) {
        await SoundTouchNode.register(audioCtx, '/soundtouch-processor.js');
        soundTouchRegistered = true;
    }
}

// ─── Source buffer ────────────────────────────────────────────────────────────

export const sourceBuffer = await fetch('amen.flac')
    .then(r => r.arrayBuffer())
    .then(ab => audioCtx.decodeAudioData(ab));

export const samples = sourceBuffer.getChannelData(0); // Float32Array, never mutated

// ─── Clip helpers ─────────────────────────────────────────────────────────────

export function makeClipFromSource(startTime, duration) {
    const s = Math.floor(startTime * sourceBuffer.sampleRate);
    const e = Math.floor((startTime + duration) * sourceBuffer.sampleRate);
    return { startTime, duration, samples: samples.slice(s, e) };
}

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

export async function playStretched(clip, stretchRatio, when = 0) {
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

export function playDirect(clip, when = 0) {
    const src = makeBufferSource(clip.samples);
    src.connect(audioCtx.destination);
    src.start(when);
    activeSources.push(src);
    src.onended = () => activeSources.splice(activeSources.indexOf(src), 1);
    return src;
}

export function stopAll() {
    for (const src of [...activeSources]) {
        try { src.stop(); } catch (_) { }
    }
    activeSources.length = 0;
    setMainPlayNode(null);
}

export async function playMain(startAt = 0, duration = null) {
    await ensureReady();
    stopAll();

    const src = audioCtx.createBufferSource();
    src.buffer = sourceBuffer;
    src.connect(audioCtx.destination);

    const offset = Math.max(0, Math.min(startAt, sourceBuffer.duration));
    duration !== null
        ? src.start(0, offset, duration)
        : src.start(0, offset);

    setMainPlayNode(src);
    setMainPlayStart(audioCtx.currentTime);
    setMainPlayOffset(offset);

    activeSources.push(src);
    src.onended = () => {
        activeSources.splice(activeSources.indexOf(src), 1);
        if (mainPlayNode === src) setMainPlayNode(null);
    };
}

// ─── Timeline transport ───────────────────────────────────────────────────────

export async function startTimeline() {
    await ensureReady();
    stopAll();
    setTransportStart(audioCtx.currentTime);

    for (const placed of timeline) {
        const when  = audioCtx.currentTime + placed.startTime;
        const ratio = placed.stretchRatio ?? 1;
        Math.abs(ratio - 1) < 0.01
            ? playDirect(placed.clip, when)
            : playStretched(placed.clip, ratio, when);
    }
}

export function stopTimeline() {
    stopAll();
    setTransportStart(null);
}
