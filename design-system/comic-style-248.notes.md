# Turn 248 · A graphic novel's comic style

Proposed 29 October 2026.

## Why this turn

The owner asked: "In the UI do we allow users to select a comic style and does the UI show the comic
style image for selection to make it easy for users to identify? If not you are permitted to use the
bench and CHATGPT Image generation to create the comic style images."

The Studio has no such choice. A graphic novel's pages take the world's art direction (its master
look) and nothing else. The art-direction picker (turn 38) has nine looks, one of them "Graphic
novel". Its cards are small SVG studies of forms, not comic pages.

## The frames

| Frame | What it decides |
|---|---|
| 248a | Tell a story with Graphic novel picked: Style under Name and Adapt from. Ten cards and Your own, then the words. |
| 248b | Pages: Style beside Reading. A sheet with the same cards and words. Use style applies to pages made from then on. |

## The pictures

Every card is the same page drawn in its style: turn 247's Low Water page 3. Maren holds a lantern
on the flooded pier, then calls "Where are you?", then the empty water and a boat with "Hsssh". Same
subject, same panels, same lettering, so the cards differ only in how the page is drawn.

ChatGPT Image (the Studio's `codex-image` route, included in the plan) made them on
29 October 2026. The brief is the page and one sentence of style words. No reference pictures were
sent, and no artist or publisher is named. The design copies are JPEGs in `assets/comic-styles/`.
The app ships the same pictures; it never generates them on demand.

The style words each card seeds:

| Card | Words |
|---|---|
| World look | the world's art direction (the card shows the world's key art) |
| Manga | Japanese manga: black and white only, crisp pen line, grey screentone shading, speed lines and dramatic close-ups. |
| Superhero | American superhero comic: bold confident ink contour, four-colour flat fills with hard cel shadows, dramatic angles and foreshortening, saturated primaries. |
| Clean line | European clean-line comic: one even unbroken ink line, flat bright colour with no hatching and no gradients, clear detailed backgrounds, calm readable staging. |
| Noir | Crime noir comic: solid black shapes and stark white, hard light carving the figure, almost no midtones, rain and shadow as graphic shapes. |
| Webtoon | Modern webtoon: soft full-colour digital painting, clean thin line, gentle cel shading with soft glow, smooth gradients in the sky. |
| Painted | Fully painted graphic novel: every panel painted in oils or gouache with visible brushwork, rich atmospheric light, no ink outlines. |
| Watercolour | Indie watercolour comic: loose ink line over transparent watercolour washes, warm paper showing through, soft bleeding edges. |
| Ink and wash | Black ink and grey wash comic: brush contour, washed greys, dramatic negative space, the paper grain showing, no colour. |
| Vintage print | Vintage newsprint comic from the 1950s: thick ink line, flat four-colour printing with visible halftone dots, slight misregistration. |

## Calls for the owner

1. Ten styles and Your own. World look comes first and is the default.
2. Each card is the same sample page drawn in its style, made once and shipped with the app.
3. The words are the record. A card only seeds them.
4. Style is picked when the book is made and changed in Pages.
5. A change applies to the pages made next. Pages already made are not remade.

## Not drawn

A style per chapter, phone layouts, and a style's own reference picture riding with the brief.
