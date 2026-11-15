// parse.js — fast drop-in replacement for marked 18.1.3 (default options: GFM on,
// breaks off, pedantic off, async off). `parse(markdown)` returns exactly the HTML
// marked.parse(markdown) returns for the same input.
//
// This is a fresh implementation of marked's algorithms, restructured for speed:
// it emits HTML directly while scanning instead of building a token tree and then
// walking it a second time. The grammar (regular expressions) is marked's GFM
// grammar, because that grammar *is* the observable behaviour; the surrounding
// code is written for this module. marked is MIT licensed; see README.md / NOTICE.
//
// Design notes:
// - One module-level immutable regex table; no per-call RegExp construction.
// - parse() is pure: all mutable state lives in a fresh per-call state object.
//   Nothing is cached across calls and nothing is written anywhere.
// - Line endings are normalised once at entry (\r\n and \r -> \n), as marked does.

// ---------------------------------------------------------------------------
// Small regex-composition helper (same idea as marked's `edit`): build a big
// regex out of named parts, dropping a leading `^` of an embedded part unless
// it follows `[` (so `^` inside a character class survives).
// ---------------------------------------------------------------------------
const CARET_RE = /(^|[^\[])\^/g;
function edit(re, flags = '') {
  let src = typeof re === 'string' ? re : re.source;
  const api = {
    replace(name, val) {
      let v = typeof val === 'string' ? val : val.source;
      v = v.replace(CARET_RE, '$1');
      src = src.replace(name, v);
      return api;
    },
    regex() { return new RegExp(src, flags); },
  };
  return api;
}

const supportsLookbehind = (() => {
  try { return !!new RegExp('(?<=1)(?<!1)'); } catch { return false; }
})();

// ---------------------------------------------------------------------------
// `other`: small shared patterns.
// ---------------------------------------------------------------------------
const O = {
  codeRemoveIndent: /^(?: {0,3}\t| {1,4})/gm,
  outputLinkReplace: /\\([\[\]])/g,
  indentCodeCompensation: /^(\s+)(?:```)/,
  beginningSpace: /^\s+/,
  endingHash: /#$/,
  startingSpaceChar: /^ /,
  endingSpaceChar: / $/,
  endingSpaceTabChar: /[ \t]$/,
  nonSpaceChar: /[^ ]/,
  newLineCharGlobal: /\n/g,
  tabCharGlobal: /\t/g,
  leadingSpaceTab: /^[ \t]+/,
  multipleSpaceGlobal: /\s+/g,
  blankLine: /^[ \t]*$/,
  doubleBlankLine: /\n[ \t]*\n[ \t]*$/,
  blockquoteStart: /^ {0,3}>/,
  blockquoteSetextReplace: /\n {0,3}((?:=+|-+)[ \t]*)(?=\n|$)/g,
  blockquoteSetextReplace2: /^ {0,3}>[ \t]?/gm,
  blockquoteMarkerWhitespace: /^( {0,3}>)([ \t]+)/gm,
  listReplaceNesting: /^ {1,4}(?=( {4})*[^ ])/g,
  listIsTask: /^\[[ xX]\][ \t]+\S/,
  listReplaceTask: /^\[[ xX]\][ \t]+/,
  listTaskCheckbox: /\[[ xX]\]/,
  anyLine: /\n.*\n/,
  hrefBrackets: /^<(.*)>$/,
  tableDelimiter: /[:|]/,
  tableAlignChars: /^\||\| *$/g,
  tableRowBlankLine: /\n[ \t]*$/,
  tableAlignRight: /^ *-+: *$/,
  tableAlignCenter: /^ *:-+: *$/,
  tableAlignLeft: /^ *:-+ *$/,
  startATag: /^<a /i,
  endATag: /^<\/a>/i,
  startPreScriptTag: /^<(pre|code|kbd|script)(\s|>)/i,
  endPreScriptTag: /^<\/(pre|code|kbd|script)(\s|>)/i,
  startAngleBracket: /^</,
  endAngleBracket: />$/,
  unicodeAlphaNumeric: /[\p{L}\p{N}]/u,
  numericCharacterReference: /&#(?:(\d{1,7})|[Xx]([A-Fa-f0-9]{1,6}));/,
  numericCharacterReferenceOrAmpersand: /&#(?:(\d{1,7})|[Xx]([A-Fa-f0-9]{1,6}));|&(?!(#\d{1,7}|#[Xx][a-fA-F0-9]{1,6}|\w+);)/g,
  escapeTest: /[&<>"']/,
  escapeReplace: /[&<>"']/g,
  escapeTestNoEncode: /[<>"']|&(?!(#\d{1,7}|#[Xx][a-fA-F0-9]{1,6}|\w+);)/,
  escapeReplaceNoEncode: /[<>"']|&(?!(#\d{1,7}|#[Xx][a-fA-F0-9]{1,6}|\w+);)/g,
  percentDecode: /%25/g,
  findPipe: /\|/g,
  splitPipe: / \|/,
  slashPipe: /\\\|/g,
  carriageReturn: /\r\n|\r/g,
  spaceLine: /^ +$/gm,
  notSpaceStart: /^\S*/,
  endingNewline: /\n$/,
  listItemRegex: (bull) => new RegExp(`^( {0,3}${bull})((?:[\t ][^\\n]*)?(?:\\n|$))`),
  nextBulletRegex: ((cache) => (indent) => {
    const k = Math.max(0, Math.min(3, indent - 1));
    return cache[k] || (cache[k] = new RegExp(`^ {0,${k}}(?:[*+-]|\\d{1,9}[.)])((?:[ \t][^\\n]*)?(?:\\n|$))`));
  })([]),
  hrRegex: ((cache) => (indent) => {
    const k = Math.max(0, Math.min(3, indent - 1));
    return cache[k] || (cache[k] = new RegExp(`^ {0,${k}}((?:-[ \t]*){3,}|(?:_[ \t]*){3,}|(?:\\*[ \t]*){3,})(?:\\n+|$)`));
  })([]),
  fencesBeginRegex: ((cache) => (indent) => {
    const k = Math.max(0, Math.min(3, indent - 1));
    return cache[k] || (cache[k] = new RegExp(`^ {0,${k}}(?:\`\`\`|~~~)`));
  })([]),
  headingBeginRegex: ((cache) => (indent) => {
    const k = Math.max(0, Math.min(3, indent - 1));
    return cache[k] || (cache[k] = new RegExp(`^ {0,${k}}#{1,6}(?:\\s|$)`));
  })([]),
  htmlBeginRegex: ((cache) => (indent) => {
    const k = Math.max(0, Math.min(3, indent - 1));
    return cache[k] || (cache[k] = new RegExp(`^ {0,${k}}(?:</?(?:${TAG})(?: +|$|/?>)|<(?:(?:script|pre|style|textarea)(?:[\\s>]|$)|!--)|<\\?|<![A-Za-z]|<!\\[CDATA\\[)`, 'i'));
  })([]),
  blockquoteBeginRegex: ((cache) => (indent) => {
    const k = Math.max(0, Math.min(3, indent - 1));
    return cache[k] || (cache[k] = new RegExp(`^ {0,${k}}>`));
  })([]),
};

// ---------------------------------------------------------------------------
// Grammar parts shared by block and inline rules.
// ---------------------------------------------------------------------------
const TAG = 'address|article|aside|base|basefont|blockquote|body|caption'
  + '|center|col|colgroup|dd|details|dialog|dir|div|dl|dt|fieldset|figcaption'
  + '|figure|footer|form|frame|frameset|h[1-6]|head|header|hr|html|iframe'
  + '|legend|li|link|main|menu|menuitem|meta|nav|noframes|ol|optgroup|option'
  + '|p|param|search|section|summary|table|tbody|td|tfoot|th|thead|title'
  + '|tr|track|ul';
const COMMENT = /<!--(?:-?>|[\s\S]*?(?:-->|$))/;
const BULLET = / {0,3}(?:[*+-]|\d{1,9}[.)])/;
const HR_RE_SRC = / {0,3}(?:(?:-[\t ]*){3,}|(?:_[ \t]*){3,}|(?:\*[ \t]*){3,})(?:\n+|$)/;
const HEADING_INT = ' {0,3}#{1,6}(?:\\s|$)';
const BLOCKQUOTE_INT = ' {0,3}>';
const FENCES_INT = ' {0,3}(?:`{3,}(?=[^`\\n]*(?:\\n|$))|~~~)[^\\n]*(?:\\n|$)';
const HTML_INT = ' {0,3}(?:</?(?:tag)(?: +|\\n|/?>)|<(?:(?:script|pre|style|textarea)(?:[\\s>]|$)|!--)|<\\?|<![A-Za-z]|<!\\[CDATA\\[)';

// ---------------------------------------------------------------------------
// Block grammar (GFM).
// ---------------------------------------------------------------------------
const B = {};
B.newline = /^(?:[ \t]*(?:\n|$))+/;
B.code = /^((?: {4}| {0,3}\t)[^\n]+(?:\n(?:[ \t]*(?:\n|$))*)?)+/;
B.fences = /^ {0,3}(`{3,}(?=[^`\n]*(?:\n|$))|~{3,})([^\n]*)(?:\n|$)(?:|([\s\S]*?)(?:\n|$))(?: {0,3}(?:(?=`)\1`*|(?=~)\1~*) *(?=\n|$)|$)/;
B.hr = /^ {0,3}((?:-[\t ]*){3,}|(?:_[ \t]*){3,}|(?:\*[ \t]*){3,})(?:\n+|$)/;
B.heading = /^ {0,3}(#{1,6})(?=\s|$)(.*)(?:\n+|$)/;
B.list = edit(/^(bull)([ \t][^\n]*?)?(?:\n|$)/).replace(/bull/g, BULLET).regex();
B.text = /^[^\n]+/;

const LHEADING_CORE = /^(?!bull |blockCode|fences|blockquote|heading|html|table)((?:.|\n(?!\s*?\n|bull |fences|blockquote|heading|hr|html|table))+?)\n {0,3}(=+|-+)[ \t]*(?:\n+|$)/;
B.lheading = edit(LHEADING_CORE)
  .replace(/bull/g, BULLET)
  .replace(/blockCode/g, /(?: {4}| {0,3}\t)/)
  .replace(/fences/g, / {0,3}(?:`{3,}|~{3,})/)
  .replace(/blockquote/g, / {0,3}>/)
  .replace(/heading/g, / {0,3}#{1,6}(?:\s|$)/)
  .replace(/hr/g, HR_RE_SRC)
  .replace(/html/g, / {0,3}<[^\n>]+>\n/)
  .replace(/table/g, / {0,3}\|?(?:[:\- ]*\|)+[\:\- ]*\n/)
  .regex();

const BLOCK_LABEL = /(?!\s*\])(?:\\[\s\S]|[^\[\]\\\n]|\n(?![ \t]*\n))+/;
B.def = edit(/^ {0,3}\[(label)\]: *(?:\n[ \t]*)?([^<\s][^\s]*|<.*?>)(?:(?: +(?:\n[ \t]*)?| *\n[ \t]*)(title))? *(?:\n+|$)/)
  .replace('label', BLOCK_LABEL)
  .replace('title', /(?:"(?:\\[\s\S]|[^"\\])*"|'(?:\\[\s\S]|[^'\\\n]|\n(?!\n))*'|\((?:\\[\s\S]|[^()\\])*\))/)
  .regex();

B.html = edit(
  '^ {0,3}(?:'
  + '<(script|pre|style|textarea)[\\s>][\\s\\S]*?(?:</\\1>[^\\n]*\\n*|$)'
  + '|comment[^\\n]*(\\n+|$)'
  + '|<\\?[\\s\\S]*?(?:\\?>[^\\n]*\\n*|$)'
  + '|<![A-Z][\\s\\S]*?(?:>[^\\n]*\\n*|$)'
  + '|<!\\[CDATA\\[[\\s\\S]*?(?:\\]\\]>[^\\n]*\\n*|$)'
  + '|</?(tag)(?:[ \\t]+|\\n|/?>|$)[\\s\\S]*?(?:(?:\\n[ \t]*)+\\n|$)'
  + '|<(?!(?:script|pre|style|textarea)(?![a-z0-9-]))([a-z][a-z0-9-]*)(?:attribute)*? */?>(?=[ \\t]*(?:\\n|$))[\\s\\S]*?(?:(?:\\n[ \t]*)+\\n|$)'
  + '|</[a-z][a-z0-9-]*\\s*>(?=[ \\t]*(?:\\n|$))[\\s\\S]*?(?:(?:\\n[ \t]*)+\\n|$))', 'i')
  .replace('comment', COMMENT)
  .replace('tag', TAG)
  .replace('attribute', / +[a-zA-Z:_][\w.:-]*(?: *= *"[^"\n]*"| *= *'[^'\n]*'| *= *[^\s"'=<>`]+)?/)
  .regex();

B.table = edit(
  '^ *([^\\n ].*)\\n'
  + ' {0,3}((?:\\| *)?:?-+:? *(?:\\| *:?-+:? *)*(?:\\| *)?)'
  + '(?:\\n((?:(?! *\\n|hr|heading|blockquote|code|fences|list|html).*(?:\\n|$))*)\\n*|$)')
  .replace('hr', HR_RE_SRC)
  .replace('heading', HEADING_INT)
  .replace('blockquote', BLOCKQUOTE_INT)
  .replace('code', '(?: {4}| {0,3}\t)[^\\n]')
  .replace('fences', FENCES_INT)
  .replace('list', ' {0,3}(?:[*+-]|1[.)])[ \\t]')
  .replace('html', HTML_INT)
  .replace('tag', TAG)
  .regex();

const PARA_CORE = /^([^\n]+(?:\n(?!hr|heading|lheading|blockquote|fences|list|html|table|[ \t]+\n)[^\n]+)*)/;
function makeParagraph(listInterrupt) {
  return edit(PARA_CORE)
    .replace('hr', HR_RE_SRC)
    .replace('heading', HEADING_INT)
    .replace('|lheading', '')
    .replace('table', B.table)
    .replace('blockquote', BLOCKQUOTE_INT)
    .replace('fences', FENCES_INT)
    .replace('list', listInterrupt)
    .replace('html', HTML_INT)
    .replace('tag', TAG)
    .regex();
}
B.paragraph = makeParagraph(/ {0,3}(?:[*+-]|1[.)])[ \t]+[^ \t\n]/);
B.blockquoteParagraph = makeParagraph(/ {0,3}(?:[*+-]|\d{1,9}[.)])(?:[ \t]|\n|$)/);
B.blockquote = edit(/^( {0,3}> ?(?:(?![ \t]*(?:\n|$))(paragraph)|[^\n]*)(?:\n|$))+/)
  .replace('paragraph', B.blockquoteParagraph)
  .regex();

// ---------------------------------------------------------------------------
// Inline grammar (GFM).
// ---------------------------------------------------------------------------
const PUNCT = /[\p{P}\p{S}]/u;
const PUNCT_SPACE = /[\s\p{P}\p{S}]/u;
const NOT_PUNCT_SPACE = /[^\s\p{P}\p{S}]/u;
const PUNCT_GFM = /(?!~)[\p{P}\p{S}]/u;
const PUNCT_SPACE_GFM = /(?!~)[\s\p{P}\p{S}]/u;
const NOT_PUNCT_SPACE_GFM = /(?:[^\s\p{P}\p{S}]|~)/u;

const I = {};
I.escape = /^\\([!"#$%&'()*+,\-./:;<=>?@\[\]\\^_`{|}~])/;
I.code = /^(`+)([^`]|[^`][\s\S]*?[^`])\1(?!`)/;
I.br = /^( {2,}|\\)\n(?!\s*$)[ \t]*/;
I.punctuation = edit(/^((?![*_])punctSpace)/, 'u').replace(/punctSpace/g, PUNCT_SPACE).regex();
I.anyPunctuation = edit(/\\(punct)/, 'gu').replace(/punct/g, PUNCT).regex();
I.anyPunctuationOutsideCode = edit(/(`+)(?:[^`]|[^`][\s\S]*?[^`])\1(?!`)|`+|\\(punct)/, 'gu')
  .replace(/punct/g, PUNCT).regex();

I.blockSkip = edit(/link|precode-code|html/, 'g')
  .replace('link', /\[(?:[^\[\]`]|(?<a>`+)[^`]+\k<a>(?!`))*?\]\((?:\\[\s\S]|[^\\\(\)]|\((?:\\[\s\S]|[^\\\(\)])*\))*\)/)
  .replace('precode-', supportsLookbehind ? '(?<!`)()' : '(^^|[^`])')
  .replace('code', /(?<b>`+)[^`]+\k<b>(?!`)/)
  .replace('html', /<(?! )[^<>]*?>/)
  .regex();

const EM_STRONG_L_CORE = /^(?:\*+(?:((?!\*)punct)|([^\s*]))?)|^_+(?:((?!_)punct)|([^\s_]))?/;
I.emStrongLDelim = edit(EM_STRONG_L_CORE, 'u').replace(/punct/g, PUNCT_GFM).regex();

const EM_STRONG_R_AST_CORE =
  '^[^_*]*?__[^_*]*?\\*[^_*]*?(?=__)'
  + '|[^*]+(?=[^*])'
  + '|(?!\\*)punct(\\*+)(?=[\\s]|$)'
  + '|notPunctSpace(\\*+)(?!\\*)(?=punctSpace|$)'
  + '|(?!\\*)punctSpace(\\*+)(?=notPunctSpace)'
  + '|[\\s](\\*+)(?!\\*)(?=punct)'
  + '|(?!\\*)punct(\\*+)(?!\\*)(?=punct)'
  + '|notPunctSpace(\\*+)(?=notPunctSpace)';
// The `^`-anchored first alternative of each R-delim regex can only match
// at the search start; when the search runs on the full masked source with
// lastIndex (instead of a slice), `^` would never match. These sticky
// twins reproduce it so the span it covers is skipped exactly once.
const EM_STRONG_R_AST_SKIP = /[^_*]*?__[^_*]*?\*[^_*]*?(?=__)/yu;
const EM_STRONG_R_UND_SKIP = /[^_*]*?\*\*[^_*]*?_[^_*]*?(?=\*\*)/yu;
const DEL_R_SKIP = /[^~]+(?=[^~])/yu;
I.emStrongRDelimAst = edit(EM_STRONG_R_AST_CORE, 'gu')
  .replace(/notPunctSpace/g, NOT_PUNCT_SPACE_GFM)
  .replace(/punctSpace/g, PUNCT_SPACE_GFM)
  .replace(/punct/g, PUNCT_GFM).regex();

I.emStrongRDelimUnd = edit(
  '^[^_*]*?\\*\\*[^_*]*?_[^_*]*?(?=\\*\\*)'
  + '|[^_]+(?=[^_])'
  + '|(?!_)punct(_+)(?=[\\s]|$)'
  + '|notPunctSpace(_+)(?!_)(?=punctSpace|$)'
  + '|(?!_)punctSpace(_+)(?=notPunctSpace)'
  + '|[\\s](_+)(?!_)(?=punct)'
  + '|(?!_)punct(_+)(?!_)(?=punct)', 'gu')
  .replace(/notPunctSpace/g, NOT_PUNCT_SPACE)
  .replace(/punctSpace/g, PUNCT_SPACE)
  .replace(/punct/g, PUNCT).regex();

I.delLDelim = edit(/^~~?(?:((?!~)punct)|[^\s~])/, 'u').replace(/punct/g, PUNCT).regex();
I.delRDelim = edit(
  '^[^~]+(?=[^~])'
  + '|(?!~)punct(~~?)(?=[\\s]|$)'
  + '|notPunctSpace(~~?)(?!~)(?=punctSpace|$)'
  + '|(?!~)punctSpace(~~?)(?=notPunctSpace)'
  + '|[\\s](~~?)(?!~)(?=punct)'
  + '|(?!~)punct(~~?)(?!~)(?=punct)'
  + '|notPunctSpace(~~?)(?=notPunctSpace)', 'gu')
  .replace(/notPunctSpace/g, NOT_PUNCT_SPACE)
  .replace(/punctSpace/g, PUNCT_SPACE)
  .replace(/punct/g, PUNCT).regex();

I.autolink = edit(/^<(scheme:[^\s\x00-\x1f<>]*|email)>/)
  .replace('scheme', /[a-zA-Z][a-zA-Z0-9+.-]{1,31}/)
  .replace('email', /[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+(@)[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)+(?![-_])/)
  .regex();
const INLINE_COMMENT = edit(COMMENT).replace('(?:-->|$)', '-->').regex();
I.tag = edit(
  '^comment'
  + '|^</[a-zA-Z][a-zA-Z0-9-]*\\s*>'
  + '|^<[a-zA-Z][a-zA-Z0-9-]*(?:attribute)*?\\s*/?>'
  + '|^<\\?[\\s\\S]*?\\?>'
  + '|^<![a-zA-Z]+\\s[\\s\\S]*?>'
  + '|^<!\\[CDATA\\[[\\s\\S]*?\\]\\]>')
  .replace('comment', INLINE_COMMENT)
  .replace('attribute', /\s+[a-zA-Z:_][\w.:-]*(?:\s*=\s*"[^"]*"|\s*=\s*'[^']*'|\s*=\s*[^\s"'=<>`]+)?/)
  .regex();

const INLINE_LABEL_BRACKETS = /\[(?:\\[\s\S]|[^\[\]\\])*\]/;
const INLINE_LABEL = edit(/(?:\[(?:brackets|\\[\s\S]|[^\[\]\\])*\]|\\[\s\S]|`+(?!`)[^`]*?`+(?!`)|``+(?=\])|[^\[\]\\`])*?/)
  .replace('brackets', INLINE_LABEL_BRACKETS)
  .regex();
I.link = edit(/^!?\[(label)\]\([ \t\n]*(href)(?:(?:[ \t]+(?:\n[ \t]*)?|\n[ \t]*)(title))?[ \t\n]*\)/)
  .replace('label', INLINE_LABEL)
  .replace('href', /<(?:\\.|[^\n<>\\])+>|[^ \t\n\x00-\x1f]+|(?=\))/)
  .replace('title', /"(?:\\[\s\S]|[^"\\])*"|'(?:\\[\s\S]|[^'\\])*'|\((?:\\[\s\S]|[^)\\])*\)/)
  .regex();
I.reflink = edit(/^!?\[(label)\]\[(ref)\]/)
  .replace('label', INLINE_LABEL)
  .replace('ref', BLOCK_LABEL)
  .regex();
I.nolink = edit(/^!?\[(ref)\](?:\[\])?/)
  .replace('ref', BLOCK_LABEL)
  .regex();
const BOUNDED_BLOCK_LABEL = /(?!\s*\])(?:\\[\s\S]|[^\[\]\\]){1,999}/;
const BOUNDED_INLINE_LABEL = edit(/(?:[^\[\]\\`]*(?:\[(?:brackets|\\[\s\S]|[^\[\]\\])*\]|\\[\s\S]|`+(?!`)[^`]*?`+(?!`)|``+(?=\]))){0,999}?[^\[\]\\`]*?/)
  .replace('brackets', INLINE_LABEL_BRACKETS)
  .regex();
I.reflinkSearch = edit('reflink|nolink(?!\\()', 'g')
  .replace('reflink', edit(/^!?\[(label)\]\[(ref)\]/)
    .replace('label', BOUNDED_INLINE_LABEL)
    .replace('ref', BOUNDED_BLOCK_LABEL)
    .regex())
  .replace('nolink', edit(/^!?\[(ref)\](?:\[\])?/)
    .replace('ref', BOUNDED_BLOCK_LABEL)
    .regex())
  .regex();

const CASE_INSENSITIVE_PROTOCOL = /[hH][tT][tT][pP][sS]?|[fF][tT][pP]/;
const EXTENDED_EMAIL = /[A-Za-z0-9._+-]+@[a-zA-Z0-9-_]+(?:\.[a-zA-Z0-9-_]*[a-zA-Z0-9])+(?![\w-])/;
const EXTENDED_EMAIL_PROTOCOL = edit(/(?:mailto:email|xmpp:email(?:\/[A-Za-z0-9@.]+)?)/)
  .replace(/email/g, EXTENDED_EMAIL)
  .regex();
I.url = edit(/^emailProtocol|^((?:protocol):\/\/|www\.)(?:[a-zA-Z0-9\-]+\.?)+[^\s<]*|^email/)
  .replace('emailProtocol', EXTENDED_EMAIL_PROTOCOL)
  .replace('protocol', CASE_INSENSITIVE_PROTOCOL)
  .replace('email', /[A-Za-z0-9._+-]+(@)[a-zA-Z0-9-_]+(?:\.[a-zA-Z0-9-_]*[a-zA-Z0-9])+(?![\w-])/)
  .regex();
I._backpedal = /(?:[^?!.,:;*_'"~()&]+|\([^)]*\)|&(?![a-zA-Z0-9]+;$)|[?!.,:;*_'"~)]+(?!$))+/;
I.del = /^(~~?)(?=[^\s~])((?:\\[\s\S]|[^\\])*?(?:\\[\s\S]|[^\s~\\]))\1(?=[^~]|$)/;
I.text = edit(/^(?:[^a-zA-Z0-9](?=emailProtocol)|(`+|~+|[^`~])(?:(?=[`~])|(?= {2,}\n)|(?=[a-zA-Z0-9.!#$%&'*+\/=?_`{\|}~-]+@)|[\s\S]*?(?:(?=[\\<!\[`*~_]|\b_|protocol:\/\/|wwwStart|$)|[^ ](?= {2,}\n)|[^a-zA-Z0-9](?=emailProtocol)|[^a-zA-Z0-9.!#$%&'*+\/=?_`{\|}~-](?=[a-zA-Z0-9.!#$%&'*+\/=?_`{\|}~-]+@))))/)
  .replace('protocol', CASE_INSENSITIVE_PROTOCOL)
  .replace(/emailProtocol/g, /(?:mailto|xmpp):/)
  .replace('wwwStart', supportsLookbehind ? '(?<![^\\s*_~(])www\\.' : 'www\\.')
  .regex();

// ---------------------------------------------------------------------------
// Helpers.
// ---------------------------------------------------------------------------
const ESCAPE_MAP = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
// Escape HTML entities. With encode=true every & < > " ' is escaped; without
// it, an & that can start a character/entity reference is left alone.
function escHtml(s, encode) {
  if (encode) {
    if (O.escapeTest.test(s)) return s.replace(O.escapeReplace, (ch) => ESCAPE_MAP[ch]);
  } else if (O.escapeTestNoEncode.test(s)) {
    return s.replace(O.escapeReplaceNoEncode, (ch) => ESCAPE_MAP[ch]);
  }
  return s;
}

// Numeric character references outside code stand for the character itself.
// A decoded character must not join its neighbours into a new reference, so
// every `&` that is not already one is escaped here.
function decodeNumRefs(text) {
  if (!O.numericCharacterReference.test(text)) return text;
  return text.replace(O.numericCharacterReferenceOrAmpersand, (ref, dec, hex) => {
    if (dec === undefined && hex === undefined) return '&amp;';
    const code = dec === undefined ? parseInt(hex, 16) : parseInt(dec, 10);
    if (code === 0 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) return '\uFFFD';
    return code === 38 ? '&amp;' : String.fromCodePoint(code);
  });
}

function cleanUrl(href) {
  try {
    href = encodeURI(href).replace(O.percentDecode, '%');
  } catch {
    return null;
  }
  return href;
}

// Split a table row into cells. A pipe only delimits when unescaped; leading /
// trailing empty cells (from outer pipes) are dropped; the result is padded or
// cut to `count` when given.
function splitCells(row, count) {
  const marked = row.replace(O.findPipe, (m, offset, str) => {
    let escaped = false;
    let curr = offset;
    while (--curr >= 0 && str[curr] === '\\') escaped = !escaped;
    return escaped ? '|' : ' |';
  });
  const cells = marked.split(O.splitPipe);
  if (!cells[0].trim()) cells.shift();
  if (cells.length > 0 && !cells[cells.length - 1]?.trim()) cells.pop();
  if (count) {
    if (cells.length > count) cells.splice(count);
    else while (cells.length < count) cells.push('');
  }
  for (let i = 0; i < cells.length; i++) cells[i] = cells[i].trim().replace(O.slashPipe, '|');
  return cells;
}

// Remove a trailing run of `c` (or, with invert, of non-`c` chars).
function rtrim(str, c, invert) {
  const l = str.length;
  if (l === 0) return '';
  let n = 0;
  while (n < l) {
    const ch = str.charAt(l - n - 1);
    if (ch === c && !invert) n++;
    else if (ch !== c && invert) n++;
    else break;
  }
  return str.slice(0, l - n);
}

function trimTrailingBlankLines(str) {
  const lines = str.split('\n');
  let end = lines.length - 1;
  while (end >= 0 && O.blankLine.test(lines[end])) end--;
  if (lines.length - end <= 2) return str;
  return lines.slice(0, end + 1).join('\n');
}

// Normalise a link label so definitions and references match: trim, collapse
// inner whitespace runs to one space, full Unicode case fold via lower->upper
// ->lower (so ẞ folds to SS the way CommonMark asks).
function normalizeLabel(label) {
  return label.trim().replace(O.multipleSpaceGlobal, ' ').toLowerCase().toUpperCase().toLowerCase();
}

// Index of the bracket that closes an unbalanced run, or -1 when balanced
// without one, -2 when more opens than closes remain.
function findClosingBracket(str, b) {
  if (str.indexOf(b[0]) === -1 && str.indexOf(b[1]) === -1) return -1;
  let level = 0;
  for (let i = 0; i < str.length; i++) {
    if (str[i] === '\\') i++;
    else if (str[i] === b[0]) level++;
    else if (str[i] === b[1]) {
      level--;
      if (level < 0) return i;
    }
  }
  return level > 0 ? -2 : -1;
}

function expandTabs(line, indent = 0) {
  let col = indent;
  let out = '';
  for (const ch of line) {
    if (ch === '\t') {
      const added = 4 - (col % 4);
      out += ' '.repeat(added);
      col += added;
    } else {
      out += ch;
      col++;
    }
  }
  return out;
}

// Fenced-code text: drop from each line at most the fence's own indentation.
function indentCodeCompensation(raw, text) {
  const m = raw.match(O.indentCodeCompensation);
  if (m === null) return text;
  const indent = m[1];
  return text.split('\n').map((node) => {
    const mm = node.match(O.beginningSpace);
    if (mm === null) return node;
    return node.slice(Math.min(mm[0].length, indent.length));
  }).join('\n');
}

// --- closer hints for one inline pass -------------------------------------
// Scan once for the last `*`/`_` run that can close emphasis/strong and the
// last `~` run that can close strikethrough. A run can close only when not
// preceded by ASCII whitespace or the start of the string.
function scanClosers(src) {
  const last = { '*': -1, '_': -1 };
  let del = -1;
  const len = src.length;
  for (let i = 0; i < len; i++) {
    const ch = src[i];
    if (ch !== '*' && ch !== '_' && ch !== '~') continue;
    const prev = i === 0 ? '\n' : src[i - 1];
    let j = i + 1;
    while (j < len && src[j] === ch) j++;
    if (prev !== ' ' && prev !== '\t' && prev !== '\n' && prev !== '\r' && prev !== '\f') {
      if (ch === '~') del = i;
      else last[ch] = i;
    }
    i = j - 1;
  }
  return { src, last, del };
}

// Per-parse state. `closerFrames` is a stack (inline runs nest: link labels,
// emphasis contents); the top frame belongs to the running pass.
function newState() {
  return {
    links: Object.create(null),
    hasLinks: false,
    inLink: false,
    inRawBlock: false,
    linkEmitted: false,
    linkParenPossible: true,
    top: true,
    closerFrames: [],
  };
}
function beginCloserScan(st, maskedSrc) {
  // Push a lazy frame: the scan only runs if an opener actually asks for a
  // closer (most inline runs never do), and its result is cached in-frame.
  st.closerFrames.push({ src: maskedSrc, last: null, del: -1, scanned: false });
}
function endCloserScan(st) {
  st.closerFrames.pop();
}
function lastEmCloser(st, maskedSrc, delim) {
  const f = st.closerFrames[st.closerFrames.length - 1];
  if (f && f.src === maskedSrc) {
    if (!f.scanned) {
      const r = scanClosers(maskedSrc);
      f.last = r.last; f.del = r.del; f.scanned = true;
    }
    return f.last[delim];
  }
  return scanClosers(maskedSrc).last[delim];
}
function lastDelCloser(st, maskedSrc) {
  const f = st.closerFrames[st.closerFrames.length - 1];
  if (f && f.src === maskedSrc) {
    if (!f.scanned) {
      const r = scanClosers(maskedSrc);
      f.last = r.last; f.del = r.del; f.scanned = true;
    }
    return f.del;
  }
  return scanClosers(maskedSrc).del;
}

function inlineHtml(src, st) {
  const prevLinkParenPossible = st.linkParenPossible;
  st.linkParenPossible = prevLinkParenPossible && src.includes(')');
  try {
    const maskedSrc = src.includes('*') || src.includes('_') || src.includes('~')
      ? (potentialOpener(src) ? maskSrc(src, st) : src)
      : src;
    beginCloserScan(st, maskedSrc);
    try {
      let keepPrevChar = false;
      let prevChar = '';
      let out = '';
      let rest = src;
      // Trigger positions, located once per run (absolute offsets into
      // `src`; `consumed` tracks how far `rest` has advanced).
      const trig = [src.indexOf('@'), src.indexOf('www.'), src.indexOf('://'), src.indexOf('mailto:'), src.indexOf('xmpp:')];
      let consumed = 0;
      while (rest) {
        if (!keepPrevChar) prevChar = '';
        keepPrevChar = false;

        // Fast path: a run of plain text up to the next character that can
        // start an inline construct. The text regex would stop at exactly
        // these characters (plus a hard-break space run), so emitting the
        // run as one text chunk is identical — unless a trigger the text
        // regex would stop before mid-run starts inside it (email / www /
        // protocol / mailto:), in which case fall through to the regex loop.
        const run = plainRunLen(rest);
        if (run > 0) {
          const pre = fastPathPrefix(rest, run, trig, consumed, st.inLink);
          if (pre !== 0) {
            const n = pre === -1 ? run : pre;
            const chunk = rest.slice(0, n);
            out += st.inRawBlock ? chunk
              : st.plainText ? decodeNumRefs(chunk) : escHtml(decodeNumRefs(chunk));
            prevChar = chunk[chunk.length - 1];
            keepPrevChar = true;
            rest = rest.slice(n);
            consumed += n;
            continue;
          }
        }

        // Dispatch on the first character: the try functions are anchored
        // to their own starting characters, so only the ones that can match
        // here need to run, in marked's order.
        const ch = rest.charCodeAt(0);
        let token = null;
        if (ch === 92) { // backslash
          token = tryEscape(rest, st) || tryBr(rest, st) || tryInlineText(rest, st);
        } else if (ch === 60) { // <
          token = tryTag(rest, st) || tryAutolink(rest, st) || tryInlineText(rest, st);
        } else if (ch === 91 || ch === 33) { // [ or ! (image)
          token = tryLink(rest, st) || tryReflink(rest, st) || tryInlineText(rest, st);
        } else if (ch === 42 || ch === 95) { // * or _
          token = tryEmStrong(rest, maskedSrc, prevChar, st) || tryInlineText(rest, st);
        } else if (ch === 96) { // backtick
          token = tryCodespan(rest, st) || tryInlineText(rest, st);
        } else if (ch === 126) { // ~
          token = tryDel(rest, maskedSrc, prevChar, st) || tryInlineText(rest, st);
        } else if (ch === 10 || ch === 32) { // newline or space (hard break)
          token = tryBr(rest, st) || tryInlineText(rest, st);
        } else {
          token = (!st.inLink && tryUrl(rest, st)) || tryInlineText(rest, st);
        }

        if (token) {
          out += token.h;
          rest = rest.slice(token.n);
          consumed += token.n;
          if (token.raw !== undefined) {
            if (!token.raw.endsWith('_')) {
              prevChar = token.raw[token.raw.length - 1] || '';
            }
            keepPrevChar = true;
          }
          continue;
        }

        throw new Error('Infinite loop on byte: ' + rest.charCodeAt(0));
      }
      return out;
    } finally {
      endCloserScan(st);
    }
  } finally {
    st.linkParenPossible = prevLinkParenPossible;
  }
}

// Length of the leading plain-text run in `s`: stops before any character
// that can start an inline construct (`\ < ! [ ` * ~ _`) and before a run of
// two or more spaces followed by a newline (a hard break). Returns 0 when
// `s` starts with such a character.
function plainRunLen(s) {
  const n = s.length;
  let i = 0;
  while (i < n) {
    const c = s.charCodeAt(i);
    if (c === 92 || c === 60 || c === 33 || c === 91 || c === 96
      || c === 42 || c === 126 || c === 95) return i;
    if (c === 32) {
      let j = i + 1;
      while (j < n && s.charCodeAt(j) === 32) j++;
      if (j - i >= 2 && j < n && s.charCodeAt(j) === 10) return i;
      i = j;
      continue;
    }
    i++;
  }
  return n;
}

// Is `c` (a char code) in the email local-part class the GFM text regex
// looks ahead for ([A-Za-z0-9.!#$%&'*+/=?^_`{|}~-])?
function isEmailLocalChar(c) {
  return (c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122)
    || c === 33 || c === 35 || c === 36 || c === 37 || c === 38 || c === 39
    || c === 42 || c === 43 || c === 45 || c === 46 || c === 47 || c === 61
    || c === 63 || c === 94 || c === 95 || c === 96 || c === 123 || c === 124
    || c === 125 || c === 126;
}

function isAlnumCode(c) {
  return (c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122);
}

// May the leading `run` characters of `rest` be emitted as one plain-text
// chunk? False when a construct the text regex would stop before starts
// strictly inside the chunk: an email local-part run reaching an '@', a
// 'www.' / protocol '://' / 'mailto:' / 'xmpp:' start (including ones that
// straddle the chunk end). The regex loop handles those cases exactly.
// Length of the plain prefix of the leading `run` characters of `rest`
// that may be emitted as one text chunk: -1 means the whole run, 0 means
// fall through to the try-chain (a construct starts at the run start).
// The text regex stops before exactly these constructs inside a plain run:
// an email local-part run reaching an '@', a 'www.' start, an
// http/https/ftp scheme start, a 'mailto:'/'xmpp:' start (all including
// ones that straddle the run end). Emitting up to — but not past — the
// earliest such construct start is identical to what the regex loop
// produces, because the constructs themselves are then handled by the
// try-chain. Inside a link label (`inLink`) the url token is disabled, so
// those constructs are plain text and the whole run is safe.
// `trig` holds each trigger's ABSOLUTE position in the inline run (-1
// absent); `consumed` is how far `rest` has advanced.
const TRIG_NEEDLES = ['@', 'www.', '://', 'mailto:', 'xmpp:'];
function fastPathPrefix(rest, run, trig, consumed, inLink) {
  if (inLink) return -1;
  let best = -1;
  // Email: resolve the first '@' (re-locating it once consumed), then walk
  // back over the local-part run. The walk uses the text regex's own wide
  // local-part class, so the start it finds is at or before the start the
  // url token would match from — emitting up to it is always safe.
  let p = trig[0];
  if (p !== -1) {
    p -= consumed;
    if (p < 0) {
      const q = rest.indexOf('@');
      trig[0] = q === -1 ? -1 : consumed + q;
      p = q;
    }
    if (p !== -1) {
      let s = p - 1;
      while (s >= 0 && isEmailLocalChar(rest.charCodeAt(s))) s--;
      if (s + 1 < run) best = s + 1;
    }
  }
  if (best === 0) return 0;
  for (let i = 1; i < 5; i++) {
    let from = trig[i];
    if (from !== -1) {
      from -= consumed;
      if (from < 0) {
        const q = rest.indexOf(TRIG_NEEDLES[i]);
        trig[i] = q === -1 ? -1 : consumed + q;
        from = q;
      }
    }
    while (from !== -1 && from < run) {
      const cand = triggerStart(rest, from, i);
      if (cand !== -1) {
        if (best === -1 || cand < best) best = cand;
        break;
      }
      from = rest.indexOf(TRIG_NEEDLES[i], from + 1);
    }
    if (best === 0) return 0;
  }
  return best;
}
// Start of the construct whose trigger sits at `pos` in `rest`, or -1 when
// the trigger at `pos` is not a construct start (a later occurrence may be).
// i: 1 = 'www.', 2 = '://', 3 = 'mailto:', 4 = 'xmpp:'.
function triggerStart(rest, pos, i) {
  if (i === 1) {
    // The text regex only stops before 'www.' at the start of the text or
    // after whitespace, '*', '_', '~', '(' or '['.
    if (pos === 0) return 0;
    const c = rest.charCodeAt(pos - 1);
    if (c === 32 || c === 9 || c === 10 || c === 11 || c === 12 || c === 13
      || c === 42 || c === 95 || c === 126 || c === 40 || c === 91
      || c === 160 || c === 0x1680 || (c >= 0x2000 && c <= 0x200a)
      || c === 0x2028 || c === 0x2029 || c === 0x202f || c === 0x205f
      || c === 0x3000 || c === 0xfeff) return pos;
    return -1;
  }
  if (i === 2) {
    // Only http/https/ftp stop the text regex; the construct starts at the
    // scheme, i.e. 3-5 characters before '://' (case-insensitive).
    if (pos >= 5
      && (rest.charCodeAt(pos - 5) | 32) === 104 && (rest.charCodeAt(pos - 4) | 32) === 116
      && (rest.charCodeAt(pos - 3) | 32) === 116 && (rest.charCodeAt(pos - 2) | 32) === 112
      && (rest.charCodeAt(pos - 1) | 32) === 115) return pos - 5;
    if (pos >= 4
      && (rest.charCodeAt(pos - 4) | 32) === 104 && (rest.charCodeAt(pos - 3) | 32) === 116
      && (rest.charCodeAt(pos - 2) | 32) === 116 && (rest.charCodeAt(pos - 1) | 32) === 112) return pos - 4;
    if (pos >= 3
      && (rest.charCodeAt(pos - 3) | 32) === 102 && (rest.charCodeAt(pos - 2) | 32) === 116
      && (rest.charCodeAt(pos - 1) | 32) === 112) return pos - 3;
    return -1;
  }
  // mailto: / xmpp:: the text regex stops before them only when the
  // preceding character is not alphanumeric (or at the start of the text).
  if (pos === 0) return 0;
  const c = rest.charCodeAt(pos - 1);
  if ((c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122)) return -1;
  return pos;
}

// Could an emphasis / strikethrough opener start anywhere in `src`?
// An opener is a run of `*`, `_` or `~` followed by a non-whitespace
// character. Without one, emStrong/del can never match, so the masked
// source (and its three regex passes) is never read.
function potentialOpener(src) {
  const n = src.length;
  for (let i = 0; i < n; i++) {
    const c = src.charCodeAt(i);
    if (c !== 42 && c !== 95 && c !== 126) continue;
    let j = i + 1;
    while (j < n && src.charCodeAt(j) === c) j++;
    if (j < n) {
      const d = src.charCodeAt(j);
      if (d !== 32 && d !== 9 && d !== 10 && d !== 13 && d !== 12) return true;
    }
    i = j - 1;
  }
  return false;
}

function inlineTextOnly(src, st) {
  const plainText = st.plainText;
  st.plainText = true;
  try {
    return inlineHtml(src, st);
  } finally {
    st.plainText = plainText;
  }
}

function maskSrc(src, st) {
  let maskedSrc = src;
  // Reflink masking can only change something when a definition exists.
  if (st.hasLinks && src.includes('[')) {
    const maskReflink = (match0) => {
      const refStart = match0.lastIndexOf('[');
      if (!Object.hasOwn(st.links, normalizeLabel(match0.slice(refStart + 1, -1)))) {
        return match0;
      }
      if (refStart > 1 && match0.charAt(0) !== '!') {
        const text = match0.slice(1, refStart - 1);
        if (linkInText(text, st)) {
          return '[' + text.replace(I.reflinkSearch, maskReflink) + ']['
            + 'a'.repeat(match0.length - refStart - 2) + ']';
        }
      }
      return '[' + 'a'.repeat(match0.length - 2) + ']';
    };
    maskedSrc = maskedSrc.replace(I.reflinkSearch, maskReflink);
  }
  // The punctuation mask only matches backtick runs or backslash escapes;
  // the block mask only matches links, code spans or tags. Skip a pass
  // entirely when its trigger characters are absent.
  if (maskedSrc.indexOf('\\') !== -1 || maskedSrc.indexOf('`') !== -1) {
    maskedSrc = maskedSrc.replace(I.anyPunctuationOutsideCode, (match0, code, punct) => {
      if (punct) return '+'.repeat(match0.length);
      if (code) {
        // Only code spans whose interior holds a backtick need rewriting;
        // otherwise the masked text is identical to the original.
        const innerEnd = match0.length - code.length;
        const bi = match0.indexOf('`', code.length);
        if (bi !== -1 && bi < innerEnd) {
          return code + match0.slice(code.length, -code.length).replace(/`/g, '+') + code;
        }
      }
      return match0;
    });
  }
  if (maskedSrc.indexOf('[') !== -1 || maskedSrc.indexOf('`') !== -1 || maskedSrc.indexOf('<') !== -1) {
    maskedSrc = maskedSrc.replace(I.blockSkip, (match0, _link, context) => {
      // The mask only hides delimiters inside links, code spans and tags.
      // A region holding no '*', '_' or '~' masks to itself, so the
      // emphasis machinery reads exactly the same characters.
      if (match0.indexOf('*') === -1 && match0.indexOf('_') === -1 && match0.indexOf('~') === -1) {
        return match0;
      }
      const offset = context ? context.length : 0;
      return match0.slice(0, offset) + '[' + 'a'.repeat(match0.length - offset - 2) + ']';
    });
  }
  return maskedSrc;
}

function linkInText(text, st) {
  if (!text.includes('[')) return false;
  for (const match of text.matchAll(I.blockSkip)) {
    if (I.link.test(match[0]) && text.charAt(match.index - 1) !== '!') return true;
  }
  for (const match of text.matchAll(I.reflinkSearch)) {
    const match0 = match[0];
    const refStart = match0.lastIndexOf('[');
    if (match0.charAt(0) === '!'
      || !Object.hasOwn(st.links, normalizeLabel(match0.slice(refStart + 1, -1)))) {
      continue;
    }
    if (refStart > 1 && linkInText(match0.slice(1, refStart - 1), st)) continue;
    return true;
  }
  return false;
}

function tryEscape(rest, st) {
  const cap = I.escape.exec(rest);
  if (!cap) return null;
  return { h: escHtml(cap[1]), n: cap[0].length };
}

function tryTag(rest, st) {
  const cap = I.tag.exec(rest);
  if (!cap) return null;
  if (!st.inLink && O.startATag.test(cap[0])) st.inLink = true;
  else if (st.inLink && O.endATag.test(cap[0])) st.inLink = false;
  if (!st.inRawBlock && O.startPreScriptTag.test(cap[0])) st.inRawBlock = true;
  else if (st.inRawBlock && O.endPreScriptTag.test(cap[0])) st.inRawBlock = false;
  return { h: cap[0], n: cap[0].length };
}

function labelEndInsideToken(src, label, labelStart) {
  if (!label.includes('<')) return false;
  for (let i = 0; i < label.length; i++) {
    if (label[i] === '\\') {
      i++;
      continue;
    }
    if (label[i] === '`') {
      const code = I.code.exec(label.slice(i));
      if (code) {
        i += code[0].length - 1;
        continue;
      }
    }
    if (label[i] !== '<') continue;
    const tok = I.tag.exec(src.slice(labelStart + i))
      || I.autolink.exec(src.slice(labelStart + i));
    if (!tok) continue;
    if (tok[0].length > label.length - i) return true;
    i += tok[0].length - 1;
  }
  return false;
}

function outputLinkHtml(cap, href, title, st) {
  const text = cap[1].replace(/\\([\[\]])/g, '$1');
  const isImage = cap[0].charAt(0) === '!';
  const outerInLink = st.inLink;
  const outerLinkEmitted = st.linkEmitted;
  const outerInRawBlock = st.inRawBlock;

  st.inLink = true;
  st.linkEmitted = false;
  const labelHtml = inlineHtml(text, st);
  const textHasLink = st.linkEmitted;
  st.linkEmitted = outerLinkEmitted;
  st.inLink = outerInLink;

  if (!isImage && textHasLink) {
    st.inRawBlock = outerInRawBlock;
    return null;
  }
  if (!isImage) st.linkEmitted = true;

  if (isImage) {
    const alt = inlineTextOnly(text, st);
    const clean = cleanUrl(href);
    if (st.plainText) return { h: alt, n: cap[0].length };
    if (clean === null) return { h: escHtml(alt), n: cap[0].length };
    let out = '<img src="' + escHtml(clean) + '" alt="' + escHtml(alt) + '"';
    if (title) out += ' title="' + escHtml(title) + '"';
    out += '>';
    return { h: out, n: cap[0].length };
  }

  if (st.plainText) return { h: labelHtml, n: cap[0].length };
  const clean = cleanUrl(href);
  if (clean === null) return { h: labelHtml, n: cap[0].length };
  let out = '<a href="' + escHtml(clean, false) + '"';
  if (title) out += ' title="' + escHtml(title, false) + '"';
  out += '>' + labelHtml + '</a>';
  return { h: out, n: cap[0].length };
}

function tryLink(rest, st) {
  if (st.linkParenPossible === false) return null;
  const cap = I.link.exec(rest);
  if (!cap) return null;
  const labelStart = cap[0].charAt(0) === '!' ? 2 : 1;
  if (labelEndInsideToken(rest, cap[1], labelStart)) return null;

  const trimmedUrl = cap[2].trim();
  if (O.startAngleBracket.test(trimmedUrl)) {
    if (!O.endAngleBracket.test(trimmedUrl)) return null;
    const r = rtrim(trimmedUrl.slice(0, -1), '\\');
    if ((trimmedUrl.length - r.length) % 2 === 0) return null;
  } else {
    const lastParen = findClosingBracket(cap[2], '()');
    if (lastParen === -2) return null;
    if (lastParen > -1) {
      const start = cap[0].indexOf('!') === 0 ? 5 : 4;
      const linkLen = start + cap[1].length + lastParen;
      cap[2] = cap[2].substring(0, lastParen);
      cap[0] = cap[0].substring(0, linkLen).trim();
      cap[3] = '';
    }
  }
  // The ')' that ends the match is the link closer only when it is not
  // escaped. `[foo](/url\)` has no closer; that paren is destination text.
  const unesc = rtrim(cap[0].slice(0, -1), '\\');
  if ((cap[0].length - unesc.length) % 2 === 0) return null;

  let href = cap[2].trim();
  const title = cap[3] ? cap[3].slice(1, -1) : '';
  if (O.startAngleBracket.test(href)) href = href.slice(1, -1);
  const href2 = href ? href.replace(I.anyPunctuation, '$1') : href;
  const title2 = title ? title.replace(I.anyPunctuation, '$1') : title;
  return outputLinkHtml(cap, href2, title2, st);
}

function tryReflink(rest, st) {
  const cap = I.reflink.exec(rest) || I.nolink.exec(rest);
  if (!cap) return null;
  const labelStart = cap[0].charAt(0) === '!' ? 2 : 1;
  if (labelEndInsideToken(rest, cap[1], labelStart)) return null;
  const link = st.links[normalizeLabel(cap[2] || cap[1])];
  if (!link) {
    const ch = cap[0].charAt(0);
    return { h: st.plainText ? ch : escHtml(ch), n: 1 };
  }
  return outputLinkHtml(cap, link.href, link.title, st);
}

// Code-point length of `s` without allocating an array for the common
// all-BMP case (delimiter runs are ASCII in practice).
const HAS_SURROGATE = /[\uD800-\uDBFF]/;
function cpLen(s) {
  return HAS_SURROGATE.test(s) ? [...s].length : s.length;
}
// Code-unit length of the first code point of `s` (2 for an astral char).
function firstCpLen(s) {
  const c = s.charCodeAt(0);
  return c >= 0xD800 && c <= 0xDBFF ? 2 : 1;
}

// Is `ch` (a single code point, possibly two code units) alphanumeric in
// the Unicode sense? ASCII is decided by code, the rest by the regex.
function isAlphaNumericChar(ch) {
  if (!ch) return false;
  const c = ch.charCodeAt(0);
  if (c < 128) {
    return (c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122);
  }
  return !!O.unicodeAlphaNumeric.test(ch);
}

function tryEmStrong(src, maskedSrc, prevChar, st) {
  let match = I.emStrongLDelim.exec(src);
  if (!match || (!match[1] && !match[2] && !match[3] && !match[4])) return null;

  const delimChar = match[0][0];
  const midRun = prevChar === delimChar;
  const srcStart = maskedSrc.length - src.length;
  let runStart = srcStart;
  while (runStart > 0 && maskedSrc[runStart - 1] === delimChar) runStart--;
  // The last code point before the run (an astral character is two code
  // units); the exact loop spread a slice into an array for the same thing.
  let runPrevChar = '';
  if (runStart > 0) {
    const c1 = maskedSrc.charCodeAt(runStart - 1);
    if (c1 >= 0xDC00 && c1 <= 0xDFFF && runStart >= 2
      && maskedSrc.charCodeAt(runStart - 2) >= 0xD800
      && maskedSrc.charCodeAt(runStart - 2) <= 0xDBFF) {
      runPrevChar = maskedSrc.slice(runStart - 2, runStart);
    } else {
      runPrevChar = maskedSrc[runStart - 1];
    }
  }
  const runPrevPunct = runPrevChar === '*' || runPrevChar === '_'
    || !!I.punctuation.exec(runPrevChar);
  if (runStart < srcStart) prevChar = runPrevChar;
  const prevPunct = runStart < srcStart
    ? runPrevPunct
    : !!I.punctuation.exec(prevChar);

  if (match[4] && isAlphaNumericChar(prevChar)) return null;
  const nextChar = match[1] || match[3] || '';
  if (!nextChar || !prevChar || prevPunct) {
    const lLength = cpLen(match[0]) - 1;
    let delimTotal = lLength;
    let midDelimTotal = 0;
    const runLength = srcStart - runStart + lLength;
    const openerCanClose = !!runPrevChar.trim()
      && (!nextChar || (delimChar === '*' && !runPrevPunct));
    if (delimChar !== '*' && delimChar !== '_') return null;

    const endReg = delimChar === '*' ? I.emStrongRDelimAst : I.emStrongRDelimUnd;
    const lastPossible = lastEmCloser(st, maskedSrc, delimChar);
    const windowStart = maskedSrc.length - src.length + lLength;
    if (lastPossible < windowStart) return null;

    const searchSrc = maskedSrc;
    const skipReg = delimChar === '*' ? EM_STRONG_R_AST_SKIP : EM_STRONG_R_UND_SKIP;
    skipReg.lastIndex = windowStart;
    const skipped = skipReg.exec(maskedSrc);
    endReg.lastIndex = skipped ? skipReg.lastIndex : windowStart;
    let closer;
    while ((closer = endReg.exec(searchSrc)) !== null) {
      if (closer.index > lastPossible) break;
      const rDelim = closer[1] || closer[2] || closer[3]
        || closer[4] || closer[5] || closer[6];
      if (!rDelim) continue;
      const rLength = rDelim.length;
      if (closer[3] || closer[4]) {
        delimTotal += rLength;
        continue;
      } else if (closer[5] || closer[6] || openerCanClose) {
        if (midRun && (closer[5] || closer[6])) break;
        if (runLength % 3 && !((runLength + rLength) % 3)) {
          midDelimTotal += rLength;
          continue;
        }
      }
      delimTotal -= rLength;
      if (delimTotal > 0) continue;
      const rLengthUsed = Math.min(rLength, rLength + delimTotal + midDelimTotal);
      const lastCharLength = firstCpLen(closer[0]);
      const raw = src.slice(0, lLength + (closer.index - windowStart) + lastCharLength + rLengthUsed);
      const text = Math.min(lLength, rLengthUsed) % 2
        ? raw.slice(1, -1)
        : raw.slice(2, -2);
      const inner = inlineHtml(text, st);
      if (st.plainText) return { h: inner, n: raw.length };
      return {
        h: Math.min(lLength, rLengthUsed) % 2
          ? '<em>' + inner + '</em>'
          : '<strong>' + inner + '</strong>',
        n: raw.length
      };
    }
  }
  return null;
}

function tryCodespan(rest, st) {
  const cap = I.code.exec(rest);
  if (!cap) return null;
  let text = cap[2].replace(/\n/g, ' ');
  if (O.nonSpaceChar.test(text) && O.startingSpaceChar.test(text)
    && O.endingSpaceChar.test(text)) {
    text = text.substring(1, text.length - 1);
  }
  return {
    h: st.plainText ? text : '<code>' + escHtml(text, true) + '</code>',
    n: cap[0].length
  };
}

function tryBr(rest, st) {
  const cap = I.br.exec(rest);
  if (!cap) return null;
  return { h: st.plainText ? '' : '<br>', n: cap[0].length };
}

function tryDel(src, maskedSrc, prevChar, st) {
  const match = I.delLDelim.exec(src);
  if (!match) return null;
  const nextChar = match[1] || '';
  if (!nextChar || !prevChar || I.punctuation.exec(prevChar)) {
    const lLength = cpLen(match[0]) - 1;
    let delimTotal = lLength;
    const endReg = I.delRDelim;
    const lastPossible = lastDelCloser(st, maskedSrc);
    const windowStart = maskedSrc.length - src.length + lLength;
    if (lastPossible < windowStart) return null;

    const searchSrc = maskedSrc;
    DEL_R_SKIP.lastIndex = windowStart;
    const skipped = DEL_R_SKIP.exec(maskedSrc);
    endReg.lastIndex = skipped ? DEL_R_SKIP.lastIndex : windowStart;
    let closer;
    while ((closer = endReg.exec(searchSrc)) !== null) {
      if (closer.index > lastPossible) break;
      const rDelim = closer[1] || closer[2] || closer[3]
        || closer[4] || closer[5] || closer[6];
      if (!rDelim) continue;
      const rLength = rDelim.length;
      if (rLength !== lLength) continue;
      if (closer[3] || closer[4]) {
        delimTotal += rLength;
        continue;
      }
      delimTotal -= rLength;
      if (delimTotal > 0) continue;
      const rLengthUsed = Math.min(rLength, rLength + delimTotal);
      const lastCharLength = firstCpLen(closer[0]);
      const raw = src.slice(0, lLength + (closer.index - windowStart) + lastCharLength + rLengthUsed);
      const text = raw.slice(lLength, -lLength);
      const inner = inlineHtml(text, st);
      return {
        h: st.plainText ? inner : '<del>' + inner + '</del>',
        n: raw.length
      };
    }
  }
  return null;
}

function tryAutolink(rest, st) {
  const cap = I.autolink.exec(rest);
  if (!cap) return null;
  const text = cap[1];
  const href = cap[2] === '@' ? 'mailto:' + text : text;
  const clean = cleanUrl(href);
  const labelHtml = escHtml(text, true);
  if (clean === null) return { h: labelHtml, n: cap[0].length };
  return {
    h: '<a href="' + escHtml(clean, true) + '">' + labelHtml + '</a>',
    n: cap[0].length
  };
}

function tryUrl(rest, st) {
  const cap = I.url.exec(rest);
  if (!cap) return null;

  let text;
  let href;
  if (cap[2] === '@') {
    text = cap[0];
    href = 'mailto:' + text;
  } else {
    let prev;
    do {
      prev = cap[0];
      cap[0] = (I._backpedal.exec(cap[0]) || [''])[0];
    } while (prev !== cap[0]);
    text = cap[0];
    href = cap[1] === 'www.' ? 'http://' + cap[0] : cap[0];
  }

  const clean = cleanUrl(href);
  const labelHtml = escHtml(text, true);
  if (clean === null) return { h: labelHtml, n: cap[0].length };
  return {
    h: '<a href="' + escHtml(clean, true) + '">' + labelHtml + '</a>',
    n: cap[0].length
  };
}

function tryInlineText(rest, st) {
  const cap = I.text.exec(rest);
  if (!cap) return null;
  const raw = cap[0];
  if (st.plainText) {
    return { h: st.inRawBlock ? raw : decodeNumRefs(raw), n: raw.length, raw };
  }
  return {
    h: st.inRawBlock ? raw : escHtml(decodeNumRefs(raw)),
    n: raw.length,
    raw
  };
}


function renderInline(src, st) {
  st.inRawBlock = false;
  return inlineHtml(src, st);
}

function codeHtml(text, lang) {
  const langString = (lang || '').match(O.notSpaceStart)?.[0];
  const code = text ? text.replace(O.endingNewline, '') + '\n' : '';
  if (!langString) return '<pre><code>' + escHtml(code, true) + '</code></pre>\n';
  return '<pre><code class="language-' + escHtml(langString) + '">' + escHtml(code, true) + '</code></pre>\n';
}

function scanSpace(src) {
  const cap = B.newline.exec(src);
  if (!cap || cap[0].length === 0) return null;
  return { desc: { kind: 'space', raw: cap[0] }, n: cap[0].length };
}

function scanCode(src) {
  const cap = B.code.exec(src);
  if (!cap) return null;
  const raw = trimTrailingBlankLines(cap[0]);
  const text = raw.replace(O.codeRemoveIndent, '');
  return { desc: { kind: 'code', raw, text, html: codeHtml(text, null) }, n: raw.length };
}

function scanFences(src) {
  const cap = B.fences.exec(src);
  if (!cap) return null;
  const raw = cap[0];
  const text = indentCodeCompensation(raw, cap[3] || '');
  const lang = cap[2] ? cap[2].trim().replace(I.anyPunctuation, '$1') : cap[2];
  return { desc: { kind: 'code', raw, text, html: codeHtml(text, lang) }, n: raw.length };
}

function scanHeading(src) {
  const cap = B.heading.exec(src);
  if (!cap) return null;
  let text = cap[2].trim();
  if (O.endingHash.test(text)) {
    const trimmed = rtrim(text, '#');
    if (!trimmed || O.endingSpaceTabChar.test(trimmed)) text = trimmed.trim();
  }
  const raw = rtrim(cap[0], '\n');
  return { desc: { kind: 'heading', depth: cap[1].length, text, raw }, n: raw.length };
}

function scanHr(src) {
  const cap = B.hr.exec(src);
  if (!cap) return null;
  const raw = rtrim(cap[0], '\n');
  return { desc: { kind: 'hr', raw }, n: raw.length };
}

function scanBlockquote(src, st) {
  const cap = B.blockquote.exec(src);
  if (!cap) return null;

  let lines = rtrim(cap[0], '\n').split('\n');
  let raw = '';
  let text = '';
  const blocks = [];

  while (lines.length > 0) {
    let inBlockquote = false;
    const currentLines = [];
    let i = 0;
    for (; i < lines.length; i++) {
      if (O.blockquoteStart.test(lines[i])) {
        currentLines.push(lines[i]);
        inBlockquote = true;
      } else if (!inBlockquote) {
        currentLines.push(lines[i]);
      } else {
        break;
      }
    }
    lines = lines.slice(i);

    const currentRaw = currentLines.join('\n');
    const currentText = currentRaw
      .replace(O.blockquoteMarkerWhitespace, (_, marker, ws) => marker + expandTabs(ws, marker.length))
      .replace(O.blockquoteSetextReplace, '\n    $1')
      .replace(O.blockquoteSetextReplace2, '');
    raw = raw ? raw + '\n' + currentRaw : currentRaw;
    text = text ? text + '\n' + currentText : currentText;

    const savedTop = st.top;
    st.top = true;
    parseBlocks(currentText, st, true, blocks);
    st.top = savedTop;
    if (lines.length === 0) break;

    const last = blocks.at(-1);
    if (last && ['code', 'heading', 'hr', 'html', 'table'].includes(last.kind)) break;

    if (last && last.kind === 'blockquote') {
      const oldToken = last;
      const continuation = lines.join('\n');
      const newText = oldToken.raw + '\n' + continuation.replace(O.blockquoteSetextReplace2, '');
      const scanned = scanBlockquote(newText, st);
      if (!scanned) break;
      const newDesc = scanned.desc;
      blocks[blocks.length - 1] = newDesc;
      const leftover = newText.substring(newDesc.raw.length).replace(/^\n/, '');
      const leftoverCount = leftover ? leftover.split('\n').length : 0;
      const consumed = leftoverCount ? lines.slice(0, -leftoverCount) : lines;
      if (consumed.length > 0) raw = raw + '\n' + consumed.join('\n');
      text = text.substring(0, text.length - oldToken.text.length) + newDesc.text;
      lines = lines.slice(consumed.length);
      if (lines.length > 0 && O.blockquoteStart.test(lines[0])) continue;
      break;
    }

    if (last && last.kind === 'list') {
      const oldToken = last;
      const newText = oldToken.raw + '\n' + lines.join('\n');
      const scanned = scanList(newText, st);
      if (!scanned) break;
      blocks[blocks.length - 1] = scanned.desc;
      const consumedCount = scanned.desc.raw.length > oldToken.raw.length
        ? newText.slice(oldToken.raw.length + 1, scanned.desc.raw.length).split('\n').length
        : 0;
      if (consumedCount > 0) {
        const consumed = lines.slice(0, consumedCount).join('\n');
        raw = raw + '\n' + consumed;
        text = text + '\n' + consumed;
      }
      lines = lines.slice(consumedCount);
      continue;
    }
  }

  const desc = { kind: 'blockquote', raw, text, blocks };
  return { desc, n: raw.length };
}

// Index of the first non-space character in `s` from `start`, counting a
// tab as four (as `line.replace(/\t/g, '    ').search(/[^ ]/)` does); -1
// when the rest is only spaces and tabs.
function naiveFirstNonSpace(s, start, end) {
  let n = 0;
  for (let i = start; i < end; i++) {
    const c = s.charCodeAt(i);
    if (c === 32) n++;
    else if (c === 9) n += 4;
    else return n;
  }
  return -1;
}
// Number of leading spaces in `s` from `start` (tabs count as zero here,
// matching the exact loop's `lLead` count).
function leadingSpaces(s, start, end) {
  let n = 0;
  while (start + n < end && s.charCodeAt(start + n) === 32) n++;
  return n;
}
// Does `s[start..end)` consist of one run of '=' or '-' followed by spaces?
function isSetextUnderline(s, start, end) {
  if (start >= end) return false;
  const c = s.charCodeAt(start);
  if (c !== 61 && c !== 45) return false;
  let i = start + 1;
  while (i < end && s.charCodeAt(i) === c) i++;
  while (i < end && s.charCodeAt(i) === 32) i++;
  return i === end;
}

// Bulk fast path for scanList's inner line loop: walks the remaining lines
// with char-code checks only (no trim, no regex, no per-line allocations)
// and builds the item contents from slices of `src`. Returns
// { contents, consumed } or null when a line needs the exact loop (a tab in
// the leading whitespace, or a lazy line that could be a setext
// continuation). `line`/`blankLine` describe the bullet line, which is the
// "previous line" for the first iterated line; `rx` holds the six break
// regexes for this item.
function scanListBulk(src, indent, line, blankLine, rx) {
  const parts = [];
  let pos = 0;
  let prevBlank = blankLine;
  // Previous line's dedented form, for the (c)/(d) checks on lazy lines:
  // its naive first-non-space index, its leading-space count and first
  // significant character, and where to find its string for the (d) regexes
  // (the bullet line's string, or a slice of `src`).
  let prevFNS = naiveFirstNonSpace(line, 0, line.length);
  let prevLLead = leadingSpaces(line, 0, line.length);
  let prevLCh = prevLLead < line.length ? line.charCodeAt(prevLLead) : -1;
  let prevStr = line;
  let prevStart = -1;
  let prevEnd = -1;

  while (pos < src.length) {
    const lineStart = pos;
    const nl = src.indexOf('\n', pos);
    const lineEnd = nl === -1 ? src.length : nl;
    let i = lineStart;
    while (i < lineEnd && src.charCodeAt(i) === 32) i++;
    if (i < lineEnd && src.charCodeAt(i) === 9) return null; // tab in leading ws
    const firstNonSpace = i - lineStart;
    const blank = firstNonSpace === lineEnd - lineStart;
    const firstCh = blank ? -1 : src.charCodeAt(lineStart + firstNonSpace);

    // (a) break tests on this line (only when it starts within `indent`).
    if (!blank && firstNonSpace <= indent) {
      const s = src.slice(lineStart, lineEnd);
      if (firstCh === 96 || firstCh === 126) { if (rx.fencesBeginRegex.test(s)) break; }
      else if (firstCh === 35) { if (rx.headingBeginRegex.test(s)) break; }
      else if (firstCh === 60) { if (rx.htmlBeginRegex.test(s)) break; }
      else if (firstCh === 62) { if (rx.blockquoteBeginRegex.test(s)) break; }
      else if (firstCh === 42 || firstCh === 43 || firstCh === 45) {
        if (rx.nextBulletRegex.test(s)) break;
        if (rx.hrRegex.test(s)) break;
      } else if (firstCh >= 48 && firstCh <= 57) { if (rx.nextBulletRegex.test(s)) break; }
    }

    if (blank || firstNonSpace >= indent) {
      parts.push('\n', src.slice(lineStart + indent, lineEnd));
    } else {
      // Lazy continuation line.
      if (prevBlank) break;
      if (prevFNS >= 4) break;
      if (prevLLead <= indent
        && (prevLCh === 96 || prevLCh === 126 || prevLCh === 35 || prevLCh === 60
          || prevLCh === 42 || prevLCh === 43 || prevLCh === 45)) {
        const prevS = prevStr !== null ? prevStr : src.slice(prevStart + indent, prevEnd);
        let hit = false;
        if (prevLCh === 96 || prevLCh === 126) hit = rx.fencesBeginRegex.test(prevS);
        else if (prevLCh === 35) hit = rx.headingBeginRegex.test(prevS);
        else if (prevLCh === 60) hit = rx.htmlBeginRegex.test(prevS);
        else if (prevLCh === 42 || prevLCh === 43 || prevLCh === 45) hit = rx.hrRegex.test(prevS);
        if (hit) break;
      }
      // A lazy line that is only '=' or '-' (up to 3 leading spaces) could
      // be a setext continuation; the exact loop decides.
      if (firstNonSpace <= 3 && isSetextUnderline(src, lineStart + firstNonSpace, lineEnd)) return null;
      parts.push('\n', src.slice(lineStart, lineEnd));
    }

    // This line becomes the previous line.
    prevBlank = blank;
    prevFNS = naiveFirstNonSpace(src, lineStart + indent, lineEnd);
    prevLLead = leadingSpaces(src, lineStart + indent, lineEnd);
    prevLCh = lineStart + indent + prevLLead < lineEnd
      ? src.charCodeAt(lineStart + indent + prevLLead) : -1;
    prevStr = null;
    prevStart = lineStart;
    prevEnd = lineEnd;
    pos = lineEnd + 1;
  }
  return { contents: parts.join(''), consumed: pos };
}

function scanList(src, st) {
  const initial = B.list.exec(src);
  if (!initial) return null;

  const listSrc = src;
  let bullText = initial[1].trim();
  const ordered = bullText.length > 1;
  const bullPattern = ordered ? '\\d{1,9}\\' + bullText.slice(-1) : '\\' + bullText;
  const itemRegex = O.listItemRegex(bullPattern);
  let loose = false;
  let endsWithBlankLine = false;
  const items = [];

  function taken() {
    return listSrc.length - src.length;
  }

  while (src) {
    let endEarly = false;
    let itemContents = '';
    const cap2 = itemRegex.exec(src);
    if (!cap2) break;
    if (B.hr.test(src)) break;

    const itemStart = taken();
    src = src.substring(cap2[0].length);
    const firstLine = cap2[2].split('\n', 1)[0];
    const bulletIndent = cap2[1].length;
    let line = firstLine.replace(O.leadingSpaceTab, ws => expandTabs(ws, bulletIndent));
    let nextLine = src.split('\n', 1)[0];
    let blankLine = !line.trim();
    let indent = 0;

    if (blankLine) {
      indent = bulletIndent + 1;
    } else {
      indent = line.search(O.nonSpaceChar);
      indent = indent > 4 ? 1 : indent;
      itemContents = line.slice(indent);
      indent += bulletIndent;
    }

    if (blankLine && O.blankLine.test(nextLine)) {
      src = src.substring(nextLine.length + 1);
      endEarly = true;
    }

    if (!endEarly) {
      const nextBulletRegex = O.nextBulletRegex(indent);
      const hrRegex = O.hrRegex(indent);
      const fencesBeginRegex = O.fencesBeginRegex(indent);
      const headingBeginRegex = O.headingBeginRegex(indent);
      const htmlBeginRegex = O.htmlBeginRegex(indent);
      const blockquoteBeginRegex = O.blockquoteBeginRegex(indent);

      const bulk = scanListBulk(src, indent, line, blankLine,
        { nextBulletRegex, hrRegex, fencesBeginRegex, headingBeginRegex, htmlBeginRegex, blockquoteBeginRegex });
      if (bulk) {
        itemContents += bulk.contents;
        src = src.substring(bulk.consumed);
      } else {
      while (src) {
        const nlIdx = src.indexOf('\n');
        const rawLine = nlIdx === -1 ? src : src.slice(0, nlIdx);
        nextLine = rawLine;
        // The break tests are all anchored `^ {0,indent}...`: a line whose
        // leading whitespace exceeds `indent`, or whose first significant
        // character cannot start any of them, needs none of the six regexes.
        let leadSpaces = 0;
        while (leadSpaces < rawLine.length && rawLine.charCodeAt(leadSpaces) === 32) leadSpaces++;
        const firstCh = leadSpaces < rawLine.length ? rawLine.charCodeAt(leadSpaces) : -1;
        const nextLineWithoutTabs = leadSpaces === 0 && rawLine.charCodeAt(0) !== 9
          ? nextLine
          : nextLine.replace(O.leadingSpaceTab, ws => expandTabs(ws));
        const trimmedLine = nextLine.trim();

        if (leadSpaces <= indent) {
          if (firstCh === 96 || firstCh === 126) { // ` or ~: fences only
            if (fencesBeginRegex.test(nextLine)) break;
          } else if (firstCh === 35) { // #: heading only
            if (headingBeginRegex.test(nextLine)) break;
          } else if (firstCh === 60) { // <: html only
            if (htmlBeginRegex.test(nextLine)) break;
          } else if (firstCh === 62) { // >: blockquote only
            if (blockquoteBeginRegex.test(nextLine)) break;
          } else if (firstCh === 42 || firstCh === 43 || firstCh === 45) { // * + -: bullet or hr
            if (nextBulletRegex.test(nextLine)) break;
            if (hrRegex.test(nextLine)) break;
          } else if (firstCh >= 48 && firstCh <= 57) { // digit: bullet only
            if (nextBulletRegex.test(nextLine)) break;
          }
        }

        // Index of the first character that is not a space (a tab counts).
        let firstNonSpace = 0;
        while (firstNonSpace < nextLineWithoutTabs.length
          && nextLineWithoutTabs.charCodeAt(firstNonSpace) === 32) firstNonSpace++;
        if (firstNonSpace >= indent || !trimmedLine) {
          itemContents += '\n' + nextLineWithoutTabs.slice(indent);
        } else {
          if (blankLine) break;
          if (line.replace(O.tabCharGlobal, '    ').search(O.nonSpaceChar) >= 4) break;
          // Same first-character filter for the previous-line break tests.
          let lLead = 0;
          while (lLead < line.length && line.charCodeAt(lLead) === 32) lLead++;
          const lCh = lLead < line.length ? line.charCodeAt(lLead) : -1;
          if (lLead <= indent) {
            if ((lCh === 96 || lCh === 126) && fencesBeginRegex.test(line)) break;
            if (lCh === 35 && headingBeginRegex.test(line)) break;
            if (lCh === 60 && htmlBeginRegex.test(line)) break;
            if ((lCh === 42 || lCh === 43 || lCh === 45) && hrRegex.test(line)) break;
          }
          const setextContinuation = /^ {0,3}(?:=+|-+) *$/.test(nextLine) && B.lheading.test(line + '\n' + nextLine);
          const continuation = setextContinuation
            ? '    ' + nextLineWithoutTabs.replace(/^ {0,3}/, '')
            : nextLine;
          itemContents += '\n' + continuation;
        }

        blankLine = !trimmedLine;
        src = src.substring(rawLine.length + 1);
        line = nextLineWithoutTabs.slice(indent);
      }
      } // end fallback loop
    }

    const itemRaw = listSrc.slice(itemStart, taken());
    if (!loose) {
      if (endsWithBlankLine) {
        loose = true;
      } else if (O.doubleBlankLine.test(itemRaw)) {
        endsWithBlankLine = true;
      }
    }
    items.push({
      raw: itemRaw,
      task: O.listIsTask.test(itemContents),
      text: itemContents,
      blocks: null,
      checked: false
    });
  }

  const lastItem = items.at(-1);
  if (!lastItem) return null;
  lastItem.raw = lastItem.raw.trimEnd();
  lastItem.text = lastItem.text.trimEnd();
  const listRaw = listSrc.slice(0, taken()).trimEnd();

  for (const item of items) {
    st.top = false;
    item.blocks = parseBlocks(item.text, st, false);
    if (!loose) {
      for (const block of item.blocks) {
        if (block.kind === 'space' && O.anyLine.test(block.raw)) { loose = true; break; }
      }
    }
  }

  for (const item of items) {
    const first = item.blocks[0];
    if (item.task && first && (first.kind === 'text' || first.kind === 'paragraph')) {
      // The marker is the first thing in the item text, hence at the start
      // of the first block's text and raw: strip it in place instead of
      // re-scanning the whole item.
      item.text = item.text.replace(O.listReplaceTask, '');
      first.text = first.text.replace(O.listReplaceTask, '');
      first.raw = first.raw.replace(O.listReplaceTask, '');
      const taskRaw = O.listTaskCheckbox.exec(item.raw);
      if (taskRaw) item.checked = taskRaw[0] !== '[ ]';
    } else if (item.task) {
      item.task = false;
    }
  }

  const start = ordered ? +bullText.slice(0, -1) : '';
  const desc = { kind: 'list', raw: listRaw, ordered, start, loose, items };
  return { desc, n: listRaw.length };
}

function scanHtml(src) {
  const cap = B.html.exec(src);
  if (!cap) return null;
  const raw = trimTrailingBlankLines(cap[0]);
  return {
    desc: {
      kind: 'html',
      html: raw,
      pre: cap[1] === 'pre' || cap[1] === 'script' || cap[1] === 'style',
      raw
    },
    n: raw.length
  };
}

function scanDef(src) {
  const cap = B.def.exec(src);
  if (!cap) return null;
  if (!O.startAngleBracket.test(cap[2]) && findClosingBracket(cap[2], '()') !== -1) return null;
  const tag = normalizeLabel(cap[1]);
  const href = cap[2] ? cap[2].replace(O.hrefBrackets, '$1').replace(I.anyPunctuation, '$1') : '';
  const title = cap[3] ? cap[3].substring(1, cap[3].length - 1).replace(I.anyPunctuation, '$1') : cap[3];
  const raw = rtrim(cap[0], '\n');
  return { desc: { kind: 'def', tag, href, title, raw }, n: raw.length };
}

function scanTable(src) {
  const cap = B.table.exec(src);
  if (!cap || !O.tableDelimiter.test(cap[2])) return null;
  const headers = splitCells(cap[1]);
  const aligns = cap[2].replace(O.tableAlignChars, '').split('|');
  if (headers.length !== aligns.length) return null;
  const align = aligns.map(value => {
    if (O.tableAlignRight.test(value)) return 'right';
    if (O.tableAlignCenter.test(value)) return 'center';
    if (O.tableAlignLeft.test(value)) return 'left';
    return null;
  });
  const rows = cap[3]?.trim()
    ? cap[3].replace(O.tableRowBlankLine, '').split('\n')
    : [];
  const raw = rtrim(cap[0], '\n');
  return {
    desc: { kind: 'table', raw, header: headers, align, rows: rows.map(row => splitCells(row, headers.length)) },
    n: raw.length
  };
}

function scanLheading(src) {
  const cap = B.lheading.exec(src);
  if (!cap) return null;
  const raw = rtrim(cap[0], '\n');
  return {
    desc: { kind: 'heading', depth: cap[2].charAt(0) === '=' ? 1 : 2, text: cap[1].trim(), raw },
    n: raw.length
  };
}

function scanParagraph(src) {
  const cap = B.paragraph.exec(src);
  if (!cap) return null;
  const text = cap[1].charAt(cap[1].length - 1) === '\n' ? cap[1].slice(0, -1) : cap[1];
  return { desc: { kind: 'paragraph', raw: cap[0], text }, n: cap[0].length };
}

function scanText(src) {
  const cap = B.text.exec(src);
  if (!cap) return null;
  return { desc: { kind: 'text', raw: cap[0], text: cap[0] }, n: cap[0].length };
}

// Could `src` hold a setext heading? The underline (a line of only `=` or
// `-`, up to 3 leading spaces) must appear before the first blank line,
// since the heading's text cannot cross one. Walks line starts only.
function couldBeLheading(src) {
  let i = src.indexOf('\n');
  while (i !== -1) {
    let j = i + 1;
    let spaces = 0;
    while (j < src.length && src.charCodeAt(j) === 32) { j++; spaces++; }
    if (j >= src.length) return false;
    const c = src.charCodeAt(j);
    if (c === 10) return false; // blank line ends the paragraph
    if (c === 9) {
      // A line starting with a tab cannot be an underline; it is blank only
      // if nothing but spaces/tabs follows it on the line.
      let k = j;
      while (k < src.length && (src.charCodeAt(k) === 32 || src.charCodeAt(k) === 9)) k++;
      if (k >= src.length || src.charCodeAt(k) === 10) return false;
    } else if (spaces <= 3 && (c === 61 || c === 45)) {
      let k = j + 1;
      let ok = true;
      while (k < src.length && src.charCodeAt(k) !== 10) {
        const ck = src.charCodeAt(k);
        if (ck !== c && ck !== 32 && ck !== 9) { ok = false; break; }
        k++;
      }
      if (ok) return true;
    }
    i = src.indexOf('\n', j);
  }
  return false;
}

function parseBlocks(src, st, lastParagraphClipped, out = []) {
  while (src) {
    const srcLength = src.length;
    // Cheap dispatch: leading spaces and the first significant character
    // decide which block scanners can possibly match. The order below is
    // still marked's order; hopeless regexes are just never run.
    let lead = 0;
    while (lead < 4 && src.charCodeAt(lead) === 32) lead++;
    const c0 = lead < src.length ? src.charCodeAt(lead) : -1;
    const in3 = lead <= 3;
    let line2 = null;
    const nl = src.indexOf('\n');
    if (nl !== -1) {
      // Table guard without slicing the second line: it needs a '-' and
      // a '|' or ':'.
      const nl2 = src.indexOf('\n', nl + 1);
      const end2 = nl2 === -1 ? src.length : nl2;
      let hasDash = false;
      let hasPipeOrColon = false;
      for (let k = nl + 1; k < end2; k++) {
        const c = src.charCodeAt(k);
        if (c === 45) hasDash = true;
        else if (c === 124 || c === 58) hasPipeOrColon = true;
        if (hasDash && hasPipeOrColon) break;
      }
      line2 = hasDash && hasPipeOrColon;
    }
    const gTable = line2 === true;
    const gLheading = couldBeLheading(src);
    const cFirst = src.charCodeAt(0);
    const gSpace = cFirst === 32 || cFirst === 9 || cFirst === 10;
    const gCode = lead === 4 || (lead <= 3 && c0 === 9);
    const gFences = in3 && (c0 === 96 || c0 === 126)
      && src.charCodeAt(lead + 1) === c0 && src.charCodeAt(lead + 2) === c0;
    const gHeading = in3 && c0 === 35;
    const gHr = in3 && (c0 === 45 || c0 === 95 || c0 === 42);
    const gBlockquote = in3 && c0 === 62;
    const gList = in3 && (c0 === 42 || c0 === 43 || c0 === 45 || (c0 >= 48 && c0 <= 57));
    const gHtml = in3 && c0 === 60;
    const gDef = in3 && c0 === 91;

    let scanned;
    if (gSpace && (scanned = scanSpace(src, st, out))) {
      const desc = scanned.desc;
      const previous = out.at(-1);
      if (desc.raw.length === 1 && previous) previous.raw += '\n';
      else out.push(desc);
      src = src.substring(scanned.n);
    } else if (gCode && (scanned = scanCode(src, st, out))) {
      const desc = scanned.desc;
      const previous = out.at(-1);
      if (previous && (previous.kind === 'paragraph' || previous.kind === 'text')) {
        previous.raw += (previous.raw.endsWith('\n') ? '' : '\n') + desc.raw;
        previous.text += '\n' + desc.text;
      } else {
        out.push(desc);
      }
      src = src.substring(scanned.n);
    } else if (gFences && (scanned = scanFences(src, st, out))) {
      out.push(scanned.desc);
      src = src.substring(scanned.n);
    } else if (gHeading && (scanned = scanHeading(src, st, out))) {
      out.push(scanned.desc);
      src = src.substring(scanned.n);
    } else if (gHr && (scanned = scanHr(src, st, out))) {
      out.push(scanned.desc);
      src = src.substring(scanned.n);
    } else if (gBlockquote && (scanned = scanBlockquote(src, st))) {
      out.push(scanned.desc);
      src = src.substring(scanned.n);
    } else if (gList && (scanned = scanList(src, st))) {
      out.push(scanned.desc);
      src = src.substring(scanned.n);
    } else if (gHtml && (scanned = scanHtml(src, st, out))) {
      out.push(scanned.desc);
      src = src.substring(scanned.n);
    } else if (gDef && (scanned = scanDef(src, st))) {
      const desc = scanned.desc;
      const previous = out.at(-1);
      if (previous && (previous.kind === 'paragraph' || previous.kind === 'text')) {
        previous.raw += (previous.raw.endsWith('\n') ? '' : '\n') + desc.raw;
        previous.text += '\n' + desc.raw;
      } else {
        if (!st.links[desc.tag]) {
          st.links[desc.tag] = { href: desc.href, title: desc.title };
          st.hasLinks = true;
        }
        out.push(desc);
      }
      src = src.substring(scanned.n);
    } else if (gTable && (scanned = scanTable(src, st, out))) {
      out.push(scanned.desc);
      src = src.substring(scanned.n);
    } else if (gLheading && (scanned = scanLheading(src, st, out))) {
      out.push(scanned.desc);
      src = src.substring(scanned.n);
    } else if (st.top && (scanned = scanParagraph(src, st, out))) {
      const desc = scanned.desc;
      const previous = out.at(-1);
      if (lastParagraphClipped && previous && previous.kind === 'paragraph') {
        previous.raw += (previous.raw.endsWith('\n') ? '' : '\n') + desc.raw;
        previous.text += '\n' + desc.text;
      } else {
        out.push(desc);
      }
      lastParagraphClipped = false;
      src = src.substring(scanned.n);
    } else if ((scanned = scanText(src, st, out))) {
      const desc = scanned.desc;
      const previous = out.at(-1);
      if (previous && previous.kind === 'text') {
        previous.raw += (previous.raw.endsWith('\n') ? '' : '\n') + desc.raw;
        previous.text += '\n' + desc.text;
      } else {
        out.push(desc);
      }
      src = src.substring(scanned.n);
    } else {
      throw new Error('Infinite loop on byte: ' + src.charCodeAt(0));
    }

    if (src.length === srcLength) {
      throw new Error('Infinite loop on byte: ' + src.charCodeAt(0));
    }
  }
  // Marked's `state.top` is mutable: every blockTokens call ends with it
  // true, and a list item's tokens are lexed with it false. So after any
  // nested block scan (a list item, a blockquote continuation) the enclosing
  // loop sees top again — an indented code block can then no longer
  // interrupt the paragraph that follows a nested list. The blockquote
  // scanner saves and restores it, as marked does.
  st.top = true;
  return out;
}

function renderBlocks(descs, st, loose = false) {
  let html = '';
  for (const desc of descs) {
    switch (desc.kind) {
      case 'space':
      case 'def':
        break;
      case 'code':
        html += desc.html;
        break;
      case 'heading':
        html += '<h' + desc.depth + '>' + renderInline(desc.text, st) + '</h' + desc.depth + '>\n';
        break;
      case 'hr':
        html += '<hr>\n';
        break;
      case 'blockquote':
        html += '<blockquote>\n' + renderBlocks(desc.blocks, st) + '</blockquote>\n';
        break;
      case 'list': {
        const type = desc.ordered ? 'ol' : 'ul';
        const start = desc.ordered && desc.start !== 1 ? ' start="' + desc.start + '"' : '';
        html += '<' + type + start + '>\n';
        for (const item of desc.items) {
          let itemHtml = renderBlocks(item.blocks, st, desc.loose);
          if (item.task) {
            const checkbox = '<input ' + (item.checked ? 'checked="" ' : '') + 'disabled="" type="checkbox"> ';
            if (desc.loose && itemHtml.startsWith('<p>')) {
              itemHtml = '<p>' + checkbox + itemHtml.slice(3);
            } else {
              itemHtml = checkbox + itemHtml;
            }
          }
          html += '<li>' + itemHtml + '</li>\n';
        }
        html += '</' + type + '>\n';
        break;
      }
      case 'html':
        html += desc.html;
        break;
      case 'table': {
        const renderCell = (cell, tag, align) =>
          '<' + tag + (align ? ' align="' + align + '"' : '') + '>' + renderInline(cell, st) + '</' + tag + '>\n';
        const header = '<tr>\n' + desc.header.map((cell, index) => renderCell(cell, 'th', desc.align[index])).join('') + '</tr>\n';
        const body = desc.rows.map(row => '<tr>\n' + row.map((cell, index) => renderCell(cell, 'td', desc.align[index])).join('') + '</tr>\n').join('');
        html += '<table>\n<thead>\n' + header + '</thead>\n' + (body ? '<tbody>' + body + '</tbody>' : '') + '</table>\n';
        break;
      }
      case 'paragraph':
        html += '<p>' + renderInline(desc.text, st) + '</p>\n';
        break;
      case 'text':
        html += loose
          ? '<p>' + renderInline(desc.text, st) + '</p>\n'
          : renderInline(desc.text, st);
        break;
    }
  }
  return html;
}

function blockHtml(src, st, lastParagraphClipped) {
  return renderBlocks(parseBlocks(src, st, lastParagraphClipped), st);
}



// ---------------------------------------------------------------------------
// Entry point.
// ---------------------------------------------------------------------------
// Render `markdown` to exactly the HTML marked 18.1.3 renders with its
// default options. Pure per call: a fresh state object is built for every
// call and nothing is retained, cached or shared between calls.
export function parse(markdown) {
  const st = newState();
  const src = String(markdown).replace(O.carriageReturn, '\n');
  return blockHtml(src, st, false);
}
