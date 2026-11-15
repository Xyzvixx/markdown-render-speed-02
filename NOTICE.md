This project is a restructured port (fork) of marked 18.1.3.

marked — Copyright (c) 2011-2026, Christopher Jeffrey and contributors.
Licensed under the MIT License. See the marked LICENSE bundled with the
upstream project at https://github.com/markedjs/marked (LICENSE file).

The port in parse.js re-implements marked's block/inline grammars and helper
semantics in a direct-emit form (HTML is produced while scanning, with no
intermediate token tree) and hardcodes the default configuration
(gfm: true, breaks: false, pedantic: false, async: false). It is not a copy
of marked's source files: the pipeline, data structures and control flow
were rewritten for this entry, while the output behaviour is kept
byte-for-byte identical to marked 18.1.3 with default options.
