/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as fs from 'fs';
import * as os from 'os';
import * as util from './common';

const unknown = 'unknown';

/**
 * There is no standard way on Linux to find the distribution name and version.
 * Recently, systemd has pushed to standardize the os-release file. This has
 * seen adoption in "recent" versions of all major distributions.
 * https://www.freedesktop.org/software/systemd/man/os-release.html
 */
export class LinuxDistribution {
    public constructor(
        public name: string,
        public version: string,
        public idLike?: string[]) { }

    public static GetCurrent(): Promise<LinuxDistribution> {
        // Try /etc/os-release and fallback to /usr/lib/os-release per the synopsis
        // at https://www.freedesktop.org/software/systemd/man/os-release.html.
        return LinuxDistribution.FromFilePath('/etc/os-release')
            .catch(() => LinuxDistribution.FromFilePath('/usr/lib/os-release'))
            .catch(() => Promise.resolve(new LinuxDistribution(unknown, unknown)));
    }

    public toString(): string {
        return `name=${this.name}, version=${this.version}`;
    }

    private static FromFilePath(filePath: string): Promise<LinuxDistribution> {
        return new Promise<LinuxDistribution>((resolve, reject) => {
            fs.readFile(filePath, 'utf8', (error, data) => {
                if (error) {
                    reject(error);
                }
                else {
                    resolve(LinuxDistribution.FromReleaseInfo(data));
                }
            });
        });
    }

    public static FromReleaseInfo(releaseInfo: string, eol: string = os.EOL): LinuxDistribution {
        let name = unknown;
        let version = unknown;
        let idLike : string[] = null;

        const lines = releaseInfo.split(eol);
        for (let line of lines) {
            line = line.trim();

            let equalsIndex = line.indexOf('=');
            if (equalsIndex >= 0) {
                let key = line.substring(0, equalsIndex);
                let value = line.substring(equalsIndex + 1);

                // Strip double quotes if necessary
                if (value.length > 1 && value.startsWith('"') && value.endsWith('"')) {
                    value = value.substring(1, value.length - 1);
                }

                if (key === 'ID') {
                    name = value;
                }
                else if (key === 'VERSION_ID') {
                    version = value;
                }
                else if (key === 'ID_LIKE') {
                    idLike = value.split(" ");
                }

                if (name !== unknown && version !== unknown && idLike !== null) {
                    break;
                }
            }
        }

        return new LinuxDistribution(name, version, idLike);
    }
}

export class PlatformInformation {
    public runtimeId: string;

    public constructor(
        public platform: string,
        public architecture: string,
        public distribution: LinuxDistribution = null,
        linuxFallbackRuntimeId: ILinuxRuntimeIdFallback = null)
    {
        try {
            this.runtimeId = PlatformInformation.getRuntimeId(platform, architecture, distribution, linuxFallbackRuntimeId);
        }
        catch (err) {
            this.runtimeId = null;
        }
    }

    public isWindows(): boolean {
        return this.platform === 'win32';
    }

    public isMacOS(): boolean {
        return this.platform === 'darwin';
    }

    public isLinux(): boolean {
        return this.platform === 'linux';
    }

    public toString(): string {
        let result = this.platform;

        if (this.architecture) {
            if (result) {
                result += ', ';
            }

            result += this.architecture;
        }

        if (this.distribution) {
            if (result) {
                result += ', ';
            }

            result += this.distribution.toString();
        }

        return result;
    }

    public static GetCurrent(linuxFallbackRuntimeId: ILinuxRuntimeIdFallback = null): Promise<PlatformInformation> {
        let platform = os.platform();
        let architecturePromise: Promise<string>;
        let distributionPromise: Promise<LinuxDistribution>;

        switch (platform) {
            case 'win32':
                architecturePromise = PlatformInformation.GetWindowsArchitecture();
                distributionPromise = Promise.resolve(null);
                break;

            case 'darwin':
                architecturePromise = PlatformInformation.GetUnixArchitecture();
                distributionPromise = Promise.resolve(null);
                break;

            case 'linux':
                architecturePromise = PlatformInformation.GetUnixArchitecture();
                distributionPromise = LinuxDistribution.GetCurrent();
                break;

            default:
                throw new Error(`Unsupported platform: ${platform}`);
        }

        return Promise.all<any>([architecturePromise, distributionPromise])
            .then(([arch, distro]) => {
                return new PlatformInformation(platform, arch, distro, linuxFallbackRuntimeId);
            });
    }

    private static GetWindowsArchitecture(): Promise<string> {
        return new Promise<string>((resolve, reject) => {
            if (process.env.PROCESSOR_ARCHITECTURE === 'x86' && process.env.PROCESSOR_ARCHITEW6432 === undefined) {
                resolve('x86');
            }
            else {
                resolve('x86_64');
            }
        });
    }

    private static GetUnixArchitecture(): Promise<string> {
        return util.execChildProcess('uname -m')
            .then(architecture => {
                if (architecture) {
                    return architecture.trim();
                }

                return null;
            });
    }

    /**
     * Returns a supported .NET Core Runtime ID (RID) for the current platform. The list of Runtime IDs
     * is available at https://github.com/dotnet/corefx/tree/master/pkg/Microsoft.NETCore.Platforms.
     */
    private static getRuntimeId(platform: string, architecture: string, distribution: LinuxDistribution, linuxFallbackRuntimeId: ILinuxRuntimeIdFallback): string {
        // Note: We could do much better here. Currently, we only return a limited number of RIDs that
        // are officially supported.

        switch (platform) {
            case 'win32':
                switch (architecture) {
                    case 'x86': return 'win7-x86';
                    case 'x86_64': return 'win7-x64';
                }

                throw new Error(`Unsupported Windows architecture: ${architecture}`);

            case 'darwin':
                if (architecture === 'x86_64') {
                    // Note: We return the El Capitan RID for Sierra
                    return 'osx.10.11-x64';
                }

                throw new Error(`Unsupported macOS architecture: ${architecture}`);

            case 'linux':
                if (architecture === 'x86_64') {

                    // First try the distribution name
                    let runtimeId = PlatformInformation.getExactRuntimeId(distribution.name, distribution.version);

                    // If we didn't recognize the distribution or version, see if the caller has provided us a fall back value
                    if ((runtimeId === LinuxRuntimeId.unknown_distribution || runtimeId === LinuxRuntimeId.unknown_version) && linuxFallbackRuntimeId !== null)
                    {
                        const fallbackRuntimeValue = linuxFallbackRuntimeId.getFallbackLinuxRuntimeId();
                        if (fallbackRuntimeValue) {
                            runtimeId = fallbackRuntimeValue;
                        }
                    }

                    // If we don't have a fallback runtime id, try again with more fuzzy matching
                    if (runtimeId === LinuxRuntimeId.unknown_distribution) {
                        runtimeId = PlatformInformation.getRuntimeIdHelper(distribution.name, distribution.version);
                    }

                    // If the distribution isn't one that we understand, but the 'ID_LIKE' field has something that we understand, use that
                    //
                    // NOTE: 'ID_LIKE' doesn't specify the version of the 'like' OS. So we will use the 'VERSION_ID' value. This will restrict
                    // how useful ID_LIKE will be since it requires the version numbers to match up, but it is the best we can do.
                    if (runtimeId === LinuxRuntimeId.unknown_distribution && distribution.idLike && distribution.idLike.length > 0) {
                        for (let id of distribution.idLike) {
                            runtimeId = PlatformInformation.getRuntimeIdHelper(id, distribution.version);
                            if (runtimeId !== LinuxRuntimeId.unknown_distribution) {
                                break;
                            }
                        }
                    }

                    if (runtimeId !== LinuxRuntimeId.unknown_distribution && runtimeId !== LinuxRuntimeId.unknown_version) {
                        return runtimeId;
                    }
                }

                // If we got here, this is not a Linux distro or architecture that we currently support.
                throw new Error(`Unsupported Linux distro: ${distribution.name}, ${distribution.version}, ${architecture}`);
        }

        // If we got here, we've ended up with a platform we don't support  like 'freebsd' or 'sunos'.
        // Chances are, VS Code doesn't support these platforms either.
        throw Error('Unsupported platform ' + platform);
    }

    private static getExactRuntimeId(distributionName: string, distributionVersion: string): string {
        switch (distributionName) {
            case 'ubuntu':
                if (distributionVersion === "14.04") {
                    // This also works for Linux Mint
                    return LinuxRuntimeId.ubuntu_14_04;
                }
                else if (distributionVersion === "16.04") {
                    return LinuxRuntimeId.ubuntu_16_04;
                }
                else if (distributionVersion === "16.10") {
                    return LinuxRuntimeId.ubuntu_16_10;
                }
                break;

            case 'linuxmint':
                if (distributionVersion.startsWith("18")) {
                    // Linux Mint 18 is binary compatible with Ubuntu 16.04
                    return LinuxRuntimeId.ubuntu_16_04;
                }

                break;

            case 'centos':
            case 'ol':
                // Oracle Linux is binary compatible with CentOS
                return LinuxRuntimeId.centos_7;
            case 'fedora':
                if (distributionVersion === "23") {
                    return LinuxRuntimeId.fedora_23;
                } else if (distributionVersion === "24") {
                    return LinuxRuntimeId.fedora_24;
                }
                break;

            case 'opensuse':
                if (distributionVersion.startsWith("13.")) {
                    return LinuxRuntimeId.opensuse_13_2;
                } else if (distributionVersion.startsWith("42.")) {
                    return LinuxRuntimeId.opensuse_42_1;
                }
                break;

            case 'rhel':
                return LinuxRuntimeId.rhel_7;
            case 'debian':
                return LinuxRuntimeId.debian_8;
            default:
                return LinuxRuntimeId.unknown_distribution;
        }

        return LinuxRuntimeId.unknown_version;
    }

    private static getRuntimeIdHelper(distributionName: string, distributionVersion: string): string {

        const runtimeId: string = PlatformInformation.getExactRuntimeId(distributionName, distributionVersion);
        if (runtimeId !== LinuxRuntimeId.unknown_distribution) {
            return runtimeId;
        }

        switch (distributionName) {
            case 'Zorin OS':
            case 'zorin': // ID changed in 12.1
                if (distributionVersion === "12") {
                    return LinuxRuntimeId.ubuntu_16_04;
                }
                break;

            case 'elementary':
            case 'elementary OS':
                if (distributionVersion.startsWith("0.3")) {
                    // Elementary OS 0.3 Freya is binary compatible with Ubuntu 14.04
                    return LinuxRuntimeId.ubuntu_14_04;
                }
                else if (distributionVersion.startsWith("0.4")) {
                    // Elementary OS 0.4 Loki is binary compatible with Ubuntu 16.04
                    return LinuxRuntimeId.ubuntu_16_04;
                }
                break;

            case 'galliumos':
                if (distributionVersion.startsWith("2.0") || distributionVersion.startsWith("2.1")) {
                    return LinuxRuntimeId.ubuntu_16_04;
                }
                break;
            
            default:
                return LinuxRuntimeId.unknown_distribution;
        }

        return LinuxRuntimeId.unknown_version;
    }
}

class LinuxRuntimeId
{
    public static readonly unknown_distribution = 'unknown_distribution';
    public static readonly unknown_version = 'unknown_version';

    public static readonly centos_7 = 'centos.7-x64';
    public static readonly debian_8 = 'debian.8-x64';
    public static readonly fedora_23 = 'fedora.23-x64';
    public static readonly fedora_24 = 'fedora.24-x64';
    public static readonly opensuse_13_2 = 'opensuse.13.2-x64';
    public static readonly opensuse_42_1 = 'opensuse.42.1-x64';
    public static readonly rhel_7 = 'rhel.7-x64';
    public static readonly ubuntu_14_04 = 'ubuntu.14.04-x64';
    public static readonly ubuntu_16_04 = 'ubuntu.16.04-x64';
    public static readonly ubuntu_16_10 = 'ubuntu.16.10-x64';
};

export interface ILinuxRuntimeIdFallback
{
    getFallbackLinuxRuntimeId() : string;
}