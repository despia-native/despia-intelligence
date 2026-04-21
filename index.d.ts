// despia-intelligence
// Wrapper around the Despia Local Intelligence WebView bridge.

export type RuntimeStatus = 'ready' | 'runtime_incompatible' | 'outdated' | 'unavailable'

export type Runtime =
  | { ok: true;  status: 'ready';                         message: null          }
  | { ok: false; status: Exclude<RuntimeStatus, 'ready'>; message: string | null }

// Returned by every API when intelligence.runtime.ok is false.
// Shape is compatible with CallHandle so the same destructure works:
//   const call = intelligence.run(params, handler)
//   if (!call.ok) { showBanner(call.message); return }
//   call.cancel() // safe on both branches
// cancel() on a NotReady is a no-op.
export type NotReady = Extract<Runtime, { ok: false }> & {
  intent:      null
  interrupted: false
  cancel():    void
}

export type ModelCategory =
  | 'text'
  | 'asr'
  | 'vision'
  | 'embedding'
  | 'vad'
  | 'speaker'

export type Model = {
  id:       string
  name:     string
  category: ModelCategory | string  // string fallback so new categories do not break types before an SDK bump
}

// Params - plain object serialised to a query string.
// type routes the call. Arrays become comma-separated. Strings are URL encoded.
// Any key passes through to the native route as-is.
// Update type union when new types are enabled in TYPES config.

export interface Params {
  type:        'text'            // extend when new types ship: 'text' | 'transcription' | ...
  model?:      string
  prompt?:     string
  system?:     string
  stream?:     boolean
  voice?:      string
  file?:       string[]          // paths / https:// URLs / cdn: indices → comma-separated
  filepicker?: string[]          // MIME types or extensions → comma-separated
  response?:   string[]          // output modes → comma-separated
  [key: string]: unknown         // any key the native route accepts
}

export interface Handler {
  stream?:      (chunk: string) => void          // accumulated text - replace, do not append
  complete?:    (text: string) => void           // full final response string
  error?:       (err: { code: number; message: string }) => void
  interrupted?: (intent: Params) => void         // notification hook for app-background. Fires for every active job on focusout. Resume is automatic and covers every concurrent job - use this for UI affordances (e.g. "Resuming..." toast) or analytics only.
}

export interface CallHandle {
  ok:          true
  intent:      Params
  interrupted: boolean
  cancel():    void
}

type DownloadEvents = {
  downloadStart:    (modelId: string) => void
  /** `percent` is a 0-100 integer. Same normalised value as the session `onProgress` callback. */
  downloadProgress: (modelId: string, percent: number) => void
  downloadEnd:      (modelId: string) => void
  downloadError:    (modelId: string, err: string) => void
}

declare const intelligence: {
  run(params: Params, handler?: Handler): CallHandle | NotReady
  runtime: Runtime
  models: {
    available(): Promise<Model[] | NotReady>
    installed(): Promise<Model[] | NotReady>
    download(modelId: string, callbacks?: {
      onStart?:    () => void
      /** Percentage complete as a 0-100 integer. Live only - not replayed on app reopen. */
      onProgress?: (percent: number) => void
      onEnd?:      () => void
      onError?:    (err: string) => void
    }): void | NotReady
    remove(modelId: string): Promise<void | NotReady>
    removeAll():             Promise<void | NotReady>
  }
  on<E extends keyof DownloadEvents>(event: E, fn: DownloadEvents[E]):   () => void
  off<E extends keyof DownloadEvents>(event: E, fn: DownloadEvents[E]):  void
  once<E extends keyof DownloadEvents>(event: E, fn: DownloadEvents[E]): void
}

export default intelligence
