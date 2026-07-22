# Zone photos

Drop a real photo of an area here and it appears automatically when a visitor
taps that zone on the map — no code changes needed.

## Convention

Name the file after the zone id, lower- or upper-case, `.jpg`:

```
web/photos/3F-REF.jpg     ← Chinese reference collection
web/photos/1F-A.jpg       ← Learning e-Garden
web/photos/5F-C.jpg       ← Science books
```

Zone ids are listed in `../data/map_model.json` (the `id` field of each zone).
The app requests `photos/<ZONE-ID>.jpg`; if the file is missing it shows a
coloured placeholder instead. To point a zone at a different filename or an
external URL, set a `"photo"` field on that zone in `map_model.json`.

Recommended: landscape JPG, ~1000×600 px, under ~300 KB.

## Copyright

Only add photos you have the right to publish — ones you took yourself, or
images with a licence that permits redistribution. Do not drop in photos
copied from the library's website, social media, or other sites without
permission; this repository is public.
