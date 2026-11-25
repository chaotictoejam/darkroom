/** Dimmed overlay with a centred card — shared by the Welcome dialogs. */
import type { ReactNode } from 'react'

export default function ModalShell({ title, width = 380, onClose, children }: {
  title: string
  width?: number
  onClose: () => void
  children: ReactNode
}) {
  return (
    <div
      onClick={onClose}
      style={{
        position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.6)',
        display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 100,
      }}
    >
      <div
        role="dialog"
        aria-label={title}
        onClick={(e) => e.stopPropagation()}
        style={{
          background: 'var(--bg-card)', border: '1px solid var(--border)',
          borderRadius: 12, padding: '26px 28px',
          width: `min(${width}px, calc(100vw - 32px))`,
          display: 'flex', flexDirection: 'column', gap: 18,
        }}
      >
        <div style={{ fontWeight: 600, fontSize: 16 }}>{title}</div>
        {children}
      </div>
    </div>
  )
}
