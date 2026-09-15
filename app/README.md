# Response Wall Studio

Upload a deck built with the `rsn-interactive-deck` skill, drop question slides
between its slides, retype any text, and run it with a phone as remote and
moderator. Question slides borrow the deck's own classes, so they match by
construction rather than by imitation.

## The four pages

| Page | Who | What |
|---|---|---|
| `studio.html` | You, signed in | Deck library and editor |
| `present.html?deck=ID` | The laptop, signed in once | The deck, rebuilt from storage, painting live results |
| `remote.html` | Your phone, signed in | Start a session, drive the slides, moderate, export |
| `index.html` (`/app/`) | Participants, via QR | Anonymous. Shows whatever question is live |

Sign-in is Google, restricted by the database rules to the addresses listed in
`rules.json`. Participants never sign in.

## Running a session

1. Studio → open the deck → **Present ↗** on the laptop. Press `F` for full screen.
2. On the phone, open `remote.html`, pick the deck, name the session (the
   setting, the date). The laptop picks it up within a second.
3. Present from either end. Laptop arrow keys and phone arrows both move the
   deck; whichever moved last wins.
4. Text and word-cloud answers land on the phone first. **Show it** puts one on
   the wall, **Hide** discards it, **Take down** removes one already showing.
   Choices and scales show live with nothing to moderate.
5. **Export** at any point: this session or every session on this deck as CSV,
   one row per response. Question ids are stable, so files from different visits
   stack.
6. **New group** ends the session, keeps its responses, and starts a fresh one
   from slide 1. **End session** sends every screen back to waiting.

## Editing a deck

- **Upload** an `.html` deck on the library page. The parser takes its styles,
  slides, footer, orbit modules and presenter notes. A deck woven earlier (the
  ShREC one) comes in with its question slides recognised, ids preserved.
- **Click any text** on an uploaded slide in the preview and retype it. Layout,
  images and animations stay as they were.
- **+ Question after this** inserts a question slide: open text wall, word
  cloud, multiple choice, scale, or a join slide with the big QR.
- **Drag** slides in the strip to reorder, or use ↑ ↓. **Hide** keeps a slide in
  the deck but out of the presentation.
- **Presenter notes** live under the preview and show on the laptop (`N`) and on
  the phone (**Notes**).
- **Replace slides from file** takes a revised deck from the skill and puts your
  question slides back where they were, anchored to the slide each followed.
  Text you retyped on the old slides is lost; question slides and their notes
  survive.

## Data

Everything lives under `/studio` in the `response-wall` Realtime Database.
`rules.json` is the full ruleset to paste into the Firebase console (it also
carries the `response-wall` block the older pages rely on). Only the listed
Google accounts can read decks, sessions' metadata and the pending queue, or
write anything except a participant's own responses. Participants can create a
pending item (only for the live question, one shape, 200 characters) and set
their own vote (only for the live question, 40 characters); they can read the
live pointer and what has been shown.

Deck documents are stored without the logo (the app ships its own `logo.png`),
so the ShREC deck is about 150 KB. The Spark plan holds hundreds of them.
