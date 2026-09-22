#!/usr/bin/env node
/**
 * plan-specs — derive the execution order instead of remembering it.
 *
 * WHY THIS EXISTS. `specs/index.html` used to carry a hand-written "Execution
 * order" section that opened by admitting its own failure mode: "the order below
 * goes stale quietly. Derive it again from the live specs rather than trusting
 * this list." That instruction was correct and expensive — it meant reading a
 * dozen HTML files before any work could start, every single time, and the
 * re-derivation was done from prose by eye.
 *
 * So the specs now declare what they touch, and this derives the rest. Same
 * move `prune-specs.mjs` already makes for the live listing and the decisions
 * section: state it once, declaratively, and generate the view.
 *
 * WHAT IT CATCHES, in the order the mistakes actually cost:
 *
 *   1. A spec that DELETES a file another spec EDITS. This is the expensive one.
 *      On Jul 31, 2026 pipevine-tip-line deleted /rescued-pipevine while
 *      pipevine-october-availability's entire subject was that page — its own
 *      blocker still read "COPY IS DONE AND VERIFIED" about a file that no
 *      longer existed. Caught by hand, barely. It is an ERROR here.
 *   2. Two open specs editing the same page. Not fatal, but they must not be
 *      worked in parallel sessions, and the second one inherits the first's
 *      changes — which is exactly what nobody remembers.
 *   3. A spec whose verify command ALREADY PASSES. That spec is done and should
 *      be pruned, not worked. `CLAUDE.md` bans stating machine-checkable state
 *      from memory; `spec-verify` is what turns that rule into something a
 *      script can enforce.
 *
 * USAGE
 *   node scripts/plan-specs.mjs            # print the plan
 *   node scripts/plan-specs.mjs --verify   # also run each spec-verify command
 *   node scripts/plan-specs.mjs --write    # regenerate specs/PLAN.html
 *
 * THIS SCRIPT NEVER WRITES `specs/index.html`, AND THAT IS THE POINT.
 *
 * The index is hand-edited constantly — Login pass items, spec descriptions,
 * notes — and often while a run is in progress. An editor holds the whole file
 * in a buffer, so any script that rewrites the index races every save: the
 * script writes, the editor saves over it, and the generated block is gone. The
 * reverse is worse, because unsaved hand edits clobbered by a script are not
 * recoverable from git.
 *
 * The content never actually conflicts — hand edits and generated blocks touch
 * different regions — so the fix is mechanical, not editorial: give the machine
 * its own file. `specs/PLAN.html` is script-owned and never hand-edited; the
 * index is hand-owned and (by this script) never written. Link to one from the
 * other and edit both at once, safely, forever.
 *
 * Anything that must still write a hand-owned file goes through `safeWrite`
 * below, which refuses rather than clobbers.
 *
 * META IT READS (all optional; a spec with none still appears, just unordered):
 *   spec-touches   space/comma-separated paths this spec edits
 *   spec-deletes   paths this spec removes
 *   spec-needs     slugs of specs that must land first
 *   spec-verify    a shell command that exits 0 when the spec is genuinely done
 *   spec-account   "yes" when it is gated on a Login pass item
 *   spec-decision  owned by prune-specs.mjs; read here, never written here.
 *                  Repeatable. A spec with one sinks in the order — it needs a
 *                  human, and "nobody wrote down what is wrong with it" is not
 *                  the same as "it is ready".
 */

import { readdir, readFile, writeFile, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SPECS_DIR = join(ROOT, 'specs');
const INDEX = 'index.html';
const PLAN = 'PLAN.html';

/**
 * Read-modify-write that refuses to clobber a file edited underneath it.
 *
 * The window is small and it is real: read the file, spend a second deriving,
 * write it back — and anything saved in between is silently gone. Re-stat
 * immediately before writing and abort if the file moved. Aborting costs a
 * re-run; clobbering costs someone's unsaved work.
 *
 * Use this for every hand-owned file. Script-owned files (PLAN.html) do not
 * need it, but it is harmless there and guards against two runs racing.
 */
async function safeWrite(path, transform) {
  const before = await stat(path).catch(() => null);
  const original = before ? await readFile(path, 'utf8') : '';
  const next = await transform(original);
  if (next == null || next === original) return 'unchanged';

  const after = await stat(path).catch(() => null);
  if (before && after && after.mtimeMs !== before.mtimeMs) {
    return 'changed-underneath';
  }
  await writeFile(path, next);
  return 'written';
}

const args = new Set(process.argv.slice(2));
const DO_VERIFY = args.has('--verify');
const DO_WRITE = args.has('--write');

/* ------------------------------------------------------------- parsing -- */

/** A decision whose content opens with RESOLVED has been answered; see CLAUDE.md. */
const RESOLVED_META = /^\s*RESOLVED\b/i;

const meta = (html, name) => {
  const m = html.match(
    new RegExp(`<meta\\s+name=["']${name}["']\\s+content=["']([^"]*)["']`, 'i'),
  );
  return m ? m[1].trim() : '';
};

/**
 * A raw " inside a content="…" attribute, which TRUNCATES the value silently.
 *
 * Found the hard way on Aug 7, 2026. A blocker was rewritten to quote Rosetta —
 * content="… she said "remove the cloudflare login method" …" — and the second
 * quote closed the attribute. Everything after it became stray junk attributes
 * on the <meta>, the browser rendered the page as if nothing were wrong, and
 * every reader of that blocker (this script, the index generator, the next
 * session) saw only the first fragment.
 *
 * That is the worst shape a bug can take in an executed document: it does not
 * fail, it shortens. A blocker truncated before the sentence naming the human
 * trips the "names no human" warning for a spec that names one; a blocker
 * truncated after it stays quiet while hiding the actual work. Quoting someone
 * is exactly what these fields are for, so this will recur — hence a check
 * rather than a note.
 *
 * Reported as an ERROR, not a warning: the value is already wrong by the time
 * anything reads it, so continuing means planning against a fiction.
 */
const truncatedMetas = (html, slug) => {
  const bad = [];
  for (const raw of html.split('\n')) {
    const m = raw.match(/<meta\s+name=["'](spec-[a-z-]+)["']\s+content="(.*)"\s*\/?>\s*$/i);
    if (!m) continue;
    // m[2] is greedy to the LAST quote on the line, i.e. the value the author
    // meant. The comparison is against what meta() above actually extracts,
    // which stops dead at the first embedded quote. If they differ, every
    // reader of this field is seeing a prefix.
    const asParsed = raw.match(/content="([^"]*)"/);
    if (asParsed && asParsed[1].length < m[2].length) {
      bad.push({ slug, name: m[1], kept: asParsed[1].length, actual: m[2].length });
    }
  }
  return bad;
};

/** Paths are written space- or comma-separated; blank entries dropped. */
const paths = (raw) => raw.split(/[\s,]+/).map((s) => s.trim()).filter(Boolean);

const titleOf = (html, fallback) => {
  const m = html.match(/<title>([\s\S]*?)<\/title>/i);
  return m ? m[1].replace(/^Spec\s*[—-]\s*/i, '').trim() : fallback;
};

/**
 * Files nearly every spec appends to. An overlap here is not a conflict worth
 * sequencing around — it is just how the repo works — so they are reported at a
 * lower volume than a genuine two-specs-one-page collision.
 */
const SHARED_APPEND_ONLY = new Set([
  'README.md',
  'CLAUDE.md',
  'schema.sql',
  'package.json',
  'wrangler.toml',
]);

/* -------------------------------------------------------------- loading -- */

const files = (await readdir(SPECS_DIR)).filter(
  (f) => f.endsWith('.html') && f !== INDEX,
);

const specs = [];
const truncated = [];
for (const file of files) {
  const html = await readFile(join(SPECS_DIR, file), 'utf8');
  const status = (meta(html, 'spec-status') || 'open').toLowerCase();
  // Checked on every spec, including done ones: a done spec's blocker is the
  // completion record the prune copies into the index, so truncating it loses
  // the account of what shipped.
  truncated.push(...truncatedMetas(html, file.replace(/\.html$/, '')));
  if (status === 'canonical' || status === 'done') continue;

  const declared = [

    ...html.matchAll(/<meta\s+name=["']spec-decision["']\s+content=["']([^"]*)["']/gi),

  ].map((m) => m[1].replace(/\s+/g, ' ').trim()).filter(Boolean);

  specs.push({
    slug: file.replace(/\.html$/, ''),
    file,
    status,
    title: titleOf(html, file),
    touches: paths(meta(html, 'spec-touches')),
    // A spec may declare none ON PURPOSE: it has finished its code and every
    // remaining step is a dashboard click, so declaring the files it already
    // changed would contend it against specs still working them. Saying so in a
    // <!-- No spec-touches: ... --> comment counts as declaring it, because a
    // warning nobody can resolve is one people learn to scroll past.
    noTouchesNote: /<!--\s*No spec-touches:/i.test(html),
    deletes: paths(meta(html, 'spec-deletes')),
    needs: paths(meta(html, 'spec-needs')).map((s) => s.replace(/\.html$/, '')),
    verify: meta(html, 'spec-verify'),
    // Hand-authored urgency, the one thing no metadata can derive: seasonality,
    // a person waiting on a reply, something wrong on the live site today.
    // Lower sorts sooner; absent means unranked and sorts after everything
    // ranked. It is RECORDED here rather than derived, which is the whole point
    // — a priority kept in a separate hand-written list goes stale silently and
    // silently omits specs, because creating a spec does not force anyone to
    // edit that list. Kept beside the spec, it cannot.
    priority: (() => {
      const raw = meta(html, 'spec-priority');
      if (raw == null || raw === '') return null;
      const n = Number(raw);
      return Number.isFinite(n) ? n : null;
    })(),
    priorityWhy: meta(html, 'spec-priority-why') ?? '',
    account: /^(yes|true|1)$/i.test(meta(html, 'spec-account')),
    blocker: meta(html, 'spec-blocker'),
    // prune-specs.mjs owns this field; read it, do not write it. A spec with an
    // unanswered decision needs a human as surely as a blocked one does, and
    // ignoring it made under-documented specs float to the top of the order —
    // absence of information reading as readiness.
    decisions: declared.filter((d) => !RESOLVED_META.test(d)),
    // Every declared decision, answered or not. The blocker lint needs this one:
    // a spec whose decisions have all been ANSWERED has still declared them, and
    // nagging it to declare what it already declared teaches people to ignore
    // the lint. Only `decisions` (the open ones) drives the order and the labels.
    declaredDecisions: declared,
  });
}

const bySlug = new Map(specs.map((s) => [s.slug, s]));
const errors = [];
const warnings = [];

for (const t of truncated) {
  errors.push(
    `${t.slug}: ${t.name} contains a raw " and is TRUNCATED — every reader sees ` +
      `${t.kept} of ${t.actual} characters. Replace the inner quotes with &quot; ` +
      `(or single quotes). This does not render as broken, it renders as shorter, ` +
      `which is why it needs a check rather than a careful reader.`,
  );
}

/* ------------------------------------------------------------ conflicts -- */

// 1. delete-vs-touch. The expensive one: a spec editing a file another deletes.
const deleteEdges = [];
for (const a of specs) {
  for (const path of a.deletes) {
    for (const b of specs) {
      if (b.slug === a.slug) continue;
      if (!b.touches.includes(path)) continue;
      errors.push(
        `${b.slug} edits ${path}, which ${a.slug} DELETES. ` +
          `Work ${b.slug} first, or fold it in — do not do both blind.`,
      );
      // Whoever edits the doomed file goes first; otherwise the edit is wasted.
      deleteEdges.push([b.slug, a.slug]);
    }
  }
}

// 2. same file, two open specs — but only warn about the ones NOBODY HAS
// SEQUENCED YET.
//
// This used to warn on every shared file unconditionally, which made the
// warning unresolvable: you could declare a perfectly correct order and the
// same fourteen lines came back next run. A permanent wall of warnings trains
// you to skip the block, and then a genuinely unsequenced pair hides in the
// noise. Fixed Aug 1, 2026 — a pair with a declared order is reported as
// sequenced, and only an UNORDERED pair is still a warning you must act on.
//
// Ordering is checked TRANSITIVELY: if A needs B and B needs C, then A and C
// are ordered too, and saying so again adds nothing.
const orderedPairs = (() => {
  // slug -> slugs it must follow, from spec-needs plus the delete edges.
  const dep = new Map(specs.map((s) => [s.slug, new Set()]));
  for (const s of specs) for (const n of s.needs) if (bySlug.has(n)) dep.get(s.slug).add(n);
  for (const [first, then] of deleteEdges) if (dep.has(then)) dep.get(then).add(first);

  // Transitive closure by DFS. The graph is a dozen or so nodes, so the naive
  // walk is fine and a cycle just stops at the visited check — cycles are
  // reported as errors by the Kahn pass below, not this one's problem.
  const reaches = new Map();
  const walk = (slug, seen = new Set()) => {
    if (reaches.has(slug)) return reaches.get(slug);
    const out = new Set();
    if (seen.has(slug)) return out;
    seen.add(slug);
    for (const d of dep.get(slug) ?? []) {
      out.add(d);
      for (const t of walk(d, seen)) out.add(t);
    }
    reaches.set(slug, out);
    return out;
  };
  for (const s of specs) walk(s.slug);
  return (a, b) => reaches.get(a)?.has(b) || reaches.get(b)?.has(a);
})();

const owners = new Map();
for (const s of specs) {
  for (const p of s.touches) {
    if (!owners.has(p)) owners.set(p, []);
    owners.get(p).push(s.slug);
  }
}
const contended = [];
const sequenced = [];
for (const [path, slugs] of owners) {
  if (slugs.length < 2) continue;
  const shared = SHARED_APPEND_ONLY.has(path);
  contended.push({ path, slugs, shared });
  if (shared) continue;

  // Every pair sharing this file needs an order between them. One unordered
  // pair is enough to make the file unsafe to work from two sessions.
  const unordered = [];
  for (let i = 0; i < slugs.length; i++) {
    for (let j = i + 1; j < slugs.length; j++) {
      if (!orderedPairs(slugs[i], slugs[j])) unordered.push(`${slugs[i]} + ${slugs[j]}`);
    }
  }

  if (unordered.length) {
    warnings.push(
      `${path} is edited by ${slugs.length} specs and ${unordered.length} pair` +
        `${unordered.length === 1 ? '' : 's'} have NO declared order: ` +
        `${unordered.join(', ')}. Add spec-needs to whichever must come second, ` +
        `or fold them together. Until then, never work them in parallel sessions.`,
    );
  } else {
    sequenced.push({ path, slugs });
  }
}

// 3. spec-needs pointing at nothing.
for (const s of specs) {
  for (const n of s.needs) {
    if (!bySlug.has(n)) {
      warnings.push(
        `${s.slug} declares spec-needs "${n}", which is not a live spec ` +
          `(already shipped and pruned, or a typo).`,
      );
    }
  }
}

/* ------------------------------------------------------- the ordering -- */

// Kahn's algorithm over spec-needs plus the delete edges. Cycles are reported
// rather than silently broken, because a cycle means two specs each expect the
// other to land first, which is a real design problem and not a sort problem.
const edges = new Map(specs.map((s) => [s.slug, new Set()])); // slug -> must follow
for (const s of specs) {
  for (const n of s.needs) if (bySlug.has(n)) edges.get(s.slug).add(n);
}
for (const [first, then] of deleteEdges) {
  if (edges.has(then)) edges.get(then).add(first);
}

/**
 * Tie-break among specs that are equally ready. Cheap and unblocked first:
 * a blocked spec cannot be finished, and an account-gated one stops for a human,
 * so both are worse uses of a run than something that can go end to end.
 */
const rank = (s) =>
  (s.status === 'blocked' ? 100 : 0) +
  // An unanswered decision stops the run just as hard as a formal block. This is
  // weighted near it deliberately: a spec is not "ready" merely because nobody
  // wrote down what is wrong with it.
  (s.decisions.length ? 80 : 0) +
  (s.account ? 50 : 0) +
  (s.blocker ? 10 : 0) -
  // A spec many others wait on earns its place at the front.
  [...edges.values()].filter((deps) => deps.has(s.slug)).length * 5;

const order = [];
const remaining = new Map(specs.map((s) => [s.slug, new Set(edges.get(s.slug))]));
while (remaining.size) {
  const ready = [...remaining.entries()]
    .filter(([, deps]) => [...deps].every((d) => !remaining.has(d)))
    .map(([slug]) => bySlug.get(slug));

  if (!ready.length) {
    errors.push(
      `Dependency cycle among: ${[...remaining.keys()].join(', ')}. ` +
        `Two specs each expect the other first — split one of them.`,
    );
    for (const slug of remaining.keys()) order.push(bySlug.get(slug));
    break;
  }

  // Hand-authored priority leads, and everything else breaks its ties. This is
  // what lets ONE list answer both questions: the topological sort above
  // guarantees the order is safe, and this guarantees that among the specs it
  // is safe to do next, the one a human said matters most goes first. An
  // unranked spec sorts after every ranked one rather than at the front, so
  // forgetting to rank something cannot promote it.
  const byPriority = (a, b) =>
    (a.priority ?? Infinity) - (b.priority ?? Infinity);
  ready.sort(
    (a, b) =>
      byPriority(a, b) || rank(a) - rank(b) || a.slug.localeCompare(b.slug),
  );
  const next = ready[0];
  order.push(next);
  remaining.delete(next.slug);
}

/* --------------------------------------------------------- verify pass -- */

const verdicts = new Map();
if (DO_VERIFY) {
  for (const s of order) {
    if (!s.verify) continue;
    try {
      execSync(s.verify, { cwd: ROOT, stdio: 'pipe', timeout: 60_000 });
      verdicts.set(s.slug, 'passes');
      warnings.push(
        `${s.slug}: its spec-verify command ALREADY PASSES. ` +
          `Confirm it is genuinely done and prune it rather than working it.`,
      );
    } catch {
      verdicts.set(s.slug, 'fails');
    }
  }
}

/* -------------------------------------------------------------- output -- */

const missing = specs.filter(
  (s) => !s.touches.length && !s.deletes.length && !s.noTouchesNote,
);

console.log(`\nspecs/ — ${specs.length} live, derived order:\n`);
order.forEach((s, i) => {
  const tags = [
    s.status === 'blocked' ? 'BLOCKED' : '',
    s.account ? 'account-gated' : '',
    verdicts.get(s.slug) === 'passes' ? 'VERIFY ALREADY PASSES' : '',
    s.decisions.length ? `${s.decisions.length} decision${s.decisions.length > 1 ? 's' : ''} waiting` : '',
    s.needs.filter((n) => bySlug.has(n)).length
      ? `after ${s.needs.filter((n) => bySlug.has(n)).join(' + ')}`
      : '',
  ].filter(Boolean);
  console.log(
    `  ${String(i + 1).padStart(2)}. ${s.slug}${tags.length ? `  [${tags.join(' · ')}]` : ''}`,
  );
});

/* --------------------------------------------------------- blocker lint -- */
/*
 * Two failures this repo keeps repeating, both invisible to a human reading one
 * spec and both obvious across all of them at once. Warnings, never errors: a
 * check that blocks the work gets switched off, and these are about hygiene
 * rather than correctness.
 *
 * 1. A DECISION HIDING IN A BLOCKER. CLAUDE.md already says one
 *    `spec-decision` per choice, and the rule keeps losing to the path of least
 *    resistance, which is one more sentence in the blocker you are already
 *    writing. It satisfies the letter of "log the stop" and leaves the choice
 *    unfindable: the index generates its Decisions section from the metas and
 *    cannot see prose. Nine accumulated that way before Jul 31, 2026, and five
 *    more on Aug 1 before anyone noticed.
 *
 * 2. A BLOCKER THAT IS NOT ABOUT A HUMAN. "Waiting on volume", "deferred",
 *    "revisit later" are all reasons a spec is parked, and none of them is
 *    something Rosetta can unblock. A run that treats them as blockers ends
 *    early while believing it is exhausted, which is precisely what happened on
 *    Aug 1, 2026: eight blockers were read, believed, and three of those specs
 *    had real work in them.
 */
// Deliberately narrow. A bare "recommendation" appears in blockers that RECORD a
// resolved one ("built by taking the spec's recommendation"), and flagging those
// is how a warning becomes noise and then gets ignored. What is matched is the
// shape of a choice still being POSED: a colon-introduced recommendation, or a
// question aimed at Rosetta.
const DECISION_SHAPED = /(recommended:|\bshould we\b|\bwhether to\b|\bor should\b|\bworth deciding\b|\byour call\b|\bhers to decide\b)/i;
const HUMAN_SHAPED = /\b(rosetta|hers|her |password|login|log in|oauth|secret|api key|2fa|dashboard|account|payment|donation|sign|approve|approval|consent|send|reply|email her|credential|seed|verify in|terms)\b/i;

/** Punctuation- and case-insensitive, so a fragment survives being rewritten. */
const norm = (t) => t.replace(/\W+/g, ' ').trim().toLowerCase();

/** A sentence that RECORDS an answer rather than posing a question. */
const RESOLVED_SHAPED =
  /\b(answered|closed|resolved|reversed|decision is taken|taken as recommended|no longer a decision)\b/i;

/** Common enough to appear in any two sentences, so they prove no overlap. */
const STOPWORDS = new Set([
  'which', 'there', 'their', 'would', 'could', 'should', 'because', 'rather',
  'about', 'these', 'those', 'other', 'where', 'while', 'after', 'before',
  'still', 'every', 'thing', 'things', 'something', 'anything', 'nothing',
  'spec', 'specs', 'rosetta', 'whether', 'recommended', 'decision', 'decisions',
]);

const blockerNotes = [];
for (const s of specs) {
  if (!s.blocker) continue;
  const hasDecisionProse = DECISION_SHAPED.test(s.blocker);
  if (hasDecisionProse && !s.declaredDecisions.length) {
    blockerNotes.push(
      `${s.slug}: blocker reads like a decision and the spec declares none. ` +
      `Give each choice its own <meta name="spec-decision">, or the index cannot show it.`,
    );
  }

  // THE GAP THIS CLOSES, found Aug 5, 2026 by auditing rather than by trusting
  // the check above: the rule was "decision prose AND zero declared decisions".
  // A spec that declared ONE and buried three more passed silently, which is the
  // failure the whole meta exists to prevent. native-plants-handout had a Canva
  // decision declared and a Spanish edition plus a page-split sitting in prose;
  // sighting-chat-intake had one CLOSED decision declared and an open question
  // about whether the model may read a photo about to be closed alongside it.
  //
  // So: check each decision-shaped SENTENCE against what the spec declares,
  // rather than checking the blocker as a whole against a count. Matched on a
  // normalised fragment, because a decision is almost never copied verbatim out
  // of the blocker into the meta - it gets rewritten with a recommendation.
  // Matched on CONTENT-WORD OVERLAP rather than on a shared prefix. A decision
  // is almost never lifted verbatim from the blocker into the meta — it gets
  // rewritten with a recommendation attached — so a prefix test reported every
  // properly-declared decision as missing. Overlap survives the rewrite.
  const declared = new Set(norm(s.decisions.join(' ')).split(' '));
  const undeclared = s.blocker
    .split(/(?<=[.!?])\s+/)
    .filter((sent) => DECISION_SHAPED.test(sent))
    // A sentence announcing a settled answer is a record, not an open question.
    // Without this the lint nags about every decision that has been MADE, which
    // is the fastest way to teach someone to ignore it.
    .filter((sent) => !RESOLVED_SHAPED.test(sent))
    .filter((sent) => {
      const words = [...new Set(norm(sent).split(' '))].filter(
        (w) => w.length > 4 && !STOPWORDS.has(w),
      );
      if (words.length < 4) return false;
      const hits = words.filter((w) => declared.has(w)).length;
      return hits / words.length < 0.5;
    });
  if (undeclared.length && s.declaredDecisions.length) {
    blockerNotes.push(
      `${s.slug}: ${undeclared.length} choice${undeclared.length === 1 ? '' : 's'} posed in the blocker ` +
      `that no spec-decision covers, though the spec declares ${s.declaredDecisions.length}. ` +
      `The index generates that section from the metas and cannot read prose:\n` +
      undeclared.map((u) => `        "${u.trim().slice(0, 110)}…"`).join('\n'),
    );
  }
  if (!HUMAN_SHAPED.test(s.blocker)) {
    blockerNotes.push(
      `${s.slug}: blocker names no human, credential or account. ` +
      `If nothing here needs Rosetta, this spec is PARKED, not blocked, and a run must not treat it as exhausted.`,
    );
  }
}
if (blockerNotes.length) {
  console.log(`\nblocker hygiene — warnings, not errors:`);
  for (const n of blockerNotes) console.log(`  !  ${n}`);
}

if (contended.length) {
  console.log(`\ncontended files — one spec at a time, in this order:`);
  // Sorted into the derived order rather than listed alphabetically. "These
  // three specs share this file" is a problem statement; "work them in this
  // order" is the answer, and it is the thing you actually need at the moment
  // you open the file. An unordered pair is still called out as a warning above.
  const rank = new Map(order.map((s, i) => [s.slug, i]));
  for (const c of contended.filter((c) => !c.shared)) {
    const inOrder = [...c.slugs].sort((a, b) => (rank.get(a) ?? 99) - (rank.get(b) ?? 99));
    console.log(`  ${c.path}\n      ${inOrder.join(' → ')}`);
  }
  const sharedCount = contended.filter((c) => c.shared).length;
  if (sharedCount) {
    console.log(`  (${sharedCount} append-only shared files omitted: README, schema, etc.)`);
  }
}

if (missing.length) {
  console.log(
    `\nno spec-touches declared (invisible to conflict detection):\n  ${missing
      .map((s) => s.slug)
      .join(', ')}`,
  );
}

for (const w of warnings) console.log(`\n!  ${w}`);
for (const e of errors) console.log(`\nX  ${e}`);

/* --------------------------------------------------------------- write -- */

if (DO_WRITE) {
  // Titles are read out of HTML, so they already contain entities. Escaping a
  // bare & only — the same guard prune-specs.mjs uses — stops "&amp;" becoming
  // "&amp;amp;" on every regeneration.
  const esc = (s) =>
    String(s)
      .replace(/&(?![a-zA-Z]+;|#\d+;)/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');

  const items = order
    .map((s) => {
      const notes = [];
      if (s.status === 'blocked') notes.push('<strong>blocked</strong>');
      if (s.decisions.length) {
        notes.push(
          `<strong>${s.decisions.length} decision${s.decisions.length > 1 ? 's' : ''} waiting on Rosetta</strong>`,
        );
      }
      if (s.account) notes.push('account-gated, needs a Login pass item');
      const deps = s.needs.filter((n) => bySlug.has(n));
      if (deps.length) notes.push(`after ${deps.map(esc).join(' + ')}`);
      const clash = contended
        .filter((c) => !c.shared && c.slugs.includes(s.slug))
        .map((c) => c.path);
      if (clash.length) {
        notes.push(`shares ${clash.map((p) => `<code>${esc(p)}</code>`).join(', ')}`);
      }
      // The hand-authored reason goes on its own line and in full. It is the
      // only part of this block a human wrote, so it must not be crushed in
      // among the derived notes.
      const why = s.priorityWhy
        ? `<br /><span class="meta" style="margin:0"><strong>Why here:</strong> ${esc(s.priorityWhy)}</span>`
        : '';
      return (
        `  <li><a href="${esc(s.file)}">${esc(s.slug)}</a> — ${esc(s.title)}` +
        (notes.length ? `<br /><span class="meta" style="margin:0">${notes.join(' · ')}</span>` : '') +
        why +
        `</li>`
      );
    })
    .join('\n');

  const problems = [...errors.map((e) => ['X', e]), ...warnings.map((w) => ['!', w])]
    .map(([k, t]) => `  <li>${k === 'X' ? '<strong>' : ''}${esc(t)}${k === 'X' ? '</strong>' : ''}</li>`)
    .join('\n');

  const block =
    `<p class="meta">Generated by <code>npm run specs:plan -- --write</code>. Do not hand-edit: ` +
    `it is derived from each spec's <code>spec-needs</code>, <code>spec-touches</code>, ` +
    `<code>spec-deletes</code> and <code>spec-decision</code>. To change the order, change a ` +
    `spec's meta — that is the point, so it cannot go stale.</p>\n` +
    `<ol class="spec-order">\n${items}\n</ol>` +
    (problems
      ? `\n<div class="callout warn">\n<h4>Conflicts to resolve first</h4>\n<ul>\n${problems}\n</ul>\n</div>`
      : '');

  // The order belongs in the index, next to the live spec list — one canonical
  // map, which is what CLAUDE.md says the index is for. It goes through
  // safeWrite because the index is hand-edited constantly and often while a run
  // is going: a script must never eat an unsaved Login pass edit.
  //
  // The reverse direction is deliberately NOT defended against. A stale editor
  // buffer saved after this ran will revert the block, and that is fine —
  // generated content is regenerable, so the cost is one command. Hand edits are
  // not regenerable, which is the whole asymmetry.
  //
  // Falls back to a standalone PLAN.html only while the index has no markers, so
  // this works before and after the markers are added, with no flag day.
  const indexPath = join(SPECS_DIR, INDEX);
  const markers =
    /(<!--\s*GENERATED:EXECUTION-ORDER:START\s*-->)[\s\S]*?(<!--\s*GENERATED:EXECUTION-ORDER:END\s*-->)/;
  const indexHtml = await readFile(indexPath, 'utf8').catch(() => '');

  if (markers.test(indexHtml)) {
    const result = await safeWrite(indexPath, (current) =>
      current.replace(markers, (_m, open, close) => `${open}\n${block}\n${close}`),
    );
    if (result === 'changed-underneath') {
      console.log(
        `\n!  specs/${INDEX} was saved while this ran — nothing written, your edit is intact. Re-run.`,
      );
    } else if (result === 'written') {
      console.log(`\n   wrote the execution order into specs/${INDEX}`);
    } else {
      console.log(`\n   specs/${INDEX} execution order already current`);
    }

    // Once the index carries the order, a leftover PLAN.html is a second answer
    // to the same question — the exact staleness this tool exists to prevent.
    if (existsSync(join(SPECS_DIR, PLAN))) {
      console.log(
        `\n!  specs/${PLAN} is now redundant — the order lives in the index. Delete it:\n` +
          `     git rm -f specs/${PLAN}`,
      );
    }
  } else {
    console.log(
      `\n!  No GENERATED:EXECUTION-ORDER markers in specs/${INDEX}.\n` +
        `   Add these two lines where the order should appear, then re-run:\n` +
        `     <!-- GENERATED:EXECUTION-ORDER:START -->\n` +
        `     <!-- GENERATED:EXECUTION-ORDER:END -->\n` +
        `   Falling back to specs/${PLAN} until then.`,
    );
    const result = await safeWrite(
      join(SPECS_DIR, PLAN),
      () => `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta name="spec-status" content="canonical" />
<title>WHRF — Derived execution order (fallback)</title>
<link rel="stylesheet" href="spec.css" />
</head>
<body>
<div class="internal">Internal planning document — <b>not part of the website</b> · never deploy <code>specs/</code></div>
<div class="wrap">
<p><a href="${INDEX}">← Specs index</a></p>
<h1>Derived execution order</h1>
<div class="callout warn">
  <h4>Temporary. This belongs in the index.</h4>
  <p>
    Generated here only because <a href="${INDEX}">${INDEX}</a> has no
    <code>GENERATED:EXECUTION-ORDER</code> markers yet. Add them and this file becomes redundant —
    two answers to "what order?" is the staleness this tool exists to prevent.
  </p>
</div>
${block}
</div>
</body>
</html>
`,
    );
    if (result === 'written') console.log(`   wrote specs/${PLAN}`);
  }
}

console.log('');
if (errors.length) process.exitCode = 1;
