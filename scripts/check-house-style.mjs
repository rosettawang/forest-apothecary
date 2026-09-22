#!/usr/bin/env node
/**
 * House style check for site-facing copy (Forest Apothecary).
 *
 *   node scripts/check-house-style.mjs          # report, exit 1 if anything found
 *   node scripts/check-house-style.mjs --list   # one file:line:col per line, no prose
 *
 * One rule so far, from whrf_newsletter_style_guide.html: no em dashes anywhere.
 * Use a comma, a period, a colon, or a middot instead. The guide is written as a
 * house rule rather than a newsletter rule, so it applies to the website too.
 *
 * Deliberately NOT wired into `npm run build`. A punctuation preference must
 * never be able to fail a deploy, least of all mid-campaign. If it should ever
 * gate anything, the honest place is a pre-commit hook.
 *
 * Carve-outs, all about what isn't ours to edit or isn't copy at all:
 *   - <blockquote cite="…">: an attributed quotation. We don't silently
 *     repunctuate CBS or UC Berkeley. A blockquote with no cite is NOT exempt,
 *     because in this repo `>` and <blockquote> are the closing-CTA callout
 *     style (see global.css) rather than a quotation marker, so exempting them
 *     wholesale would hide our own copy.
 *   - Any line carrying the marker `house-style-ok`, in a comment. The escape
 *     hatch for a quotation that sits inline in prose, where nothing in the
 *     markup distinguishes someone else's words from ours.
 *   - <style> blocks.
 *   - Code comments, including .astro frontmatter comments and the comments
 *     inside <script>. Only string literals are checked in code, which is where
 *     nav labels and JSON-LD descriptions live.
 *
 * What this can never see: prose generated at request time. The pipevine chat
 * on /plant-a-pipevine writes site-facing copy that lives in no file — the rule
 * belongs in its system prompt, and the audit is a query against chat_messages.
 * See specs/copy-house-style.html.
 */

import { readdir, readFile } from 'node:fs/promises';
import { join, relative, dirname, extname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const LIST_ONLY = process.argv.includes('--list');

/** Everything that ends up in front of a reader, including nav labels and JSON-LD. */
const SCAN = ['index.html', 'shop', 'notes', 'netlify/functions'];
const EXTS = new Set(['.html', '.js', '.mjs', '.json', '.md']);

const BANNED = [{ char: '—', name: 'em dash', fix: 'comma, period, colon, or middot' }];

/** Put this in a comment on a line holding someone else's words, to exempt it. */
const OK_MARKER = 'house-style-ok';

/** Blank out a region while keeping every byte offset and newline in place, so
 *  reported line and column numbers still match the file on disk. */
const blank = (src, re) =>
  src.replace(re, (m) => m.replace(/[^\n]/g, ' '));

/**
 * Blank out JS comments, leaving string literals alone. A scanner rather than a
 * regex because `https://` inside a string would fool any regex into treating
 * the rest of the line as a comment.
 *
 * Deliberately line-local: quote state resets at every newline. A regex literal
 * like /[&<>"']/g contains unbalanced quotes, and a whole-file scanner
 * desynchronises there and silently stops recognising comments for the rest of
 * the file. Resetting per line contains that to the one line it happens on.
 */
function blankComments(code) {
  let inBlock = false;
  return code
    .split('\n')
    .map((line) => {
      const out = line.split('');
      let i = 0;
      while (i < line.length) {
        if (inBlock) {
          const end = line.indexOf('*/', i);
          const stop = end === -1 ? line.length : end + 2;
          while (i < stop) out[i++] = ' ';
          if (end !== -1) inBlock = false;
          continue;
        }
        const c = line[i];
        if (c === '"' || c === "'" || c === '`') {
          const quote = c;
          i++;
          while (i < line.length && line[i] !== quote) {
            if (line[i] === '\\') i++;
            i++;
          }
          i++;
        } else if (c === '/' && line[i + 1] === '/') {
          while (i < line.length) out[i++] = ' ';
        } else if (c === '/' && line[i + 1] === '*') {
          inBlock = true;
        } else {
          i++;
        }
      }
      return out.join('');
    })
    .join('\n');
}

const CODE_EXTS = new Set(['.ts', '.tsx', '.js', '.mjs']);
const PY_EXTS = new Set(['.py']);
const MARKUP_EXTS = new Set(['.astro', '.html', '.md', '.mdx']);

function stripExempt(src, ext) {
  // First, before anything else strips comments: the marker usually sits in one.
  let out = src
    .split('\n')
    .map((line) => (line.includes(OK_MARKER) ? line.replace(/[^\n]/g, ' ') : line))
    .join('\n');
  if (MARKUP_EXTS.has(ext)) {
    out = blank(out, /<style[\s\S]*?<\/style>/gi);
    // A <script> block is not exempt: error messages and thank-you copy live in
    // its string literals. Treat it as code, so only its comments are skipped.
    out = out.replace(
      /(<script\b[^>]*>)([\s\S]*?)(<\/script>)/gi,
      (_m, open, body, close) => open + blankComments(body) + close,
    );
    out = blank(out, /<blockquote\b[^>]*\bcite\s*=[\s\S]*?<\/blockquote>/gi);
    // Comments are notes to us, not copy: HTML, JSX, and the `//` lines that
    // appear inside .astro expression blocks.
    out = blank(out, /<!--[\s\S]*?-->/g);
    out = blank(out, /\{\/\*[\s\S]*?\*\/\}/g);
    out = blank(out, /^[ \t]*\/\/.*$/gm);
  }
  if (CODE_EXTS.has(ext)) out = blankComments(out);
  // Python: `#` to end of line. Deliberately naive about `#` inside a string —
  // a false exemption here only ever means a missed warning, never a false one,
  // and no line in scripts/ pairs a literal `#` with a banned fact.
  if (PY_EXTS.has(ext)) out = blank(out, /#.*$/gm);
  if (ext === '.astro') {
    // Only the frontmatter fence is JavaScript; the rest is markup.
    const fence = /^---\n([\s\S]*?)\n---/.exec(out);
    if (fence) {
      out =
        out.slice(0, fence.index + 4) +
        blankComments(fence[1]) +
        out.slice(fence.index + 4 + fence[1].length);
    }
  }
  return out;
}

async function* walk(dir) {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return; // a scanned directory that doesn't exist yet is not an error
  }
  for (const e of entries) {
    const full = join(dir, e.name);
    if (e.isDirectory()) yield* walk(full);
    else if (EXTS.has(extname(e.name))) yield full;
  }
}

const hits = [];

for (const rel of SCAN) {
  for await (const file of walk(join(ROOT, rel))) {
    const src = await readFile(file, 'utf8');
    if (!BANNED.some((b) => src.includes(b.char))) continue;

    const lines = stripExempt(src, extname(file)).split('\n');
    lines.forEach((line, i) => {
      for (const b of BANNED) {
        let col = line.indexOf(b.char);
        while (col !== -1) {
          hits.push({
            file: relative(ROOT, file),
            line: i + 1,
            col: col + 1,
            banned: b,
            text: line.trim(),
          });
          col = line.indexOf(b.char, col + 1);
        }
      }
    });
  }
}

/* ------------------------------------------------------- heading case -- */
/**
 * Sentence case, site-wide, decided Jul 31, 2026 (specs/heading-case.html).
 *
 * The rule is "capitalise the first word and the names, stop." Only the second
 * half needs a person, and the test is: *would this appear capitalised in the
 * middle of an ordinary sentence, written by someone outside WHRF?* Names that
 * pass go in NAMES below; everything else is flagged.
 *
 * Deliberately a heuristic that under-reports rather than over-reports: it only
 * complains when EVERY significant word after the first is capitalised, which is
 * unambiguous Title Case. "Caring for Your Caterpillars" is caught; a single
 * stray capital is not, because at that point the false-positive rate on species
 * names and place names makes the check something people switch off.
 *
 * Escape hatch is the same `house-style-ok` marker the punctuation check uses.
 */
const NAMES = new Set([
  'forest apothecary', 'laurelate', 'thanaka aftershave',
  'laurelate chai', 'mct coffee', 'colombian sipping chocolate',
  'california bay laurel hydrosol', 'mugwort matcha', 'black sage',
  'yerba santa', 'stinging nettle', 'laurel spritz', 'nettle soup',
  'for the skin', 'the simple', 'what is in it', 'to use', 'why i made this',
]);
// Words that stay lowercase inside a sentence-case heading anyway, so their case
// tells us nothing about whether the heading is Title Case.
const SMALL = new Set(['a','an','the','and','or','but','for','nor','on','at','to','from','by',
  'of','in','with','as','is','it','we','us','your','you','our','&','&amp;','vs','via','into']);

// Individual words that legitimately keep a capital anywhere. Checked per token,
// not per whole heading, so "Email UC Berkeley" reads as first-word + name and
// passes, while "Bay Laurel Documentation" still fails on "Documentation".
// NOT here on purpose: pipevine, swallowtail, laurel, bay — common names of
// species take no capital, which is the rule people get wrong most often.
const NAME_WORDS = new Set(['uc','berkeley','strawberry','creek','oakland','california',
  'clark','kerr','pre-school','codornices','alameda','whrfund','wild','harvest','restoration',
  'fund','pipevine.','aristolochia','battus','google','apple','stripe','resend','cloudflare',
  'partiful','nextdoor','facebook','whatsapp','inaturalist','sender.net','d1','r2',
  'january','february','march','april','may','june','july','august','september','october',
  'november','december','monday','tuesday','wednesday','thursday','friday','saturday','sunday']);

const HEADING_RE = /<h[1-4][^>]*>([^<]{3,90})<\/h[1-4]>/gi;
const MD_HEADING_RE = /^#{1,4}\s+(.{3,90})$/gm;

const caseHits = [];
for (const rel of SCAN) {
  for await (const file of walk(join(ROOT, rel))) {
    const ext = extname(file);
    if (!MARKUP_EXTS.has(ext)) continue;
    const src = await readFile(file, 'utf8');
    const scrubbed = stripExempt(src, ext);

    const found = [
      ...[...scrubbed.matchAll(HEADING_RE)].map((m) => [m[1], m.index]),
      ...[...scrubbed.matchAll(MD_HEADING_RE)].map((m) => [m[1], m.index]),
    ];

    for (const [rawText, idx] of found) {
      const text = rawText.replace(/\{[^}]*\}/g, '').trim(); // drop {expressions}
      if (!text || NAMES.has(text.toLowerCase())) continue;

      const words = text.split(/\s+/).filter((w) => /^[A-Za-z]/.test(w));
      if (words.length < 2) continue;
      const norm = (w) => w.toLowerCase().replace(/[:,.?!&]+$/, '');
      const rest = words
        .slice(1)
        .filter((w) => !SMALL.has(norm(w)) && !NAME_WORDS.has(norm(w)));
      // Every remaining significant word capitalised = unambiguous Title Case.
      // Empty means the only capitals were names, which is correct sentence case.
      if (!rest.length || !rest.every((w) => /^[A-Z]/.test(w))) continue;

      caseHits.push({
        file: relative(ROOT, file),
        line: scrubbed.slice(0, idx).split('\n').length,
        text,
      });
    }
  }
}

/* ---------------------------------------------------------------------------
 * 3. Facts typed in by hand, when a constant exists for them.
 *
 * specs/editability-cleanup.html §1: the contact address was in 22 code files,
 * the potting evening in 6. That is not untidiness, it is the reason a copy edit
 * cannot be trusted — you cannot know you found them all. src/lib/site.ts now
 * holds each of these once, and this check is what stops them growing back.
 *
 * It has already gone wrong once: the chat system prompt held a stale pickup
 * date while the pages said something else, so visitors were told the wrong
 * thing by a file nobody thinks of as copy.
 *
 * WHY functions/ IS SCANNED HERE AND NOWHERE ELSE IN THIS FILE: Worker code is
 * not site copy for the punctuation and heading rules, but the system prompt IS
 * the most important consumer of these facts and the least likely to be
 * remembered. It gets checked.
 *
 * Content (src/content) is exempt on purpose: prose in Markdown and JSON cannot
 * import anything, and inventing a templating layer for it would be worse than
 * the duplication.
 * ------------------------------------------------------------------------- */
const FACT_SCAN = ['index.html', 'shop', 'notes', 'netlify/functions',
  // scripts/ was outside BOTH scan lists in the whrfund original until Sep 9,
  // 2026, which is the hole a stale letter footer fell through: the rule existed
  // and named the right replacement, and simply never ran over the file that had
  // the problem. Kept in from the start here.
  'scripts'];

const FACTS = [
  // BOTH addresses are banned literals. The gmail because it is no longer the
  // contact address at all (moved Sep 9, 2026), so a copy of it in the source
  // is now wrong rather than merely duplicated; hello@whrfund.org because it
  // is the new one, and the whole point of the constant is that the NEXT move
  // is one edit. Catching only the old value would have let the replacement be
  // hardcoded 22 times over.
  // `stale: true` means this value is SUPERSEDED, not merely duplicated. Those are
  // enforced even in files that cannot import the constant (see CANNOT_IMPORT), because
  // a superseded literal is wrong rather than untidy.
  { literal: 'wildreciprocity@gmail.com', stale: true, use: 'CONTACT_EMAIL — and note this is no longer the contact address' },
  { literal: 'hello@whrfund.org',         use: 'CONTACT_EMAIL' },
  { literal: '3062 California St',        use: 'PICKUP_ADDRESS or PICKUP_ADDRESS_POSTAL' },
  { literal: '5:30 to 7:30pm',            use: 'POTTING_HOURS, or POTTING_EVENINGS for the whole phrase' },
  // Rosetta may move the potting evening, so the public copy names a cadence and
  // never a day. The day belongs in the dated event files and in
  // .claude/commands/post-event.md, and nowhere a reader can see it go stale.
  // Widened Aug 22, 2026: the first version only matched a weekday next to
  // "potting", and the copy that had actually gone stale said "Collect any
  // Wednesday evening in Oakland". Same staleness, different noun. A weekday
  // near EITHER word is the shape to catch. Dated prose like "Friday, July 24,
  // 2026" is safe: it names a day that happened, and no evening or potting
  // follows it.
  { pattern: /(Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday)s?\s+(potting|evenings?\b|evening we pot)/i,
    use: 'POTTING_EVENINGS — the public copy says "weekly", never a weekday' },
  { literal: '93-2331362',                use: 'WHRF_EIN' },
];

/** Files that hold a literal for a reason, each of which had to be argued for. */
const FACT_EXEMPT = new Set([
  // The definitions themselves.
  'src/lib/site.ts',
  // This file. It has to name the literals it bans; that is the rule, not a copy
  // of a fact. Added Sep 9, 2026 when scripts/ came into the fact scan and the
  // checker immediately reported its own rule table.
  'scripts/check-house-style.mjs',
  // Test fixtures that assert against real values ON PURPOSE. A test importing
  // the constant it is checking cannot detect a change to that constant — it
  // would assert `x === x` and pass through any edit. These are the one place a
  // hardcoded fact is doing real work.
  'scripts/check-access-jwt.mjs',
  'scripts/check-donation-email.mjs',
  'scripts/check-letters.mjs',
]);

/**
 * Files that physically cannot import `src/lib/site.ts`, so a duplicated
 * CURRENT value is unavoidable there and only a SUPERSEDED one is a defect.
 * Python: reportlab scripts rendering the printed letters and labels.
 */
const CANNOT_IMPORT = (rel) => rel.endsWith('.py');

const factHits = [];
for (const rel of FACT_SCAN) {
  for await (const file of walk(join(ROOT, rel))) {
    const relPath = relative(ROOT, file);
    if (FACT_EXEMPT.has(relPath)) continue;
    const ext = extname(file);
    if (!EXTS.has(ext)) continue;
    const src = await readFile(file, 'utf8');
    // Comments are exempt: a comment recording where a value came from is
    // documentation, and rewriting those would delete the reasoning.
    const scrubbed = stripExempt(src, ext);

    // Search a whitespace-FLATTENED copy, not the raw text. Markup wraps, and a
    // wrapped fact is still a hard-coded fact: "5:30 to\n            7:30pm" sat
    // in plant-a-pipevine.astro and a plain indexOf walked straight past it —
    // caught on Aug 5, 2026 only because the rendered page was read afterwards.
    // The map keeps every flattened offset pointing back at its real line.
    const flat = [];
    const map = [];
    {
      const lines = scrubbed.split('\n');
      let prevSpace = false;
      for (let i = 0; i < lines.length; i++) {
        for (const ch of lines[i]) {
          const isSpace = ch === ' ' || ch === '\t';
          if (isSpace && prevSpace) continue;
          flat.push(isSpace ? ' ' : ch);
          map.push(i + 1);
          prevSpace = isSpace;
        }
        if (!prevSpace) { flat.push(' '); map.push(i + 1); prevSpace = true; }
      }
    }
    const hay = flat.join('');
    const rawLines = scrubbed.split('\n');

    for (const fact of FACTS) {
      // A file that cannot import the constant is judged only on SUPERSEDED
      // values. Its duplication of the current value is structural, so flagging
      // it would fail the check permanently, and a check that cannot be made to
      // pass is one people learn to skip.
      if (!fact.stale && CANNOT_IMPORT(relPath)) continue;
      // A fact can be a literal or a PATTERN. The pattern branch exists because
      // one of these facts is "no weekday next to potting", which is a shape
      // rather than a string. Added Aug 22, 2026 — and note the first attempt
      // just put a `pattern` key in the list, which did nothing except make
      // indexOf search for the string "undefined".
      if (fact.pattern) {
        const flags = fact.pattern.flags.includes('g')
          ? fact.pattern.flags : `${fact.pattern.flags}g`;
        for (const m of hay.matchAll(new RegExp(fact.pattern.source, flags))) {
          const line = map[m.index];
          const endLine = map[Math.min(m.index + m[0].length - 1, map.length - 1)];
          if ((rawLines[line - 1] || '').includes(OK_MARKER)) continue;
          if ((rawLines[endLine - 1] || '').includes(OK_MARKER)) continue;
          factHits.push({ file: relPath, line, literal: m[0], use: fact.use });
        }
        continue;
      }
      let from = 0;
      for (;;) {
        const idx = hay.indexOf(fact.literal, from);
        if (idx === -1) break;
        from = idx + 1;
        const line = map[idx];
        // The marker exempts the line the fact STARTS on, and the line it ends
        // on, so a wrapped literal can be marked from either end.
        const endLine = map[Math.min(idx + fact.literal.length - 1, map.length - 1)];
        if ((rawLines[line - 1] || '').includes(OK_MARKER)) continue;
        if ((rawLines[endLine - 1] || '').includes(OK_MARKER)) continue;
        factHits.push({ file: relPath, line, literal: fact.literal, use: fact.use });
      }
    }
  }
}

if (LIST_ONLY) {
  for (const h of hits) console.log(`${h.file}:${h.line}:${h.col}`);
  for (const h of caseHits) console.log(`${h.file}:${h.line}: ${h.text}`);
  for (const h of factHits) console.log(`${h.file}:${h.line}: ${h.literal}`);
  process.exit(hits.length || caseHits.length || factHits.length ? 1 : 0);
}

if (factHits.length) {
  console.log(
    `House style: ${factHits.length} hard-coded fact${factHits.length === 1 ? '' : 's'} ` +
      `that src/lib/site.ts already holds.\n`,
  );
  for (const h of factHits) console.log(`  ${h.file}:${h.line}  "${h.literal}"  →  ${h.use}`);
  console.log(
    `\nImport it from src/lib/site.ts instead. Workers can: functions/ resolves\n` +
      `'../../src/lib/site' and the value bundles (verified Aug 5, 2026). A bundled\n` +
      `Astro <script> cannot — read document.body.dataset.contactEmail, which\n` +
      `BaseLayout publishes for exactly that case. If a literal genuinely belongs\n` +
      `where it is, mark the line ${OK_MARKER} and say why.`,
  );
}

if (caseHits.length) {
  console.log(
    `House style: ${caseHits.length} heading${caseHits.length === 1 ? '' : 's'} in Title Case. ` +
      `Sentence case is the rule (specs/heading-case.html).\n`,
  );
  for (const h of caseHits) console.log(`  ${h.file}:${h.line}  ${h.text}`);
  console.log(
    `\nCapitalise the first word and the names, nothing else. If it IS a name — would someone\n` +
      `outside Laurelate capitalise it mid-sentence? — add it to NAMES in this script, or mark the\n` +
      `line ${OK_MARKER}. Note "California pipevine" capitalises California only, and\n` +
      `"pipevine swallowtail" takes none: common names of species are not proper nouns.`,
  );
}

if (hits.length === 0 && caseHits.length === 0 && factHits.length === 0) {
  console.log('House style: clean. No banned punctuation, no Title Case headings, no hard-coded facts.');
  // Both lists, because they differ and the difference has mattered: the fact
  // scan reaches functions/ and scripts/ while the punctuation scan does not,
  // and a summary naming only the narrower one reads as full coverage.
  console.log(`Scanned for punctuation and headings: ${SCAN.join(', ')}.`);
  console.log(`Scanned for hard-coded facts: ${FACT_SCAN.join(', ')}.`);
  console.log(`Exempt: comments, <style>, cited quotations, and lines marked ${OK_MARKER}.`);
  process.exit(0);
}

if (hits.length === 0) process.exit(1);

const byFile = new Map();
for (const h of hits) {
  if (!byFile.has(h.file)) byFile.set(h.file, []);
  byFile.get(h.file).push(h);
}

console.log(`House style: ${hits.length} banned character${hits.length === 1 ? '' : 's'} in ${byFile.size} file${byFile.size === 1 ? '' : 's'}.\n`);

for (const [file, list] of [...byFile].sort((a, b) => b[1].length - a[1].length)) {
  console.log(`${file}  (${list.length})`);
  for (const h of list) {
    const snippet = h.text.length > 110 ? `${h.text.slice(0, 107)}...` : h.text;
    console.log(`  ${h.line}:${h.col}  ${snippet}`);
  }
  console.log('');
}

const names = [...new Set(hits.map((h) => `${h.banned.name} → ${h.banned.fix}`))];
for (const n of names) console.log(`Fix: ${n}`);
console.log('Read each in context. A blind find-and-replace produces comma splices.');
process.exit(1);
