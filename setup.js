var options = require("commander");
var q = require("q");
var BigIp = require('./lib/bigIp');
var globalSettings = {
    guiSetup: 'disabled'
};

var bigIp;

var collect = function(val, collection) {
    collection.push(val);
    return collection;
};

var map = function(pair, map) {
    var nameVal = pair.split(':');
    map[nameVal[0].trim()] = nameVal[1].trim();
};

options
    .option('--host <ip_address>', 'BIG-IP management IP.')
    .option('-u, --user <user>', 'BIG-IP admin user.')
    .option('-p, --password <password>', 'BIG-IP admin user password.')
    .option('-l, --license <license_key>', 'BIG-IP license key.')
    .option('-a, --add-on <add-on keys>', 'Add on license keys.', collect, [])
    .option('-g, --global-settings <name: value>', 'A global setting name/value pair. For multiple settings, use multiple -g entries', map, globalSettings)
    .parse(process.argv);

bigIp = new BigIp(options.host, options.user, options.password);

console.log("Waiting for BIG-IP to be ready...");
bigIp.ready()
    .then(function() {
        console.log("BIG-IP is ready.");
        console.log("Performing initial setup...");

        var nameServers = ["10.133.20.70", "10.133.20.71"];
        var timezone = 'UTC';
        var ntpServers = ["0.us.pool.ntp.org", "1.us.pool.ntp.org"];

        return bigIp.initialSetup(
            {
                dns: {
                    nameServers: nameServers
                },
                ntp: {
                    timezone: timezone,
                    servers: ntpServers
                },
                globalSettings: globalSettings
            }
        );
    })
    .then(function() {
        console.log("Initial setup complete.");

        var registrationKey = options.license;
        var addOnKeys = options.addOn;

        if (registrationKey || addOnKeys.length > 0) {
            console.log("Licensing...");

            return bigIp.license(
                {
                    registrationKey: registrationKey,
                    addOnKeys: addOnKeys
                }
            );
        }

        return q();
    })
    .then(function(response) {
        if (response) {
            console.log(response);
        }

        console.log("BIG-IP setup complete.");
    })
    .catch(function(err) {
        console.log("BIG-IP setup failed: " + (typeof err === 'object' ? err.message : err));
    })
    .done();
