import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import ZoomControls from './ZoomControls'

function renderControls(props: Partial<Parameters<typeof ZoomControls>[0]> = {}) {
  const onZoom = vi.fn()
  render(<ZoomControls zoom={4} maxZoom={20} zoomPercent={100} labelTarget={1} onZoom={onZoom} {...props} />)
  return onZoom
}

describe('ZoomControls', () => {
  it('shows the zoom percentage', () => {
    renderControls({ zoomPercent: 37 })
    expect(screen.getByText('37%')).toBeTruthy()
  })

  it('zooms in and out by a step', () => {
    const onZoom = renderControls()
    fireEvent.click(screen.getByRole('button', { name: '+' }))
    expect(onZoom).toHaveBeenLastCalledWith(6)
    fireEvent.click(screen.getByRole('button', { name: '−' }))
    expect(onZoom).toHaveBeenLastCalledWith(4 / 1.5)
  })

  it('disables zoom out at fit and zoom in at the maximum', () => {
    renderControls({ zoom: 1 })
    expect(screen.getByTitle<HTMLButtonElement>('Zoom out').disabled).toBe(true)
    expect(screen.getByTitle<HTMLButtonElement>('Zoom in').disabled).toBe(false)
    expect(screen.getByTitle('Zoom out').style.opacity).toBe('0.35')
  })

  it('disables zoom in at the maximum', () => {
    renderControls({ zoom: 20 })
    expect(screen.getByTitle<HTMLButtonElement>('Zoom in').disabled).toBe(true)
  })

  it('jumps back to fit from the label when zoomed in', () => {
    const onZoom = renderControls({ labelTarget: 1 })
    fireEvent.click(screen.getByTitle('Click to fit the whole recording'))
    expect(onZoom).toHaveBeenCalledWith(1)
  })

  it('jumps to 100% from the label at fit', () => {
    const onZoom = renderControls({ zoom: 1, labelTarget: 4 })
    fireEvent.click(screen.getByTitle('Click to zoom to 100%'))
    expect(onZoom).toHaveBeenCalledWith(4)
  })

  it('leaves the label inert when the recording is already readable', () => {
    const onZoom = renderControls({ labelTarget: null })
    const label = screen.getByText('100%')
    expect(label.title).toBe('')
    fireEvent.click(label)
    expect(onZoom).not.toHaveBeenCalled()
  })

  it('keeps button presses from reaching the track', () => {
    const onTrackPointerDown = vi.fn()
    render(
      <div onPointerDown={onTrackPointerDown}>
        <ZoomControls zoom={4} maxZoom={20} zoomPercent={100} labelTarget={1} onZoom={() => {}} />
      </div>,
    )
    for (const button of screen.getAllByRole('button')) fireEvent.pointerDown(button)
    expect(onTrackPointerDown).not.toHaveBeenCalled()
  })
})
