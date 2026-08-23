import assert from 'node:assert/strict';
import { copyFile, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { preparePersonalIosProject } from './prepare-personal-ios-project.mjs';

const temporaryDirectory = await mkdtemp(join(tmpdir(), 'delivery-ios-project-'));
after(() => rm(temporaryDirectory, { recursive: true, force: true }));

describe('Personal Team Xcode project preparation', () => {
  it('removes unsupported capabilities and rewrites bundle identifiers exactly once', async () => {
    const source = fileURLToPath(new URL(
      '../ios/SwissDeliveryTracker.xcodeproj/project.pbxproj',
      import.meta.url,
    ));
    const target = join(temporaryDirectory, 'project.pbxproj');
    await copyFile(source, target);

    await preparePersonalIosProject(target);
    const transformed = await readFile(target, 'utf8');
    assert.doesNotMatch(
      transformed,
      /CODE_SIGN_ENTITLEMENTS = (?:SwissDeliveryTracker|DeliveryWidgetExtension)\//,
    );
    assert.doesNotMatch(transformed, /APS_ENVIRONMENT =/);
    assert.match(
      transformed,
      /PRODUCT_BUNDLE_IDENTIFIER = com\.plhery\.SwissDeliveryTracker\.Personal;/,
    );
    assert.match(
      transformed,
      /PRODUCT_BUNDLE_IDENTIFIER = com\.plhery\.SwissDeliveryTracker\.Personal\.DeliveryWidget;/,
    );
    await assert.rejects(() => preparePersonalIosProject(target), /Expected 1 project matches/);
  });
});
