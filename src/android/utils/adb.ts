import { spawn } from 'child_process';
import * as Debug from 'debug';
import * as split2 from 'split2';
import * as through2 from 'through2';

import { ADBException, ERR_INCOMPATIBLE_UPDATE } from '../../errors';
import { execFile } from '../../utils/process';

import { SDK } from './sdk';

const debug = Debug('native-run:android:utils:adb');

export interface DeviceProperties {
  [key: string]: string | undefined;
}

export interface Device {
  serial: string;
  state: string; // 'offline' | 'device' | 'no device'
  type: 'emulator' | 'hardware';
  manufacturer: string;
  model: string;
  product: string;
  sdkVersion: string;
  properties: DeviceProperties;
}

const ADB_GETPROP_MAP: ReadonlyMap<string, keyof Device> = new Map<string, keyof Device>([
  ['ro.product.manufacturer', 'manufacturer'],
  ['ro.product.model', 'model'],
  ['ro.product.name', 'product'],
  ['ro.build.version.sdk', 'sdkVersion'],
]);

// export async function getDeviceSerials(sdk: SDK): Promise<string[]> {
//   const adbBin = `${sdk.platformTools.path}/adb`;
//   const args = ['devices'];
//   debug('Invoking adb: %O %O', adbBin, args);

//   const { stdout } = await execFile(adbBin, args);

//   const devices = parseAdbDevices(stdout);

//   return devices.map(device => device.serial);
// }

export async function getDevices(sdk: SDK): Promise<Device[]> {
  const adbBin = `${sdk.platformTools.path}/adb`;
  const args = ['devices', '-l'];
  debug('Invoking adb: %O %O', adbBin, args);

  const { stdout } = await execFile(adbBin, args);

  const devices = parseAdbDevices(stdout);

  await Promise.all(devices.map(async device => {
    const properties = await getDeviceProperties(sdk, device);

    for (const [ prop, deviceProp ] of ADB_GETPROP_MAP.entries()) {
      const value = properties[prop];

      if (value) {
        device[deviceProp] = value;
      }
    }
  }));

  return devices;
}

export async function getDeviceProperty(sdk: SDK, device: Device, property: string): Promise<string> {
  const adbBin = `${sdk.platformTools.path}/adb`;
  const args = ['-s', device.serial, 'shell', 'getprop', property];
  debug('Invoking adb: %O %O', adbBin, args);

  const { stdout } = await execFile(adbBin, args);

  return stdout.trim();
}

export async function getDeviceProperties(sdk: SDK, device: Device): Promise<DeviceProperties> {
  const re = /^\[([a-z0-9\.]+)\]: \[(.*)\]$/;
  const adbBin = `${sdk.platformTools.path}/adb`;
  const args = ['-s', device.serial, 'shell', 'getprop'];
  debug('Invoking adb: %O %O', adbBin, args);
  const propAllowList = [...ADB_GETPROP_MAP.keys()];

  const { stdout } = await execFile(adbBin, args);
  const properties: DeviceProperties = {};

  for (const line of stdout.split('\n')) {
    const m = line.match(re);

    if (m) {
      const [ , key, value ] = m;

      if (propAllowList.includes(key)) {
        properties[key] = value;
      }
    }
  }

  return properties;
}

export async function waitForDevice(sdk: SDK, serial: string): Promise<void> {
  const adbBin = `${sdk.platformTools.path}/adb`;
  const args = ['-s', serial, 'wait-for-any-device'];
  debug('Invoking adb: %O %O', adbBin, args);

  await execFile(adbBin, args);
}

export async function waitForBoot(sdk: SDK, device: Device): Promise<void> {
  return new Promise<void>(resolve => {
    const interval = setInterval(async () => {
      const booted = await getDeviceProperty(sdk, device, 'dev.bootcomplete');

      if (booted) {
        clearInterval(interval);
        resolve();
      }
    }, 100);
  });
}

export async function installApk(sdk: SDK, device: Device, apk: string): Promise<void> {
  const adbBin = `${sdk.platformTools.path}/adb`;
  const args = ['-s', device.serial, 'install', '-r', '-t', apk];
  debug('Invoking adb: %O %O', adbBin, args);

  const p = spawn(adbBin, args, { stdio: 'pipe' });

  return new Promise<void>((resolve, reject) => {
    p.on('close', code => {
      if (code === 0) {
        resolve();
      } else {
        reject(new ADBException(`Non-zero exit code from adb: ${code}`));
      }
    });

    p.on('error', err => {
      debug('adb install error: %O', err);
      reject(err);
    });

    p.stderr.pipe(split2()).pipe(through2((chunk, enc, cb) => {
      const line = chunk.toString();

      debug('adb install: %O', line);
      const event = parseAdbInstallOutput(line);

      if (event === ADBEvent.IncompatibleUpdate) {
        reject(new ADBException(`Encountered adb error: ${ADBEvent[event]}.`, ERR_INCOMPATIBLE_UPDATE));
      }

      cb();
    }));
  });
}

export async function uninstallApp(sdk: SDK, device: Device, app: string): Promise<void> {
  const adbBin = `${sdk.platformTools.path}/adb`;
  const args = ['-s', device.serial, 'uninstall', app];
  debug('Invoking adb: %O %O', adbBin, args);

  await execFile(adbBin, args);
}

export enum ADBEvent {
  IncompatibleUpdate, // signatures do not match the previously installed version
}

export function parseAdbInstallOutput(line: string): ADBEvent | undefined {
  let event: ADBEvent | undefined;

  if (line.includes('INSTALL_FAILED_UPDATE_INCOMPATIBLE')) {
    event = ADBEvent.IncompatibleUpdate;
  }

  if (typeof event !== 'undefined') {
    debug('Parsed event from adb install output: %s', ADBEvent[event]);
  }

  return event;
}

export async function startActivity(sdk: SDK, device: Device, packageName: string, activityName: string): Promise<void> {
  const adbBin = `${sdk.platformTools.path}/adb`;
  const args = ['-s', device.serial, 'shell', 'am', 'start', '-W', '-n', `${packageName}/${activityName}`];
  debug('Invoking adb: %O %O', adbBin, args);

  await execFile(adbBin, args);
}

export function parseAdbDevices(output: string): Device[] {
  const re = /^([\S]+)\s+([a-z\s]+)\s+(.*)$/;
  const lines = output.split('\n');

  const devices: Device[] = [];

  for (const line of lines) {
    if (line && !line.startsWith('List')) {
      const m = line.match(re);

      if (m) {
        const [ , serial, state, description ] = m;
        const properties = description
          .split(/\s+/)
          .map(prop => prop.includes(':') ? prop.split(':') : undefined)
          .filter((kv): kv is [string, string] => typeof kv !== 'undefined' && typeof kv[0] === 'string' && typeof kv[1] === 'string')
          .reduce((acc, [ k, v ]) => {
            if (k && v) {
              acc[k.trim()] = v.trim();
            }

            return acc;
          }, {} as { [key: string]: string; });

        devices.push({
          serial,
          state,
          type: 'usb' in properties ? 'hardware' : 'emulator',
          properties,
          // We might not know these yet
          manufacturer: '',
          model: properties['model'] || '',
          product: '',
          sdkVersion: '',
        });
      } else {
        debug('adb devices output line does not match expected regex: %O', line);
      }
    }
  }

  return devices;
}
