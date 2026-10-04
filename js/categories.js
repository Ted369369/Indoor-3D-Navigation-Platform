/*
 * What each kind of place looks like: the tint of the room on the map, the
 * colour of its icon badge, and a short label for lists.
 *
 * A zone's `kind` picks the category. Models can override that with `cat`
 * (e.g. a children's area is a collection, but should read as "children")
 * and pick a more specific symbol with `icon`.
 */

export const CATEGORIES = {
  collection: { label: "Books", fill: "#e3ebf8", color: "#3a6cc2", icon: "menu_book" },
  children: { label: "Children", fill: "#fcefc4", color: "#c08400", icon: "child_care" },
  teen: { label: "Teens", fill: "#fce3cf", color: "#cf651c", icon: "sports_esports" },
  reading: { label: "Reading and study", fill: "#dff0e3", color: "#2c8752", icon: "chair" },
  service: { label: "Service", fill: "#ebe3f6", color: "#7650b8", icon: "support_agent" },
  entrance: { label: "Entrance", fill: "#ebe3f6", color: "#7650b8", icon: "door_front" },
  digital: { label: "Computers", fill: "#dcf0ee", color: "#1b827c", icon: "computer" },
  facility: { label: "Facility", fill: "#e7ebf0", color: "#56677a", icon: "print" },
  program: { label: "Programs", fill: "#fae5da", color: "#c35a2a", icon: "theater_comedy" },
  meeting: { label: "Meeting room", fill: "#fae5da", color: "#c35a2a", icon: "meeting_room" },
  shop: { label: "Shop", fill: "#f8e1e8", color: "#b8456d", icon: "storefront" },
  outdoor: { label: "Outdoor", fill: "#e2eed8", color: "#53843a", icon: "deck" },
  restricted: { label: "On request", fill: "#e9edf2", color: "#65768a", icon: "lock" },
  restroom: { label: "Restroom", fill: "#e6e9ee", color: "#4b5c6e", icon: "wc" },
  stairs: { label: "Stairs", fill: "#e5e8ed", color: "#465366", icon: "stairs" },
  escalator: { label: "Escalator", fill: "#e5e8ed", color: "#465366", icon: "escalator" },
  elevator: { label: "Elevator", fill: "#e5e8ed", color: "#465366", icon: "elevator" },
  staff: { label: "Staff only", fill: "#ecebe8", color: "#858b92", icon: "lock" },
};

/** Kinds that are ways between floors or amenities: icon only, no name on the map. */
export const AMENITY_KINDS = new Set(["stairs", "escalator", "elevator", "restroom"]);

export function categoryOf(zone) {
  return CATEGORIES[zone.cat] || CATEGORIES[zone.kind] || CATEGORIES.collection;
}

export function iconOf(zone) {
  return zone.icon || categoryOf(zone).icon;
}
