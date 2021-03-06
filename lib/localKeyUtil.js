/**
 * Copyright 2017-2018 F5 Networks, Inc.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

'use strict';

const assert = require('assert');
const fs = require('fs');
const childProcess = require('child_process');
const q = require('q');
const cryptoUtil = require('../lib/cryptoUtil');
const util = require('../lib/util');
const Logger = require('./logger');

let logger = Logger.getLogger({
    logLevel: 'none',
    module
});

/**
 * This routines are utilities for setting up public/private keys.
 *
 * These routines are meant to be used locally on a BIG-IP and operate via tmsh
 * rather than iControl REST. This is so that we do not need to take in
 * unencrypted passwords as parameters either on the command line or via
 * the filesystem.
 *
 * Notes:
 *    + Only runs locally on a BIG-IP. Cannot run on a remote BIG-IP.
 *    + Uses tmsh rather than iControl REST so that we do not need to take in a password
 *
 * @module
 */
module.exports = {
    /**
     * Generates and installs a public/private key pair if not already installed
     *
     * @param {String}  publicKeyDirctory       - Directory into which to write the public key
     * @param {String}  publicKeyOutFile        - Filename for public key
     * @param {String}  privateKeyFolder        - BIG-IP folder into which to install the private key
     * @param {String}  privateKeyName          - Name for private key on BIG-IP
     * @param {Object}  [options]               - Optional parameters
     * @param {Boolean} [options.force]         - Force generation even if private key exists
     * @param {Boolean} [options.installPublic] - Install the public key as an iFile (so that it is synecd)
     *
     * @returns {Promise} A promise which is resolved with the name of the public key if we
     *                    installed one, or rejected if an error occurs.
     */
    generateAndInstallKeyPair(
        publicKeyDirectory,
        publicKeyOutFile,
        privateKeyFolder,
        privateKeyName,
        options
    ) {
        const PASSPHRASE_LENGTH = 18;
        const PRIVATE_KEY_TEMP_FILE = `/tmp/cloudLibsPrivate${Date.now()}.pem`;

        const force = options ? options.force : false;
        const installPublic = options ? options.installPublic : false;

        let passphrase;
        let installedPublicKeyPath;

        assert.equal(typeof publicKeyDirectory, 'string', 'publicKeyDirectory must be a string');
        assert.equal(typeof publicKeyOutFile, 'string', 'publicKeyOutFile must be a string');
        assert.equal(typeof privateKeyFolder, 'string', 'privateKeyFolder must be a string');
        assert.equal(typeof privateKeyName, 'string', 'privateKeyName must be a string');

        // Check to see if we have a key pair yet
        return this.privateKeyExists(privateKeyFolder, privateKeyName)
            .then((hasPrivateKey) => {
                if (hasPrivateKey && !force) {
                    logger.debug('Private key already exists');
                    if (installPublic) {
                        return q(this.getKeyFilePath('Common', 'ifile', privateKeyName));
                    }
                    return q();
                }

                if (hasPrivateKey) {
                    logger.debug('Private key exists. Regenerating.');
                } else {
                    logger.debug('No private key found - generating key pair');
                }

                return createDirectory(publicKeyDirectory)
                    .then(() => {
                        return cryptoUtil.generateRandomBytes(PASSPHRASE_LENGTH, 'base64');
                    })
                    .then((response) => {
                        passphrase = response;
                        return cryptoUtil.generateKeyPair(
                            PRIVATE_KEY_TEMP_FILE,
                            {
                                publicKeyOutFile,
                                passphrase,
                                keyLength: '3072'
                            }
                        );
                    })
                    .then(() => {
                        return installPrivateKey(
                            PRIVATE_KEY_TEMP_FILE,
                            privateKeyFolder,
                            privateKeyName,
                            { passphrase }
                        );
                    })
                    .then(() => {
                        if (installPublic) {
                            return installPublicKey.call(
                                this,
                                publicKeyOutFile,
                                privateKeyName
                            );
                        }
                        return q();
                    })
                    .then((publicKeyPath) => {
                        installedPublicKeyPath = publicKeyPath;
                        const func = function () {
                            return util.runTmshCommand('save sys config');
                        };

                        return util.tryUntil(this, util.MEDIUM_RETRY, func);
                    })
                    .then(() => {
                        return q(installedPublicKeyPath);
                    });
            });
    },

    /**
     *
     * @param {String} folder   - BIG-IP folder name.
     * @param {String} keyType - File type. For example: certificate_key or ifile.
     * @param {String} name     - Name of key.
     */
    getKeyFilePath(folder, keyType, name) {
        const KEY_DIR = `/config/filestore/files_d/${folder}_d/${keyType}_d/`;

        assert.equal(typeof folder, 'string', 'folder must be a string');
        assert.equal(typeof name, 'string', 'name must be a string');

        return util.runShellCommand(`ls -1t ${KEY_DIR}`)
            .then((response) => {
                const KEY_FILE_PREFIX = `:${folder}:${name}`;
                const files = response.split('\n');
                const ourKey = files.find((element) => {
                    return element.startsWith(KEY_FILE_PREFIX);
                });
                if (ourKey) {
                    return KEY_DIR + ourKey;
                }
                return q();
            });
    },

    getPrivateKeyFilePath(folder, name) {
        return this.getKeyFilePath(folder, 'certificate_key', name);
    },

    /**
     * Gets the local private key
     *
     * @returns {Promise} A promise which is resolved with the key metadata or
     *                    rejected if an error occurs
     */
    getPrivateKeyMetadata(folder, name) {
        assert.equal(typeof folder, 'string', 'folder must be a string');
        assert.equal(typeof name, 'string', 'name must be a string');

        return getKeySuffix()
            .then((response) => {
                return util.runTmshCommand(`list sys file ssl-key /${folder}/${name}${response}`);
            })
            .then((response) => {
                const keyVals = response.split(/\s+/);
                const result = {};

                // find the parts inside the {}
                const openingBraceIndex = keyVals.indexOf('{');
                const closingBraceIndex = keyVals.lastIndexOf('}');

                for (let i = openingBraceIndex + 1; i < closingBraceIndex - 1; i += 2) {
                    result[keyVals[i]] = keyVals[i + 1];
                }

                return result;
            });
    },

    privateKeyExists(folder, name) {
        return getKeySuffix()
            .then((response) => {
                return util.runTmshCommand(`list sys crypto key /${folder}/${name}${response}`);
            })
            .then((response) => {
                if (response) {
                    return this.getPrivateKeyFilePath(folder, name);
                }
                return false;
            })
            .then((response) => {
                if (response) {
                    return true;
                }
                return false;
            });
    },

    setLogger(aLogger) {
        logger = aLogger;
    },

    setLoggerOptions(loggerOptions) {
        const loggerOpts = Object.assign({}, loggerOptions);
        loggerOpts.module = module;
        logger = Logger.getLogger(loggerOpts);
    }
};

function installPrivateKey(privateKeyFile, folder, name, options) {
    const deferred = q.defer();
    let installCmd;

    const passphrase = options ? options.passphrase : undefined;

    installCmd = `install sys crypto key /${folder}/${name} from-local-file ${privateKeyFile}`;
    if (passphrase) {
        installCmd += ` passphrase ${passphrase}`;
    }

    ready()
        .then(() => {
            return createBigIpFolder(`/${folder}`);
        })
        .then(() => {
            return util.runTmshCommand(installCmd);
        })
        .then(() => {
            fs.unlink(privateKeyFile, (err) => {
                if (err) {
                    logger.debug('Failed to delete private key:', err);
                }

                deferred.resolve();
            });
        })
        .catch((err) => {
            deferred.reject(err);
        });

    return deferred.promise;
}

function installPublicKey(publicKeyPath, name) {
    return ready()
        .then(() => {
            return util.runTmshCommand(`create sys file ifile ${name} source-path file://${publicKeyPath}`);
        })
        .then(() => {
            return this.getKeyFilePath('Common', 'ifile', name);
        })
        .catch((err) => {
            return q.reject(err);
        });
}

function ready() {
    const deferred = q.defer();

    childProcess.execFile(`${__dirname}/../scripts/waitForMcp.sh`, (error) => {
        if (error) {
            deferred.reject(error);
        } else {
            deferred.resolve();
        }
    });

    return deferred.promise;
}

function createDirectory(directory) {
    const deferred = q.defer();

    fs.access(directory, (fsAccessErr) => {
        if (fsAccessErr) {
            fs.mkdir(directory, (mkdirErr) => {
                if (mkdirErr) {
                    deferred.reject(mkdirErr);
                } else {
                    deferred.resolve();
                }
            });
        } else {
            deferred.resolve();
        }
    });

    return deferred.promise;
}

function createBigIpFolder(folder) {
    return folderExists(folder)
        .then((exists) => {
            if (exists) {
                return q();
            }
            return util.runTmshCommand(`create sys folder ${folder} device-group none traffic-group none`);
        });
}

function folderExists(folder) {
    // tmsh returns an error if trying to list a non-existent folder
    return util.runTmshCommand(`list sys folder ${folder}`)
        .then(() => {
            return q(true);
        })
        .catch(() => {
            return q(false);
        });
}

// Prior to 14.0, private keys end in '.key'. On 14.0 and up, they do not
function getKeySuffix() {
    return util.runTmshCommand('show sys version')
        .then((response) => {
            // show sys version outputs:
            //   Sys::Version
            //   Main Package
            //     Product     BIG-IP
            //     Version     14.0.0
            //     Build       0.0.1736
            //     Edition     Final
            //     Date        Thu Feb  1 04:16:38 PST 2018
            const reg = /(\s+Version\s+)(\S+)\s+/;
            const version = reg.exec(response)[2];

            if (util.versionCompare(version, '14.0.0') < 0) {
                return '.key';
            }
            return '';
        });
}
