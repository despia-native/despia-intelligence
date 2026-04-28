// Types for the default export of despia-intelligence (Local Intelligence WebView bridge).

export type RuntimeStatus = 'ready' | 'outdated' | 'unavailable'

export type Runtime =
  | { ok: true;  status: 'ready';                         message: null          }
  | { ok: false; status: Exclude<RuntimeStatus, 'ready'>; message: string | null }

/** Not-ready branch matches CallHandle shape so `if (!call.ok)` / `call.cancel()` work the same. */
export type NotReady = Extract<Runtime, { ok: false }> & {
  intent:   null
  cancel(): void
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
  category: ModelCategory | string
}

/** Serialised to intelligence:// query; extend `type` when TYPES in index.js adds routes. */
export interface Params {
  type:        'text'
  model?:      string
  prompt?:     string
  system?:     string
  stream?:     boolean
  voice?:      string
  file?:       string[]
  filepicker?: string[]
  response?:   string[]
  [key: string]: unknown
}

export interface Handler {
  /** `chunk` is full accumulated text; replace UI, do not append. */
  stream?:   (chunk: string) => void
  complete?: (text: string) => void
  error?:    (err: { code: number; message: string }) => void
}

export interface CallHandle {
  ok:       true
  intent:   Params
  cancel(): void
}

type DownloadEvents = {
  downloadStart:    (modelId: string) => void
  downloadProgress: (modelId: string, percent: number) => void
  downloadEnd:      (modelId: string) => void
  downloadError:    (modelId: string, err: string) => void
}

declare const intelligence: {
  run(params: Params, handler?: Handler): CallHandle | NotReady
  runtime: Runtime
  models: {
    available(): Promise<Model[]>
    installed(): Promise<Model[] | NotReady>
    download(modelId: string, callbacks?: {
      onStart?:    () => void
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
