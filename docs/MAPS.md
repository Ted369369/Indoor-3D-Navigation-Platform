# The maps

Each library is one JSON file in `web/data/`. This page says where the numbers
came from, so anyone checking the model knows which parts are measured and
which are guesses.

## Taipei Public Library, Main Library (`map_model.json`)

- Five floors, 1F to 5F, 3.8 m apart, drawn as a 50 x 35 m rectangle.
- Traced from the hand-drawn plans in `raw_map/`, the pictures in
  `raw_picture/` and photos of the library's own floor guide.
- The real building is rotated relative to north. The model is drawn north-up,
  so the GPS placement in the file is only approximate. Calibrate on site
  (Settings, Map calibration) before relying on it.

## Yorba Linda Public Library (`yorba_linda.json`)

4852 Lakeview Ave, Yorba Linda, California. Two floors.

### Sources

1. The **lower and upper level campus maps** on the library's tour page,
   <https://ylpl.org/librarytour/>. Room names, positions and colours come from
   these, along with the descriptions of each stop on the tour (1 to 18).
2. The **building footprint** from OpenStreetMap,
   [way 1111599863](https://www.openstreetmap.org/way/1111599863). It sets the
   real size (about 97 x 42 m), the outline used for both floors, and the GPS
   anchors. The arts center (way 1111599862) is just north, which is why the
   entrance is on the north side of the lobby.
3. Room capacity for the Community Room (185 seats theater style) is from
   <https://ylpl.org/floorplans/>.

### How the maps were traced

The two tour images are 764 px wide. Points were read off them on a grid and
turned into metres:

- Across, both images span 717 px for the 97.2 m the footprint measures, so
  1 px = 0.1356 m.
- Down, the lower level image uses the same scale. The upper level image was
  published squashed vertically, so it gets its own scale: 285 px for 41.5 m,
  1 px = 0.1456 m.
- The tour map draws the south-east corner a few metres wider than the real
  footprint. Room corners past the OSM east wall were pulled back to it.

The script that did this isn't in the repository; the coordinates in the JSON
are the result, rounded to 0.1 m.

### What is estimated

These are **not** on the public maps, so treat them as placeholders until
someone checks on site:

| Item | What the model assumes |
|---|---|
| Floor height | 5.5 m between the lower and upper level. The lobby is double height, but no exact figure was found. Floor detection only needs the two levels to be clearly apart, so small errors here don't matter much. |
| Elevator | Next to the grand staircase, on the north side of the lobby. |
| West stairs | The small room at the west end of both floors, beside the storytime theater downstairs and inside the adult area upstairs. It sits in the same place on both maps, which is typical of an exit stair, but the map doesn't label it. |
| Unlabelled grey areas | The public map shows large grey areas without names (the middle of the lower level, the south half of the upper level, and two small rooms). They are in the model as "Unlabelled area", marked not open to visitors and not routable. |
| Adult collection layout | The map shows "Adults" as one area. Search sends every adult subject there and mentions the Dewey hundreds to look for, but it can't say which shelf. |
| Periodicals | No separate area is shown, so "newspapers" goes to the adult reading room. |
| Walkable paths | Drawn by hand between room doors shown on the map. Doors that aren't drawn were assumed. |

If you visit and find any of these wrong, fix the numbers in
`web/data/yorba_linda.json` and restart the engine.
