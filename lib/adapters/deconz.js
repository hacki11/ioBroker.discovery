'use strict';

const tools = require('../tools.js');

function addDeconz(ip, device, options) {
    options.log.debug('deconz FOUND! ' + ip);

    let instance = tools.findInstance(options, 'deconz', obj =>
        obj && obj.native && (obj.native.bridge === ip || obj.native.webServer === device._name));

    if (!instance) {
        instance = {
            _id: tools.getNextInstanceID('deconz', options),
            common: {
                name: 'deconz'
            },
            native: {
                bridge: ip
            },
            comment: {
                add: [tools.translate(options.language, 'for %s', ip)],
                inputs: [
                    {
                        name: 'native.user',
                        def: '',
                        type: 'text', // text, checkbox, number, select, password. Select requires
                        title: 'user' // see translation in words.js
                    }
                ]
            }
        };
        options.newInstances.push(instance);
        return true;
    } else {
        return false;
    }
}

// just check if IP exists
function detect(ip, device, options, callback) {
    let foundInstance = false;

    device._upnp.forEach(upnp => {
        if (!foundInstance && (upnp['GWID.PHOSCON.DE'] || upnp['gwid.phoscon.de'])) {
            if (addDeconz(ip, device, options)) {
                foundInstance = true;
            }
        }
    });

    callback(null, foundInstance, ip);
}

exports.detect = detect;
exports.type = ['upnp'];// make type=serial for USB sticks
exports.timeout = 500;
