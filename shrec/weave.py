# -*- coding: utf-8 -*-
import re, io, sys

SRC = SP = sys.argv[1]
s = io.open(SRC, encoding='utf-8').read()

# ---- pull the join QR out of slide 12 so the question slides can reuse it ----
m = re.search(r'qrcard card orange qr-big.*?<img src="(data:image/png;base64,[A-Za-z0-9+/=]+)"', s, re.S)
JOIN_QR = m.group(1)

# ---- split the deck into its 25 sections ----
start = s.index('<div class="deck">')
end   = s.index('</div><!-- /deck -->')
head, body, tail = s[:start], s[start:end], s[end:]
blocks = re.findall(r'  <!-- ===== \d+ .*?</section>\n', body, re.S)
assert len(blocks) == 25, len(blocks)
pre = body[:body.index(blocks[0])]

QUESTIONS = {
 'q1': ("What does a good conversation with a three-year-old sound like?",
        "Short and concrete. Around fifteen words.",
        "Before the evidence"),
 'q2': ("Which of the four is already strongest in your room?",
        "Name the one you would be happy for a visitor to watch.",
        "All four moves &middot; now yours"),
 'q3': ("Where in your day do adults and children already share attention, without anyone planning it?",
        "A moment, a place, a routine.",
        "Before the timeline"),
 'q4': ("A child watching the window says &ldquo;dog run&rdquo;. What do you say next?",
        "Say it exactly as you would say it to the child.",
        "The one that earns its place"),
 'q5': ("What gets in the way of talk like this on a difficult morning?",
        "Be honest. This is the useful one.",
        "The honest question"),
 'q6': ("What would be most helpful for you to do ShREC better?",
        "Time is always a pressure, but what else?",
        "Before you go"),
}

def question_slide(qid, n):
    q, hint, kicker = QUESTIONS[qid]
    # attribute-safe: curly quotes become &quot; so the value survives the attribute
    attr_q    = q.replace('&ldquo;','&quot;').replace('&rdquo;','&quot;')
    attr_hint = hint.replace('"','&quot;')
    plain_kick = kicker.replace('&middot;','\u00b7')
    return u'''  <!-- ===== W{n} · RESPONSE WALL · {qid} ===== -->
  <section class="slide wallslide" data-notes="w-{qid}" data-prompt="{qid}"
           data-question="{attr_q}"
           data-hint="{attr_hint}">
    <div class="kicker reveal d1"><span class="fx-pulse c-red"></span> &nbsp;Response wall &middot; {kicker}</div>
    <h2 class="reveal d2">{q}</h2>
    <p class="wallhint reveal d3">{hint}</p>
    <div class="walldeck reveal d4">
      <div class="wallgrid" style="--cols:2"></div>
      <aside class="wallside">
        <div class="wallqr">
          <img alt="Scan to join the response wall">
          <div class="qr-hint">Scan to join</div>
          <div class="url">jrodgers-edu.github.io/Response-Wall</div>
        </div>
        <div class="walltally"><div class="n">0</div><span>on the wall</span></div>
      </aside>
    </div>
  </section>
'''.format(n=n, qid=qid, q=q, hint=hint, kicker=kicker, attr_q=attr_q, attr_hint=attr_hint, plain_kick=plain_kick)

# original 1-indexed slide numbers, with 'qN' marking an inserted question slide
ORDER = [1, 2, 12, 'q1',
         3, 4, 5, 6, 7, 8, 9, 10, 11, 'q2',
         13, 'q4',
         14, 15, 16, 17, 'q5',
         18, 19, 'q3',
         20, 21, 22, 'q6',
         23, 24, 25]

out, wn = [], 0
for item in ORDER:
    if isinstance(item, str):
        wn += 1
        out.append(question_slide(item, wn))
    else:
        out.append(blocks[item-1])

body = pre + '\n'.join(out)
assert len(out) == 31, len(out)

# ---- presenter notes for the six question slides ----
NOTES = u'''
/* ---------- response wall slides (w1..w6) ---------- */
NOTES["w-q1"]=["Ask it before any of the evidence, because the answers are the baseline. Twenty practitioners describing a good conversation in their own words, before anyone has been told what the research says. Come back to two of them later if you can.","Say the anonymity line plainly first. Nothing carries a name, nothing is recorded against a room, and nothing reaches the screen until you show it. People type honestly once they believe that."];
NOTES["w-q2"]=["All four moves are now on the table, so this is the one that starts from what the setting already does well rather than auditing what it lacks. Read three or four aloud and look for the pattern across the room.","Across settings this is the aggregation question. Whichever move comes back weakest trust-wide is where the follow-up support goes."];
NOTES["w-q3"]=["A warm question and the one to cut if the session is running long. It works here because the routines timeline is next and this is its warm-up: shared attention that already happens without anyone planning it.","Push for a moment, a place or a routine rather than an aspiration. Nappy changing, the walk to the gate, the bit before lunch."];
NOTES["w-q4"]=["The question the whole wall exists for. Everything before it was preparation. Insist on the actual words they would say to the child, not a description of what they would do.","Read three responses aloud and ask what each one gives the child. The difference between responding and expanding argues itself and nobody has to be told. Point back at the fan if you need to."];
NOTES["w-q5"]=["The honest one, and it needs the silence. Say you want the difficult morning, not the good one, and then stop talking while people type.","These are the barriers in practitioners' own words, which is exactly what the implementation story needs and what a tick-box survey never produces. Do not defend against them on the day. Collect them."];
NOTES["w-q6"]=["The last one, and it asks what they need rather than what they will do. It sits here deliberately, after the conversation cycle and the goal setting, so people answer it knowing what the follow-up actually involves.","Time will come back and the hint heads it off, so push past it. These answers are the ones that shape what the implementation lead offers next, and across settings they are the clearest signal of what the rollout should fund."];
'''

# ---- inject CSS, JS and notes ----
css = io.open(SP_CSS, encoding='utf-8').read()
js  = io.open(SP_JS,  encoding='utf-8').read()

head = head.replace('</head>', css.rstrip('\n') + '\n</head>')
tail = tail.replace('<div id="notes">',
                    '<div class="wallstale" id="wallstale">Reconnecting</div>\n\n<div id="notes">')
tail = tail.replace('\ngo(0);\n',
                    '\n' + NOTES.strip() + '\n\nwindow.go = go;\nwindow.JOIN_QR = "' + JOIN_QR + '";\n\ngo(0);\n')
tail = tail.replace('</body>', js.rstrip('\n') + '\n</body>')

s = head + body + tail
io.open(SRC, 'w', encoding='utf-8').write(s)
print('sections:', len(out), '| questions:', wn, '| bytes:', len(s))
