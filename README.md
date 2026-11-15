# markdown-render-speed-02 — a faster drop-in for marked

[![make.fun · markdown-render-speed-02](https://make.fun/badge/markdown-render-speed-02.svg)](https://make.fun/bounty/markdown-render-speed-02?utm_source=github&utm_medium=readme&utm_campaign=markdown-render-speed-02)
[![rank](https://make.fun/badge/markdown-render-speed-02/Xyzvixx/markdown-render-speed-02/rank.svg)](https://make.fun/bounty/markdown-render-speed-02/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=markdown-render-speed-02)
[![reward](https://make.fun/badge/markdown-render-speed-02/Xyzvixx/markdown-render-speed-02/reward.svg)](https://make.fun/bounty/markdown-render-speed-02?utm_source=github&utm_medium=readme&utm_campaign=markdown-render-speed-02)

A dependency-free JavaScript module whose `parse(markdown)` returns exactly
the HTML that [marked](https://github.com/markedjs/marked) 18.1.3 returns with
its default options (GitHub Flavored Markdown on) — but faster. Built for the
[make.fun bounty](https://make.fun/bounty/markdown-render-speed-02) of the
same name.

## Files

- `parse.js` — the parser. Dependency-free ES module, no imports. Single
  file, no token tree: the block scanner builds light descriptors and the
  renderer emits HTML directly, with the emphasis / link / autolink rules of
  marked 18.1.3 reproduced exactly (including where marked departs from the
  CommonMark / GFM spec — marked wins).
- `main.ts` — the harness entrypoint. Run as `node /bot/main.ts` on Node 22;
  reads `/input/cases.json`, renders each case alone with `parse`, writes
  `/output/html.json`. (`MAKEFUN_INPUT_DIR` / `MAKEFUN_OUTPUT_DIR` override
  the directories outside a container.)
- `LICENSE` — MIT.

## How it is fast

- Block dispatch by leading whitespace and first character, so hopeless
  block scanners are never run; a bulk char-code path for list-item lines.
- Inline fast path: plain-text runs are emitted as one chunk, with the
  email / `www.` / scheme / `mailto:` / `xmpp:` starts the text regex would
  stop before computed exactly, so the regex loop only runs where a
  construct can start.
- Emphasis closers are scanned lazily and cached per inline run; the masked
  source (which hides delimiters inside links, code spans and tags) is only
  built when an opener can exist, and its masking passes skip regions that
  hold no delimiter.
- No caching across `parse` calls: `parse` is pure per call (a fresh state
  object every time), so results are deterministic and byte-identical
  across executions.

## Verification (practice set, drand round 33735412)

- Byte-for-byte identical HTML to marked 18.1.3 on all **720/720** practice
  cases (680 CommonMark 0.31.2 + GFM 0.29 spec examples, 40 generated
  READMEs), plus 6 further generated instances (4,320 cases) and 856
  pathological hand-built inputs (emphasis / link nesting, CRLF, tabs,
  deep lists and blockquotes) — all matching.
- Local timing (Node 24, this VM, median of 9 alternating runs): **~456 ms**
  vs marked's **~673 ms** — about **1.48×** faster. The heat measures CPU
  time in fresh 1-CPU containers; the ratio is what matters.
- Deterministic: two runs of `main.ts` on the practice set produce
  byte-identical `html.json`.

## Credit and licence

This is a re-structured port of marked 18.1.3's parsing algorithms (not a
copy of its source): the grammar regexes are marked's, because they define
the observable behaviour, and the surrounding code is re-expressed as a
direct-emit scanner. marked is MIT-licensed; see its
[LICENSE](https://github.com/markedjs/marked/blob/master/LICENSE.md). This
entry is MIT-licensed (see `LICENSE`).

## Run it

```sh
node main.ts            # reads /input/cases.json, writes /output/html.json
```

Or use the parser directly:

```js
import { parse } from './parse.js';
parse('# Hello\n\nSome *emphasised* text.');
// '<h1>Hello</h1>\n<p>Some <em>emphasised</em> text.</p>\n'
```
