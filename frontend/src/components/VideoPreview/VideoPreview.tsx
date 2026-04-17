/**
 * VideoPreview — plays a speaker's video file while respecting word-level cuts
 * and EDL segment cuts. On timeupdate it skips any cut regions and calls back
 * with the current time so the TranscriptEditor can highlight the active word.
 */
import { useEffect, useImperativeHandle, useRef, forwardRef } from 'react'
import type { EDLSegment, WordCut, WordMute } from '../../api/types'

export interface VideoPreviewHandle {
  /** Seek the video to a specific time (seconds). */
  seekTo: (time: number) => void
}

interface Props {
  /** URL served by the backend, e.g. /projects/{id}/files/cam_A_foo.mp4 */
  src: string
  wordCuts: WordCut[]
  /** EDL segments — segments with keep=false are also skipped. Pass [] if no EDL yet. */
  edlSegments: EDLSegment[]
  /** Called on every timeupdate with the current playback time in seconds. */
  onTimeUpdate?: (time: number) => void
  /** Ranges where audio should be silenced (video is kept). */
  wordMutes?: WordMute[]
  /** Called once the video metadata loads, with the total duration in seconds. */
  onDurationChange?: (duration: number) => void
  /** When true, renders an <audio> element instead of <video> (podcast mode). */
  isAudio?: boolean
}

/**
 * Build a flat sorted list of {start,end} ranges that should be skipped.
 * Merges word cuts and EDL cuts, then merges any overlapping intervals.
 */
function buildSkipRanges(wordCuts: WordCut[], edlSegments: EDLSegment[]): WordCut[] {
  const raw: WordCut[] = [
    ...wordCuts,
    ...edlSegments.filter((s) => !s.keep).map((s) => ({ start: s.start, end: s.end })),
  ]
  if (raw.length === 0) return []

  raw.sort((a, b) => a.start - b.start)

  const merged: WordCut[] = [raw[0]]
  for (let i = 1; i < raw.length; i++) {
    const last = merged[merged.length - 1]
    if (raw[i].start <= last.end + 0.05) {
      last.end = Math.max(last.end, raw[i].end)
    } else {
      merged.push({ ...raw[i] })
    }
  }
  return merged
}

const VideoPreview = forwardRef<VideoPreviewHandle, Props>(
  ({ src, wordCuts, edlSegments, wordMutes = [], onTimeUpdate, onDurationChange, isAudio = false }, ref) => {
    const mediaRef = useRef<HTMLVideoElement | HTMLAudioElement>(null)
    const skipRangesRef = useRef<WordCut[]>([])
    const muteRangesRef = useRef<WordMute[]>([])

    useEffect(() => {
      skipRangesRef.current = buildSkipRanges(wordCuts, edlSegments)
    }, [wordCuts, edlSegments])

    useEffect(() => {
      muteRangesRef.current = wordMutes
    }, [wordMutes])

    useImperativeHandle(ref, () => ({
      seekTo(time: number) {
        if (mediaRef.current) mediaRef.current.currentTime = time
      },
    }))

    function handleTimeUpdate() {
      const media = mediaRef.current
      if (!media) return
      const t = media.currentTime
      onTimeUpdate?.(t)

      // Skip into any cut region — jump to its end
      for (const cut of skipRangesRef.current) {
        if (t >= cut.start && t < cut.end) {
          media.currentTime = cut.end
          return
        }
      }

      // Mute audio in mute ranges
      const shouldMute = muteRangesRef.current.some((m) => t >= m.start && t < m.end)
      if (media.muted !== shouldMute) media.muted = shouldMute
    }

    function handleLoadedMetadata() {
      onDurationChange?.(mediaRef.current?.duration ?? 0)
    }

    if (isAudio) {
      return (
        <div style={{ width: '100%', padding: '16px 0' }}>
          <audio
            ref={mediaRef as React.RefObject<HTMLAudioElement>}
            src={src}
            controls
            onTimeUpdate={handleTimeUpdate}
            onLoadedMetadata={handleLoadedMetadata}
            style={{ width: '100%' }}
          />
        </div>
      )
    }

    return (
      <div style={{ position: 'relative', width: '100%', background: '#000', borderRadius: 8, overflow: 'hidden' }}>
        <video
          ref={mediaRef as React.RefObject<HTMLVideoElement>}
          src={src}
          controls
          onTimeUpdate={handleTimeUpdate}
          onLoadedMetadata={handleLoadedMetadata}
          style={{ width: '100%', display: 'block', maxHeight: '40vh' }}
        />
      </div>
    )
  },
)

VideoPreview.displayName = 'VideoPreview'
export default VideoPreview
