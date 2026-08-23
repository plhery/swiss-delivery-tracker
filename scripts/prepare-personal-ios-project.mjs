import { readFile, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

const replacements = [
  [
    'buildPhases = (E30000000000000000000001, E20000000000000000000001, E40000000000000000000001, E10000000000000000000001, ); buildRules = (); dependencies = (D20000000000000000000001, D20000000000000000000003, );',
    'buildPhases = (E30000000000000000000001, E20000000000000000000001, E40000000000000000000001, E10000000000000000000001, ); buildRules = (); dependencies = (D20000000000000000000003, );',
    1,
  ],
  [
    'A10000000000000000000001 = {CreatedOnToolsVersion = 26.6; SystemCapabilities = {com.apple.ApplicationGroups.iOS = {enabled = 1; }; com.apple.Push = {enabled = 1; }; }; };',
    'A10000000000000000000001 = {CreatedOnToolsVersion = 26.6; };',
    1,
  ],
  [
    'A10000000000000000000004 = {CreatedOnToolsVersion = 26.6; SystemCapabilities = {com.apple.ApplicationGroups.iOS = {enabled = 1; }; }; };',
    'A10000000000000000000004 = {CreatedOnToolsVersion = 26.6; };',
    1,
  ],
  [
    'files = (B10000000000000000000014 /* ShareExtension.appex in Embed App Extensions */, B10000000000000000000022 /* DeliveryWidgetExtension.appex in Embed App Extensions */, );',
    'files = (B10000000000000000000022 /* DeliveryWidgetExtension.appex in Embed App Extensions */, );',
    1,
  ],
  ['APS_ENVIRONMENT = development; ', '', 1],
  ['APS_ENVIRONMENT = production; ', '', 1],
  ['CODE_SIGN_ENTITLEMENTS = SwissDeliveryTracker/SwissDeliveryTracker.entitlements; ', '', 2],
  ['CODE_SIGN_ENTITLEMENTS = DeliveryWidgetExtension/DeliveryWidgetExtension.entitlements; ', '', 2],
  [
    'PRODUCT_BUNDLE_IDENTIFIER = com.plhery.SwissDeliveryTracker;',
    'PRODUCT_BUNDLE_IDENTIFIER = com.plhery.SwissDeliveryTracker.Personal;',
    2,
  ],
  [
    'PRODUCT_BUNDLE_IDENTIFIER = com.plhery.SwissDeliveryTracker.DeliveryWidget;',
    'PRODUCT_BUNDLE_IDENTIFIER = com.plhery.SwissDeliveryTracker.Personal.DeliveryWidget;',
    2,
  ],
];

function occurrenceCount(text, value) {
  return text.split(value).length - 1;
}

/** Prepare a temporary Xcode project for Personal Team signing. */
export async function preparePersonalIosProject(projectFile) {
  let text = await readFile(projectFile, 'utf8');
  for (const [oldValue, newValue, expected] of replacements) {
    const count = occurrenceCount(text, oldValue);
    if (count !== expected) {
      throw new Error(
        `Expected ${expected} project matches, found ${count}: ${oldValue.slice(0, 72)}`,
      );
    }
    text = text.replaceAll(oldValue, newValue);
  }
  await writeFile(projectFile, text, 'utf8');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const projectFile = process.argv[2];
  if (!projectFile) {
    console.error('Usage: node scripts/prepare-personal-ios-project.mjs PROJECT_FILE');
    process.exitCode = 2;
  } else {
    await preparePersonalIosProject(projectFile);
  }
}
