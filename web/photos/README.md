# Zone photos

Put a photo of an area in this folder and it shows up when someone taps that
zone on the map. No code change needed.

## File names

Use the zone id as the file name, with `.jpg`. The name has to match the id
exactly, including upper case, because GitHub Pages is case-sensitive:

```
web/photos/3F-REF.jpg     Chinese reference collection
web/photos/1F-A.jpg       Learning e-Garden
web/photos/5F-C.jpg       Science books
```

The ids are the `id` fields in `../data/map_model.json`. The app loads
`photos/<ZONE-ID>.jpg` and shows a plain coloured box if there's no file. If you
want a different file name or an external URL, add a `"photo"` field to that
zone in `map_model.json`.

A landscape JPG around 1000x600 px and under 300 KB works well.

## Copyright

The repository is public, so only add photos you're allowed to publish: ones
you took yourself, or ones whose licence allows it. Don't copy photos from the
library's website or social media without permission.
