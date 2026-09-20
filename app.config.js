// Lets anyone build with their own Apple team WITHOUT editing app.json.
// With none of these set, this file returns app.json untouched (Hamza's team, bundle id and widget).
// To override, put these in .env.local (git-ignored):
//   FRESCO_BUNDLE_ID=com.yourname.fresco   your own unique bundle id
//   FRESCO_TEAM_ID=ABCDE12345              optional; otherwise pick the team in Xcode
//   FRESCO_NO_WIDGET=1                     free "Personal Team" accounts cannot use App Groups,
//                                          so the widget target and App Group entitlement are dropped
module.exports = ({ config }) => {
  const bundleId = process.env.FRESCO_BUNDLE_ID;
  if (!bundleId) return config;

  const ios = { ...config.ios, bundleIdentifier: bundleId };
  if (process.env.FRESCO_TEAM_ID) ios.appleTeamId = process.env.FRESCO_TEAM_ID;
  else delete ios.appleTeamId; // never inherit someone else's team

  let plugins = config.plugins;
  if (process.env.FRESCO_NO_WIDGET === '1') {
    const { 'com.apple.security.application-groups': _groups, ...entitlements } = ios.entitlements ?? {};
    ios.entitlements = entitlements;
    plugins = (plugins ?? []).filter((p) => (Array.isArray(p) ? p[0] : p) !== '@bacons/apple-targets');
  }
  return { ...config, ios, plugins };
};
