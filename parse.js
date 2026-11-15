// parse.js — fast, dependency-free drop-in for marked 18.1.3 (defaults:
// gfm true, breaks false, pedantic false, async false).
//
// A restructured port of marked 18.1.3 (MIT, see NOTICE.md): the same block
// and inline grammars and helper semantics, but HTML is emitted directly
// while scanning instead of building a token tree and walking it again.
// The configuration is hardcoded, so every pedantic / breaks / async /
// extension branch is gone. No imports, no cross-call state, no caching
// across parse() calls, no clock / network / filesystem access.

const noopTest = { exec: () => null };

function edit(regex, opt = '') {
  let source = typeof regex === 'string' ? regex : regex.source;
  const obj = {
    replace: (name, val) => {
      let valSource = typeof val === 'string' ? val : val.source;
      valSource = valSource.replace(other.caret, '$1');
      source = source.replace(name, valSource);
      return obj;
    },
    getRegex: () => new RegExp(source, opt),
  };
  return obj;
}

const supportsLookbehind = (() => {
  try { return !!new RegExp('(?<=1)(?<!1)'); } catch { return false; }
})();

function cachedIndentRegex(createRegex) {
  const cache = [];
  return (indent) => {
    const cacheIndex = Math.max(0, Math.min(3, indent - 1));
    let regex = cache[cacheIndex];
    if (!regex) {
      regex = createRegex(cacheIndex);
      cache[cacheIndex] = regex;
    }
    return regex;
  };
}

const other = {
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
  caret: /(^|[^\[])\^/g,
  percentDecode: /%25/g,
  findPipe: /\|/g,
  splitPipe: / \|/,
  slashPipe: /\\\|/g,
  carriageReturn: /\r\n|\r/g,
  spaceLine: /^ +$/gm,
  notSpaceStart: /^\S*/,
  endingNewline: /\n$/,
  listItemRegex: (bull) => new RegExp(`^( {0,3}${bull})((?:[\t ][^\\n]*)?(?:\\n|$))`),
  nextBulletRegex: cachedIndentRegex((indent) => new RegExp(`^ {0,${indent}}(?:[*+-]|\\d{1,9}[.)])((?:[ \t][^\\n]*)?(?:\\n|$))`)),
  hrRegex: cachedIndentRegex((indent) => new RegExp(`^ {0,${indent}}((?:-[ \t]*){3,}|(?:_[ \t]*){3,}|(?:\\*[ \t]*){3,})(?:\\n+|$)`)),
  fencesBeginRegex: cachedIndentRegex((indent) => new RegExp(`^ {0,${indent}}(?:\`\`\`|~~~)`)),
  headingBeginRegex: cachedIndentRegex((indent) => new RegExp(`^ {0,${indent}}#{1,6}(?:\\s|$)`)),
  htmlBeginRegex: cachedIndentRegex((indent) => new RegExp(`^ {0,${indent}}(?:</?(?:${_tag})(?: +|$|/?>)|<(?:(?:script|pre|style|textarea)(?:[\\s>]|$)|!--)|<\\?|<![A-Za-z]|<!\\[CDATA\\[)`, 'i')),
  blockquoteBeginRegex: cachedIndentRegex((indent) => new RegExp(`^ {0,${indent}}>`)),
};

// ---- Block grammar (GFM) ----

const newline = /^(?:[ \t]*(?:\n|$))+/;
const blockCode = /^((?: {4}| {0,3}\t)[^\n]+(?:\n(?:[ \t]*(?:\n|$))*)?)+/;
const fences = /^ {0,3}(`{3,}(?=[^`\n]*(?:\n|$))|~{3,})([^\n]*)(?:\n|$)(?:|([\s\S]*?)(?:\n|$))(?: {0,3}(?:(?=`)\1`*|(?=~)\1~*) *(?=\n|$)|$)/;
const hr = /^ {0,3}((?:-[\t ]*){3,}|(?:_[ \t]*){3,}|(?:\*[ \t]*){3,})(?:\n+|$)/;
const heading = /^ {0,3}(#{1,6})(?=\s|$)(.*)(?:\n+|$)/;
const bullet = / {0,3}(?:[*+-]|\d{1,9}[.)])/;
const lheadingCore = /^(?!bull |blockCode|fences|blockquote|heading|html|table)((?:.|\n(?!\s*?\n|bull |fences|blockquote|heading|hr|html|table))+?)\n {0,3}(=+|-+)[ \t]*(?:\n+|$)/;
const lheading = edit(lheadingCore)
  .replace(/bull/g, bullet)
  .replace(/blockCode/g, /(?: {4}| {0,3}\t)/)
  .replace(/fences/g, / {0,3}(?:`{3,}|~{3,})/)
  .replace(/blockquote/g, / {0,3}>/)
  .replace(/heading/g, / {0,3}#{1,6}(?:\s|$)/)
  .replace(/hr/g, / {0,3}(?:(?:-[\t ]*){3,}|(?:_[ \t]*){3,}|(?:\*[ \t]*){3,})(?:\n+|$)/)
  .replace(/html/g, / {0,3}<[^\n>]+>\n/)
  .replace(/table/g, / {0,3}\|?(?:[:\- ]*\|)+[\:\- ]*\n/)
  .getRegex();
const _paragraph = /^([^\n]+(?:\n(?!hr|heading|lheading|blockquote|fences|list|html|table|[ \t]+\n)[^\n]+)*)/;
const blockText = /^[^\n]+/;
const _blockLabel = /(?!\s*\])(?:\\[\s\S]|[^\[\]\\\n]|\n(?![ \t]*\n))+/;
const def = edit(/^ {0,3}\[(label)\]: *(?:\n[ \t]*)?([^<\s][^\s]*|<.*?>)(?:(?: +(?:\n[ \t]*)?| *\n[ \t]*)(title))? *(?:\n+|$)/)
  .replace('label', _blockLabel)
  .replace('title', /(?:"(?:\\[\s\S]|[^"\\])*"|'(?:\\[\s\S]|[^'\\\n]|\n(?!\n))*'|\((?:\\[\s\S]|[^()\\])*\))/)
  .getRegex();

const list = edit(/^(bull)([ \t][^\n]*?)?(?:\n|$)/)
  .replace(/bull/g, bullet)
  .getRegex();

const _tag = 'address|article|aside|base|basefont|blockquote|body|caption'
  + '|center|col|colgroup|dd|details|dialog|dir|div|dl|dt|fieldset|figcaption'
  + '|figure|footer|form|frame|frameset|h[1-6]|head|header|hr|html|iframe'
  + '|legend|li|link|main|menu|menuitem|meta|nav|noframes|ol|optgroup|option'
  + '|p|param|search|section|summary|table|tbody|td|tfoot|th|thead|title'
  + '|tr|track|ul';
const _comment = /<!--(?:-?>|[\s\S]*?(?:-->|$))/;
const html = edit(
  '^ {0,3}(?:'
  + '<(script|pre|style|textarea)[\\s>][\\s\\S]*?(?:</\\1>[^\\n]*\\n*|$)'
  + '|comment[^\\n]*(\\n+|$)'
  + '|<\\?[\\s\\S]*?(?:\\?>[^\\n]*\\n*|$)'
  + '|<![A-Z][\\s\\S]*?(?:>[^\\n]*\\n*|$)'
  + '|<!\\[CDATA\\[[\\s\\S]*?(?:\\]\\]>[^\\n]*\\n*|$)'
  + '|</?(tag)(?:[ \\t]+|\\n|/?>|$)[\\s\\S]*?(?:(?:\\n[ \t]*)+\\n|$)'
  + '|<(?!(?:script|pre|style|textarea)(?![a-z0-9-]))([a-z][a-z0-9-]*)(?:attribute)*? */?>(?=[ \\t]*(?:\\n|$))[\\s\\S]*?(?:(?:\\n[ \t]*)+\\n|$)'
  + '|</[a-z][a-z0-9-]*\\s*>(?=[ \\t]*(?:\\n|$))[\\s\\S]*?(?:(?:\\n[ \t]*)+\\n|$)'
  + ')', 'i')
  .replace('comment', _comment)
  .replace('tag', _tag)
  .replace('attribute', / +[a-zA-Z:_][\w.:-]*(?: *= *"[^"\n]*"| *= *'[^'\n]*'| *= *[^\s"'=<>`]+)?/)
  .getRegex();

const createParagraph = (listInterrupt) => edit(_paragraph)
  .replace('hr', hr)
  .replace('heading', ' {0,3}#{1,6}(?:\\s|$)')
  .replace('|lheading', '')
  .replace('|table', '')
  .replace('blockquote', ' {0,3}>')
  .replace('fences', ' {0,3}(?:`{3,}(?=[^`\\n]*(?:\\n|$))|~~~)[^\\n]*(?:\\n|$)')
  .replace('list', listInterrupt)
  .replace('html', ' {0,3}(?:</?(?:tag)(?: +|\\n|/?>)|<(?:(?:script|pre|style|textarea)(?:[\\s>]|$)|!--)|<\\?|<![A-Za-z]|<!\\[CDATA\\[)')
  .replace('tag', _tag)
  .getRegex();

const blockquoteParagraph = createParagraph(/ {0,3}(?:[*+-]|\d{1,9}[.)])(?:[ \t]|\n|$)/);

const blockquote = edit(/^( {0,3}> ?(?:(?![ \t]*(?:\n|$))(paragraph)|[^\n]*)(?:\n|$))+/ )
  .replace('paragraph', blockquoteParagraph)
  .getRegex();

const gfmTable = edit(
  '^ *([^\\n ].*)\\n'
  + ' {0,3}((?:\\| *)?:?-+:? *(?:\\| *:?-+:? *)*(?:\\| *)?)'
  + '(?:\\n((?:(?! *\\n|hr|heading|blockquote|code|fences|list|html).*(?:\\n|$))*)\\n*|$)')
  .replace('hr', hr)
  .replace('heading', ' {0,3}#{1,6}(?:\\s|$)')
  .replace('blockquote', ' {0,3}>')
  .replace('code', '(?: {4}| {0,3}\t)[^\\n]')
  .replace('fences', ' {0,3}(?:`{3,}(?=[^`\\n]*(?:\\n|$))|~~~)[^\\n]*(?:\\n|$)')
  .replace('list', ' {0,3}(?:[*+-]|1[.)])[ \\t]')
  .replace('html', ' {0,3}(?:</?(?:tag)(?: +|\\n|/?>)|<(?:(?:script|pre|style|textarea)(?:[\\s>]|$)|!--)|<\\?|<![A-Za-z]|<!\\[CDATA\\[)')
  .replace('tag', _tag)
  .getRegex();

const paragraph = edit(_paragraph)
  .replace('hr', hr)
  .replace('heading', ' {0,3}#{1,6}(?:\\s|$)')
  .replace('|lheading', '')
  .replace('table', gfmTable)
  .replace('blockquote', ' {0,3}>')
  .replace('fences', ' {0,3}(?:`{3,}(?=[^`\\n]*(?:\\n|$))|~~~)[^\\n]*(?:\\n|$)')
  .replace('list', ' {0,3}(?:[*+-]|1[.)])[ \\t]+[^ \\t\\n]')
  .replace('html', ' {0,3}(?:</?(?:tag)(?: +|\\n|/?>)|<(?:(?:script|pre|style|textarea)(?:[\\s>]|$)|!--)|<\\?|<![A-Za-z]|<!\\[CDATA\\[)')
  .replace('tag', _tag)
  .getRegex();

// ---- Inline grammar (GFM) ----

const inlineEscape = /^\\([!"#$%&'()*+,\-./:;<=>?@\[\]\\^_`{|}~])/;
const inlineCode = /^(`+)([^`]|[^`][\s\S]*?[^`])\1(?!`)/;
const inlineBr = /^( {2,}|\\)\n(?!\s*$)[ \t]*/;
const _punctuation = /[\p{P}\p{S}]/u;
const _punctuationOrSpace = /[\s\p{P}\p{S}]/u;
const _notPunctuationOrSpace = /[^\s\p{P}\p{S}]/u;
const punctuation = edit(/^((?![*_])punctSpace)/, 'u')
  .replace(/punctSpace/g, _punctuationOrSpace).getRegex();
const _punctuationGfmStrongEm = /(?!~)[\p{P}\p{S}]/u;
const _punctuationOrSpaceGfmStrongEm = /(?!~)[\s\p{P}\p{S}]/u;
const _notPunctuationOrSpaceGfmStrongEm = /(?:[^\s\p{P}\p{S}]|~)/u;

const blockSkip = edit(/link|precode-code|html/, 'g')
  .replace('link', /\[(?:[^\[\]`]|(?<a>`+)[^`]+\k<a>(?!`))*?\]\((?:\\[\s\S]|[^\\\(\)]|\((?:\\[\s\S]|[^\\\(\)])*\))*\)/)
  .replace('precode-', supportsLookbehind ? '(?<!`)()' : '(^^|[^`])')
  .replace('code', /(?<b>`+)[^`]+\k<b>(?!`)/)
  .replace('html', /<(?! )[^<>]*?>/)
  .getRegex();

const emStrongLDelimCore = /^(?:\*+(?:((?!\*)punct)|([^\s*]))?)|^_+(?:((?!_)punct)|([^\s_]))?/;
const emStrongLDelim = edit(emStrongLDelimCore, 'u')
  .replace(/punct/g, _punctuationGfmStrongEm)
  .getRegex();

const emStrongRDelimAstCore =
  '^[^_*]*?__[^_*]*?\\*[^_*]*?(?=__)'
  + '|[^*]+(?=[^*])'
  + '|(?!\\*)punct(\\*+)(?=[\\s]|$)'
  + '|notPunctSpace(\\*+)(?!\\*)(?=punctSpace|$)'
  + '|(?!\\*)punctSpace(\\*+)(?=notPunctSpace)'
  + '|[\\s](\\*+)(?!\\*)(?=punct)'
  + '|(?!\\*)punct(\\*+)(?!\\*)(?=punct)'
  + '|notPunctSpace(\\*+)(?=notPunctSpace)';
const emStrongRDelimAst = edit(emStrongRDelimAstCore, 'gu')
  .replace(/notPunctSpace/g, _notPunctuationOrSpaceGfmStrongEm)
  .replace(/punctSpace/g, _punctuationOrSpaceGfmStrongEm)
  .replace(/punct/g, _punctuationGfmStrongEm)
  .getRegex();

const emStrongRDelimUnd = edit(
  '^[^_*]*?\\*\\*[^_*]*?_[^_*]*?(?=\\*\\*)'
  + '|[^_]+(?=[^_])'
  + '|(?!_)punct(_+)(?=[\\s]|$)'
  + '|notPunctSpace(_+)(?!_)(?=punctSpace|$)'
  + '|(?!_)punctSpace(_+)(?=notPunctSpace)'
  + '|[\\s](_+)(?!_)(?=punct)'
  + '|(?!_)punct(_+)(?!_)(?=punct)', 'gu')
  .replace(/notPunctSpace/g, _notPunctuationOrSpace)
  .replace(/punctSpace/g, _punctuationOrSpace)
  .replace(/punct/g, _punctuation)
  .getRegex();

const delLDelim = edit(/^~~?(?:((?!~)punct)|[^\s~])/, 'u')
  .replace(/punct/g, _punctuation)
  .getRegex();

const delRDelimCore =
  '^[^~]+(?=[^~])'
  + '|(?!~)punct(~~?)(?=[\\s]|$)'
  + '|notPunctSpace(~~?)(?!~)(?=punctSpace|$)'
  + '|(?!~)punctSpace(~~?)(?=notPunctSpace)'
  + '|[\\s](~~?)(?!~)(?=punct)'
  + '|(?!~)punct(~~?)(?!~)(?=punct)'
  + '|notPunctSpace(~~?)(?=notPunctSpace)';
const delRDelim = edit(delRDelimCore, 'gu')
  .replace(/notPunctSpace/g, _notPunctuationOrSpace)
  .replace(/punctSpace/g, _punctuationOrSpace)
  .replace(/punct/g, _punctuation)
  .getRegex();

const anyPunctuation = edit(/\\(punct)/, 'gu')
  .replace(/punct/g, _punctuation)
  .getRegex();
const anyPunctuationOutsideCode = edit(/(`+)(?:[^`]|[^`][\s\S]*?[^`])\1(?!`)|`+|\\(punct)/, 'gu')
  .replace(/punct/g, _punctuation)
  .getRegex();

const autolink = edit(/^<(scheme:[^\s\x00-\x1f<>]*|email)>/)
  .replace('scheme', /[a-zA-Z][a-zA-Z0-9+.-]{1,31}/)
  .replace('email', /[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+(@)[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)+(?![-_])/)
  .getRegex();

const _inlineComment = edit(_comment).replace('(?:-->|$)', '-->').getRegex();
const inlineTag = edit(
  '^comment'
    + '|^</[a-zA-Z][a-zA-Z0-9-]*\\s*>'
    + '|^<[a-zA-Z][a-zA-Z0-9-]*(?:attribute)*?\\s*/?>'
    + '|^<\\?[\\s\\S]*?\\?>'
    + '|^<![a-zA-Z]+\\s[\\s\\S]*?>'
    + '|^<!\\[CDATA\\[[\\s\\S]*?\\]\\]>')
  .replace('comment', _inlineComment)
  .replace('attribute', /\s+[a-zA-Z:_][\w.:-]*(?:\s*=\s*"[^"]*"|\s*=\s*'[^']*'|\s*=\s*[^\s"'=<>`]+)?/)
  .getRegex();

const _inlineLabelBrackets = /\[(?:\\[\s\S]|[^\[\]\\])*\]/;
const _inlineLabel = edit(/(?:\[(?:brackets|\\[\s\S]|[^\[\]\\])*\]|\\[\s\S]|`+(?!`)[^`]*?`+(?!`)|``+(?=\])|[^\[\]\\`])*?/)
  .replace('brackets', _inlineLabelBrackets)
  .getRegex();

const inlineLink = edit(/^!?\[(label)\]\([ \t\n]*(href)(?:(?:[ \t]+(?:\n[ \t]*)?|\n[ \t]*)(title))?[ \t\n]*\)/)
  .replace('label', _inlineLabel)
  .replace('href', /<(?:\\.|[^\n<>\\])+>|[^ \t\n\x00-\x1f]+|(?=\))/)
  .replace('title', /"(?:\\[\s\S]|[^"\\])*"|'(?:\\[\s\S]|[^'\\])*'|\((?:\\[\s\S]|[^)\\])*\)/)
  .getRegex();

const inlineReflink = edit(/^!?\[(label)\]\[(ref)\]/)
  .replace('label', _inlineLabel)
  .replace('ref', _blockLabel)
  .getRegex();

const inlineNolink = edit(/^!?\[(ref)\](?:\[\])?/)
  .replace('ref', _blockLabel)
  .getRegex();

const _boundedBlockLabel = /(?!\s*\])(?:\\[\s\S]|[^\[\]\\]){1,999}/;
const _boundedInlineLabel = edit(/(?:[^\[\]\\`]*(?:\[(?:brackets|\\[\s\S]|[^\[\]\\])*\]|\\[\s\S]|`+(?!`)[^`]*?`+(?!`)|``+(?=\]))){0,999}?[^\[\]\\`]*?/)
  .replace('brackets', _inlineLabelBrackets)
  .getRegex();

const reflinkSearch = edit('reflink|nolink(?!\\()', 'g')
  .replace('reflink', edit(/^!?\[(label)\]\[(ref)\]/)
    .replace('label', _boundedInlineLabel)
    .replace('ref', _boundedBlockLabel)
    .getRegex())
  .replace('nolink', edit(/^!?\[(ref)\](?:\[\])?/)
    .replace('ref', _boundedBlockLabel)
    .getRegex())
  .getRegex();

const _caseInsensitiveProtocol = /[hH][tT][tT][pP][sS]?|[fF][tT][pP]/;
const _extendedEmail = /[A-Za-z0-9._+-]+@[a-zA-Z0-9-_]+(?:\.[a-zA-Z0-9-_]*[a-zA-Z0-9])+(?![\w-])/;
const _extendedEmailProtocol = edit(/(?:mailto:email|xmpp:email(?:\/[A-Za-z0-9@.]+)?)/)
  .replace(/email/g, _extendedEmail)
  .getRegex();

const inlineUrl = edit(/^emailProtocol|^((?:protocol):\/\/|www\.)(?:[a-zA-Z0-9\-]+\.?)+[^\s<]*|^email/)
  .replace('emailProtocol', _extendedEmailProtocol)
  .replace('protocol', _caseInsensitiveProtocol)
  .replace('email', /[A-Za-z0-9._+-]+(@)[a-zA-Z0-9-_]+(?:\.[a-zA-Z0-9-_]*[a-zA-Z0-9])+(?![\w-])/)
  .getRegex();
const urlBackpedal = /(?:[^?!.,:;*_'"~()&]+|\([^)]*\)|&(?![a-zA-Z0-9]+;$)|[?!.,:;*_'"~)]+(?!$))+/;
const inlineDel = /^(~~?)(?=[^\s~])((?:\\[\s\S]|[^\\])*?(?:\\[\s\S]|[^\s~\\]))\1(?=[^~]|$)/;
const inlineText = edit(/^(?:[^a-zA-Z0-9](?=emailProtocol)|(`+|~+|[^`~])(?:(?=[`~])|(?= {2,}\n)|(?=[a-zA-Z0-9.!#$%&'*+\/=?_`{\|}~-]+@)|[\s\S]*?(?:(?=[\\<!\[`*~_]|\b_|protocol:\/\/|wwwStart|$)|[^ ](?= {2,}\n)|[^a-zA-Z0-9](?=emailProtocol)|[^a-zA-Z0-9.!#$%&'*+\/=?_`{\|}~-](?=[a-zA-Z0-9.!#$%&'*+\/=?_`{\|}~-]+@))))/)
  .replace('protocol', _caseInsensitiveProtocol)
  .replace(/emailProtocol/g, /(?:mailto|xmpp):/)
  .replace('wwwStart', supportsLookbehind ? '(?<![^\\s*_~(])www\\.' : 'www\\.')
  .getRegex();

// ---- Helpers ----

const escapeReplacements = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};
const getEscapeReplacement = (ch) => escapeReplacements[ch];

function escapeHtml(html, encode) {
  if (encode) {
    if (other.escapeTest.test(html)) {
      return html.replace(other.escapeReplace, getEscapeReplacement);
    }
  } else {
    if (other.escapeTestNoEncode.test(html)) {
      return html.replace(other.escapeReplaceNoEncode, getEscapeReplacement);
    }
  }
  return html;
}

function decodeNumericCharacterReferences(text) {
  if (!other.numericCharacterReference.test(text)) {
    return text;
  }
  return text.replace(other.numericCharacterReferenceOrAmpersand, (ref, dec, hex) => {
    if (dec === undefined && hex === undefined) {
      return '&amp;';
    }
    const code = dec === undefined ? Number.parseInt(hex, 16) : Number.parseInt(dec, 10);
    if (code === 0 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) {
      return '�';
    }
    return code === 38 ? '&amp;' : String.fromCodePoint(code);
  });
}

function cleanUrl(href) {
  try {
    href = encodeURI(href).replace(other.percentDecode, '%');
  } catch {
    return null;
  }
  return href;
}

// Manual splitCells: same output as marked's regex version, but linear.
// Split on unescaped '|', drop a blank first/last cell, pad/truncate to
// `count`, trim each cell and turn '\|' back into '|'.
function splitCells(tableRow, count) {
  const cells = [];
  let cur = '';
  let i = 0;
  const n = tableRow.length;
  while (i < n) {
    const ch = tableRow[i];
    if (ch === '\\') {
      let j = i;
      while (j < n && tableRow[j] === '\\') j++;
      const run = j - i;
      if (j < n && tableRow[j] === '|') {
        if (run % 2 === 1) {
          // odd run: last backslash escapes the pipe
          cur += tableRow.slice(i, j - 1) + '\\|';
          i = j + 1;
        } else {
          // even run: pipe is a delimiter, backslashes stay in the cell
          cur += tableRow.slice(i, j);
          cells.push(cur);
          cur = '';
          i = j + 1;
        }
        continue;
      }
      cur += tableRow.slice(i, j);
      i = j;
      continue;
    }
    if (ch === '|') {
      cells.push(cur);
      cur = '';
      i++;
      continue;
    }
    cur += ch;
    i++;
  }
  cells.push(cur);

  if (!cells[0].trim()) {
    cells.shift();
  }
  if (cells.length > 0 && !cells[cells.length - 1].trim()) {
    cells.pop();
  }

  if (count) {
    if (cells.length > count) {
      cells.length = count;
    } else {
      while (cells.length < count) cells.push('');
    }
  }

  for (let j = 0; j < cells.length; j++) {
    cells[j] = cells[j].trim().replace(other.slashPipe, '|');
  }
  return cells;
}

function rtrim(str, c, invert) {
  const l = str.length;
  if (l === 0) {
    return '';
  }
  let suffLen = 0;
  while (suffLen < l) {
    const currChar = str.charAt(l - suffLen - 1);
    if (currChar === c && !invert) {
      suffLen++;
    } else if (currChar !== c && invert) {
      suffLen++;
    } else {
      break;
    }
  }
  return str.slice(0, l - suffLen);
}

function trimTrailingBlankLines(str) {
  const lines = str.split('\n');
  let end = lines.length - 1;
  while (end >= 0 && other.blankLine.test(lines[end])) {
    end--;
  }
  if (lines.length - end <= 2) {
    return str;
  }
  return lines.slice(0, end + 1).join('\n');
}

function normalizeLabel(label) {
  return label.trim().replace(other.multipleSpaceGlobal, ' ').toLowerCase().toUpperCase().toLowerCase();
}

function findClosingBracket(str, b) {
  if (str.indexOf(b[0]) === -1 && str.indexOf(b[1]) === -1) {
    return -1;
  }
  let level = 0;
  for (let i = 0; i < str.length; i++) {
    if (str[i] === '\\') {
      i++;
    } else if (str[i] === b[0]) {
      level++;
    } else if (str[i] === b[1]) {
      level--;
      if (level < 0) {
        return i;
      }
    }
  }
  if (level > 0) {
    return -2;
  }
  return -1;
}

function expandTabs(line, indent = 0) {
  let col = indent;
  let expanded = '';
  for (const char of line) {
    if (char === '\t') {
      const added = 4 - (col % 4);
      expanded += ' '.repeat(added);
      col += added;
    } else {
      expanded += char;
      col++;
    }
  }
  return expanded;
}

function indentCodeCompensation(raw, text) {
  const matchIndentToCode = raw.match(other.indentCodeCompensation);
  if (matchIndentToCode === null) {
    return text;
  }
  const indentToCode = matchIndentToCode[1];
  return text
    .split('\n')
    .map((node) => {
      const matchIndentInNode = node.match(other.beginningSpace);
      if (matchIndentInNode === null) {
        return node;
      }
      const [indentInNode] = matchIndentInNode;
      return node.slice(Math.min(indentInNode.length, indentToCode.length));
    })
    .join('\n');
}

// Scan one masked source for the last runs that can close emphasis/strong
// ('*' / '_') and strikethrough ('~'). A run can close only when it is not
// preceded by ASCII whitespace or the start of the string.
function scanClosers(src) {
  let star = -1;
  let under = -1;
  let tilde = -1;
  const len = src.length;
  for (let i = 0; i < len; i++) {
    const ch = src[i];
    if (ch !== '*' && ch !== '_' && ch !== '~') {
      continue;
    }
    const prev = i === 0 ? '\n' : src[i - 1];
    let j = i + 1;
    while (j < len && src[j] === ch) {
      j++;
    }
    if (prev !== ' ' && prev !== '\t' && prev !== '\n' && prev !== '\r' && prev !== '\f') {
      if (ch === '~') tilde = i;
      else if (ch === '*') star = i;
      else under = i;
    }
    i = j - 1;
  }
  return { maskedSrc: src, star, under, tilde };
}

function lastPossibleCloser(ctx, maskedSrc, delim) {
  const frame = ctx.closerStack[ctx.closerStack.length - 1];
  if (frame && frame.maskedSrc === maskedSrc) {
    return delim === '~' ? frame.tilde : delim === '*' ? frame.star : frame.under;
  }
  const f = scanClosers(maskedSrc);
  return delim === '~' ? f.tilde : delim === '*' ? f.star : f.under;
}

// ---- Per-call context & rendering ----
// An `out` array holds block records in document order:
//   {k:'s', s, raw}            raw HTML chunk (code, hr, html block)
//   {k:'p', src, raw}          paragraph (inline slot)
//   {k:'t', src, raw}          text block (inline slot, no <p> wrapper)
//   {k:'h', src, raw, depth}   heading (inline slot)
//   {k:'bq', out, raw, text}   blockquote (nested out array)
//   {k:'list', ...}            list (items hold nested out arrays)
//   {k:'table', header, rows}  table (cells hold inline src)
//   {k:'def', raw}             link reference definition (renders '')
// Inline slots are rendered only after the whole block scan, in document
// order — exactly when marked's deferred inline queue runs, so link
// definitions anywhere in the document apply everywhere.

function newCtx() {
  return {
    links: Object.create(null),
    inLink: false,
    inRawBlock: false,
    linkEmitted: false,
    linkParenPossible: true,
    top: true,
    closerStack: [],
    queue: [],
    linkCount: 0,
  };
}

function renderCode(text, lang) {
  const langString = (lang || '').match(other.notSpaceStart)?.[0];
  const code = text ? text.replace(other.endingNewline, '') + '\n' : '';
  if (!langString) {
    return '<pre><code>' + escapeHtml(code, true) + '</code></pre>\n';
  }
  return '<pre><code class="language-' + escapeHtml(langString) + '">'
    + escapeHtml(code, true) + '</code></pre>\n';
}

function inlineSlot(ctx, src) {
  // an inline <pre>/<code>/<kbd>/<script> left open ends with the block
  // holding it; carried over, it would stop every later block's text from
  // being escaped
  ctx.inRawBlock = false;
  return inlineToHtml(ctx, src);
}

function renderCell(ctx, c) {
  const tag = c.header ? 'th' : 'td';
  const open = c.align ? '<' + tag + ' align="' + c.align + '">' : '<' + tag + '>';
  return open + inlineSlot(ctx, c.src) + '</' + tag + '>\n';
}

function renderTable(ctx, it) {
  let header = '';
  for (const c of it.header) header += renderCell(ctx, c);
  header = '<tr>\n' + header + '</tr>\n';
  let body = '';
  for (const row of it.rows) {
    let cell = '';
    for (const c of row) cell += renderCell(ctx, c);
    body += '<tr>\n' + cell + '</tr>\n';
  }
  if (body) body = '<tbody>' + body + '</tbody>';
  return '<table>\n<thead>\n' + header + '</thead>\n' + body + '</table>\n';
}

function renderList(ctx, it) {
  let body = '';
  for (const item of it.items) {
    body += '<li>' + (item.lead || '') + renderOut(ctx, item.out) + '</li>\n';
  }
  const type = it.ordered ? 'ol' : 'ul';
  const startAttr = (it.ordered && it.start !== 1) ? (' start="' + it.start + '"') : '';
  return '<' + type + startAttr + '>\n' + body + '</' + type + '>\n';
}

function renderItem(ctx, it) {
  switch (it.k) {
    case 's': return it.s;
    case 'p': return '<p>' + (it.pre || '') + inlineSlot(ctx, it.src) + '</p>\n';
    case 't': return (it.pre || '') + inlineSlot(ctx, it.src);
    case 'h': return '<h' + it.depth + '>' + inlineSlot(ctx, it.src) + '</h' + it.depth + '>\n';
    case 'def': return '';
    case 'space': return '';
    case 'bq': return '<blockquote>\n' + renderOut(ctx, it.out) + '</blockquote>\n';
    case 'list': return renderList(ctx, it);
    case 'table': return renderTable(ctx, it);
  }
  return '';
}

function renderOut(ctx, out) {
  let s = '';
  for (let i = 0; i < out.length; i++) s += renderItem(ctx, out[i]);
  return s;
}

// ---- Block emitters (return a record, or null) ----

function emitDef(ctx, src) {
  const cap = def.exec(src);
  if (!cap) return null;
  if (!other.startAngleBracket.test(cap[2]) && findClosingBracket(cap[2], '()') !== -1) {
    return null;
  }
  const tag = normalizeLabel(cap[1]);
  const href = cap[2] ? cap[2].replace(other.hrefBrackets, '$1').replace(anyPunctuation, '$1') : '';
  const title = cap[3] ? cap[3].substring(1, cap[3].length - 1).replace(anyPunctuation, '$1') : cap[3];
  return { tag, href, title, raw: rtrim(cap[0], '\n') };
}

function emitTable(ctx, src) {
  const cap = gfmTable.exec(src);
  if (!cap) return null;
  if (!other.tableDelimiter.test(cap[2])) {
    return null;
  }
  const headers = splitCells(cap[1]);
  const aligns = cap[2].replace(other.tableAlignChars, '').split('|');
  const rows = cap[3] && cap[3].trim() ? cap[3].replace(other.tableRowBlankLine, '').split('\n') : [];
  if (headers.length !== aligns.length) {
    return null;
  }
  const align = [];
  for (const a of aligns) {
    if (other.tableAlignRight.test(a)) align.push('right');
    else if (other.tableAlignCenter.test(a)) align.push('center');
    else if (other.tableAlignLeft.test(a)) align.push('left');
    else align.push(null);
  }
  return {
    k: 'table',
    raw: rtrim(cap[0], '\n'),
    header: headers.map((h, i) => {
      const c = { src: h, align: align[i], header: true };
      ctx.queue.push(c);
      return c;
    }),
    rows: rows.map((row) => splitCells(row, headers.length).map((cell, i) => {
      const c = { src: cell, align: align[i], header: false };
      ctx.queue.push(c);
      return c;
    })),
  };
}

function lastItem(out) {
  return out.length ? out[out.length - 1] : undefined;
}

function isParaOrText(it) {
  return !!it && (it.k === 'p' || it.k === 't');
}

// ---- Block scanner ----
function blockTokens(ctx, src, out, lastParagraphClipped = false, spaces = null) {
  let srcLength = Infinity;
  while (src) {
    if (src.length < srcLength) {
      srcLength = src.length;
    } else {
      throw new Error('Infinite loop on byte: ' + src.charCodeAt(0));
    }

    const c0 = src.charCodeAt(0);
    // first significant char (up to 3 leading spaces)
    let j = 0;
    while (j < 3 && src.charCodeAt(j) === 32) j++;
    const fc = src.charCodeAt(j);

    // newline / space
    if (c0 === 10 || c0 === 32 || c0 === 9) {
      const cap = newline.exec(src);
      if (cap && cap[0].length > 0) {
        const raw = cap[0];
        src = src.substring(raw.length);
        const last = lastItem(out);
        if (raw.length === 1 && last !== undefined) {
          last.raw += '\n';
        } else {
          // A space token is a real record: it stops the next indented-code
          // block, definition or text run from merging into the last block.
          out.push({ k: 'space', raw });
          if (spaces) spaces.push(raw);
        }
        continue;
      }
    }

    // indented code
    if (c0 === 32 || c0 === 9) {
      const cap = blockCode.exec(src);
      if (cap) {
        const raw = trimTrailingBlankLines(cap[0]);
        const text = raw.replace(other.codeRemoveIndent, '');
        src = src.substring(raw.length);
        const last = lastItem(out);
        if (isParaOrText(last)) {
          last.raw += (last.raw.endsWith('\n') ? '' : '\n') + raw;
          last.src += '\n' + text;
        } else {
          out.push({ k: 's', sub: 'code', raw, s: renderCode(text, null) });
        }
        continue;
      }
    }

    // fences
    if (fc === 96 || fc === 126) {
      const cap = fences.exec(src);
      if (cap) {
        const raw = cap[0];
        const text = indentCodeCompensation(raw, cap[3] || '');
        const lang = cap[2] ? cap[2].trim().replace(anyPunctuation, '$1') : cap[2];
        src = src.substring(raw.length);
        out.push({ k: 's', sub: 'code', raw, s: renderCode(text, lang) });
        continue;
      }
    }

    // heading
    if (fc === 35) {
      const cap = heading.exec(src);
      if (cap) {
        let text = cap[2].trim();
        if (other.endingHash.test(text)) {
          const trimmed = rtrim(text, '#');
          if (!trimmed || other.endingSpaceTabChar.test(trimmed)) {
            text = trimmed.trim();
          }
        }
        const raw = rtrim(cap[0], '\n');
        src = src.substring(raw.length);
        out.push(mkSlot(ctx, { k: 'h', src: text, raw, depth: cap[1].length }));
        continue;
      }
    }

    // hr
    if (fc === 45 || fc === 95 || fc === 42) {
      const cap = hr.exec(src);
      if (cap) {
        const raw = rtrim(cap[0], '\n');
        src = src.substring(raw.length);
        out.push({ k: 's', sub: 'hr', raw, s: '<hr>\n' });
        continue;
      }
    }

    // blockquote
    if (fc === 62) {
      const bq = emitBlockquote(ctx, src);
      if (bq) {
        src = src.substring(bq.raw.length);
        out.push(bq);
        continue;
      }
    }

    // list
    if (fc === 42 || fc === 43 || fc === 45 || (fc >= 48 && fc <= 57)) {
      const lst = emitList(ctx, src);
      if (lst) {
        src = src.substring(lst.raw.length);
        out.push(lst);
        continue;
      }
    }

    // html block
    if (fc === 60) {
      const cap = html.exec(src);
      if (cap) {
        const raw = trimTrailingBlankLines(cap[0]);
        src = src.substring(raw.length);
        out.push({ k: 's', sub: 'html', raw, s: raw });
        continue;
      }
    }

    // def
    if (fc === 91) {
      const d = emitDef(ctx, src);
      if (d) {
        src = src.substring(d.raw.length);
        const last = lastItem(out);
        if (isParaOrText(last)) {
          last.raw += (last.raw.endsWith('\n') ? '' : '\n') + d.raw;
          last.src += '\n' + d.raw;
        } else {
          if (!ctx.links[d.tag]) {
            ctx.links[d.tag] = { href: d.href, title: d.title };
            ctx.linkCount++;
          }
          out.push({ k: 'def', raw: d.raw });
        }
        continue;
      }
    }

    // table (needs a second line holding '-' in the delimiter row)
    if (src.indexOf('\n') > 0) {
      const nl = src.indexOf('\n');
      const nl2 = src.indexOf('\n', nl + 1);
      const line2 = src.slice(nl + 1, nl2 === -1 ? src.length : nl2);
      if (line2.indexOf('-') !== -1) {
        const t = emitTable(ctx, src);
        if (t) {
          src = src.substring(t.raw.length);
          out.push(t);
          continue;
        }
      }
    }

    // lheading: a setext underline may sit on any line of the paragraph
    // text (not just line 2), so scan for one before the next blank line.
    if (src.indexOf('\n') > 0) {
      let k = src.indexOf('\n');
      let hasSetext = false;
      while (k !== -1) {
        const e = src.indexOf('\n', k + 1);
        const line = src.slice(k + 1, e === -1 ? src.length : e);
        if (/^[ \t]*$/.test(line)) break;
        if (/^ {0,3}(=+|-+)[ \t]*$/.test(line)) { hasSetext = true; break; }
        k = e;
      }
      if (hasSetext) {
        const cap = lheading.exec(src);
        if (cap) {
          const text = cap[1].trim();
          const raw = rtrim(cap[0], '\n');
          src = src.substring(raw.length);
          out.push(mkSlot(ctx, { k: 'h', src: text, raw, depth: cap[2].charAt(0) === '=' ? 1 : 2 }));
          continue;
        }
      }
    }

    // paragraph (top level only)
    if (ctx.top) {
      const cap = paragraph.exec(src);
      if (cap) {
        const text = cap[1].charAt(cap[1].length - 1) === '\n' ? cap[1].slice(0, -1) : cap[1];
        const last = lastItem(out);
        if (lastParagraphClipped && last && last.k === 'p') {
          last.raw += (last.raw.endsWith('\n') ? '' : '\n') + cap[0];
          last.src += '\n' + text;
        } else {
          out.push(mkSlot(ctx, { k: 'p', src: text, raw: cap[0] }));
        }
        lastParagraphClipped = false;
        src = src.substring(cap[0].length);
        continue;
      }
    }

    // text
    {
      const cap = blockText.exec(src);
      if (cap) {
        const last = lastItem(out);
        if (last && last.k === 't') {
          last.raw += (last.raw.endsWith('\n') ? '' : '\n') + cap[0];
          last.src += '\n' + cap[0];
        } else {
          out.push(mkSlot(ctx, { k: 't', src: cap[0], raw: cap[0] }));
        }
        src = src.substring(cap[0].length);
        continue;
      }
    }

    if (src) {
      throw new Error('Infinite loop on byte: ' + src.charCodeAt(0));
    }
  }

  ctx.top = true;
  return out;
}

// ---- Blockquote & list ----

// Expand leading tabs of a line (tabs run to the next tab stop). When the
// leading whitespace holds no tab, the line is unchanged.
function expandLeadingTabs(str, indent = 0) {
  const m = /^[ \t]+/.exec(str);
  if (!m || m[0].indexOf('\t') === -1) return str;
  return expandTabs(m[0], indent) + str.slice(m[0].length);
}

// Every inline slot is also appended to ctx.queue in creation order: that
// is marked's deferred inline queue, and the list checkbox pass searches
// it from the end.
function mkSlot(ctx, slot) {
  ctx.queue.push(slot);
  return slot;
}

function emitBlockquote(ctx, src) {
  const cap = blockquote.exec(src);
  if (!cap) return null;
  let lines = rtrim(cap[0], '\n').split('\n');
  let raw = '';
  let text = '';
  const out = [];

  while (lines.length > 0) {
    let inBlockquote = false;
    const currentLines = [];
    let i;
    for (i = 0; i < lines.length; i++) {
      if (other.blockquoteStart.test(lines[i])) {
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
      .replace(
        other.blockquoteMarkerWhitespace,
        (_, marker, whitespace) => marker + expandTabs(whitespace, marker.length),
      )
      .replace(other.blockquoteSetextReplace, '\n    $1')
      .replace(other.blockquoteSetextReplace2, '');
    raw = raw ? `${raw}\n${currentRaw}` : currentRaw;
    text = text ? `${text}\n${currentText}` : currentText;

    const top = ctx.top;
    ctx.top = true;
    blockTokens(ctx, currentText, out, true);
    ctx.top = top;

    if (lines.length === 0) {
      break;
    }

    const lastToken = out[out.length - 1];
    if (lastToken && (lastToken.k === 'h' || lastToken.k === 'table' || lastToken.k === 's')) {
      // blockquote continuation cannot be preceded by a code block, heading,
      // hr, html block or table
      break;
    } else if (lastToken && lastToken.k === 'bq') {
      const oldToken = lastToken;
      const continuation = lines.join('\n');
      const newText = oldToken.raw + '\n' + continuation.replace(other.blockquoteSetextReplace2, '');
      const newToken = emitBlockquote(ctx, newText);
      if (!newToken) break;
      out[out.length - 1] = newToken;
      const leftover = newText.substring(newToken.raw.length).replace(/^\n/, '');
      const leftoverCount = leftover ? leftover.split('\n').length : 0;
      const consumed = leftoverCount ? lines.slice(0, -leftoverCount) : lines;
      if (consumed.length > 0) {
        raw = `${raw}\n${consumed.join('\n')}`;
      }
      text = text.substring(0, text.length - oldToken.text.length) + newToken.text;
      lines = lines.slice(consumed.length);
      if (lines.length > 0 && other.blockquoteStart.test(lines[0])) {
        continue;
      }
      break;
    } else if (lastToken && lastToken.k === 'list') {
      const oldToken = lastToken;
      const newText = oldToken.raw + '\n' + lines.join('\n');
      const newToken = emitList(ctx, newText);
      if (!newToken) break;
      out[out.length - 1] = newToken;
      const consumedCount = newToken.raw.length > oldToken.raw.length
        ? newText.slice(oldToken.raw.length + 1, newToken.raw.length).split('\n').length
        : 0;
      if (consumedCount > 0) {
        const consumed = lines.slice(0, consumedCount).join('\n');
        raw = `${raw}\n${consumed}`;
        text = `${text}\n${consumed}`;
      }
      lines = lines.slice(consumedCount);
      continue;
    }
  }

  return { k: 'bq', raw, text, out };
}

function emitList(ctx, src) {
  let cap = list.exec(src);
  if (!cap) return null;
  const listSrc = src;
  let s = src;
  const taken = () => listSrc.length - s.length;
  let bull = cap[1].trim();
  const isordered = bull.length > 1;

  const lst = {
    k: 'list',
    raw: '',
    ordered: isordered,
    start: isordered ? +bull.slice(0, -1) : '',
    loose: false,
    items: [],
  };

  bull = isordered ? `\\d{1,9}\\${bull.slice(-1)}` : `\\${bull}`;

  const itemRegex = other.listItemRegex(bull);
  let endsWithBlankLine = false;
  while (s) {
    let endEarly = false;
    let itemContents = '';
    if (!(cap = itemRegex.exec(s))) {
      break;
    }
    if (hr.test(s)) {
      break;
    }

    const itemStart = taken();
    s = s.substring(cap[0].length);

    const firstLine = cap[2].split('\n', 1)[0];
    const bulletIndent = cap[1].length;
    let line = expandLeadingTabs(firstLine, bulletIndent);
    let nextLine = s.split('\n', 1)[0];
    let blankLine = !line.trim();

    let indent = 0;
    if (blankLine) {
      indent = bulletIndent + 1;
    } else {
      indent = line.search(other.nonSpaceChar);
      indent = indent > 4 ? 1 : indent;
      itemContents = line.slice(indent);
      indent += bulletIndent;
    }

    if (blankLine && other.blankLine.test(nextLine)) {
      s = s.substring(nextLine.length + 1);
      endEarly = true;
    }

    if (!endEarly) {
      const nextBulletRegex = other.nextBulletRegex(indent);
      const hrRegex = other.hrRegex(indent);
      const fencesBeginRegex = other.fencesBeginRegex(indent);
      const headingBeginRegex = other.headingBeginRegex(indent);
      const htmlBeginRegex = other.htmlBeginRegex(indent);
      const blockquoteBeginRegex = other.blockquoteBeginRegex(indent);

      while (s) {
        const rawLine = s.split('\n', 1)[0];
        nextLine = rawLine;
        const nextLineWithoutTabs = expandLeadingTabs(nextLine);
        // First significant char (within the indent the begin-regexes allow):
        // most continuation lines match none of the six tests, so skip the
        // regexes entirely unless the char could start one.
        let p = 0;
        while (p < indent && nextLine.charCodeAt(p) === 32) p++;
        const fc = nextLine.charCodeAt(p);

        if ((fc === 96 || fc === 126) && fencesBeginRegex.test(nextLine)) break;
        if (fc === 35 && headingBeginRegex.test(nextLine)) break;
        if (fc === 60 && htmlBeginRegex.test(nextLine)) break;
        if (fc === 62 && blockquoteBeginRegex.test(nextLine)) break;
        if ((fc === 42 || fc === 43 || fc === 45 || (fc >= 48 && fc <= 57)) && nextBulletRegex.test(nextLine)) break;
        if ((fc === 45 || fc === 95 || fc === 42) && hrRegex.test(nextLine)) break;

        if (nextLineWithoutTabs.search(other.nonSpaceChar) >= indent || !nextLine.trim()) {
          itemContents += '\n' + nextLineWithoutTabs.slice(indent);
        } else {
          if (blankLine) break;
          if (line.replace(other.tabCharGlobal, '    ').search(other.nonSpaceChar) >= 4) break;
          let q = 0;
          while (q < indent && line.charCodeAt(q) === 32) q++;
          const lfc = line.charCodeAt(q);
          if ((lfc === 96 || lfc === 126) && fencesBeginRegex.test(line)) break;
          if (lfc === 35 && headingBeginRegex.test(line)) break;
          if (lfc === 60 && htmlBeginRegex.test(line)) break;
          if ((lfc === 45 || lfc === 95 || lfc === 42) && hrRegex.test(line)) break;

          const setextContinuation = /^ {0,3}(?:=+|-+) *$/.test(nextLine)
            && lheading.test(`${line}\n${nextLine}`);
          const continuation = setextContinuation
            ? `    ${nextLineWithoutTabs.replace(/^ {0,3}/, '')}`
            : nextLine;
          itemContents += '\n' + continuation;
        }

        blankLine = !nextLine.trim();
        s = s.substring(rawLine.length + 1);
        line = nextLineWithoutTabs.slice(indent);
      }
    }

    const raw = listSrc.slice(itemStart, taken());

    if (!lst.loose) {
      if (endsWithBlankLine) {
        lst.loose = true;
      } else if (other.doubleBlankLine.test(raw)) {
        endsWithBlankLine = true;
      }
    }

    lst.items.push({
      raw,
      task: other.listIsTask.test(itemContents),
      loose: false,
      text: itemContents,
      out: [],
      spaces: [],
    });
  }

  const lastItemRec = lst.items[lst.items.length - 1];
  if (lastItemRec) {
    lastItemRec.raw = lastItemRec.raw.trimEnd();
    lastItemRec.text = lastItemRec.text.trimEnd();
  } else {
    return null;
  }
  lst.raw = listSrc.slice(0, taken()).trimEnd();

  // Item child tokens
  for (const item of lst.items) {
    ctx.top = false;
    blockTokens(ctx, item.text, item.out, false, item.spaces);
    if (!lst.loose) {
      const hasMultipleLineBreaks = item.spaces.length > 0
        && item.spaces.some((t) => other.anyLine.test(t));
      lst.loose = hasMultipleLineBreaks;
    }
  }

  // Task checkboxes, using the final list.loose
  for (const item of lst.items) {
    const itemToken = item.out[0];
    if (item.task && itemToken && (itemToken.k === 't' || itemToken.k === 'p')) {
      item.text = item.text.replace(other.listReplaceTask, '');
      itemToken.raw = itemToken.raw.replace(other.listReplaceTask, '');
      for (let i = ctx.queue.length - 1; i >= 0; i--) {
        if (other.listIsTask.test(ctx.queue[i].src)) {
          ctx.queue[i].src = ctx.queue[i].src.replace(other.listReplaceTask, '');
          break;
        }
      }

      const taskRaw = other.listTaskCheckbox.exec(item.raw);
      if (taskRaw) {
        const checked = taskRaw[0] !== '[ ]';
        const cbHtml = '<input ' + (checked ? 'checked="" ' : '') + 'disabled="" type="checkbox"> ';
        item.checked = checked;
        if (lst.loose) {
          itemToken.pre = cbHtml;
        } else {
          item.lead = cbHtml;
        }
      }
    } else if (item.task) {
      item.task = false;
    }
  }

  // Set all items to loose if list is loose
  if (lst.loose) {
    for (const item of lst.items) {
      item.loose = true;
      for (const token of item.out) {
        if (token.k === 't') {
          token.k = 'p';
        }
      }
    }
  }

  return lst;
}

// ---- Inline scanner ----

// Fast path: a run with no inline-significant characters renders as-is.
// Excluded: backslash escapes, tags, links/images, emphasis, code spans,
// strikethrough, entities, quotes, 'www.' / protocol autolinks, emails,
// and the two-spaces-before-newline hard break.
const plainInlineTest = /[\\<>[\]!*_`~&"']|www\.|:\/\/|  +\n/;
const plainEmailTest = /[A-Za-z0-9._+\-]+@[A-Za-z0-9]/;
function isPlainInline(src) {
  return !plainInlineTest.test(src) && !plainEmailTest.test(src);
}

function inlineToHtml(ctx, src) {
  if (src.length === 0) return '';
  if (isPlainInline(src)) return src;
  return inlineTokens(ctx, src, false);
}

function inlineTokens(ctx, src, textMode) {
  const prevLinkParenPossible = ctx.linkParenPossible;
  ctx.linkParenPossible = prevLinkParenPossible && src.includes(')');
  try {
    return inlineTokensInner(ctx, src, textMode);
  } finally {
    ctx.linkParenPossible = prevLinkParenPossible;
  }
}

function inlineTokensInner(ctx, src, textMode) {
  const maskedSrc = (src.includes('*') || src.includes('_') || src.includes('~'))
    ? maskSrc(ctx, src)
    : src;
  ctx.closerStack.push(scanClosers(maskedSrc));
  try {
    return tokenizeInlines(ctx, src, maskedSrc, textMode);
  } finally {
    ctx.closerStack.pop();
  }
}

function tokenizeInlines(ctx, src, maskedSrc, textMode) {
  let out = '';
  let keepPrevChar = false;
  let prevChar = '';
  let srcLength = Infinity;
  while (src) {
    if (src.length < srcLength) {
      srcLength = src.length;
    } else {
      throw new Error('Infinite loop on byte: ' + src.charCodeAt(0));
    }
    if (!keepPrevChar) {
      prevChar = '';
    }
    keepPrevChar = false;

    const c = src.charCodeAt(0);
    let res = null;
    if (c === 92) { // backslash
      res = inlineEscapeFn(src, textMode) || inlineBrFn(src, textMode);
    } else if (c === 60) { // <
      res = inlineTagFn(ctx, src) || inlineAutolinkFn(src, textMode);
    } else if (c === 91 || (c === 33 && src.charCodeAt(1) === 91)) { // [ or ![
      res = inlineLinkFn(ctx, src, textMode) || inlineReflinkFn(ctx, src, textMode);
    } else if (c === 42 || c === 95) { // * _
      // '*' cannot start a url; '_' can (email local part), so try url
      // after emStrong — marked tries url before text as well.
      res = inlineEmStrongFn(ctx, src, maskedSrc, prevChar, textMode)
        || (c === 95 && !ctx.inLink ? inlineUrlFn(src, textMode) : null);
    } else if (c === 96) { // `
      res = inlineCodespanFn(src, textMode);
    } else if (c === 32) { // space: possible hard break
      res = inlineBrFn(src, textMode);
    } else if (c === 126) { // ~
      res = inlineDelFn(ctx, src, maskedSrc, prevChar, textMode);
    } else if (!ctx.inLink && ((c >= 65 && c <= 90) || (c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 46 || c === 43 || c === 45)) {
      // url can also start with '.', '+' or '-' (email local part)
      res = inlineUrlFn(src, textMode);
    }

    if (res) {
      out += res.html;
      src = src.substring(res.len);
      continue;
    }

    const t = inlineTextFn(ctx, src, textMode);
    if (t) {
      out += t.html;
      if (t.raw.charAt(t.raw.length - 1) !== '_') {
        prevChar = t.raw.charAt(t.raw.length - 1);
      }
      keepPrevChar = true;
      src = src.substring(t.len);
      continue;
    }

    if (src) {
      throw new Error('Infinite loop on byte: ' + src.charCodeAt(0));
    }
  }
  return out;
}

function linkInText(ctx, text) {
  if (!text.includes('[')) {
    return false;
  }
  for (const match of text.matchAll(blockSkip)) {
    if (inlineLink.test(match[0]) && text.charAt(match.index - 1) !== '!') {
      return true;
    }
  }
  for (const match of text.matchAll(reflinkSearch)) {
    const match0 = match[0];
    const refStart = match0.lastIndexOf('[');
    if (match0.charAt(0) === '!' || !Object.hasOwn(ctx.links, normalizeLabel(match0.slice(refStart + 1, -1)))) {
      continue;
    }
    if (refStart > 1 && linkInText(ctx, match0.slice(1, refStart - 1))) {
      continue;
    }
    return true;
  }
  return false;
}

function maskSrc(ctx, src) {
  let maskedSrc = src;
  // The reflink mask is the identity when no link definition exists yet.
  if (ctx.linkCount > 0 && src.includes('[')) {
    const maskReflink = (match0) => {
      const refStart = match0.lastIndexOf('[');
      if (!Object.hasOwn(ctx.links, normalizeLabel(match0.slice(refStart + 1, -1)))) {
        return match0;
      }
      if (refStart > 1 && match0.charAt(0) !== '!') {
        const text = match0.slice(1, refStart - 1);
        if (linkInText(ctx, text)) {
          return '[' + text.replace(reflinkSearch, maskReflink)
            + '][' + 'a'.repeat(match0.length - refStart - 2) + ']';
        }
      }
      return '[' + 'a'.repeat(match0.length - 2) + ']';
    };
    maskedSrc = maskedSrc.replace(reflinkSearch, maskReflink);
  }

  // anyPunctuationOutsideCode only matches code spans (`) or escapes (\).
  if (src.indexOf('`') !== -1 || src.indexOf('\\') !== -1) {
    maskedSrc = maskedSrc.replace(anyPunctuationOutsideCode, (match0, code, punct) => {
      if (punct) {
        return '+'.repeat(match0.length);
      }
      if (code) {
        return code + match0.slice(code.length, -code.length).replace(/`/g, '+') + code;
      }
      return match0;
    });
  }

  // blockSkip only matches links ([), code spans (`) or tags (<).
  if (src.indexOf('[') !== -1 || src.indexOf('`') !== -1 || src.indexOf('<') !== -1) {
    maskedSrc = maskedSrc.replace(blockSkip, (match0, _link, context) => {
      const offset = context ? context.length : 0;
      return match0.slice(0, offset) + '[' + 'a'.repeat(match0.length - offset - 2) + ']';
    });
  }

  return maskedSrc;
}

function isLabelEndInsideToken(src, label, labelStart) {
  if (!label.includes('<')) {
    return false;
  }
  for (let i = 0; i < label.length; i++) {
    if (label[i] === '\\') {
      i++;
      continue;
    }
    if (label[i] === '`') {
      const code = inlineCode.exec(label.slice(i));
      if (code) {
        i += code[0].length - 1;
        continue;
      }
    }
    if (label[i] !== '<') {
      continue;
    }
    const tokenSrc = src.slice(labelStart + i);
    const token = inlineTag.exec(tokenSrc) || autolink.exec(tokenSrc);
    if (!token) {
      continue;
    }
    if (token[0].length > label.length - i) {
      return true;
    }
    i += token[0].length - 1;
  }
  return false;
}

function renderLink(href, title, parsedText, autolink) {
  const cleanHref = cleanUrl(href);
  if (cleanHref === null) {
    return parsedText;
  }
  const h = escapeHtml(cleanHref, autolink);
  let out = '<a href="' + h + '"';
  if (title) {
    out += ' title="' + escapeHtml(title) + '"';
  }
  out += '>' + parsedText + '</a>';
  return out;
}

function renderImage(href, title, text) {
  const cleanHref = cleanUrl(href);
  if (cleanHref === null) {
    return escapeHtml(text);
  }
  let out = `<img src="${escapeHtml(cleanHref)}" alt="${escapeHtml(text)}"`;
  if (title) {
    out += ` title="${escapeHtml(title)}"`;
  }
  out += '>';
  return out;
}

function outputLink(ctx, cap, link, raw, textMode) {
  const href = link.href;
  const title = link.title || null;
  const text = cap[1].replace(other.outputLinkReplace, '$1');
  const isImage = cap[0].charAt(0) === '!';

  const outerInLink = ctx.inLink;
  const outerLinkEmitted = ctx.linkEmitted;
  const outerInRawBlock = ctx.inRawBlock;
  ctx.inLink = true;
  ctx.linkEmitted = false;
  // An image flattens its label into alt text; a link renders its label as
  // HTML. In text mode everything flattens.
  const inner = inlineTokens(ctx, text, textMode ? true : isImage);
  const textHasLink = ctx.linkEmitted;
  ctx.linkEmitted = outerLinkEmitted;
  ctx.inLink = outerInLink;

  if (!isImage) {
    // Links may not contain other links, at any level of nesting.
    if (textHasLink) {
      ctx.inRawBlock = outerInRawBlock;
      return null;
    }
    ctx.linkEmitted = true;
  }

  if (textMode) {
    return { html: inner, len: raw.length };
  }
  if (isImage) {
    return { html: renderImage(href, title, inner), len: raw.length };
  }
  return { html: renderLink(href, title, inner, false), len: raw.length };
}

function inlineLinkFn(ctx, src, textMode) {
  if (ctx.linkParenPossible === false) {
    return null;
  }
  const cap = inlineLink.exec(src);
  if (!cap) return null;
  const labelStart = cap[0].charAt(0) === '!' ? 2 : 1;
  if (isLabelEndInsideToken(src, cap[1], labelStart)) {
    return null;
  }
  const trimmedUrl = cap[2].trim();
  if (other.startAngleBracket.test(trimmedUrl)) {
    if (!other.endAngleBracket.test(trimmedUrl)) {
      return null;
    }
    const rtrimSlash = rtrim(trimmedUrl.slice(0, -1), '\\');
    if ((trimmedUrl.length - rtrimSlash.length) % 2 === 0) {
      return null;
    }
  } else {
    const lastParenIndex = findClosingBracket(cap[2], '()');
    if (lastParenIndex === -2) {
      return null;
    }
    if (lastParenIndex > -1) {
      const start = cap[0].indexOf('!') === 0 ? 5 : 4;
      const linkLen = start + cap[1].length + lastParenIndex;
      cap[2] = cap[2].substring(0, lastParenIndex);
      cap[0] = cap[0].substring(0, linkLen).trim();
      cap[3] = '';
    }
  }
  const unescaped = rtrim(cap[0].slice(0, -1), '\\');
  if ((cap[0].length - unescaped.length) % 2 === 0) {
    return null;
  }
  let href = cap[2];
  const title = cap[3] ? cap[3].slice(1, -1) : '';
  href = href.trim();
  if (other.startAngleBracket.test(href)) {
    href = href.slice(1, -1);
  }
  return outputLink(ctx, cap, {
    href: href ? href.replace(anyPunctuation, '$1') : href,
    title: title ? title.replace(anyPunctuation, '$1') : title,
  }, cap[0], textMode);
}

function inlineReflinkFn(ctx, src, textMode) {
  const cap = inlineReflink.exec(src) || inlineNolink.exec(src);
  if (!cap) return null;
  const labelStart = cap[0].charAt(0) === '!' ? 2 : 1;
  if (isLabelEndInsideToken(src, cap[1], labelStart)) {
    return null;
  }
  const link = ctx.links[normalizeLabel(cap[2] || cap[1])];
  if (!link) {
    const ch = cap[0].charAt(0);
    return { html: textMode ? ch : escapeHtml(ch), len: 1 };
  }
  return outputLink(ctx, cap, link, cap[0], textMode);
}

function inlineEmStrongFn(ctx, src, maskedSrc, prevChar = '', textMode = false) {
  let match = emStrongLDelim.exec(src);
  if (!match) return null;
  if (!match[1] && !match[2] && !match[3] && !match[4]) return null;

  const delimChar = match[0][0];
  const midRun = prevChar === delimChar;

  const srcStart = maskedSrc.length - src.length;
  let runStart = srcStart;
  while (runStart > 0 && maskedSrc[runStart - 1] === delimChar) {
    runStart--;
  }
  const runPrevChar = [...maskedSrc.slice(Math.max(0, runStart - 2), runStart)].at(-1) ?? '';
  const runPrevPunct = runPrevChar === '*' || runPrevChar === '_' || !!punctuation.exec(runPrevChar);
  if (runStart < srcStart) {
    prevChar = runPrevChar;
  }
  const prevPunct = runStart < srcStart ? runPrevPunct : !!punctuation.exec(prevChar);

  if (match[4] && prevChar.match(other.unicodeAlphaNumeric)) return null;

  const nextChar = match[1] || match[3] || '';

  if (!nextChar || !prevChar || prevPunct) {
    const lLength = [...match[0]].length - 1;
    let rDelim, rLength, delimTotal = lLength, midDelimTotal = 0;

    const runLength = srcStart - runStart + lLength;
    const openerCanClose = !!runPrevChar.trim()
      && (!!nextChar || (delimChar === '*' && !runPrevPunct));
    if (delimChar !== '*' && delimChar !== '_') return null;
    const endReg = delimChar === '*' ? emStrongRDelimAst : emStrongRDelimUnd;
    const lastPossible = lastPossibleCloser(ctx, maskedSrc, delimChar);
    const windowStart = maskedSrc.length - src.length + lLength;
    if (lastPossible < windowStart) return null;
    maskedSrc = maskedSrc.slice(-1 * src.length + lLength);
    const lastPossibleInWindow = lastPossible - windowStart;
    endReg.lastIndex = 0;

    while ((match = endReg.exec(maskedSrc)) !== null) {
      if (match.index > lastPossibleInWindow) break;
      rDelim = match[1] || match[2] || match[3] || match[4] || match[5] || match[6];

      if (!rDelim) continue;

      rLength = [...rDelim].length;

      if (match[3] || match[4]) {
        delimTotal += rLength;
        continue;
      } else if (match[5] || match[6] || openerCanClose) {
        if (midRun && (match[5] || match[6])) {
          break;
        }
        if (runLength % 3 && !((runLength + rLength) % 3)) {
          midDelimTotal += rLength;
          continue;
        }
      }

      delimTotal -= rLength;

      if (delimTotal > 0) continue;

      rLength = Math.min(rLength, rLength + delimTotal + midDelimTotal);
      const lastCharLength = [...match[0]][0].length;
      const raw = src.slice(0, lLength + match.index + lastCharLength + rLength);

      if (Math.min(lLength, rLength) % 2) {
        const text = raw.slice(1, -1);
        const inner = inlineTokens(ctx, text, textMode);
        return { html: textMode ? inner : '<em>' + inner + '</em>', len: raw.length };
      }

      const text = raw.slice(2, -2);
      const inner = inlineTokens(ctx, text, textMode);
      return { html: textMode ? inner : '<strong>' + inner + '</strong>', len: raw.length };
    }
  }
  return null;
}

function inlineDelFn(ctx, src, maskedSrc, prevChar = '', textMode = false) {
  let match = delLDelim.exec(src);
  if (!match) return null;

  const nextChar = match[1] || '';

  if (!nextChar || !prevChar || punctuation.exec(prevChar)) {
    const lLength = [...match[0]].length - 1;
    let rDelim, rLength, delimTotal = lLength;

    const endReg = delRDelim;
    const lastPossible = lastPossibleCloser(ctx, maskedSrc, '~');
    const windowStart = maskedSrc.length - src.length + lLength;
    if (lastPossible < windowStart) return null;
    maskedSrc = maskedSrc.slice(-1 * src.length + lLength);
    const lastPossibleInWindow = lastPossible - windowStart;
    endReg.lastIndex = 0;

    while ((match = endReg.exec(maskedSrc)) !== null) {
      if (match.index > lastPossibleInWindow) break;
      rDelim = match[1] || match[2] || match[3] || match[4] || match[5] || match[6];

      if (!rDelim) continue;

      rLength = [...rDelim].length;

      if (rLength !== lLength) continue;

      if (match[3] || match[4]) {
        delimTotal += rLength;
        continue;
      }

      delimTotal -= rLength;

      if (delimTotal > 0) continue;

      rLength = Math.min(rLength, rLength + delimTotal);
      const lastCharLength = [...match[0]][0].length;
      const raw = src.slice(0, lLength + match.index + lastCharLength + rLength);

      const text = raw.slice(lLength, -lLength);
      const inner = inlineTokens(ctx, text, textMode);
      return { html: textMode ? inner : '<del>' + inner + '</del>', len: raw.length };
    }
  }
  return null;
}

function inlineEscapeFn(src, textMode) {
  const cap = inlineEscape.exec(src);
  if (!cap) return null;
  return { html: textMode ? cap[1] : escapeHtml(cap[1]), len: cap[0].length };
}

function inlineTagFn(ctx, src) {
  const cap = inlineTag.exec(src);
  if (!cap) return null;
  if (!ctx.inLink && other.startATag.test(cap[0])) {
    ctx.inLink = true;
  } else if (ctx.inLink && other.endATag.test(cap[0])) {
    ctx.inLink = false;
  }
  if (!ctx.inRawBlock && other.startPreScriptTag.test(cap[0])) {
    ctx.inRawBlock = true;
  } else if (ctx.inRawBlock && other.endPreScriptTag.test(cap[0])) {
    ctx.inRawBlock = false;
  }
  return { html: cap[0], len: cap[0].length };
}

function inlineCodespanFn(src, textMode) {
  const cap = inlineCode.exec(src);
  if (!cap) return null;
  let text = cap[2].replace(other.newLineCharGlobal, ' ');
  const hasNonSpaceChars = other.nonSpaceChar.test(text);
  const hasSpaceCharsOnBothEnds = other.startingSpaceChar.test(text) && other.endingSpaceChar.test(text);
  if (hasNonSpaceChars && hasSpaceCharsOnBothEnds) {
    text = text.substring(1, text.length - 1);
  }
  return { html: textMode ? text : `<code>${escapeHtml(text, true)}</code>`, len: cap[0].length };
}

function inlineBrFn(src, textMode) {
  const cap = inlineBr.exec(src);
  if (!cap) return null;
  return { html: textMode ? '' : '<br>', len: cap[0].length };
}

function inlineAutolinkFn(src, textMode) {
  const cap = autolink.exec(src);
  if (!cap) return null;
  let text, href;
  if (cap[2] === '@') {
    text = cap[1];
    href = 'mailto:' + text;
  } else {
    text = cap[1];
    href = text;
  }
  if (textMode) {
    return { html: text, len: cap[0].length };
  }
  return { html: renderLink(href, null, escapeHtml(text, true), true), len: cap[0].length };
}

function inlineUrlFn(src, textMode) {
  let cap = inlineUrl.exec(src);
  if (!cap) return null;
  let text, href;
  if (cap[2] === '@') {
    text = cap[0];
    href = 'mailto:' + text;
  } else {
    let prevCapZero;
    do {
      prevCapZero = cap[0];
      cap[0] = urlBackpedal.exec(cap[0])?.[0] ?? '';
    } while (prevCapZero !== cap[0]);
    text = cap[0];
    if (cap[1] === 'www.') {
      href = 'http://' + cap[0];
    } else {
      href = cap[0];
    }
  }
  if (textMode) {
    return { html: text, len: cap[0].length };
  }
  return { html: renderLink(href, null, escapeHtml(text, true), true), len: cap[0].length };
}

function inlineTextFn(ctx, src, textMode) {
  const cap = inlineText.exec(src);
  if (!cap) return null;
  const text = ctx.inRawBlock ? cap[0] : decodeNumericCharacterReferences(cap[0]);
  return {
    html: ctx.inRawBlock ? cap[0] : (textMode ? text : escapeHtml(text)),
    len: cap[0].length,
    raw: cap[0],
  };
}

// ---- Entry point ----

export function parse(markdown) {
  const ctx = newCtx();
  const src = String(markdown).replace(other.carriageReturn, '\n');
  const out = [];
  blockTokens(ctx, src, out);
  return renderOut(ctx, out);
}
