/*
    The AudioWorklet that hosts the WebAssembly engine.

    This is the browser's equivalent of the desktop's audio device callback, and
    it is held to the same rules: nothing in process() allocates, nothing takes
    a lock, and nothing waits on the main thread. Commands from the UI arrive by
    message and are applied between blocks, which is the same arrangement
    AudioEngine has with its engineLock - just enforced by the platform instead
    of by discipline.

    Plain JavaScript rather than TypeScript: this file is loaded by
    `addModule()` straight from public/, with no bundler in the path. Its
    contract with the typed side is one file - src/engine/protocol.ts - and both
    ends reference it.

    Kept out of src/ deliberately. Vite would happily bundle a worklet, but the
    result is a module that can only be loaded through a blob URL or a
    ?worker-style import, and both make the WASM module's own loading harder to
    reason about for no benefit here.
*/

import createEngineModule from '../engine/jlooper-engine.js'

/** Must match Web/src/engine/protocol.ts. */
const Command = {
    launchClip: 1,
    launchScene: 2,
    stopClip: 3,
    stopAllClips: 4,
    clearClip: 5,
    stopAndReset: 6,
    resetAllSlots: 7,
    undoOverdub: 8,
    setPlaying: 9,
    setTempo: 10,
    setBeatsPerBar: 11,
    setLaunchQuantum: 12,
    setQuantise: 13,
    setCountIn: 14,
    setMasterBars: 15,
    reinterpretTempo: 16,
    setSelectedTrack: 17,
    setMasterGain: 18,
    setMasterMuted: 19,
    setVisibleScenes: 20,
    setTrackGain: 21,
    setTrackPan: 22,
    setTrackMuted: 23,
    setTrackInstrument: 24,
    setInstrumentParam: 34,
    setDrumSample: 35,
    restoreErasedClip: 36,
    setTrackInput: 25,
    setMetronome: 26,
    midi: 27,
    setLoopCycle: 28,
    clearEverything: 29,
    readClipEvents: 30,
    setMasterLoop: 31,
    setTempoMode: 32,
    setTrackSource: 33,
}

class JLooperProcessor extends AudioWorkletProcessor {
    constructor (options) {
        super(options)

        this.ready = false
        this.pendingCommands = []

        // Snapshots go to the UI at roughly 30 Hz, which is the rate the
        // desktop's timer repaints at. Every block would be 375 messages a
        // second for a picture nobody can see change that fast.
        this.blocksPerSnapshot = Math.max(1, Math.round(sampleRate / 128 / 30))
        this.blocksSinceSnapshot = 0

        this.port.onmessage = (event) => this.onMessage(event.data)

        createEngineModule().then((module) => this.start(module)).catch((error) => {
            this.port.postMessage({ type: 'error', message: String(error) })
        })
    }

    start (module) {
        this.module = module
        this.engine = module._engine_create()

        module._engine_prepare(this.engine, sampleRate, 128)

        // Scratch regions inside the WASM heap. The browser hands us its own
        // Float32Arrays, which live in JS memory the module cannot address, so
        // every block is copied in and out through these. Allocated once here,
        // never in process().
        this.maxBlock = 1024
        this.inputPtr = module._malloc(this.maxBlock * 2 * 4)
        this.outputPtr = module._malloc(this.maxBlock * 2 * 4)

        // Room for one clip's events. MidiClip caps at 8192 events, each a
        // 24-byte header plus a short message, so 512 KB is comfortably above
        // the worst case and is allocated once rather than per save.
        this.clipScratchBytes = 512 * 1024
        this.clipScratchPtr = module._malloc(this.clipScratchBytes)

        this.snapshotFloats = module._engine_snapshot_size()
        this.snapshotPtr = module._malloc(this.snapshotFloats * 4)

        this.snapshotBuffer = new Float32Array(this.snapshotFloats)

        this.ready = true

        for (const command of this.pendingCommands)
            this.apply(command)

        this.pendingCommands.length = 0
        this.port.postMessage({
            type: 'ready',
            snapshotFloats: this.snapshotFloats,
            eventFormatVersion: module._engine_event_format_version(),
        })
    }

    onMessage (data) {
        if (!this.ready) {
            // Commands can arrive before the module finishes instantiating -
            // the page does not wait to be told it may exist. Replaying them in
            // order afterwards is what makes startup look instant.
            this.pendingCommands.push(data)
            return
        }

        this.apply(data)
    }

    apply (c) {
        const m = this.module
        const e = this.engine

        // Not a command: a request that answers. Handled before the table
        // because it is the only message that sends anything back.
        if (c.request === 'clips') {
            this.sendClips()
            return
        }

        if (c.request === 'notes') {
            this.sendNotes(c.wanted ?? [])
            return
        }

        switch (c.id) {
            case Command.launchClip:        m._engine_launch_clip(e, c.a, c.b); break
            case Command.launchScene:       m._engine_launch_scene(e, c.a); break
            case Command.stopClip:          m._engine_stop_clip(e, c.a, c.b); break
            case Command.stopAllClips:      m._engine_stop_all_clips(e); break
            case Command.clearClip:         m._engine_clear_clip(e, c.a, c.b); break
            case Command.stopAndReset:      m._engine_stop_and_reset(e); break
            case Command.resetAllSlots:     m._engine_reset_all_slots(e); break
            case Command.undoOverdub:       m._engine_undo_overdub(e, c.a); break
            case Command.restoreErasedClip: m._engine_restore_erased_clip(e); break
            case Command.setPlaying:        m._engine_set_playing(e, c.a); break
            case Command.setTempo:          m._engine_set_tempo(e, c.a); break
            case Command.setBeatsPerBar:    m._engine_set_beats_per_bar(e, c.a); break
            case Command.setLaunchQuantum:  m._engine_set_launch_quantum(e, c.a); break
            case Command.setQuantise:       m._engine_set_quantise(e, c.a, c.b, c.c); break
            case Command.setCountIn:        m._engine_set_count_in(e, c.a); break
            case Command.setMasterBars:     m._engine_set_master_bars(e, c.a); break
            case Command.reinterpretTempo:  m._engine_reinterpret_tempo(e, c.a); break
            case Command.setSelectedTrack:  m._engine_set_selected_track(e, c.a); break
            case Command.setMasterGain:     m._engine_set_master_gain(e, c.a); break
            case Command.setMasterMuted:    m._engine_set_master_muted(e, c.a); break
            case Command.setVisibleScenes:  m._engine_set_visible_scenes(e, c.a); break
            case Command.setTrackGain:      m._engine_set_track_gain(e, c.a, c.b); break
            case Command.setTrackPan:       m._engine_set_track_pan(e, c.a, c.b); break
            case Command.setTrackMuted:     m._engine_set_track_muted(e, c.a, c.b); break
            case Command.setTrackInstrument: m._engine_set_track_instrument(e, c.a, c.b); break
            case Command.setInstrumentParam: m._engine_set_instrument_param(e, c.a, c.b, c.c); break

            // Audio, not a number: the floats ride on the message and are
            // copied into the heap here. Its own allocation rather than the
            // shared scratch - a kit's samples are far larger than a clip's
            // events, and this happens once per note at load time.
            case Command.setDrumSample: {
                const frames = c.samples.length
                const ptr = m._malloc(frames * 4)

                m.HEAPF32.set(c.samples, ptr >> 2)

                // c.rate, not `sampleRate`. They are usually the same number -
                // decodeAudioData resamples to the context rate - but the rate
                // belongs to the audio, and the engine is the wrong place to
                // infer it. The desktop feeds the same call at 44.1k.
                m._engine_set_drum_sample(e, c.a, c.b, ptr, frames, c.rate)
                m._free(ptr)
                break
            }
            case Command.setTrackInput:     m._engine_set_track_input(e, c.a, c.b, c.c); break
            case Command.setMetronome:      m._engine_set_metronome(e, c.a); break
            case Command.midi:              m._engine_push_midi(e, c.a, c.b, c.c, c.d | 0); break
            case Command.clearEverything:   m._engine_clear_everything(e); break
            case Command.setMasterLoop:     m._engine_set_master_loop(e, c.a); break
            case Command.setTempoMode:      m._engine_set_tempo_mode(e, c.a); break
            case Command.setTrackSource:    m._engine_set_track_source(e, c.a, c.b); break

            case Command.readClipEvents: {
                // The bytes travel with the message rather than through the
                // scratch buffer: a load is a one-off, and copying them in here
                // keeps the caller from having to know about the heap.
                const bytes = c.bytes ?? new Uint8Array(0)

                if (bytes.length <= this.clipScratchBytes) {
                    m.HEAPU8.set(bytes, this.clipScratchPtr)
                    m._engine_read_clip_events(e, c.a, c.b, this.clipScratchPtr, bytes.length,
                                               c.c, c.d, c.isMaster ? 1 : 0)
                }

                break
            }
            case Command.setLoopCycle:      m._engine_set_loop_cycle(e, c.a); break
            default: break
        }
    }

    process (inputs, outputs) {
        const output = outputs[0]

        if (!this.ready || !output || output.length === 0)
            return true

        const numSamples = output[0].length

        if (numSamples > this.maxBlock)
            return true         // a quantum this large would overrun the scratch

        const m = this.module
        const heap = m.HEAPF32
        const inputChannels = inputs[0] ?? []
        const numInputChannels = Math.min(inputChannels.length, 2)

        // --- in ---
        for (let ch = 0; ch < numInputChannels; ++ch) {
            const source = inputChannels[ch]
            const base = (this.inputPtr >> 2) + ch * numSamples

            if (source && source.length === numSamples)
                heap.set(source, base)
            else
                heap.fill(0, base, base + numSamples)
        }

        // Clamped for the same reason the input is: the scratch either side of
        // the call is malloc'd for two channels, and nothing here enforces that
        // the node was created with two. It is - client.ts asks for
        // outputChannelCount: [2] - but that is a one-line change in another
        // file, and the failure it would cause is a heap overrun on the audio
        // thread rather than anything that would point back at it.
        const numOutputChannels = Math.min(output.length, 2)

        m._engine_process(this.engine,
                          this.inputPtr, numInputChannels,
                          this.outputPtr, numOutputChannels,
                          numSamples)

        // --- out ---
        for (let ch = 0; ch < output.length; ++ch) {
            // A third channel or beyond gets the last one the engine rendered,
            // rather than whatever happens to sit past the allocation.
            const from = Math.min(ch, numOutputChannels - 1)
            const base = (this.outputPtr >> 2) + from * numSamples
            output[ch].set(heap.subarray(base, base + numSamples))
        }

        if (++this.blocksSinceSnapshot >= this.blocksPerSnapshot) {
            this.blocksSinceSnapshot = 0
            this.sendSnapshot()
        }

        return true
    }

    /** Every clip's event bytes, for a save. */
    sendClips () {
        const m = this.module
        const clips = []

        for (let track = 0; track < 8; ++track) {
            for (let scene = 0; scene < 8; ++scene) {
                const written = m._engine_write_clip_events(this.engine, track, scene,
                                                            this.clipScratchPtr, this.clipScratchBytes)

                if (written <= 0) continue

                clips.push({
                    track,
                    scene,
                    // Sliced, not a view: the scratch buffer is reused by the
                    // very next iteration, and a view would all end up pointing
                    // at the last clip.
                    bytes: m.HEAPU8.slice(this.clipScratchPtr, this.clipScratchPtr + written),
                })
            }
        }

        this.port.postMessage({ type: 'clips', clips })
    }

    /** Note pictures for the cells the page says have changed. Asked for rather
        than pushed: a grid of loops is far too much to ship every frame, and
        almost none of it changes between takes. */
    sendNotes (wanted) {
        const m = this.module
        const maxNotes = Math.floor(this.clipScratchBytes / 4 / 5)
        const pictures = []

        for (const { track, scene } of wanted) {
            const count = m._engine_write_note_picture(this.engine, track, scene,
                                                       this.clipScratchPtr, maxNotes)

            if (count < 0) continue      // more notes than the scratch can hold

            const base = this.clipScratchPtr >> 2

            pictures.push({
                track,
                scene,
                // Sliced, not a view: the scratch is reused by the next
                // iteration, and views would all point at the last picture.
                notes: m.HEAPF32.slice(base, base + count * 5),
            })
        }

        this.port.postMessage({ type: 'notes', pictures })
    }

    sendSnapshot () {
        const m = this.module

        m._engine_write_snapshot(this.engine, this.snapshotPtr)

        const base = this.snapshotPtr >> 2
        this.snapshotBuffer.set(m.HEAPF32.subarray(base, base + this.snapshotFloats))

        // Not transferred: a transfer detaches the array, so the next frame
        // would need a fresh allocation here on the audio thread. Cloning keeps
        // this buffer reusable.
        //
        // Being straight about it: postMessage still allocates internally to
        // serialise the copy, so this is not allocation-free the way the render
        // path is - nothing short of a SharedArrayBuffer would be, and that
        // needs COOP/COEP headers which would stop jLooper being droppable on
        // any static host. 1.8 KB thirty times a second is the price, and it is
        // off the critical path in a way a heap growth inside the engine
        // would not be.
        this.port.postMessage({ type: 'snapshot', data: this.snapshotBuffer })
    }
}

registerProcessor('jlooper-engine', JLooperProcessor)
