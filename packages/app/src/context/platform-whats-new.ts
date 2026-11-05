// The notes of one desktop version, from its update metadata.
export type ReleaseNotes = {
  notes: string
  releaseDate?: string
  version: string
}

// Desktop only: the notes shown once after an update, kept by the updater so
// showing them needs no request of its own.
export type WhatsNewClient = {
  // The running version's notes, whether or not they were shown.
  current(): Promise<ReleaseNotes | null>
  dismiss(version: string): Promise<void>
  onAvailable(callback: (notes: ReleaseNotes) => void): () => void
  // The notes to show now, once, after an update.
  pending(): Promise<ReleaseNotes | null>
}
