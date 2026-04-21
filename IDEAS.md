# IDEAS

Internal parking lot for features that are spec'd but not yet shipped by the native runtime. Not published, not referenced from the public README. Move a section into `README.md` only after the native team confirms the route is live.

The package already passes `file` and `filepicker` through unchanged - these ideas are about **publishing** usage examples, not about any code changes in `index.js`.

---

## Multi-modal - attach files

Gated on: vision-capable text models shipping + native file ingestion pipeline for `file=` in the `text` route.

```js
intelligence.run({
  type:   'text',
  model:  'lfm2.5-vl-1.6b',
  prompt: 'Describe this image.',
  file:   ['/var/mobile/.../photo.jpg'],
}, {
  stream:   (chunk)  => el.textContent = chunk,
  complete: (result) => save(result),
})
```

### Multiple mixed sources

Gated on: native URL-fetch and `cdn:<index>` resolver.

```js
intelligence.run({
  type:   'text',
  model:  'lfm2.5-vl-1.6b',
  prompt: 'Compare these images.',
  file:   ['/var/mobile/.../a.jpg', 'https://cdn.example.com/b.jpg', 'cdn:my_index'],
}, {
  stream: (chunk) => el.textContent = chunk,
})
```

---

## Native file picker

Gated on: native `filepicker=` handler that opens the platform picker, collects user-selected files, and converts them into the equivalent of `file=` before firing inference.

```js
intelligence.run({
  type:       'text',
  model:      'lfm2.5-vl-1.6b',
  prompt:     'What is in this image?',
  filepicker: ['image/*', '.jpg', '.png'],
}, {
  complete: (result) => save(result),
})
```

---

## Stacking - text → speech per sentence

Gated on: `audio` type enabled in `TYPES` + a TTS model shipped by native.

The pattern works today for any combination of enabled types - fire one call from inside another's `stream` handler, nothing is blocking. Keep this example out of the public README until `audio` ships.

```js
let prev = ''

intelligence.run({
  type:   'text',
  model:  'lfm2.5-1.2b-instruct',
  prompt: 'Tell me three facts about TCP.',
  stream: true,
}, {
  stream: (chunk) => {
    el.textContent = chunk
    const sentence = extractNewSentence(prev, chunk)
    if (sentence) intelligence.run({
      type:     'audio',
      model:    'tts-model',
      prompt:   sentence,
      response: ['speak'],
    })
    prev = chunk
  },
  complete: (result) => save(result),
})
```

---

## Future model catalogue

Models to advertise in the README once the corresponding `type` flips to `"enabled": true` in `TYPES`.

- **Vision** (`type: 'vision'` or multi-modal `text`) - `lfm2.5-vl-1.6b`, `lfm2-vl-450m`, `qwen3.5-2b`, `qwen3.5-0.8b`, `gemma-4-e2b-it`, `gemma-3n-e2b-it`
- **Transcription** (`type: 'transcription'`) - `parakeet-tdt-0.6b-v3`, `parakeet-ctc-1.1b`, `parakeet-ctc-0.6b`, `whisper-medium`, `whisper-small`, `whisper-base`, `whisper-tiny`, `moonshine-base`
- **Embedding / VAD / Speaker** (`type: 'embed'` and friends) - `qwen3-embedding-0.6b`, `nomic-embed-text-v2-moe`, `silero-vad`, `segmentation-3.0`, `wespeaker-voxceleb-resnet34-lm`

All models ship as `int4` (smaller, faster) or `int8` (higher quality).

### Transcription model grid (draft for README when `transcription` ships)

| Model                   | Strengths                      | Good use cases                                              |
| ----------------------- | ------------------------------ | ----------------------------------------------------------- |
| `whisper-tiny`          | Fast, real-time                | Live captions, voice commands, push-to-talk                 |
| `moonshine-base`        | Fast, real-time                | Live captions, streaming dictation                          |
| `whisper-base`          | Balanced                       | General dictation, short voice notes                        |
| `whisper-small`         | Higher quality                 | Meetings, longer recordings                                 |
| `whisper-medium`        | High quality                   | Transcribing accented or noisy audio                        |
| `parakeet-ctc-0.6b`     | Streaming-friendly             | Live transcription with partial results                     |
| `parakeet-ctc-1.1b`     | Higher accuracy streaming      | Live transcription where accuracy matters                   |
| `parakeet-tdt-0.6b-v3`  | Highest accuracy               | Offline transcription, archival, closed captioning          |

---

## Shipping checklist - publishing an idea

- [ ] Native team confirms route/param is live on iOS and Android
- [ ] Spec the result shape (what `complete(result)` receives when files are involved)
- [ ] Move the section from `IDEAS.md` → `README.md`
- [ ] Bump minor version in `package.json`
- [ ] If a new `type` is involved, follow the "Shipping checklist - new type" in `MAINTENANCE.md`
