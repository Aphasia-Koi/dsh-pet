/**
 * frames2d renderer — plays the free-form named frame-sequence tracks of a
 * frames2d pet (manifest v2 'frames2d' block). The pet center picks the
 * track from the ActivityPhase stream (phase -> track map, idle fallback);
 * the gameplay driver may force a track through the handle's setState
 * override (drag/work/sleep/shop...), and a finished non-loop track settles
 * into its fallback, releasing the override when the fallback matches the
 * phase-mapped track. Rendering never throws: a broken track list degrades
 * to the first decodable frame, and the 1.2 s stall watchdog re-kicks the
 * playback chain after timer throttling.
 *
 * Frame presentation has two modes picked once at mount by capability
 * probing:
 * - Canvas bitmap buffer (default where createImageBitmap/fetch/2D context
 *   exist): frames are decoded once into an ImageBitmap on demand, with a
 *   bounded look-ahead window over the playing track, and drawn onto one
 *   <canvas> - steady-state playback issues zero DOM mutations and zero
 *   re-decodes (measured hotspot: swapping <img>.src per frame drove image
 *   decode + invalidation every tick).
 * - Classic <img> fallback (jsdom/tests or missing APIs): identical to the
 *   historical behavior - cache-warm Image elements plus guarded src swaps,
 *   so environments without modern decoding keep working unchanged.
 *
 * @module @linxin666/dsh-pet/client/renderers/frames2d
 */

import { PET_RENDERER_API_VERSION, type PetRenderer, type PetRendererContext, type PetRendererHandle } from '../../contracts/renderer.ts'
import type { ActivityPhase } from '../../state.ts'

/** One track as served inside the pet definition (browser URLs). */
export interface Frames2dTrackConfig {
  frames: string[]
  durations: number[]
  loop: boolean
  fallback?: string
}

/** The frames2d block as served inside the pet definition. */
export interface PetFrames2dConfig {
  tracks: Record<string, Frames2dTrackConfig>
  phases: Partial<Record<ActivityPhase, string>> & { idle: string }
  /** Selectable skins; each swaps the base idle target while selected. */
  skins?: Frames2dSkinConfig[]
}

/** One selectable skins entry as served inside the pet definition. */
export interface Frames2dSkinConfig {
  id: string
  label: string
  /** A declared looping track that becomes the base idle while selected. */
  idleTrack: string
  /** Click actions exclusive to this skin (roll by probability; miss → touch zones). */
  clickActions?: Frames2dSkinClickActionConfig[]
  /** Gameplay-state overrides (state -> track) swapped in while selected. */
  gameplayTracks?: Record<string, string>
}

/** One probability-rolled tap action a skin may declare. */
export interface Frames2dSkinClickActionConfig {
  track: string
  probability: number
  phrases?: string[]
}

export interface Frames2dRendererHandle extends PetRendererHandle {
  /** Force a track id (gameplay override); undefined returns to phase mapping. */
  setState(track: string | undefined): void
  /**
   * Swap the base idle target (idle phase, unmapped phases and every
   * fallback back to idle) to a declared looping track — a skin. undefined
   * restores the manifest idle track.
   */
  setIdleTrack(track: string | undefined): void
  /** The track currently playing (diagnostics and tests). */
  currentTrack(): string
  /** Decoded frames still retained (diagnostics and tests). */
  cachedFrameCount(): number
  /** Decoded bytes still retained (diagnostics and tests). */
  cachedFrameBytes(): number
}

/** Stall watchdog period: a looping track stuck longer re-kicks its chain. */
const WATCHDOG_MS = 1200

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Fail-closed client-side validation of the served frames2d block. */
function validateFrames2dConfig(config: unknown): PetFrames2dConfig {
  if (!isRecord(config) || !isRecord(config.tracks) || !isRecord(config.phases)) {
    throw new Error('frames2d config requires tracks and phases objects')
  }
  const tracks: Record<string, Frames2dTrackConfig> = {}
  for (const [name, raw] of Object.entries(config.tracks)) {
    if (!isRecord(raw) || !Array.isArray(raw.frames) || raw.frames.length === 0
      || raw.frames.some(f => typeof f !== 'string' || f === '')
      || !Array.isArray(raw.durations) || raw.durations.length !== raw.frames.length
      || raw.durations.some(d => typeof d !== 'number' || !(d > 0))) {
      throw new Error('frames2d track ' + JSON.stringify(name) + ' needs same-length frames/durations')
    }
    tracks[name] = {
      frames: raw.frames as string[],
      durations: raw.durations as number[],
      loop: raw.loop !== false,
      ...(typeof raw.fallback === 'string' ? { fallback: raw.fallback } : {}),
    }
  }
  const phases = config.phases as Partial<Record<ActivityPhase, string>>
  if (typeof phases.idle !== 'string' || tracks[phases.idle] === undefined) {
    throw new Error('frames2d phases.idle must name an existing track')
  }
  // Skins: keep entries whose idleTrack survives validation and loops —
  // a non-looping base idle would settle into itself forever. Click actions
  // with an unresolvable track are dropped from that skin.
  let skins: Frames2dSkinConfig[] | undefined
  if (Array.isArray(config.skins)) {
    const resolved: Frames2dSkinConfig[] = []
    for (const skin of config.skins as unknown[]) {
      if (!isRecord(skin) || typeof skin.id !== 'string' || typeof skin.label !== 'string'
        || typeof skin.idleTrack !== 'string' || skin.idleTrack === '') continue
      const target = tracks[skin.idleTrack]
      if (target === undefined || !target.loop) continue
      let clickActions: Frames2dSkinClickActionConfig[] | undefined
      if (Array.isArray(skin.clickActions)) {
        const kept: Frames2dSkinClickActionConfig[] = []
        for (const action of skin.clickActions as unknown[]) {
          if (!isRecord(action) || typeof action.track !== 'string' || action.track === ''
            || typeof action.probability !== 'number' || !(action.probability > 0) || action.probability > 1) continue
          if (tracks[action.track] === undefined) continue
          kept.push({
            track: action.track,
            probability: action.probability,
            ...(Array.isArray(action.phrases) ? { phrases: action.phrases as string[] } : {}),
          })
        }
        if (kept.length > 0) clickActions = kept
      }
      let gameplayTracks: Record<string, string> | undefined
      if (isRecord(skin.gameplayTracks)) {
        const kept: Record<string, string> = {}
        for (const [state, trackName] of Object.entries(skin.gameplayTracks)) {
          if (typeof trackName !== 'string' || trackName === '' || tracks[trackName] === undefined) continue
          kept[state] = trackName
        }
        if (Object.keys(kept).length > 0) gameplayTracks = kept
      }
      resolved.push({
        id: skin.id,
        label: skin.label,
        idleTrack: skin.idleTrack,
        ...(clickActions === undefined ? {} : { clickActions }),
        ...(gameplayTracks === undefined ? {} : { gameplayTracks }),
      })
    }
    if (resolved.length > 0) skins = resolved
  }
  return { tracks, phases: phases as PetFrames2dConfig['phases'], ...(skins === undefined ? {} : { skins }) }
}

interface DecodedFrame {
  source: ImageBitmap | HTMLImageElement
  width: number
  height: number
}

export const frames2dRenderer: PetRenderer<PetFrames2dConfig> = {
  id: 'frames2d',
  apiVersion: PET_RENDERER_API_VERSION,
  validateConfig: validateFrames2dConfig,

  mount(ctx: PetRendererContext, config: PetFrames2dConfig): Frames2dRendererHandle {
    const reducedMotion = typeof window !== 'undefined'
      && typeof window.matchMedia === 'function'
      && window.matchMedia('(prefers-reduced-motion: reduce)').matches

    // Capability probe: the canvas path needs decode-to-bitmap, same-origin
    // fetch, and a real 2D context (jsdom returns null and falls back below).
    let canvas: HTMLCanvasElement | null = null
    let context2d: CanvasRenderingContext2D | null = null
    let img: HTMLImageElement | null = null
    try {
      if (typeof createImageBitmap === 'function' && typeof fetch === 'function') {
        const probe = document.createElement('canvas')
        const c2d = probe.getContext('2d')
        if (c2d !== null) {
          canvas = probe
          context2d = c2d
        }
      }
    } catch {
      canvas = null
      context2d = null
    }

    if (canvas !== null && context2d !== null) {
      canvas.dataset.dshPetFrames2d = ctx.petId
      canvas.draggable = false
      canvas.style.width = '100%'
      canvas.style.height = '100%'
      canvas.style.objectFit = 'contain'
      canvas.style.pointerEvents = 'none'
      ctx.container.appendChild(canvas)
    } else {
      img = document.createElement('img')
      img.dataset.dshPetFrames2d = ctx.petId
      img.alt = ''
      img.draggable = false
      img.style.width = '100%'
      img.style.height = '100%'
      img.style.objectFit = 'contain'
      img.style.pointerEvents = 'none'
      ctx.container.appendChild(img)
    }

    // Decode cache: one concurrent decode per URL, memoized. Failures resolve
    // undefined and keep the last painted frame instead of breaking playback.
    //
    // ★ The cache is BOUNDED. It used to be memoized forever, which is fine for
    // the tiny pets the comment above imagined but not for a real pack: one
    // 256x256 RGBA frame is ~262 KB decoded, so a 372-frame pet retains ~93 MB
    // of bitmaps for the life of the page. Once decoded-frame memory outgrows
    // what the compositor can hold, every further decode has to wait, the
    // 120 ms frame timer keeps firing, and the TAIL of each animation is what
    // gets dropped — playback looked fine at first and degraded the longer the
    // page ran. So: keep the most recently used frames inside a budget, always
    // keep the playing track and the frame actually painted, and release the
    // bitmap (ImageBitmap.close) of anything we drop.
    const decoding = new Map<string, Promise<DecodedFrame | undefined>>()
    /** Resolved bitmap per URL, for eviction; insertion order = age (LRU). */
    const decoded = new Map<string, DecodedFrame>()
    /** Rough decoded cost per URL, summed into the budget. */
    const frameCost = new Map<string, number>()
    /** Eviction generation per URL; a stale decode must not re-adopt itself. */
    const epoch = new Map<string, number>()
    let cachedCost = 0
    /** Frame budget in decoded bytes. 150 frames of 256x256 RGBA ~ 39 MB. */
    const FRAME_CACHE_BUDGET = 150 * 256 * 256 * 4
    const decodedAll: Promise<void>[] = []
    // All frame fetches funnel through a small pool. Full-library warm passes
    // on large pets fire 1100+ requests at once, which trips the browser's
    // in-flight request limit (net::ERR_INSUFFICIENT_RESOURCES) and fails
    // whole batches of frames while starving the rest of the page. Playback
    // demand jumps ahead of the warm backlog.
    const FRAME_POOL_LIMIT = 8
    const frameQueue: Array<{ url: string; release: () => void }> = []
    let activeFrames = 0

    const decodeFrame = async (url: string): Promise<DecodedFrame | undefined> => {
      try {
        const response = await fetch(url)
        if (!response.ok) throw new Error('http ' + response.status)
        const bitmap = await createImageBitmap(await response.blob())
        return { source: bitmap, width: bitmap.width, height: bitmap.height }
      } catch {
        // Fail-open: classic Image decode keeps non-modern runtimes alive.
        return await new Promise<DecodedFrame | undefined>((resolve) => {
          try {
            const pre = new Image()
            pre.onload = (): void => {
              resolve(pre.naturalWidth > 0 ? { source: pre, width: pre.naturalWidth, height: pre.naturalHeight } : undefined)
            }
            pre.onerror = (): void => resolve(undefined)
            pre.src = url
          } catch {
            resolve(undefined)
          }
        })
      }
    }

    const pumpFrames = (): void => {
      while (activeFrames < FRAME_POOL_LIMIT && frameQueue.length > 0) {
        const queued = frameQueue.shift()!
        activeFrames += 1
        queued.release()
      }
    }

    /**
     * Bounded look-ahead window: decode only the frames playback is about to
     * need. The historical warm pass decoded every frame of every track up
     * front - a shipped pet carries ~1.1k 512x683 frames, so that pass pulls
     * tens of megabytes and retains every decoded bitmap for the life of the
     * page. Prefetching the playing track's next frames keeps loops and phase
     * switches warm while unplayed tracks (and every unselected skin's
     * frames) stay on demand, where playback jumps the queue anyway.
     */
    const PREFETCH_AHEAD = 12

    /** Release one cached bitmap; an ImageBitmap must be closed explicitly. */
    const releaseFrame = (url: string): void => {
      const frame = decoded.get(url)
      if (frame === undefined) return
      decoded.delete(url)
      cachedCost -= frameCost.get(url) ?? 0
      frameCost.delete(url)
      const maybeClose = (frame.source as { close?: () => void }).close
      if (typeof maybeClose === 'function') {
        try {
          maybeClose.call(frame.source)
        } catch { /* already closed */ }
      }
    }

    /**
     * Drop a URL from the cache completely and refuse to re-adopt it. The epoch
     * guard matters: a decode that started before the eviction must not resolve
     * afterwards and re-insert a bitmap that callers were told is gone.
     */
    const dropDecoded = (url: string): void => {
      decoding.delete(url)
      if (!decoded.has(url)) return
      epoch.set(url, (epoch.get(url) ?? 0) + 1)
      releaseFrame(url)
    }

    /**
     * A closed ImageBitmap still resolves but reports zero dimensions, and
     * drawing it throws. Treat that as a cache miss so the frame is fetched
     * again rather than painted as nothing.
     */
    const usableDecoded = (url: string): boolean => {
      const frame = decoded.get(url)
      if (frame === undefined) return false
      if (frame.width > 0 && frame.source.width > 0) return true
      decoded.delete(url)
      cachedCost -= frameCost.get(url) ?? 0
      frameCost.delete(url)
      decoding.delete(url)
      return false
    }

    /**
     * Move a URL to the young end of the LRU. Playback calls this as it paints,
     * so the frames being shown are always the last candidates for eviction.
     */
    const touchDecoded = (url: string): void => {
      const frame = decoded.get(url)
      if (frame === undefined) return
      decoded.delete(url)
      decoded.set(url, frame)
    }

    /**
     * Drop oldest bitmaps until the cache fits its budget. The frame currently
     * painted is never evicted outright — the canvas branch would have nothing
     * to draw if it were reclaimed — but it may be released during an over-budget
     * sweep; every other frame still inside the window playback needs (a few
     * frames behind plus the prefetch window) is kept. Protecting a whole track
     * instead would make an idle pet's own frames un-evictable and the budget
     * could never be honoured.
     */
    const overBudget = (): boolean => cachedCost > FRAME_CACHE_BUDGET

    const evictDecoded = (): void => {
      if (!overBudget()) {
        lowWater = 0
        return
      }
      const playing = config.tracks[track]
      const keepFrom = Math.max(0, frameIndex - 4)
      const keepTo = frameIndex + PREFETCH_AHEAD
      const pinned = lastDrawnUrl
      for (const url of [...decoded.keys()]) {
        if (!overBudget()) break
        if (url === pinned) continue
        if (playing !== undefined && playing.frames.includes(url)) {
          const at = playing.frames.indexOf(url)
          if (at >= keepFrom && at <= keepTo) continue
        }
        dropDecoded(url)
      }
      // Still over budget means everything left is protected by the current
      // position. Record how much we wanted to shed; once playback moves and a
      // fresh batch lands under that water mark, the pin protecting the frame
      // painted at the time is released instead of pinning one frame per track
      // forever (the "one more frame per animation" leak).
      if (overBudget()) {
        const wanted = cachedCost - FRAME_CACHE_BUDGET
        if (lowWater === 0 || wanted < lowWater) lowWater = wanted
      }
    }

    /** Spend the over-budget water mark by unpinning the painted frame. */
    const spendLowWater = (): void => {
      if (lowWater <= 0 || cachedCost > lowWater || lastDrawnUrl === undefined) return
      const url = lastDrawnUrl
      lowWater = 0
      dropDecoded(url)
    }

    const loadFrame = (url: string, jump = false): Promise<DecodedFrame | undefined> => {
      // Jump first: warm-enqueued frames already carry their memo, so a
      // playback demand must reorder the unstarted entry before the cache
      // lookup short-circuits.
      if (jump) {
        const index = frameQueue.findIndex((queued) => queued.url === url)
        if (index > 0) frameQueue.unshift(frameQueue.splice(index, 1)[0]!)
      }
      const cached = decoding.get(url)
      if (cached !== undefined) return cached
      // Snapshot the eviction generation: if the URL is dropped while this
      // decode is in flight, the resolution below must not re-adopt the frame.
      const bornAt = epoch.get(url) ?? 0
      let release!: () => void
      const gate = new Promise<void>((resolve) => { release = resolve })
      const job: Promise<DecodedFrame | undefined> = gate.then(() => (disposed ? undefined : decodeFrame(url)))
      job.then(
        (frame) => {
          if (frame === undefined) {
            decoding.delete(url)
            return
          }
          if ((epoch.get(url) ?? 0) !== bornAt || decoded.has(url)) return
          decoded.set(url, frame)
          frameCost.set(url, frame.width * frame.height * 4)
          cachedCost += frame.width * frame.height * 4
          evictDecoded()
          spendLowWater()
        },
        () => decoding.delete(url),
      )
      void job.finally(() => {
        activeFrames -= 1
        pumpFrames()
      })
      decoding.set(url, job)
      decodedAll.push(job.then(() => undefined, () => undefined))
      const entry = { url, release }
      if (jump) frameQueue.unshift(entry)
      else frameQueue.push(entry)
      pumpFrames()
      return job
    }

    const prefetchAhead = (trackId: string, index: number): void => {
      const def = config.tracks[trackId]
      if (def === undefined) return
      const end = Math.min(def.frames.length, index + 1 + PREFETCH_AHEAD)
      for (let ahead = index + 1; ahead < end; ahead += 1) {
        const url = def.frames[ahead]
        if (url !== undefined) void loadFrame(url)
      }
    }

    let disposed = false
    let timer: ReturnType<typeof setTimeout> | undefined
    let watchdog: ReturnType<typeof setInterval> | undefined
    let track: string = config.phases.idle
    let frameIndex = 0
    let lastAdvance = Date.now()
    let override: string | undefined
    // Skin base idle: every "back to idle" target resolves through this
    // (idle phase, unmapped phases and fallbacks), so a selected skin swaps
    // the pet's resting look without touching gameplay tracks.
    let baseIdle: string = config.phases.idle
    let drawToken = 0
    let lastDrawnUrl: string | undefined
    /**
     * How far over budget the last blocked sweep was. While playback sits on a
     * frame we cannot evict, this records the debt; the next batch of frames
     * that lands under it releases the pin.
     */
    let lowWater = 0

    const trackForPhase = (phase: ActivityPhase): string => {
      const mapped = config.phases[phase]
      if (mapped === undefined) return baseIdle
      const target = mapped === config.phases.idle ? baseIdle : mapped
      return config.tracks[target] !== undefined ? target : baseIdle
    }

    /** Canvas path: paints the newest requested frame; stale draws drop out. */
    const paintCanvas = (url: string): void => {
      if (context2d === null || canvas === null) return
      const myToken = ++drawToken
      void loadFrame(url, true).then((frame) => {
        if (disposed || frame === undefined || myToken !== drawToken) return
        // Resizing clears the canvas, so size only when it actually differs.
        if (canvas.width !== frame.width || canvas.height !== frame.height) {
          canvas.width = frame.width
          canvas.height = frame.height
        } else {
          context2d.clearRect(0, 0, canvas.width, canvas.height)
        }
        context2d.drawImage(frame.source as CanvasImageSource, 0, 0)
      }).catch(() => { /* keep last frame */ })
    }

    const show = (trackId: string, index: number): void => {
      const def = config.tracks[trackId]
      const url = def?.frames[index]
      if (url === undefined) return
      prefetchAhead(trackId, index)
      // Painting is a use: keep this frame at the young end of the LRU so
      // eviction never throws away what is on screen.
      touchDecoded(url)
      // ★ lastDrawnUrl must be set HERE, synchronously, not inside the canvas
      // draw callback. The callback only runs for the newest token, so any
      // frame superseded before it resolved never recorded itself, and the pin
      // that protects "what is on screen" from eviction silently pointed at a
      // stale frame instead.
      lastDrawnUrl = url
      if (img !== null) {
        if (img.getAttribute('src') !== url) img.src = url
        return
      }
      if (!usableDecoded(url) && decoding.get(url) === undefined) {
        // The cached bitmap was released; re-decode instead of painting nothing.
        void loadFrame(url, true)
      }
      paintCanvas(url)
    }

    /**
     * A finished non-loop track will not be played again until the user asks for
     * it, so its bitmaps are dead weight — release them right away. This is what
     * keeps a long session from accumulating one eaten dish after another.
     */
    const releaseTrack = (trackId: string): void => {
      const def = config.tracks[trackId]
      if (def === undefined) return
      for (const url of def.frames) {
        if (url === lastDrawnUrl) continue
        dropDecoded(url)
      }
    }

    const schedule = (ms: number): void => {
      if (disposed) return
      timer = setTimeout(tick, ms)
    }

    function tick(): void {
      if (disposed) return
      const def = config.tracks[track]
      if (def === undefined || def.frames.length === 0) return
      lastAdvance = Date.now()
      const next = frameIndex + 1
      if (next < def.frames.length) {
        frameIndex = next
        show(track, frameIndex)
        schedule(def.durations[frameIndex] ?? 200)
        return
      }
      if (def.loop) {
        frameIndex = 0
        show(track, frameIndex)
        schedule(def.durations[frameIndex] ?? 200)
        return
      }
      // Non-loop completion: settle into the fallback — an explicit fallback to
      // a real track wins, except when it points back at the manifest idle
      // (that resolves through the skin base idle); anything else lands on
      // the skin base idle. When the settle target is what the phase map
      // plays anyway, release the gameplay override.
      const finished = track
      const target = def.fallback !== undefined && config.tracks[def.fallback] !== undefined
        ? (def.fallback === config.phases.idle ? baseIdle : def.fallback)
        : baseIdle
      if (target === trackForPhase(ctx.phase.get())) override = undefined
      play(target)
      // ★ Release the finished one-shot's bitmaps. The track is over until the
      // user asks for it again, so holding one eaten dish after another is what
      // used to grow the cache without bound.
      releaseTrack(finished)
      return
    }

    function play(trackId: string): void {
      if (disposed) return
      if (config.tracks[trackId] === undefined) trackId = baseIdle
      if (timer !== undefined) clearTimeout(timer)
      track = trackId
      frameIndex = 0
      lastAdvance = Date.now()
      show(track, frameIndex)
      if (reducedMotion) return
      const def = config.tracks[track]!
      schedule(def.durations[0] ?? 200)
    }

    const unsubscribe = ctx.phase.subscribe((phase) => {
      if (override !== undefined) return
      const target = trackForPhase(phase)
      if (target !== track) play(target)
    })

    // Watchdog: a throttled-away timer (background tab) leaves the chain
    // dead; re-kick when a looping track has not advanced on schedule.
    if (!reducedMotion) {
      watchdog = setInterval(() => {
        if (disposed) return
        const def = config.tracks[track]
        if (def === undefined || !def.loop) return
        const expected = (def.durations[frameIndex] ?? 200) + WATCHDOG_MS
        if (Date.now() - lastAdvance > expected) tick()
      }, WATCHDOG_MS)
    }

    play(track)

    let disposedOnce = false
    const dispose = (): void => {
      if (disposedOnce) return
      disposedOnce = true
      disposed = true
      unsubscribe()
      if (timer !== undefined) clearTimeout(timer)
      if (watchdog !== undefined) clearInterval(watchdog)
      // Release decoded bitmaps after pending decodes settle; close() is
      // browser-only, so guard it for exotic hosts. Queued-but-unstarted
      // frames release immediately as no-ops so the settle barrier drains.
      for (const queued of frameQueue.splice(0)) queued.release()
      // Drop everything we already hold, then catch whatever is still in flight.
      for (const url of [...decoded.keys()]) releaseFrame(url)
      const inFlight = [...decoding.entries()]
      void Promise.allSettled(decodedAll).then(() => {
        for (const [url, job] of inFlight) {
          void job.then((frame) => {
            // Already evicted (or re-adopted then evicted): do not double-close.
            if (decoded.has(url)) return
            try {
              const maybeClose = (frame?.source as { close?: () => void } | undefined)?.close
              if (typeof maybeClose === 'function' && frame !== undefined) maybeClose.call(frame.source)
            } catch { /* already released */ }
          }).catch(() => { /* never rejects anyway */ })
        }
        decoding.clear()
        decoded.clear()
        frameCost.clear()
        cachedCost = 0
      })
      canvas?.remove()
      img?.remove()
    }
    ctx.onCleanup(dispose)

    return {
      dispose,
      setState(next: string | undefined): void {
        if (disposed) return
        if (next === undefined) {
          override = undefined
          const target = trackForPhase(ctx.phase.get())
          if (target !== track) play(target)
          return
        }
        if (config.tracks[next] === undefined) return
        override = next
        if (next !== track) play(next)
      },
      setIdleTrack(next: string | undefined): void {
        if (disposed) return
        if (next === undefined || (config.tracks[next] !== undefined && config.tracks[next]!.loop)) {
          baseIdle = next ?? config.phases.idle
        }
        // A skin only owns the resting look: re-resolve only when no
        // gameplay override is active (active overrides end into baseIdle).
        if (override === undefined) {
          const target = trackForPhase(ctx.phase.get())
          if (target !== track) play(target)
        }
      },
      currentTrack(): string {
        return track
      },
      /** Test/diagnostic hook: how many decoded frames the cache still holds. */
      cachedFrameCount(): number {
        return decoded.size
      },
      /** Test/diagnostic hook: decoded bytes currently retained. */
      cachedFrameBytes(): number {
        return cachedCost
      },
    }
  },
}
