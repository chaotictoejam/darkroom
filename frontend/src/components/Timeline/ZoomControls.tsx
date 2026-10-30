/** Timeline zoom: − / + buttons and the percentage label, which jumps between fit and 100%. */

const ZOOM_STEP = 1.5 // zoom factor per button press

function StepButton({ label, title, disabled, onClick }: { label: string; title: string; disabled: boolean; onClick: () => void }) {
  return (
    <button
      onPointerDown={(e) => e.stopPropagation()}
      onClick={onClick}
      disabled={disabled}
      title={title}
      style={{ background: 'none', border: 'none', color: 'var(--text)', fontSize: 16, lineHeight: 1, padding: '0 4px', cursor: disabled ? 'default' : 'pointer', opacity: disabled ? 0.35 : 1 }}
    >{label}</button>
  )
}

export default function ZoomControls({
  zoom,
  maxZoom,
  zoomPercent,
  labelTarget,
  onZoom,
}: {
  zoom: number
  maxZoom: number
  zoomPercent: number
  /** Zoom the label jumps to when clicked, or null when it does nothing. */
  labelTarget: number | null
  onZoom: (zoom: number) => void
}) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
      <StepButton label="−" title="Zoom out" disabled={zoom <= 1} onClick={() => onZoom(zoom / ZOOM_STEP)} />
      <span
        style={{ fontSize: 12, color: 'var(--text)', minWidth: 44, textAlign: 'center', cursor: labelTarget !== null ? 'pointer' : 'default' }}
        title={labelTarget === null ? undefined : labelTarget === 1 ? 'Click to fit the whole recording' : 'Click to zoom to 100%'}
        onClick={labelTarget !== null ? () => onZoom(labelTarget) : undefined}
      >
        {zoomPercent}%
      </span>
      <StepButton label="+" title="Zoom in" disabled={zoom >= maxZoom} onClick={() => onZoom(zoom * ZOOM_STEP)} />
    </div>
  )
}
