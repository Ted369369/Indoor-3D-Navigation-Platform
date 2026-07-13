/*
 * Deployment configuration - fill these in before hosting.
 * The app runs in solo mode (no friends) if Supabase is left blank.
 */
window.NAV_CONFIG = {
  // HiveMQ Cloud WebSocket endpoint (Overview page > WebSocket port 8884)
  mqttUrl: "wss://xxxxxxxx.s1.eu.hivemq.cloud:8884/mqtt",
  mqttUser: "webapp",
  mqttPass: "changeme",

  // Supabase project (Settings > API). Leave empty to disable friends/auth.
  supabaseUrl: "",
  supabaseAnonKey: "",

  // Rates and limits (should match the position engine)
  gpsPublishHz: 1,
  maxDevices: 5,
};
