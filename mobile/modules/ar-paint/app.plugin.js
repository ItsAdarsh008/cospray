const { AndroidConfig, withAndroidManifest } = require('expo/config-plugins');

/**
 * Android: how ARCore's cloud services (Cloud Anchors, Geospatial) authenticate, read from the
 * environment / .env.local at prebuild time.
 *
 *   ARCORE_AUTH=keyless   OAuth via the app's signing certificate, registered in Google Cloud
 *                         (see goal2.md). Cloud Anchors live up to 365 days. Use this for anything
 *                         public: there is no key in the APK to extract.
 *   ARCORE_API_KEY=AIza…  API key in the manifest. Cloud Anchors expire after 1 day (ARCore's cap
 *                         for key auth), so pieces lose their exact placement overnight.
 *
 * Neither: the app still paints in AR; saved pieces reappear "placed from memory".
 */
const KEYLESS_META = 'expo.modules.arpaint.KEYLESS';

module.exports = function withArPaint(config) {
  return withAndroidManifest(config, (cfg) => {
    const app = AndroidConfig.Manifest.getMainApplicationOrThrow(cfg.modResults);
    const keyless = (process.env.ARCORE_AUTH || '').trim().toLowerCase() === 'keyless';
    const key = (process.env.ARCORE_API_KEY || '').trim();
    // with both, ARCore would use the key: keyless only works when the key is absent
    if (key && !keyless) AndroidConfig.Manifest.addMetaDataItemToMainApplication(app, 'com.google.android.ar.API_KEY', key);
    else AndroidConfig.Manifest.removeMetaDataItemFromMainApplication(app, 'com.google.android.ar.API_KEY');
    if (keyless) AndroidConfig.Manifest.addMetaDataItemToMainApplication(app, KEYLESS_META, 'true');
    else AndroidConfig.Manifest.removeMetaDataItemFromMainApplication(app, KEYLESS_META);
    return cfg;
  });
};
