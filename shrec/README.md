# ShREC in-setting session

The taught deck and the response wall in one page, running on GitHub Pages.

## The three surfaces

| Surface | URL | Who has it |
|---|---|---|
| The presentation | `/Response-Wall/shrec/` | The laptop, on the projector |
| The moderator | `/Response-Wall/shrec/moderate.html` | Your phone, in your hand |
| The join page | `/Response-Wall/` | Practitioners, via the QR |

The presentation only ever paints responses you have shown. Nothing unmoderated
can reach the projector, because the queue lives on the phone and nowhere else.

## Running a session

1. Open the deck on the laptop and go full screen (`F`).
2. Open `moderate.html` on your phone, code `bigfoot`.
3. Present. Slide 3 is the join moment and carries the big QR; every question
   slide carries a smaller one so latecomers can still get in.
4. On a question slide, responses arrive on the phone. **Show it** puts one on the
   wall, **Hide** discards it, **Take down** removes one already showing.
5. **Export** before you leave. Responses live only in the session.
6. **New group** clears the wall and queue for the next setting.

The phone's back and forward buttons drive the deck, so you can moderate from the
back of the room. The laptop's arrow keys still work as normal.

## The six questions

Wording is fixed. It matches what ran at the first settings, so the per-session
exports aggregate into rollout-wide evidence rather than separate one-offs.
Resist tweaking it between visits.

| Slide | id | Question |
|---|---|---|
| 4 | q1 | What does a good conversation with a three-year-old sound like? |
| 14 | q2 | Which of the four is already strongest in your room? |
| 16 | q4 | A child watching the window says "dog run". What do you say next? |
| 21 | q5 | What gets in the way of talk like this on a difficult morning? |
| 24 | q3 | Where in your day do adults and children already share attention? |
| 28 | q6 | What would be most helpful for you to do ShREC better? |

If a visit runs short, q3 goes first. It is the warmest question and the weakest
for aggregation. Keep q2, q4 and q5 whatever else goes.

## Rebuilding after a deck revision

The deck content is still authored with the `rsn-interactive-deck` skill. When you
revise it, re-weave rather than hand-editing this file:

    cp "<the rebuilt 25-slide deck>.html" shrec/index.html
    python3 - shrec/index.html <<'PY'
    SP_CSS = "shrec/wall.css.part"
    SP_JS  = "shrec/wall.js.part"
    exec(open("shrec/weave.py").read())
    PY

`weave.py` moves the join slide to position 3, inserts the six question slides at
their teaching moments, and injects the wall layer. It asserts on 25 input
sections and 31 output slides, so a changed deck fails loudly rather than quietly
producing something wrong.

## Notes

- Questions are read from the slides themselves (`data-prompt`, `data-question`,
  `data-hint`) and published to the session, so the wording on a phone can never
  drift from the wording on the wall.
- Bump `DECK_REV` in `wall.js.part` whenever a question changes. Phones compare it
  and pick up the new deck without being reloaded.
- Shared data is the same Firebase session the root page uses, so the existing
  security rules cover this with no change.
- The wall thins its own type as it fills: up to 8 responses it stays large, then
  steps down twice. Twenty show at once and the rest are counted underneath.
