# Codex brief: refinement pass, not features

Read-only audit. Do NOT edit any file. Report findings only.

You are reviewing a deployed, fully client-side browser audio workstation.
~10k lines of dependency-free ES modules. It works. Your job is to find where
it is UNREFINED, with evidence, so it can be tightened.

## What I want, ranked

1. **Duplication that is load-bearing.** The same logic implemented twice in
   two places that can drift apart. Name both sites and say what happens when
   one changes and the other does not. I care much more about this than about
   cosmetic repetition.
2. **Dead code and dead data.** Fields written but never read, functions never
   called, exports nobody imports, parameters always passed the same value,
   branches that cannot be reached. Prove it with grep, not intuition. One
   known example so you can calibrate: `clip.gain` is set to 1 in three places
   and read in exactly one (cliprefs.js audition) and never varies.
3. **Inconsistency a reader would trip on.** Two modules solving the same
   problem differently for no reason (event naming, error handling, guard
   style, how views inject CSS, how controllers reach the store).
4. **Fragility.** Places where one failure takes down more than it should.
   Specifically: `js/main.js` calls six `init*Controller(ctx)` functions in
   sequence with no isolation, so a throw in any one leaves the app half-built
   and silent. Find the others like it.
5. **Comments that lie.** A comment describing behaviour the code no longer
   has. These are worse than no comment.

## Rules

- Every finding needs `file:line`, what is wrong, and the concrete consequence.
- No style opinions, no "consider extracting", no formatting, no naming taste.
- If you are unsure, label it UNVERIFIED rather than asserting.
- Do NOT report: the WebAudio biquad Q-in-dB convention (deliberate), the
  OP-1 fixed-point constant (verified against hardware), unity-RMS plate
  normalization (deliberate), the offline-render master limiter (a documented
  deliberate exception in docs/CONTRACT-CONFORM.md section 4b).
- Rank by consequence. Say plainly if a category has nothing worth reporting.

## Where to look

js/machine/controller.js (now very large, grew by accretion), js/main.js,
js/app/*.js, js/machine/*.js, js/analysis/*.js, js/dsp/*.js, workers/*.js.
