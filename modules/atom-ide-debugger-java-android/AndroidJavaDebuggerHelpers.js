/**
 * Copyright (c) 2017-present, Facebook, Inc.
 * All rights reserved.
 *
 * This source code is licensed under the BSD-style license found in the
 * LICENSE file in the root directory of this source tree. An additional grant
 * of patent rights can be found in the PATENTS file in the same directory.
 *
 * @flow
 * @format
 */

import type {SshTunnelService, AdbDevice} from 'nuclide-adb/lib/types';
import type {NuclideUri} from 'nuclide-commons/nuclideUri';
import type {JavaAttachPortTargetConfig} from 'atom-ide-debugger-java/JavaDebuggerHelpersService';

import nullthrows from 'nullthrows';
import invariant from 'assert';
import {getJavaDebuggerHelpersServiceByNuclideUri} from 'atom-ide-debugger-java/utils';
import UniversalDisposable from 'nuclide-commons/UniversalDisposable';
import {Subject} from 'rxjs';
import consumeFirstProvider from 'nuclide-commons-atom/consumeFirstProvider';
import nuclideUri from 'nuclide-commons/nuclideUri';
import {getAdbServiceByNuclideUri} from 'nuclide-adb';

// Only one AdbProcessInfo can be active at a time. Since it ties up a forwarded
// adb port, new instances need to wait for the previous one to clean up before
// they can begin debugging.
let cleanupSubject: ?Subject<void> = null;

export type AndroidDebugTargetInfo = {
  pid: number,
  attach: boolean,
};

export async function launchAndroidServiceOrActivity(
  adbServiceUri: NuclideUri,
  service: ?string,
  activity: ?string,
  action: ?string,
  device: AdbDevice,
  packageName: string,
): Promise<void> {
  const adbService = getAdbServiceByNuclideUri(adbServiceUri);
  if (service != null) {
    await adbService.launchService(
      device.serial,
      packageName,
      service || '',
      true,
    );
  } else if (activity != null && action != null) {
    // First query the device to be sure the activity exists in the specified package.
    // This will allow us to bubble up a useful error message instead of a cryptic
    // adb failure if the user simply mistyped the activity or package name.
    const activityExists = await adbService.activityExists(
      device.serial,
      packageName,
      activity || '',
    );

    if (!activityExists) {
      const packages = await adbService.getAllAvailablePackages(device.serial);
      const availableActivities = new Set(
        packages.filter(line => line.includes(packageName + '/')),
      );
      atom.notifications.addError(
        `Activity ${activity || ''} does not exist in package ` +
          packageName +
          '\n' +
          'Did you mean one of these activities: ' +
          '\n' +
          Array.from(availableActivities)
            .map(activityLine => activityLine.split('/')[1])
            .join('\n'),
      );
    }

    await adbService.launchActivity(
      device.serial,
      packageName,
      activity || '',
      true,
      action,
    );
  }
}

export async function getPidFromPackageName(
  adbServiceUri: NuclideUri,
  device: AdbDevice,
  packageName: string,
): Promise<number> {
  const adbService = getAdbServiceByNuclideUri(adbServiceUri);
  const pid = await adbService.getPidFromPackageName(
    device.serial,
    packageName,
  );
  if (!Number.isInteger(pid)) {
    throw new Error(`Fail to get pid for package: ${packageName}`);
  }
  return pid;
}

export async function getAdbAttachPortTargetInfo(
  device: AdbDevice,
  adbServiceUri: NuclideUri,
  targetUri: NuclideUri,
  pid: ?number,
  subscriptions: UniversalDisposable,
): Promise<JavaAttachPortTargetConfig> {
  const tunnelRequired =
    nuclideUri.isLocal(adbServiceUri) && nuclideUri.isRemote(targetUri);
  const tunnelService = tunnelRequired
    ? (await consumeFirstProvider('nuclide.ssh-tunnel'): ?SshTunnelService)
    : null;
  const adbService = getAdbServiceByNuclideUri(adbServiceUri);
  // tunnel Service's getAvailableServerPort does something weird where it
  //   wants adbServiceUri to be either '' or 'localhost'
  const adbPort = tunnelRequired
    ? await nullthrows(tunnelService).getAvailableServerPort(
        nuclideUri.isLocal(adbServiceUri) ? 'localhost' : adbServiceUri,
      )
    : await getJavaDebuggerHelpersServiceByNuclideUri(
        adbServiceUri,
      ).getPortForJavaDebugger();
  const forwardSpec = await adbService.forwardJdwpPortToPid(
    device.serial,
    adbPort,
    pid || 0,
  );

  if (cleanupSubject != null) {
    await cleanupSubject.toPromise();
  }
  cleanupSubject = new Subject();
  subscriptions.add(async () => {
    const result = await adbService.removeJdwpForwardSpec(
      device.serial,
      forwardSpec,
    );
    if (result.trim().startsWith('error')) {
      // TODO(Ericblue): The OneWorld proxy swaps TCP forward for a local filesystem
      // redirection, which confuses adb and prevents proper removal of
      // the forward spec.  Fall back to removing all specs to avoid leaking
      // the port.
      await adbService.removeJdwpForwardSpec(device.serial, null);
    }

    if (cleanupSubject != null) {
      cleanupSubject.complete();
    }
  });

  const attachPort = await new Promise(async (resolve, reject) => {
    try {
      if (!tunnelRequired) {
        resolve(adbPort);
        return;
      }
      invariant(tunnelService);
      const debuggerPort = await tunnelService.getAvailableServerPort(
        targetUri,
      );
      const tunnel = {
        description: 'Java debugger',
        from: {
          host: nuclideUri.getHostname(targetUri),
          port: debuggerPort,
          family: 4,
        },
        to: {host: 'localhost', port: adbPort, family: 4},
      };
      const openTunnel = tunnelService.openTunnels([tunnel]).share();
      subscriptions.add(openTunnel.subscribe());
      await openTunnel.take(1).toPromise();
      resolve(debuggerPort);
    } catch (e) {
      reject(e);
    }
  });
  return {
    debugMode: 'attach',
    machineName: 'localhost',
    port: attachPort,
  };
}
