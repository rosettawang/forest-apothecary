# Forest Apothecary

The Apothecary app, plus a small static storefront.

## What is here

`index.html` is the whole app: a compiled `dc-runtime` React bundle (`support.js`) that
renders the menu, the herbalist consultation and the pickup cart client-side from arrays
declared inline. There is no router and no build step, so every screen lives at `/`.

`shop/` and `notes/` are plain static HTML, deliberately outside that bundle. They exist
because a product cannot rank without a crawlable URL of its own, and they work unchanged
on Netlify and on Cloudflare.

`netlify/functions/` holds the backend against Supabase and Twilio, written with raw
`https` rather than SDKs. Keep it that way: the dependency list is empty and worth
protecting.

`specs/` is internal planning material. It is not built and must never be linked from the
app.

## House style

**No em dashes**, anywhere in site-facing copy. Use a comma, a colon, a full stop, or a
middot. Headings are sentence case. `npm run style:check` enforces both, and covers the
system prompts in `netlify/functions/` because those write site-facing prose at request
time where no scanner can reach it.

Prose in Rosetta's voice is full flowing sentences, never bold-label fragments, and says a
thing once.

## Commands

| Command | What it does |
|---|---|
| `npm run specs:check` | Dry run: what would be pruned, plus the derived execution order |
| `npm run specs:prune` | Delete specs marked `done`, rewrite the index, regenerate the order |
| `npm run specs:plan` | Execution order only |
| `npm run style:check` | House style over site-facing copy |

<!-- SPEC-PASS:START -->
**Spec pass, how specs get worked by default.** A session runs the whole thing without
asking what to do next.

1. **Reassess the spec first.** A spec is a starting point, not a contract. Check its
   claims against the current code, schema and live state before building. Specs here go
   stale. Where reality has moved, correct the spec and say what changed.
2. **Sequence it, then work the sequence end to end.** Do not stop after one item to
   report progress, and do not ask which item to do next.
3. **Use discretion to build it out.** Fill gaps the spec left, fix what it got wrong,
   improve on it where the better design is clear. Note the deviations.
4. **Stop only at a blocker or a decision:** credentials, a dashboard, an account, content
   only Rosetta can write, or a choice that is structural and hard to reverse. Not on mere
   uncertainty. If a call is cheap and reversible, make it, note it, keep going. Stopping
   means stopping that spec, never the session.
5. **Log the stop** in that spec's `<meta name="spec-blocker">`, dated, then run
   `npm run specs:prune` so the index reflects it. A blocker must name a human, a
   credential or an account. "Revisit later" is parked, not blocked, and a later run that
   reads it as a blocker will end early believing it is finished.
6. **Declare each decision separately**, one `<meta name="spec-decision">` per choice,
   stating the recommended answer and whether it blocks. The prune collects these into the
   index. Write the meta when you notice the decision, not when you finish the spec. A
   decision with no recommendation is a question, and a question is harder to answer than
   a proposal.

`spec-needs` takes the names of other specs, and `spec-touches` takes paths. Both are
parsed, so prose in either produces nonsense in the derived order.
<!-- SPEC-PASS:END -->
