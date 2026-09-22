/**
 * Marks the .index-nav link for the section you are currently looking at.
 *
 * PROGRESSIVE ENHANCEMENT, DELIBERATELY. The nav is plain anchor links and the
 * bar is sticky in CSS, so with this file absent, blocked, or failing, a spec
 * still has a working jump-nav that follows you down the page. That matters
 * because these documents are opened straight off disk as often as they are
 * served, and CLAUDE.md's rule is that a spec must work that way. Nothing here
 * is load-bearing; it only adds the highlight.
 *
 * Shared by every spec, so the behaviour lives in one file rather than being
 * pasted into each one. Include it with:
 *   <script src="spec-nav.js" defer></script>
 */
(() => {
  const nav = document.querySelector('.index-nav');
  if (!nav || !('IntersectionObserver' in window)) return;

  // Map each observed section element to its nav link. Skip the Top link and
  // any cross-document link (RUN-LOG.html) — neither names a section here.
  const linkFor = new Map();
  for (const a of nav.querySelectorAll('a[href^="#"]')) {
    if (a.classList.contains('to-top')) continue;
    const id = decodeURIComponent(a.getAttribute('href').slice(1));
    const el = id && document.getElementById(id);
    if (el) linkFor.set(el, a);
  }
  if (!linkFor.size) return;

  const onScreen = new Set();

  const paint = () => {
    // The active section is the visible one closest to the top of the viewport.
    // Picking "first intersecting" instead gets it wrong on the way back up,
    // because entries arrive in observer order rather than document order.
    let top = null;
    for (const el of onScreen) {
      if (!top || el.getBoundingClientRect().top < top.getBoundingClientRect().top) top = el;
    }
    for (const a of linkFor.values()) a.classList.remove('active');
    if (top) linkFor.get(top).classList.add('active');
  };

  const io = new IntersectionObserver(
    (entries) => {
      for (const e of entries) {
        if (e.isIntersecting) onScreen.add(e.target);
        else onScreen.delete(e.target);
      }
      paint();
    },
    {
      // Top inset clears the sticky bar itself, so a heading tucked under it
      // does not count as visible. Bottom inset keeps the highlight on the
      // section you are reading rather than jumping to one just peeking in.
      // rootMargin takes px and % only — rem is silently invalid here.
      rootMargin: '-72px 0px -65% 0px',
    },
  );

  for (const el of linkFor.keys()) io.observe(el);
})();
