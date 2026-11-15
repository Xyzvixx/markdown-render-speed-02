# markdown-render-speed-02

[![make.fun · markdown-render-speed-02](https://make.fun/badge/markdown-render-speed-02.svg)](https://make.fun/bounty/markdown-render-speed-02?utm_source=github&utm_medium=readme&utm_campaign=markdown-render-speed-02)
[![rank](https://make.fun/badge/markdown-render-speed-02/Xyzvixx/markdown-render-speed-02/rank.svg)](https://make.fun/bounty/markdown-render-speed-02/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=markdown-render-speed-02)
[![reward](https://make.fun/badge/markdown-render-speed-02/Xyzvixx/markdown-render-speed-02/reward.svg)](https://make.fun/bounty/markdown-render-speed-02?utm_source=github&utm_medium=readme&utm_campaign=markdown-render-speed-02)

A fast, dependency-free drop-in replacement for `marked.parse(markdown)`
(marked 18.1.3, default options: GFM on, breaks off, pedantic off, async off).
It produces byte-for-byte identical HTML to marked on the competition's
720 practice cases — and renders them roughly 1.5x faster.

## How it works

This is a restructured port of marked 18.1.3's algorithms (see `NOTICE.md`
for the fork credit and licence): the same block/inline grammars and helper
semantics, but emitting HTML directly while scanning instead of building a
token tree and walking it a second time. The configuration is hardcoded to
the competition defaults, so every pedantic / breaks / async / extension
branch is deleted. Fast paths skip the generic machinery for plain
paragraphs, simple headings, fenced code blocks and plain table rows when a
cheap scan proves the output is identical.

## Usage

```js
import { parse } from "./parse.js";
const html = parse("# Hello\n\nSome *markdown*.");
```

`parse.js` is a single ES module with zero imports. `parse(markdown)` is
pure: no state is shared between calls, nothing is cached, nothing is
written to disk, and it never reads the clock or the network.

## Harness

`main.ts` is the competition driver (Node 22, type-stripping). It reads
`/input/cases.json` (`[{id, markdown}]`), renders each case on its own with
`parse`, and writes `/output/html.json`. For local runs the directories can
be overridden with `MAKEFUN_INPUT_DIR` / `MAKEFUN_OUTPUT_DIR`:

```sh
MAKEFUN_INPUT_DIR=./input MAKEFUN_OUTPUT_DIR=./output node main.ts
```

## Credit & licence

Fork of [marked](https://github.com/markedjs/marked) 18.1.3 (MIT), credited
in `NOTICE.md`. This project is MIT licensed — see `LICENSE`.
