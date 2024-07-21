/**
 *
 *      ioBroker Discovery Adapter
 *
 *      Copyright (c) 2017-2023 Denis Haev ak Bluefox <dogafox@gmail.com>
 *
 *      MIT License
 *
 */

/* jshint -W097 */
/* jshint strict: false */
/* jslint node: true */

'use strict';
const utils = require('@iobroker/adapter-core'); // Get common adapter utils
const getAdapterDir = utils.commonTools.getAdapterDir;
const adapterName = require('./package.json').name.split('.').pop();
const fs = require('fs');
const dns = require('dns');
const adapters = {};
let   methods = null;

let adapter;
function startAdapter(options) {
    options = options || {};

    Object.assign(options, {name: adapterName});
    adapter  = new utils.Adapter(options);

    adapter.on('message', obj => obj && processMessage(obj));

    adapter.on('ready', main);

    adapter.on('unload', callback => {
        if (isRunning) {
            adapter && adapter.setState && adapter.setState('scanRunning', false, true);
            isRunning = false;
            haltAllMethods();
            setTimeout(() => callback && callback(), 1000);
        } else if (callback) {
            callback();
        }
    });

    return adapter;
}

function enumAdapters(repository) {
    let dir;
    try {
        dir = fs.readdirSync(`${__dirname}/lib/adapters`);
    } catch (err) {
        adapter.log.warn(`Adapter scan classes not found: ${err}`);
        dir = [];
    }

    for (let f = 0; f < dir.length; f++) {
        const parts = dir[f].split('.');
        if (parts[parts.length - 1] === 'js') {
            parts.pop();

            const moduleName = `${__dirname}/lib/adapters/${dir[f]}`;
            const aName      = parts.join('.');

            if (adapters && adapters[aName] && adapters[aName].reloadModule) {
                const module = require.resolve(moduleName);
                delete require.cache[module];
                delete adapters[aName];
            }

            // check if this adapter available in repository
            if (!adapters[aName] && (!repository || repository.includes(aName))) {
                adapters[aName] = require(moduleName);
            }
        }
    }
}

function enumMethods() {
    const dir = fs.readdirSync(`${__dirname}/lib/methods`);
    methods = {};
    for (let f = 0; f < dir.length; f++) {
        const parts = dir[f].split('.');
        if (parts[parts.length - 1] === 'js' && parts[0] !== '_') {
            parts.pop();
            methods[parts.join('.')] = require(`${__dirname}/lib/methods/${dir[f]}`);
        }
    }
}

let isRunning = false;

function processMessage(obj) {
    if (!obj || !obj.command) {
        return;
    }
    switch (obj.command) {
        case 'browse': {
            if (obj.callback) {
                adapter.log.debug('Received "browse" event');
                browse(obj.message, (error, newInstances, devices) => {
                    adapter.log.debug('Browse finished');
                    adapter.setState('scanRunning', false, true);
                    adapter.sendTo(obj.from, obj.command, {
                        error,
                        devices,
                        newInstances
                    }, obj.callback);
                });
            }
            break;
        }
        case 'listMethods': {
            if (obj.callback) {
                adapter.log.debug('Received "listMethods" event');
                if (!methods || !methods.length) {
                    enumMethods();
                }

                adapter.sendTo(obj.from, obj.command, methods, obj.callback);
            }
            break;
        }
    }
}

function isValidAdapter(adapterName, type, dependencies) {
    if (!Object.prototype.hasOwnProperty.call(adapters, adapterName)) {
        return false;
    }
    const adapter = adapters[adapterName];

    if (typeof adapter.type === 'string' && adapter.type !== type) {
        return false;
    } else if (typeof adapter.type === 'object' && !adapter.type.includes(type)) {
        return false;
    } else {
        return (!!adapter.dependencies) === dependencies;
    }
}

function forEachValidAdapter(device, dependencies, callback) {
    if (typeof dependencies === 'function') {
        callback = dependencies;
        dependencies = undefined;
    }
    let cnt  = 0;
    const type = typeof device === 'object' ? device._type : device;
    for (const a in adapters) {
        if (Object.prototype.hasOwnProperty.call(adapters, a) && isValidAdapter(a, type, dependencies)) {
            callback && callback(adapters[a], a);
            cnt += 1;
        }
    }
    return cnt;
}

function analyseDeviceDependencies(device, options, callback) {
    let count = forEachValidAdapter(device, true);
    const callbacks = {};

    // try all found adapter types (with dependencies)
    forEachValidAdapter(device, true, (_adapter, a) => {
        let timeout = setTimeout(() => {
            timeout = null;
            //options.log.error('Timeout by detect "' + adpr + '" on "' + device._addr + '": ' + (adapters[adpr].timeout || 2000) + 'ms');
            if (!--count) {
                analyseDeviceDependencies(device, options, callback);
                count = false;
            }
        }, adapters[a].timeout || 2000);


        (function (adpr) {
            adapter.log.debug(`Test ${device._type} ${device._addr} ${adpr}`);
            // expected, that detect method will add to _instances one instance of a specific type or extend existing one
            adapters[adpr].detect(device._addr, device, options, (err, isFound /* , addr */) => {
                if (callbacks[adpr]) {
                    adapter.log.error(`Double callback by "${adpr}"`);
                } else {
                    callbacks[adpr] = true;
                }

                if (isFound) {
                    adapter.log.debug(`Test ${device._type} ${device._addr} ${adpr} DETECTED!`);
                }
                if (timeout) {
                    clearTimeout(timeout);
                    timeout = null;
                    if (count !== false && !--count) {
                        count = false;
                        callback(err);
                    }
                }
            });
        })(a);
    });

    if (count === 0) {
        callback(null);
    }
}

function analyseDeviceSerial(device, options, list, callback) {
    if (!list || !list.length) {
        callback();
    } else {
        const adpr = list.shift();
        adapter.log.debug(`Test ${device._addr} ${adpr}`);

        let done = false;
        let timeout = setTimeout(() => {
            timeout = null;
            //options.log.error('Timeout by detect "' + adpr + '" on "' + device._addr + '": ' + (adapters[adpr].timeout || 2000) + 'ms');
            analyseDeviceSerial(device, options, list, callback);
        }, adapters[adpr].timeout || 2000);


        try {
            // expected, that detect method will add to _instances one instance of a specific type or extend existing one
            adapters[adpr].detect(device._addr, device, options, (err, isFound /* , addr */) => {
                if (timeout) {
                    if (done) {
                        adapter.log.error(`Double callback by "${adpr}"`);
                    } else {
                        done = true;
                    }

                    clearTimeout(timeout);
                    timeout = null;
                    setTimeout(analyseDeviceSerial, 0, device, options, list, callback);
                }
                if (isFound) {
                    adapter.log.debug(`Test ${device._addr} ${adpr} DETECTED!`);
                }
            });
        } catch (e) {
            options.log.error(`Cannot detect "${adpr}" on "${device._addr}": ${e}`);
            setTimeout(analyseDeviceSerial, 0, device, options, list, callback);
        }
    }
}

// addr can be IP address (192.168.1.1) or serial port name (/dev/ttyUSB0, COM1)
function analyseDevice(device, options, callback) {
    let count = forEachValidAdapter(device, false);

    if (device._type === 'serial') {
        const list = [];
        forEachValidAdapter(device, false, (adapter, aName) => list.push(aName));
        analyseDeviceSerial(device, options, list, () => analyseDeviceDependencies(device, options, callback));
    } else {
        const callbacks = {};
        // try all found adapter types (first without dependencies)
        forEachValidAdapter(device, false, (_adapter, a) => {

            (function (adpr) {
                adapter.log.debug(`Test ${device._type} ${device._addr} ${adpr}`);

                let timeout = setTimeout(() => {
                    timeout = null;
                    //options.log.error('Timeout by detect "' + adpr + '" on "' + device._addr + '": ' + (adapters[adpr].timeout || 2000) + 'ms');
                    if (count !== false && !--count) {
                        analyseDeviceDependencies(device, options, callback);
                        count = false;
                    }
                }, adapters[adpr].timeout || 2000);

                try {
                    // expected, that detect method will add to _instances one instance of a specific type or extend existing one
                    adapters[adpr].detect(device._addr, device, options, (err, isFound /* , addr */) => {
                        if (timeout) {
                            if (callbacks[adpr]) {
                                adapter.log.error(`Double callback by "${adpr}"`);
                            } else {
                                callbacks[adpr] = true;
                            }

                            clearTimeout(timeout);
                            timeout = null;
                            if (count !== false && !--count) {
                                analyseDeviceDependencies(device, options, callback);
                                count = false;
                            }
                        }

                        if (isFound) {
                            adapter.log.debug(`Test ${device._addr} ${adpr} DETECTED!`);
                        }
                    });
                } catch (e) {
                    adapter.log.error(`Cannot detect "${adpr}" on "${device._addr}": ${e}`);
                    if (count !== false && !--count) {
                        analyseDeviceDependencies(device, options, callback);
                        count = false;
                    }
                }
            })(a);
        });
        if (count === 0) analyseDeviceDependencies(device, options, callback);
    }
}

function analyseDevices(devices, options, index, callback) {
    if (typeof index === 'function') {
        index = callback;
        index = 0;
    }
    adapter.setState('servicesProgress', Math.round(index * 100 / devices.length), true);
    adapter.setState('instancesFound', options.newInstances.length, true);

    if (!devices || index >= devices.length) {
        let count = 0;
        for (const aa in adapters) {
            if (!Object.prototype.hasOwnProperty.call(adapters, aa)) {
                continue;
            }
            if (adapters[aa].type !== 'advice') {
                continue;
            }

            count++;
        }

        const callbacks = {};
        // add suggested adapters
        for (const a in adapters) {
            if (!Object.prototype.hasOwnProperty.call(adapters, a)) {
                continue;
            }
            if (adapters[a].type !== 'advice') {
                continue;
            }

            (function (adpr) {
                try {
                    // expected, that detect method will add to _instances one instance of a specific type or extend existing one
                    adapters[adpr].detect(null, null, options, (err, isFound, name) => {
                        if (callbacks[adpr]) {
                            adapter.log.error(`Double callback by "${adpr}"`);
                        } else {
                            callbacks[adpr] = true;
                        }
                        if (isFound) {
                            adapter.log.debug(`Added suggested adapter: ${name}`);
                        }
                        if (!--count && callback) {
                            adapter.setState('servicesProgress', 100, true);
                            adapter.setState('instancesFound', options.newInstances.length, true);
                            callback && callback(null);
                            callback =  null;
                        }
                    });
                } catch (e) {
                    adapter.log.error(`Cannot detect suggested adapter: ${e}`);
                    count--;
                }
            })(a);
        }
        if (!count && callback) {
            adapter.setState('servicesProgress', 100, true);
            adapter.setState('instancesFound', options.newInstances.length, true);
            callback && callback(null);
            callback =  null;
        }
    } else {
        analyseDevice(devices[index], options, err => {
            err && adapter.log.error(`Error by analyse device: ${err}`);
            setTimeout(analyseDevices, 0, devices, options, index + 1, callback);
        });
    }
}

function getInstances(callback) {
    adapter.getObjectView('system', 'instance', {startkey: 'system.adapter.', endkey: 'system.adapter.\u9999'}, (err, doc) => {
        if (err || !doc || !doc.rows || !doc.rows.length) return callback && callback ([]);
        const res = [];
        doc.rows.forEach(row => res.push(row.value));
        callback && callback (res);
    });
}

function discoveryEnd(devices, callback) {
    adapter.log.info(`Found ${devices.length} addresses`);

    adapter.getForeignObject('system.repositories', (err, repo) => {
        adapter.getForeignObject('system.config', (err, systemConfig) => {
            let repository = null;
            if (repo && repo.native && systemConfig && systemConfig.common && systemConfig.common.activeRepo &&
                repo.native.repositories && repo.native.repositories[systemConfig.common.activeRepo] && repo.native.repositories[systemConfig.common.activeRepo].json) {
                repository = Object.keys(repo.native.repositories[systemConfig.common.activeRepo].json);
            }

            // use only installed adapter if onlyLocal flag activated
            if (adapter.config.onlyLocal) {
                repository = repository.filter(a => getAdapterDir(a));
            }

            // Get the list of adapters with auto-discovery
            enumAdapters(repository);

            getInstances(instances => {
                adapter.getEnums(null, (err, enums) => {
                    // read language
                    adapter.getForeignObject('system.config', (err, obj) => {
                        const options = {
                            existingInstances: instances,
                            newInstances: [],
                            enums: enums,
                            language: obj ? obj.common.language : 'en',
                            log: {
                                debug: text => adapter.log.debug(text),
                                warn: text => adapter.log.warn(text),
                                error: text => adapter.log.error(text),
                                info: text => adapter.log.info(text)
                            }
                        };

                        options._devices = devices; // allow adapters to know all IPs and their infos
                        options._g_devices = g_devices;

                        // analyze every IP address
                        analyseDevices(devices, options, 0, async (/* err */) => {
                            adapter.log.info(`Discovery finished. Found new or modified ${options.newInstances.length} instances`);

                            // read secret
                            const systemConfig = await adapter.getForeignObjectAsync('system.config');
                            const secret = (systemConfig && systemConfig.native && systemConfig.native.secret) || 'Zgfr56gFe87jJOM';

                            // try to encrypt all passwords
                            options.newInstances.forEach(instance => {
                                if (instance.encryptedNativeLegacy) {
                                    const list = instance.encryptedNativeLegacy;
                                    delete instance.encryptedNativeLegacy;
                                    list.forEach(attr => {
                                        if (instance.native[attr]) {
                                            instance.native[attr] = adapter.encrypt(secret, instance.native[attr]);
                                        }
                                    });
                                }
                            });

                            // add this information to system.discovery.host
                            let obj;
                            try {
                                obj = await adapter.getForeignObjectAsync('system.discovery');
                            } catch (e) {
                                // ignore
                            }

                            if (!obj) {
                                obj = {
                                    common: {
                                        name: 'prepared update of discovery',
                                    },
                                    native: {},
                                    type: 'config',
                                };
                            }
                            const oldInstances = obj.native.newInstances || [];
                            obj.native.newInstances = options.newInstances;
                            obj.native.devices = devices;
                            obj.native.lastScan = new Date().getTime();
                            for (let j = oldInstances.length - 1; j >= 0; j--) {
                                if (oldInstances[j].comment.ack) {
                                    delete oldInstances[j].comment.ack;
                                    oldInstances[j]._id = oldInstances[j]._id.replace(/\.\d+$/, '');
                                    oldInstances[j]= JSON.stringify(oldInstances[j]);
                                } else {
                                    oldInstances.splice(j, 1);
                                }
                            }

                            for (let i = 0; i < oldInstances.length; i++) {
                                for (let n = 0; n < options.newInstances.length; n++) {
                                    const modified = JSON.parse(JSON.stringify(options.newInstances[n]));
                                    modified._id = modified._id.replace(/\.\d+$/, '');
                                    if (oldInstances[i] === JSON.stringify(modified)) {
                                        options.newInstances[n].comment.ack = true;
                                        break;
                                    }
                                }
                            }

                            await adapter.setForeignObjectAsync('system.discovery', obj);
                            isRunning = false;
                            err && adapter.log.error(`Cannot update system.discovery: ${err}`);
                            adapter.log.info('Discovery finished');
                            adapter.setState('scanRunning', false, true);
                            if (typeof callback === 'function') {
                                callback(null, options.newInstances, devices);
                            }
                        });
                    });
                });
            });
        });
    });
}

let g_devices = {};
// let g_devices_count = 0;
let g_browse = null;
const specialEntryNames = 'name,data,LOCATION'.split(',');

function haltAllMethods() {
    methods && Object.keys(methods).forEach(method => {
        // not final
        if (method && method.halt !== undefined) {
            method.halt = true;
        }
    });
}

////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////
// wrapper class for each method module

const Method = function (methodName, parent) {
    if (!(this instanceof Method)) {
        return new Method(methodName, parent);
    }
    const module = methods[methodName];
    module.source = module.source || methodName;
    Object.assign(this, module);
    const self = this;
    let doneCalled = 0;

    this.parent = parent;
    this.options = adapter.config;
    this.foundCount = 0;
    this.progress = 0;
    this.adapter = adapter;
    this.log = adapter.log;
    this.halt = parent.halt;
    this.halt [methodName] = false; // not necessary, but to see hwo to use

    this.add = this.addDevice = function (newDevice, err) {
        if (newDevice === null) {
            return self.done();
        }
        self.foundCount += 1;
        return parent.addDevice(newDevice, self.source, self.type);
    };

    this.get = this.getDevice = function (ip, type) {
        type = type || 'ip';
        if (g_devices[type] === undefined) {
            return undefined;
        }
        return g_devices[type][ip];
    };

    this.updateProgress = function (progress) {
        if (typeof progress === 'number') {
            self.progress = Math.round(progress);
        }
        adapter.log.debug(`${self.source}: ${self.progress}%, devices - ${self.foundCount}`);
        parent.updateProgress();
    };

    this.done = function (err) {
        if (err) {
            adapter.log.warn(err);
        }
        if (doneCalled++) {
            return;
        }  // only one call accepted
        if (timer) {
            clearTimeout(timer);
            timer = null;
        }
        if (interval) {
            clearInterval(interval);
            interval = null;
        }
        self.progress = 100;
        adapter.log.info (`Done discovering ${self.source} devices. ${self.foundCount} packages received`);
        parent.done (self);
    };
    this.close = this.done; // * this.close should be overwritten. Is called to stop searching

    let timer;
    let interval;
    this.setTimeout = this.setInterval = function (timeout, options) {
        options = options || {};

        if (options.timeout !== false) {
            timer = setTimeout(() => {
                timer = null;
                self.close();

                if (!doneCalled) {
                    self.done();
                }
            }, timeout);
        }

        if (options.progress !== false) {
            parent.updateProgress();
            interval = setInterval(() => {
                self.progress += 5;

                parent.updateProgress();

                if (self.progrress > 95) {
                    clearInterval(interval);
                    interval = null;
                }
            }, timeout / 20);
        }
    };
};

function browse(options, callback) {
    if (isRunning) {
        return callback && callback('Yet running');
    }

    isRunning = true;
    g_devices = {};
    // g_devices_count = 0;

    adapter.setState('scanRunning', true, true);
    enumMethods();

    function Browse () {
        const self = this;
        adapter.config.stopPingOnTR064Ready = true; //

        const methodsArray = Object.keys(methods).filter(m => methods[m].browse && (!options || options.includes(m)));

        this.count = methodsArray.length;
        this.foundCount = 0;
        this.halt = {};

        let timeoutProgress;
        this.updateProgress = function () {
            if (timeoutProgress) {
                return;
            }
            timeoutProgress = setTimeout(() => {
                timeoutProgress = null;
                let value = 0;
                methodsArray.forEach(n => value += methods[n].progress);
                adapter.setState('devicesProgress', Math.round(value / methodsArray.length), true);
                adapter.setState('devicesFound', self.foundCount, true);
            }, 1000);
        };

        this.done = function (method) {
            if (method !== undefined) {
                self.count--;
            }
            self.updateProgress();
            if (!self.count) {
                self.count = -1;
                timeoutProgress && clearTimeout(timeoutProgress);
                const devices = [];

                Object.keys(g_devices).sort().forEach(t =>
                    Object.keys(g_devices[t]).sort().forEach(d =>
                        devices.push(g_devices[t][d])
                    )
                );

                self.getMissedNames(devices, () => {
                    devices.push({
                        _addr: '0.0.0.0',
                        _name: 'localhost',
                        _type: 'once'
                    });
                    discoveryEnd(devices, callback);
                });
            }
        };

        this.getMissedNames = function (devices, callback) {
            let cnt = 0;
            (function doIt() {
                if (cnt >= devices.length) {
                    return callback();
                }
                const dev = devices[cnt++];

                if (dev._name) {
                    return doIt();
                }

                dns.reverse (dev._addr, (err, hostnames) => {
                    dev._name = !err && hostnames && hostnames.length ? hostnames[0] : dev._sddr;
                    dev._dns = {
                        hostnames: hostnames
                    };
                    doIt();
                });
            })();
        };

        this.addDevice = function (newDevice, source /* methodName */, type) {
            let device;
            if (!newDevice || !newDevice._addr) {
                return;
            }

            g_devices[type] = g_devices[type] || {};

            const old = g_devices[type][newDevice._addr];

            if (old && old._type === type) {
                device = old;
                adapter.log.debug(`extended Device: ${newDevice._addr} source=${source}`);
                if (type === 'upnp' && !old._upnp) {
                    old._upnp = [];
                }

                if (newDevice._upnp !== undefined) {
                    old._upnp.push(newDevice._upnp);
                }

                g_devices[type][newDevice._addr] = old;
            } else {
                adapter.log.debug(`main.addDevice: ip=${newDevice._addr} source=${source}`);

                if (type === 'upnp') {
                    newDevice._upnp = [newDevice._upnp];
                }

                // g_devices_count += 1;
                newDevice._source = source;
                newDevice._type = type || 'ip';
                newDevice._new = true;
                self.foundCount += 1;
                g_devices[type][newDevice._addr] = newDevice;
                device = {};
            }
            delete newDevice._new;
            //debug:
            // device.__debug = device.__debug || [];
            // device.__debug.push(newDevice);

            (function _merge(dest, from) {
                Object.getOwnPropertyNames(from).forEach(name => {
                    if (name === '__debug') {
                        return;
                    }
                    if (typeof from[name] === 'object') {
                        if (typeof dest[name] !== 'object') {
                            dest[name] = {};
                        }
                        _merge(dest[name], from[name]);
                    } else {
                        let uneq = true;
                        const namex = `${name}x`;
                        if (specialEntryNames.includes(name) && dest[name] && from[name] !== undefined && (uneq = (dest[name] !== from[name]))) {
                            if (dest[namex] === undefined) {
                                dest[namex] = [dest[name]];
                            }
                            if (from[name] && !dest[namex].includes(from[name])) {
                                dest[namex].push(from[name]);
                            }
                        }
                        if (uneq) {
                            dest[name] = from[name];
                        }
                    }
                });
            })(device, newDevice);

            if (!device._name && newDevice._name) {
                device._name = newDevice._name;
            }
            return true;
        };

        methodsArray.forEach(m => {
            // if (m !== 'ping') return;
            const method = Method(m, self);
            methods[m] = method;
            method.browse(method);
        });

        if (!methodsArray.length) {
            self.done();
        }
    }
    g_browse = new Browse();
}

function main() {
    adapter.setState('scanRunning', false, true);
    adapter.config.pingTimeout = parseInt(adapter.config.pingTimeout, 10) || 1000;
    adapter.config.pingBlock   = parseInt(adapter.config.pingBlock, 10) || 20;

    //browse();
}

// If started as allInOne/compact mode => return function to create instance
if (module && module.parent) {
    module.exports = startAdapter;
} else {
    // or start the instance directly
    startAdapter();
}

