/**
 * Processing view — live progress via WebSocket while transcription/analysis/rendering runs.
 */
import { useEffect, useRef, useState } from 'react'
import { api, subscribeToProgress } from '../api/client'
import type { Project } from '../api/types'

interface Props {
  project: Project
  onComplete: (project: Project) => void
  onError: (project: Project) => void
}

const STEPS = ['upload', 'transcribe', 'analyze', 'ready'] as const
type Step = (typeof STEPS)[number]

function stepFromStatus(status: string): Step {
  if (status === 'transcribing') return 'transcribe'
  if (status === 'analyzing') return 'analyze'
  if (status === 'ready') return 'ready'
  return 'upload'
}

export default function Processing({ project, onComplete, onError }: Props) {
  const [progress, setProgress] = useState(project.progress)
  const [status, setStatus] = useState(project.status)
  const unsubRef = useRef<(() => void) | null>(null)

  useEffect(() => {
    // Subscribe to live WebSocket progress events
    unsubRef.current = subscribeToProgress(project.id, (evt) => {
      if (evt.type === 'ping') return
      if (evt.progress) setProgress(evt.progress)
      if (evt.status) {
        setStatus(evt.status as typeof status)
        if (evt.status === 'ready' || evt.status === 'transcribed') {
          api.getProject(project.id).then(onComplete)
        } else if (evt.status === 'error') {
          api.getProject(project.id).then(onError)
        }
      }
    })

    return () => unsubRef.current?.()
  }, [project.id])

  const activeStep = stepFromStatus(status)

  return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', minHeight: '100vh', gap: 24 }}>
      <div style={{ background: 'var(--bg-card)', borderRadius: 16, padding: 40, width: '100%', maxWidth: 480, textAlign: 'center' }}>
        <div style={{ fontSize: 36, marginBottom: 16 }}>⏳</div>
        <div style={{ fontWeight: 600, marginBottom: 8 }}>{progress.message || 'Working…'}</div>

        {/* Step pills */}
        <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', gap: 6, marginBottom: 24 }}>
          {STEPS.map((step, i) => {
            const activeIdx = STEPS.indexOf(activeStep)
            const isPast = i < activeIdx
            const isCurrent = step === activeStep
            return (
              <span key={step}>
                <span style={{
                  padding: '4px 12px', borderRadius: 20, fontSize: 12, fontWeight: 500,
                  background: isCurrent ? 'var(--accent)' : isPast ? 'var(--border)' : 'transparent',
                  color: isCurrent ? '#fff' : isPast ? 'var(--text-muted)' : 'var(--border)',
                  border: isCurrent ? 'none' : '1px solid var(--border)',
                  textTransform: 'capitalize',
                }}>
                  {step}
                </span>
                {i < STEPS.length - 1 && <span style={{ color: 'var(--border)', margin: '0 2px' }}>›</span>}
              </span>
            )
          })}
        </div>

        {/* Progress bar */}
        <div style={{ background: 'var(--border)', borderRadius: 4, height: 6, overflow: 'hidden' }}>
          <div style={{
            height: '100%', background: 'var(--accent)', borderRadius: 4,
            width: `${progress.percent}%`, transition: 'width 0.4s ease',
          }} />
        </div>

        {status === 'error' && (
          <pre style={{ marginTop: 16, color: '#f55', fontSize: 11, textAlign: 'left', maxHeight: 200, overflow: 'auto', background: '#111', padding: 12, borderRadius: 8 }}>
            {progress.message}
          </pre>
        )}
      </div>
    </div>
  )
}
