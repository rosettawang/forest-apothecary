#!/usr/bin/env node
/**
 * Prune finished internal spec sheets and rewrite the index listing.
 *
 *   node scripts/prune-specs.mjs            # delete specs marked done, update index
 *   node scripts/prune-specs.mjs --dry-run  # show what would happen, change nothing
 *
 * A spec declares its state in its <head>:
 *   <meta name="spec-status" content="open|blocked|done|canonical">
 *
 * - done      → deleted
 * - open      → kept, listed
 * - blocked   → kept, listed
 * - canonical → never touched (index.html)
 * - missing   → kept and reported, so a typo can't cause a silent delete
 *
 * specs/ is internal planning material. It is not built and not deployed.
 */

import { readdir, readFile, writeFile, unlink, stat } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SPECS_DIR = join(ROOT, 'specs');
const RULES = join(ROOT, 'CLAUDE.md');
const INDEX = 'index.html';
const DRY = process.argv.includes('--dry-run');

const read = (f) => readFile(join(SPECS_DIR, f), 'utf8');

/* --------------------------------------------------- spec-pass mirroring -- *
 * The spec-pass rule is authored ONCE, in CLAUDE.md, because that is the file
 * Claude auto-loads every session. The index shows a
 * copy so the folder documents its own conventions — but a copy anyone can edit
 * is a copy that drifts, so this generates it instead.
 *
 * One authored source means the two files can lag behind each other, but can
 * never contradict each other. --dry-run reports staleness without writing.
 */

const SPEC_PASS_SRC = /<!--\s*SPEC-PASS:START\s*-->([\s\S]*?)<!--\s*SPEC-PASS:END\s*-->/;
const SPEC_PASS_DEST =
  /(<!--\s*GENERATED:SPEC-PASS:START\s*-->)[\s\S]*?(<!--\s*GENERATED:SPEC-PASS:END\s*-->)/;

/** Escape for HTML without double-escaping entities the source already used. */
const escapeText = (s) =>
  s
    .replace(/&(?![a-zA-Z]+;|#\d+;)/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');

/**
 * Render the small markdown subset used in that block: paragraphs, ordered
 * lists, pipe tables, `code`, **bold**, *italic*. Deliberately tiny — if the
 * block ever needs more than this, that is a sign it belongs in its own
 * document rather than mirrored into two.
 *
 * Two cases this handles that the first version did not, both because the
 * spec-pass rule grew them and both of which rendered as garbage rather than
 * failing loudly (found Jul 31, 2026, in the index's own spec-pass section):
 *
 *   - A TABLE. Every line starts with "|", so the old every()-is-a-list-item
 *     test fell through to the paragraph branch and emitted the raw pipes:
 *     "| Rosetta says | What runs | |---|---| | ..." as body text.
 *   - A LIST ITEM WITH A CONTINUATION LINE. The old test required *every* line
 *     in the block to start with "N. ", so the one indented sub-paragraph under
 *     step 4 turned all six steps into a single <p> — and, worse, ran inline()
 *     across the join, which paired ** markers across item boundaries and
 *     produced overlapping <strong> tags. Splitting per item keeps the inline
 *     pass local, which is what makes the pairing correct.
 */
function miniMarkdownToHtml(md) {
  const inline = (t) =>
    escapeText(t)
      .replace(/`([^`]+)`/g, '<code>$1</code>')
      .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
      .replace(/(^|[^*])\*([^*]+)\*/g, '$1<em>$2</em>');

  const cells = (row) =>
    row.replace(/^\||\|$/g, '').split('|').map((c) => c.trim());
  const isDivider = (row) => /^\|?[\s:-]*-[\s|:-]*\|?$/.test(row);

  const out = [];
  for (const block of md.trim().split(/\n{2,}/)) {
    const lines = block.split('\n').map((l) => l.trim()).filter(Boolean);
    if (!lines.length) continue;

    // Table: every line is a pipe row.
    if (lines.length >= 2 && lines.every((l) => l.startsWith('|'))) {
      const rows = lines.filter((l) => !isDivider(l));
      const [head, ...body] = rows;
      out.push(
        '<table>\n<thead><tr>' +
          cells(head).map((c) => `<th>${inline(c)}</th>`).join('') +
          '</tr></thead>\n<tbody>\n' +
          body
            .map(
              (r) =>
                '  <tr>' + cells(r).map((c) => `<td>${inline(c)}</td>`).join('') + '</tr>'
            )
            .join('\n') +
          '\n</tbody>\n</table>'
      );
      continue;
    }

    // Ordered list: starts with "N. ". Lines that do not are continuations of
    // the item above, not the start of a new one.
    if (/^\d+\.\s/.test(lines[0])) {
      const items = [];
      for (const line of lines) {
        if (/^\d+\.\s/.test(line)) items.push(line.replace(/^\d+\.\s*/, ''));
        else if (items.length) items[items.length - 1] += ' ' + line;
      }
      out.push(
        '<ol>\n' + items.map((t) => `  <li>${inline(t)}</li>`).join('\n') + '\n</ol>'
      );
      continue;
    }

    out.push(`<p>${inline(lines.join(' '))}</p>`);
  }
  return out.join('\n');
}

function statusOf(html) {
  const m = html.match(/<meta\s+name=["']spec-status["']\s+content=["']([^"']+)["']/i);
  return m ? m[1].trim().toLowerCase() : null;
}
function titleOf(html, fallback) {
  const m = html.match(/<title>([^<]*)<\/title>/i);
  return m ? m[1].replace(/^Spec\s*[—-]\s*/i, '').trim() : fallback;
}
function summaryOf(html) {
  const m = html.match(/<p class=["']lede["']>([\s\S]*?)<\/p>/i);
  if (!m) return '';
  return m[1].replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
}
/**
 * Why a spec is blocked, so the index says so without anyone hand-editing it
 * (this list is regenerated, so hand-edits here get clobbered):
 *   <meta name="spec-blocker" content="…">
 */
function blockerOf(html) {
  const m = html.match(/<meta\s+name=["']spec-blocker["']\s+content=["']([^"]*)["']/i);
  return m ? m[1].replace(/\s+/g, ' ').trim() : '';
}
/**
 * Choices that are Rosetta's rather than a build problem. REPEATABLE — one meta
 * per decision, because one decision per line is what makes them answerable:
 *   <meta name="spec-decision" content="Which model? Cost, not capability. Does not block the build.">
 *
 * These used to live only inside spec-blocker prose, which satisfied the letter
 * of the spec-pass rule ("log the stop, prune so the index reflects it") and
 * failed its intent: on Jul 31, 2026 there were nine of them buried across seven
 * specs, and no way to answer "what is waiting on me?" without reading all seven.
 * Declared separately, they generate their own section — see decisionsHtml below.
 *
 * State the recommendation and whether it blocks. A decision with no recommended
 * answer is a question, and a question is harder to answer than a proposal.
 */
/**
 * A decision Rosetta has already answered is recorded in place rather than
 * deleted, so the answer and its reasoning survive for the next session
 * (CLAUDE.md: "overwrite decisions with the latest answer"). Those are settled,
 * so they must not keep appearing in "Decisions waiting" — a resolved question
 * still listed as open is how she ends up answering the same thing twice.
 *
 * Convention: a decision whose text begins with RESOLVED is answered.
 */
const RESOLVED = /^\s*RESOLVED\b/i;

function allDecisionsOf(html) {
  return [...html.matchAll(/<meta\s+name=["']spec-decision["']\s+content=["']([^"]*)["']/gi)]
    .map((m) => m[1].replace(/\s+/g, ' ').trim())
    .filter(Boolean);
}

/** Only the ones still waiting on an answer. */
function decisionsOf(html) {
  return allDecisionsOf(html).filter((d) => !RESOLVED.test(d));
}
const escapeHtml = (s) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

const files = (await readdir(SPECS_DIR))
  .filter((f) => f.endsWith('.html') && f !== INDEX)
  .sort();

const kept = [];
const removed = [];
const unmarked = [];

for (const file of files) {
  const html = await read(file);
  const status = statusOf(html);
  if (status === 'done') {
    removed.push({ file, title: titleOf(html, file), summary: summaryOf(html) });
    continue;
  }
  // `canonical` is a permanent map — the index, RUN-LOG.html — not a unit of
  // work. Excluding index.html by filename alone was not enough: RUN-LOG.html is
  // canonical too, and without this it rendered in the Live specs list as though
  // the run log were outstanding work. plan-specs.mjs already skips canonical;
  // this keeps the two agreeing. Found Jul 31, 2026.
  if (status === 'canonical') continue;
  if (!status) unmarked.push(file);
  kept.push({
    file,
    status: status ?? 'unmarked',
    title: titleOf(html, file),
    summary: summaryOf(html),
    blocker: blockerOf(html),
    decisions: decisionsOf(html),
    // Answered ones included: a spec that has DECLARED its decisions must not be
    // nagged to declare them, or the lint fires on exactly the specs that did the
    // right thing and people learn to scroll past it.
    declaredDecisions: allDecisionsOf(html),
  });
}

// --- delete finished specs -------------------------------------------------
for (const { file } of removed) {
  if (!DRY) await unlink(join(SPECS_DIR, file));
}

// --- rewrite the index's "Live specs" list ---------------------------------
// Repeated procedures do not live here. Ones Claude runs end to end are command
// files (.claude/commands/*.md); ones a human follows are root runbooks, e.g.
// SENDER-RUNBOOK.html. Everything in specs/ is disposable work, so this list is
// a to-do list and nothing else.
const order = { blocked: 0, open: 1, unmarked: 2 };
kept.sort((a, b) => (order[a.status] ?? 9) - (order[b.status] ?? 9) || a.title.localeCompare(b.title));

const listHtml = kept.length
  ? kept
      .map(
        ({ file, status, title, summary, blocker }) => `  <li>
    <a href="${file}">${title}</a>
    <span class="tag tag-${status === 'unmarked' ? 'open' : status}">${status}</span>
    <p>${summary}</p>${
      // Label by status: "Blocked:" only when it really is. An open spec can still
      // carry a spec-blocker note (what's left, who owns it), and calling that
      // "Blocked:" made the index read "Blocked: Unblocked Jul 27…".
      blocker
        ? `\n    <p class="blocker"><strong>${status === 'blocked' ? 'Blocked' : 'Remaining'}:</strong> ${escapeHtml(blocker)}</p>`
        : ''
    }
  </li>`
      )
      .join('\n')
  : '  <li><p>No live specs. Everything is shipped.</p></li>';

const indexPath = join(SPECS_DIR, INDEX);
// Stat BEFORE the read, and hold it. The guard below compares against this, so
// the window it protects is the whole run rather than the microsecond inside the
// write helper. See safeWrite.
const indexStatAtRead = await stat(indexPath).catch(() => null);
let index = await readFile(indexPath, 'utf8');
const listRe = /(<ul class="spec-list">)[\s\S]*?(<\/ul>)/;

if (listRe.test(index)) {
  // Replacer FUNCTION, not a template string: spec text can legitimately contain
  // "$1", "$&" etc. (e.g. "a real $1 donation"), and String.replace would treat
  // those as backreferences and splice captured HTML into the prose. Bit us
  // Jul 27, 2026 — the index rendered 'a real <ul class="spec-list"> donation'.
  index = index.replace(listRe, (_m, open, close) => `${open}\n${listHtml}\n${close}`);
} else {
  console.warn(`! Could not find <ul class="spec-list"> in ${INDEX} — live listing not updated.`);
}

// --- rewrite the "Decisions waiting" section --------------------------------
// Generated rather than hand-maintained for the reason the index gives about its
// own Execution order: a hand-kept list of what is outstanding goes stale
// quietly, and a stale decision list is worse than none — it asks for an answer
// that was already given.
const withDecisions = kept.filter((k) => k.decisions.length);
const decisionCount = withDecisions.reduce((n, k) => n + k.decisions.length, 0);

const decisionsHtml = withDecisions.length
  ? `<p class="meta">${decisionCount} decision${decisionCount === 1 ? '' : 's'} across ` +
    `${withDecisions.length} spec${withDecisions.length === 1 ? '' : 's'}, generated from each spec's ` +
    `<code>spec-decision</code> meta. Answer one and it disappears from here on the next prune.</p>\n` +
    '<ul class="spec-decision-list">\n' +
    withDecisions
      .map(
        ({ file, title, status, decisions }) => `  <li>
    <a href="${file}">${title}</a>${status === 'blocked' ? ' <span class="tag tag-blocked">blocked</span>' : ''}
    <ul>
${decisions.map((d) => `      <li>${escapeHtml(d)}</li>`).join('\n')}
    </ul>
  </li>`
      )
      .join('\n') +
    '\n</ul>'
  : '<p>No decisions outstanding. Everything live is a build problem.</p>';

const DECISIONS_DEST =
  /(<!--\s*GENERATED:DECISIONS:START\s*-->)[\s\S]*?(<!--\s*GENERATED:DECISIONS:END\s*-->)/;
let decisionsNote = null;
if (DECISIONS_DEST.test(index)) {
  // Replacer function, not a template string — see the $1/$& note above.
  index = index.replace(DECISIONS_DEST, (_m, open, close) => `${open}\n${decisionsHtml}\n${close}`);
} else {
  decisionsNote = `! Could not find the GENERATED:DECISIONS markers in ${INDEX} — decisions section not updated.`;
}

// Drift guard for the exact failure this section was added to fix: a spec whose
// blocker prose talks about a decision but which never declared one, so it stays
// invisible in the list above.
// Two tuning notes, both learned by getting it wrong on Jul 31, 2026:
//   - the PLURAL matters. /\bdecision\b/ misses "Two decisions are Rosetta's",
//     which is how the phrase is actually written, so the first spec to declare
//     nothing sailed past this guard.
//   - "decided" must NOT match. Past tense means the choice was already made, and
//     matching it flagged donation-notifications for the sentence "Also decided
//     Jul 31: no value is ascribed to the sticker". A guard that cries wolf is a
//     guard that gets ignored.
const DECISION_PROSE =
  /\bdecisions?\b|\bdecide(?:s)?\b|Rosetta's call|\bher call\b|\bis hers\b|Rosetta's and not/i;
const undeclared = kept.filter(
  (k) => !k.declaredDecisions.length && DECISION_PROSE.test(k.blocker),
);

// --- mirror the spec-pass rule from CLAUDE.md into the index ---------------
let specPassNote = null;
try {
  const rules = await readFile(RULES, 'utf8');
  const src = rules.match(SPEC_PASS_SRC);
  if (!src) {
    specPassNote = `! CLAUDE.md has no <!-- SPEC-PASS:START --> block — spec-pass section not updated.`;
  } else if (!SPEC_PASS_DEST.test(index)) {
    specPassNote = `! Could not find the GENERATED:SPEC-PASS markers in ${INDEX} — spec-pass section not updated.`;
  } else {
    const rendered = miniMarkdownToHtml(src[1]);
    const current = index.match(SPEC_PASS_DEST)[0];
    const wasStale = !current.includes(rendered);
    // Replacer function, not a template string — see the note above about $1/$&.
    index = index.replace(SPEC_PASS_DEST, (_m, open, close) => `${open}\n${rendered}\n${close}`);
    if (wasStale) {
      specPassNote = DRY
        ? `! ${INDEX} spec-pass block is STALE — CLAUDE.md changed. Run \`npm run specs:prune\`.`
        : `  synced   spec-pass block in ${INDEX} from CLAUDE.md`;
    }
  }
} catch (err) {
  specPassNote = `! Could not read CLAUDE.md (${err.code ?? err.message}) — spec-pass section not updated.`;
}

// --- record what was pruned, so finished work leaves a trace ---------------
if (removed.length) {
  const today = new Date().toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });
  const entries = removed
    .map(
      ({ title, summary }) =>
        `  <li><strong>${title}</strong> <span class="when">shipped ${today}</span>` +
        `${summary ? ` — ${summary}` : ''}</li>`
    )
    .join('\n');
  const doneRe = /(<ul class="spec-done-list">)/;
  if (doneRe.test(index)) {
    index = index.replace(doneRe, (_m, open) => `${open}\n${entries}`); // see note above: function, not template
  } else {
    console.warn(
      `! Could not find <ul class="spec-done-list"> in ${INDEX} — completions not recorded.\n` +
        `  Add one under a "Recently completed" heading.`
    );
  }
}

/**
 * Read-modify-write that refuses to clobber a file edited underneath it.
 *
 * The index is hand-edited constantly — Login pass items, spec descriptions —
 * and often while this runs. Re-stat immediately before writing and abort if the
 * file moved. Aborting costs a re-run; clobbering costs unsaved work that git
 * cannot get back, because a hand edit is not regenerable and this file's
 * generated blocks are.
 *
 * Ported from scripts/plan-specs.mjs on Aug 1, 2026. Same asymmetry, same fix.
 *
 * The baseline mtime is passed IN, taken when the file was read at the top of
 * this script. The first port took it inside this function, two lines before the
 * comparison, so the guard covered a few microseconds and could not have caught
 * anything: a hand edit lands during the pruning, not during the write. A check
 * that cannot fail is worse than none, because it reads as protection.
 */
async function safeWrite(path, next, baseline) {
  const now = await stat(path).catch(() => null);
  if (baseline && now && now.mtimeMs !== baseline.mtimeMs) return 'changed-underneath';
  await writeFile(path, next);
  return 'written';
}

if (!DRY) {
  const result = await safeWrite(indexPath, index, indexStatAtRead);
  if (result === 'changed-underneath') {
    console.warn(
      `\n!  ${INDEX} was saved while this ran — nothing written, your edit is intact. Re-run.`,
    );
  }
}

// --- report ----------------------------------------------------------------
const tag = DRY ? '[dry run] ' : '';
console.log(`${tag}specs/ — ${kept.length} live, ${removed.length} pruned`);
for (const { file, title } of removed) console.log(`${tag}  deleted  ${file}  (${title})`);
for (const { file, status, decisions } of kept) {
  const d = decisions.length ? `  ${decisions.length} decision${decisions.length === 1 ? '' : 's'}` : '';
  console.log(`${tag}  kept     ${file}  [${status}]${d}`);
}
console.log(
  `${tag}  ${decisionCount} decision(s) awaiting Rosetta, across ${withDecisions.length} spec(s)`
);
if (decisionsNote) console.log(`${tag}${decisionsNote}`);
if (specPassNote) console.log(`${tag}${specPassNote}`);
if (undeclared.length) {
  console.warn(
    `\n! ${undeclared.length} spec(s) mention a decision in spec-blocker but declare no ` +
      `spec-decision meta, so it will not appear in "Decisions waiting":\n` +
      undeclared.map((k) => `    ${k.file}`).join('\n') +
      `\n  Add <meta name="spec-decision" content="…"> per decision, or reword the blocker.`
  );
}
if (unmarked.length) {
  console.warn(
    `\n! ${unmarked.length} spec(s) have no spec-status meta and were kept: ${unmarked.join(', ')}\n` +
      `  Add <meta name="spec-status" content="open"> so the index reads correctly.`
  );
}
if (DRY && removed.length) console.log('\nNothing was deleted. Re-run without --dry-run to apply.');
