/**
 * Bridge to the Electron shell (desktop/preload.cjs). Undefined in a plain browser,
 * so every caller must treat the desktop features as optional.
 */
export interface DarkroomDesktop {
  isDesktop: true
  platform: string
  /** Prompts for OS-level microphone access where the OS requires it (macOS). */
  requestMicrophoneAccess: () => Promise<boolean>
}

declare global {
  interface Window {
    darkroom?: DarkroomDesktop
  }
}

export const desktop: DarkroomDesktop | undefined = window.darkroom
